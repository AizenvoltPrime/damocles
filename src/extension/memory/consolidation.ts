import { log } from '../logger';
import type { MemoryKind, MemoryScope } from '@shared/types/memory';
import type {
  ConsolidationPersistOutcome,
  ConsolidationExtractedMemory,
  ConsolidationResult,
  ConsolidationTrigger,
  ConsolidationPhaseEvent,
} from '@shared/types/consolidation';
import type { DatabaseInstance, MemoryRow } from './types';
import type { MemoryWriteQueue } from './write-queue';
import type { MemorySubCallRunner, MemorySubCallResult } from './subcall-runner';
import type { FactGraphManager } from './managers/fact-graph-manager';
import type { ProfileManager } from './managers/profile-manager';
import {
  insertWithDedup,
  findNearDuplicates,
  mergeNearDuplicates,
  applyDecaySweep,
  promoteEpisodes,
  pruneConsumedCandidates,
  getDedupThreshold,
  type NewMemoryFields,
} from './dedup-decay';

/** Why consolidation ran — drives candidate scoping and is purely diagnostic otherwise. */
export type ConsolidationReason = 'switch' | 'idle' | 'start' | 'manual';

/** A consolidation request folded into the single pending slot when one arrives mid-pass. */
export interface PendingConsolidationRequest {
  reason: ConsolidationReason;
  sessionId?: string;
  forceExtract?: boolean;
}

/**
 * Folds a request that arrived mid-pass into the single pending slot, preserving its
 * `{reason, sessionId}` when it matches what is already queued. When two requests target different
 * sessions a single session-scoped follow-up cannot cover both, so it broadens to a global `idle`
 * pass — which claims ALL unconsumed candidates and thus covers either request.
 *
 * `forceExtract` is OR-ed across both requests so a manual "Run now" folded into an in-flight auto
 * pass still forces extraction in the follow-up, even with global auto-extract OFF (the flag-loss
 * bug: the merged slot must not silently drop the manual run's extraction intent).
 */
export function mergePendingConsolidation(
  existing: PendingConsolidationRequest | null,
  incoming: PendingConsolidationRequest,
): PendingConsolidationRequest {
  const forceExtract = (existing?.forceExtract ?? false) || (incoming.forceExtract ?? false);
  const force = forceExtract ? { forceExtract: true } : {};
  if (!existing) return { ...incoming, ...force };
  if (existing.sessionId === incoming.sessionId) return { ...existing, ...force };
  return { reason: 'idle', ...force };
}

/** Everything {@link runConsolidation} needs, supplied by MemoryService (or a test harness). */
export interface ConsolidationCtx {
  db: DatabaseInstance;
  writeQueue: MemoryWriteQueue;
  runner: MemorySubCallRunner;
  factGraph: FactGraphManager;
  profileManager: ProfileManager;
  reason: ConsolidationReason;
  sessionId?: string;
  workspace: string;
  /** True only when auto-extraction is enabled (D6); a false value runs maintenance but extracts nothing. */
  autoExtractEnabled: boolean;
  /** Whether this pass was user-initiated ('manual') or a background pass ('auto') — set on the result. */
  trigger: ConsolidationTrigger;
  /** Invoked once when the runner reports a persistent `no-model` failure (D8). */
  onNoModel: () => void;
  /**
   * Optional live-progress stream: fires `active` then one of `done|skipped|failed` per phase, in
   * Claim→Extract→Persist→Maintain→Profiles order. A genuine stream of events (not a terminal value),
   * so a callback is the right tool here; the terminal outcome is the function's RETURN value instead.
   */
  onPhase?: (event: ConsolidationPhaseEvent) => void;
}

/** A candidate claimed for this consolidation pass. */
interface ClaimedCandidate {
  id: string;
  userText: string;
  assistantText: string;
}

interface ClaimedRow {
  id: string;
  user_text: string;
  assistant_text: string;
}

/** One memory the extractor asked to durably store. */
interface ExtractedMemory {
  kind: string;
  content: string;
  scope: string;
  tags?: string[];
  forget_after?: number;
  relation?: { type: 'updates' | 'extends' | 'derives'; targetHint?: string };
}

interface ExtractionResult {
  memories: ExtractedMemory[];
}

const CANDIDATE_BATCH_LIMIT = 50;

const CHARS_PER_TOKEN = 4;

/**
 * Token budget for the candidate-text portion of one extraction prompt. A pass claims turns
 * oldest-first only while they fit (the count cap above bounds the working set; this bounds its
 * size), so the built prompt can never exceed the model context — the remaining turns roll into the
 * next pass. Haiku's window is ~200K; this leaves ample room for the existing-memories block,
 * system prompt, schema, and the model's output.
 */
export const CANDIDATE_TOKEN_BUDGET = 100_000;

/**
 * Per-turn hard cap so a single oversized turn — claimed alone to guarantee the queue makes
 * progress — cannot by itself build a prompt that exceeds the budget. Sized so one turn's
 * user + assistant halves together stay within {@link CANDIDATE_TOKEN_BUDGET}.
 */
const MAX_TURN_CHARS = (CANDIDATE_TOKEN_BUDGET * CHARS_PER_TOKEN) / 2;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function clipTurnText(text: string): string {
  return text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)} …[truncated]` : text;
}

const VALID_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  'fact',
  'preference',
  'observation',
  'note',
  'episode',
]);

const VALID_SCOPES: ReadonlySet<MemoryScope> = new Set<MemoryScope>(['session', 'project', 'global']);

const EXTRACTION_SYSTEM_PROMPT =
  'Extract durable, reusable memories from this conversation. Prefer few high-value items. ' +
  "kind: 'fact'|'preference'|'observation'|'episode'. " +
  "scope: 'project' for workspace-specific, 'global' for cross-project user preferences, " +
  "'session' for ephemeral. Use 'episode' for time-bound 'currently working on X'. " +
  'You are given the memories ALREADY stored. Do NOT re-extract anything already captured there — ' +
  'even if reworded. Only emit a memory if it is genuinely NEW, or if it UPDATES/CONTRADICTS an ' +
  'existing one (in which case state the corrected fact). Return [] if nothing new is durable.';

/** Existing live memories most likely to overlap with new extractions, used to suppress duplicates. */
const EXISTING_MEMORY_LIMIT = 40;

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { enum: ['fact', 'preference', 'observation', 'episode'] },
          content: { type: 'string' },
          scope: { enum: ['session', 'project', 'global'] },
          tags: { type: 'array', items: { type: 'string' } },
          forget_after: { type: 'number' },
          relation: {
            type: 'object',
            properties: {
              type: { enum: ['updates', 'extends', 'derives'] },
              targetHint: { type: 'string' },
            },
            required: ['type'],
            additionalProperties: false,
          },
        },
        required: ['kind', 'content', 'scope'],
        additionalProperties: false,
      },
    },
  },
  required: ['memories'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

/**
 * Atomically RESERVES the oldest unconsumed candidates that fit within {@link CANDIDATE_TOKEN_BUDGET}
 * (reading up to {@link CANDIDATE_BATCH_LIMIT} rows as the working set, then accumulating oldest-first
 * until the next turn would overflow the budget), select-then-update in one synchronous write-lock
 * callback so two concurrent passes never double-claim a row. At least one turn is always claimed —
 * even if it alone exceeds the budget — so an oversized turn cannot stall the queue (its text is
 * clipped at prompt-build time). Scopes to one session when `sessionId` is supplied. The reservation
 * is committed by a successful pass and released by {@link releaseCandidates} on failure, so
 * `consumed = 1` means "in-flight or done", never "lost".
 */
function claimCandidates(ctx: ConsolidationCtx): Promise<ClaimedCandidate[]> {
  return ctx.writeQueue.run(() => {
    const where = ctx.sessionId !== undefined ? 'consumed = 0 AND session_id = ?' : 'consumed = 0';
    const selectParams: unknown[] = ctx.sessionId !== undefined ? [ctx.sessionId] : [];

    const rows = ctx.db
      .prepare(`SELECT id, user_text, assistant_text FROM memory_candidates WHERE ${where} ORDER BY created_at LIMIT ?`)
      .all(...selectParams, CANDIDATE_BATCH_LIMIT) as ClaimedRow[];

    if (rows.length === 0) return [];

    const claimed: ClaimedCandidate[] = [];
    let tokens = 0;
    for (const r of rows) {
      const cost = estimateTokens(r.user_text) + estimateTokens(r.assistant_text);
      if (claimed.length > 0 && tokens + cost > CANDIDATE_TOKEN_BUDGET) break;
      claimed.push({ id: r.id, userText: r.user_text, assistantText: r.assistant_text });
      tokens += cost;
    }

    const ids = claimed.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    ctx.db
      .prepare(`UPDATE memory_candidates SET consumed = 1 WHERE id IN (${placeholders})`)
      .run(...ids);

    return claimed;
  });
}

/**
 * Releases a reserved batch back to `consumed = 0` so a transient/no-model extraction failure (or a
 * throw before the batch is committed) leaves the candidates for the next pass instead of dropping
 * them. Runs in the write lock for the same single-claimer guarantee as {@link claimCandidates}.
 */
function releaseCandidates(ctx: ConsolidationCtx, ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return ctx.writeQueue.run(() => {
    const placeholders = ids.map(() => '?').join(',');
    ctx.db
      .prepare(`UPDATE memory_candidates SET consumed = 0 WHERE id IN (${placeholders})`)
      .run(...ids);
  });
}

/**
 * Commits a reserved batch by setting `reprocessed = 1` — called ONLY after the extracted memories
 * are persisted, so a crash between persistence and this commit leaves the batch `reprocessed = 0`
 * for the startup reclaim to reset and re-extract. Re-extraction never loses a turn, but it is only
 * BEST-EFFORT idempotent: exact-hash dedup ({@link insertWithDedup}) drops verbatim repeats and the
 * extraction-aware prompt suppresses already-stored memories (up to {@link EXISTING_MEMORY_LIMIT}),
 * yet a non-deterministic LLM re-run can reword content past both gates on large stores — producing
 * near-duplicates that the near-dup merge pass later consolidates. (True persist+commit atomicity is
 * not achievable: persistence spans multiple write-lock turns with LLM conflict/merge calls between
 * them, which cannot run inside a single lock.) This marker distinguishes a fully-processed batch
 * from a crash-stranded claim.
 */
function commitCandidates(ctx: ConsolidationCtx, ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return ctx.writeQueue.run(() => {
    const placeholders = ids.map(() => '?').join(',');
    ctx.db
      .prepare(`UPDATE memory_candidates SET reprocessed = 1 WHERE id IN (${placeholders})`)
      .run(...ids);
  });
}

/**
 * Loads the live fact/preference/episode memories most likely to overlap with this pass's
 * extraction (project rows for the active workspace + all global rows), so the extractor can skip
 * re-stating already-known information — the root fix for reworded duplicates that lexical dedup
 * (content-hash + Jaccard) cannot catch.
 */
function loadExistingMemoriesForExtraction(ctx: ConsolidationCtx): string[] {
  const rows = ctx.db
    .prepare(
      `SELECT content FROM memories
        WHERE is_latest = 1 AND forgotten = 0
          AND kind IN ('fact', 'preference', 'episode')
          AND (scope = 'global' OR (scope = 'project' AND workspace IS ?))
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(ctx.workspace, EXISTING_MEMORY_LIMIT) as Array<{ content: string }>;
  return rows.map(r => r.content);
}

function buildExtractionPrompt(candidates: ClaimedCandidate[], existing: string[]): string {
  const turns = candidates
    .map((c, index) => {
      const user = clipTurnText(c.userText.trim()) || '(empty)';
      const assistant = clipTurnText(c.assistantText.trim()) || '(empty)';
      return `Turn ${index + 1}:\nUser: ${user}\nAssistant: ${assistant}`;
    })
    .join('\n\n');

  if (existing.length === 0) return turns;

  const known = existing.map(c => `- ${c}`).join('\n');
  return `Already-stored memories (do NOT re-extract these):\n${known}\n\nConversation:\n${turns}`;
}

function toNewMemoryFields(memory: ExtractedMemory, workspace: string, sessionId?: string): NewMemoryFields | null {
  if (!VALID_KINDS.has(memory.kind as MemoryKind)) return null;
  if (!VALID_SCOPES.has(memory.scope as MemoryScope)) return null;
  const content = memory.content.trim();
  if (!content) return null;

  const kind = memory.kind as MemoryKind;
  const scope = memory.scope as MemoryScope;

  return {
    kind,
    scope,
    content,
    ...(memory.tags && memory.tags.length > 0 ? { tags: memory.tags } : {}),
    ...(scope === 'project' && workspace ? { workspace } : {}),
    ...(scope === 'session' && sessionId ? { sessionId } : {}),
  };
}

/**
 * Persists one extracted memory through the full write pipeline: exact-dedup insert, then (for
 * fact/preference) LLM conflict resolution BEFORE near-duplicate soft-merge. Exact duplicates and
 * rows that vanished before re-read are no-ops. All steps are top-level awaits — never inside a
 * write-lock callback — because {@link FactGraphManager.resolveConflict} self-acquires the lock and
 * would deadlock otherwise.
 */
async function persistExtracted(ctx: ConsolidationCtx, memory: ExtractedMemory): Promise<ConsolidationPersistOutcome> {
  const fields = toNewMemoryFields(memory, ctx.workspace, ctx.sessionId);
  if (!fields) return 'invalid';

  const { id, deduped } = await insertWithDedup(ctx.db, ctx.writeQueue, fields);
  if (deduped) return 'deduped';

  const row = ctx.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  if (!row) return 'invalid';

  let superseded = false;
  if (row.kind === 'fact' || row.kind === 'preference') {
    const conflict = await ctx.factGraph.resolveConflict(row);
    superseded = conflict.superseded.length > 0;
  }

  let merged = false;
  const dups = findNearDuplicates(ctx.db, row, getDedupThreshold());
  if (dups.length > 0) {
    const result = await mergeNearDuplicates(ctx.db, ctx.writeQueue, ctx.runner, row, dups);
    merged = result.merged > 0;
  }

  return merged ? 'merged' : superseded ? 'superseded' : 'inserted';
}

async function runMaintenance(ctx: ConsolidationCtx): Promise<{ promoted: number; decayed: number; pruned: number }> {
  const { promoted } = await promoteEpisodes(ctx.db, ctx.writeQueue);
  const { forgotten } = await applyDecaySweep(ctx.db, ctx.writeQueue);
  const { pruned } = await pruneConsumedCandidates(ctx.db, ctx.writeQueue);
  return { promoted, decayed: forgotten, pruned };
}

async function updateProfiles(ctx: ConsolidationCtx): Promise<void> {
  await ctx.profileManager.updateProfile('project', ctx.workspace);
  await ctx.profileManager.updateProfile('global', '');
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Batch memory consolidation (D2/D5/D6). Claims a batch of unconsumed candidates under the write
 * lock, extracts durable memories via one privacy-gated `extract` sub-call (OUTSIDE the lock), runs
 * each through dedup → conflict-resolution → near-dup merge, then promotes/decays episodes and
 * regenerates the user profile. When auto-extraction is disabled it still runs maintenance so a
 * setting flip mid-session cannot strand episodes.
 *
 * TOTAL FUNCTION: every code path — including the outer catch — returns a terminal
 * {@link ConsolidationResult}. The non-`void` return type makes a silent finish impossible: there is
 * no bare `return;`, so a pass cannot end without a result the panel can render. Running-state and
 * the result both flow through the MemoryService wrapper (the single lifecycle owner), so the two
 * can never desync. Live progress is reported through the {@link ConsolidationCtx.onPhase} stream;
 * the terminal outcome is the return value.
 *
 * Relation hints emitted by the extractor are not wired in v1: `resolveConflict` already discovers
 * `UPDATES` lineage from content, and `enrich`/`markInferred` are left for a later story (US-009).
 */
export async function runConsolidation(ctx: ConsolidationCtx): Promise<ConsolidationResult> {
  const phase = (event: ConsolidationPhaseEvent): void => ctx.onPhase?.(event);

  let candidatesReviewed = 0;
  let maintenance = { promoted: 0, decayed: 0, pruned: 0 };

  /** Build a terminal result from the running tallies; callers override status/extracted/failure. */
  const done = (over: Partial<ConsolidationResult>): ConsolidationResult => ({
    ranAt: Date.now(),
    trigger: ctx.trigger,
    status: 'empty',
    extracted: [],
    maintenance,
    candidatesReviewed,
    ...over,
  });

  try {
    // PHASE 1 — CLAIM (instant; reserves the oldest unconsumed candidates under the write lock).
    let candidates: ClaimedCandidate[] = [];
    if (ctx.autoExtractEnabled) {
      candidates = await claimCandidates(ctx);
    }
    candidatesReviewed = candidates.length;
    phase({ phase: 'claim', status: 'done', meta: { count: candidatesReviewed } });

    // Nothing to extract: auto-extract off, or an empty queue. Run maintenance only, end `empty`.
    if (!ctx.autoExtractEnabled || candidates.length === 0) {
      const reason = !ctx.autoExtractEnabled ? 'auto-extract off' : 'no queued turns';
      phase({ phase: 'extract', status: 'skipped', meta: { reason } });
      phase({ phase: 'persist', status: 'skipped', meta: { reason } });
      maintenance = await runMaintenancePhase(ctx, phase);
      phase({ phase: 'profiles', status: 'skipped', meta: { reason } });
      return done({ status: 'empty' });
    }

    const claimedIds = candidates.map(c => c.id);
    const existing = loadExistingMemoriesForExtraction(ctx);
    const prompt = buildExtractionPrompt(candidates, existing);

    // PHASE 2 — EXTRACT (one LLM call; the slow step, ~5–20s). Can throw, or yield null/no-model.
    phase({ phase: 'extract', status: 'active', meta: { count: candidatesReviewed } });
    let extraction: MemorySubCallResult<ExtractionResult>;
    try {
      extraction = await ctx.runner.run<ExtractionResult>({
        purpose: 'extract',
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        prompt,
        schema: EXTRACTION_SCHEMA,
      });
    } catch (err) {
      // Release the batch so the turns re-enter the next pass, then STILL run maintenance — it is
      // pure SQL and model-independent, so an extraction failure must not strand maintainable
      // episodes. End `failed` so the panel shows a failure card, never a silent revert.
      await releaseCandidates(ctx, claimedIds);
      phase({ phase: 'extract', status: 'failed', meta: { reason: errorDetail(err) } });
      log('[MemoryConsolidation] extraction threw; released %d candidates: %O', claimedIds.length, err);
      phase({ phase: 'persist', status: 'skipped' });
      maintenance = await runMaintenancePhase(ctx, phase);
      phase({ phase: 'profiles', status: 'skipped' });
      return done({ status: 'failed', failure: { kind: 'error', detail: errorDetail(err), phase: 'extract' } });
    }

    if (extraction.value === null) {
      // The runner returned no value. `no-model` is its own failure-card kind (with a Sign-in action);
      // every other null outcome (transient timeout, or an unexpected null) collapses to `error` with
      // a consistent detail so the card always has a cause to show.
      await releaseCandidates(ctx, claimedIds);
      if (extraction.failure === 'no-model') ctx.onNoModel();
      phase({ phase: 'extract', status: 'failed', meta: { reason: extraction.failure ?? 'transient' } });
      phase({ phase: 'persist', status: 'skipped' });
      maintenance = await runMaintenancePhase(ctx, phase);
      phase({ phase: 'profiles', status: 'skipped' });
      if (extraction.failure === 'no-model') {
        return done({ status: 'failed', failure: { kind: 'no-model', phase: 'extract' } });
      }
      return done({ status: 'failed', failure: { kind: 'error', detail: 'extraction unavailable', phase: 'extract' } });
    }
    phase({ phase: 'extract', status: 'done', meta: { count: extraction.value.memories.length } });

    // PHASE 3 — PERSIST (per-item; streams done/total as each extracted memory resolves).
    const total = extraction.value.memories.length;
    phase({ phase: 'persist', status: 'active', meta: { done: 0, total } });
    const extracted: ConsolidationExtractedMemory[] = [];
    for (const memory of extraction.value.memories) {
      try {
        const outcome = await persistExtracted(ctx, memory);
        extracted.push({ kind: memory.kind, scope: memory.scope, content: memory.content, outcome });
      } catch (err) {
        extracted.push({ kind: memory.kind, scope: memory.scope, content: memory.content, outcome: 'invalid' });
        log('[MemoryConsolidation] failed to persist one extracted memory; continuing batch: %O', err);
      }
      phase({ phase: 'persist', status: 'active', meta: { done: extracted.length, total } });
    }
    phase({ phase: 'persist', status: 'done', meta: { done: extracted.length, total } });

    await commitCandidates(ctx, claimedIds);

    // PHASE 4 — MAINTAIN (pure SQL: promote episodes + decay sweep + prune consumed candidates).
    maintenance = await runMaintenancePhase(ctx, phase);

    // PHASE 5 — PROFILES (2 LLM calls). A failure here does NOT downgrade the pass: the extracted
    // memories are already persisted, so the terminal status stays `extracted` with a failed row.
    phase({ phase: 'profiles', status: 'active', meta: { total: 2 } });
    try {
      await updateProfiles(ctx);
      phase({ phase: 'profiles', status: 'done', meta: { done: 2, total: 2 } });
    } catch (err) {
      phase({ phase: 'profiles', status: 'failed', meta: { reason: errorDetail(err) } });
      log('[MemoryConsolidation] profile regeneration failed (memories already persisted): %O', err);
    }

    return done({ status: extracted.length > 0 ? 'extracted' : 'empty', extracted });
  } catch (err) {
    // Catch-all: the function is total even from the top-level guard. A thrown error becomes a
    // terminal `failed` result instead of escaping and crashing the extension host.
    log('[MemoryConsolidation] pass failed (reason=%s): %O', ctx.reason, err);
    return done({ status: 'failed', failure: { kind: 'error', detail: errorDetail(err) } });
  }
}

/** Runs maintenance and emits its active/done phase events with a human-readable count summary. */
async function runMaintenancePhase(
  ctx: ConsolidationCtx,
  phase: (event: ConsolidationPhaseEvent) => void,
): Promise<{ promoted: number; decayed: number; pruned: number }> {
  phase({ phase: 'maintain', status: 'active' });
  const counts = await runMaintenance(ctx);
  phase({
    phase: 'maintain',
    status: 'done',
    meta: {
      summary: `${counts.promoted} promoted · ${counts.decayed} decayed · ${counts.pruned} pruned`,
    },
  });
  return counts;
}
