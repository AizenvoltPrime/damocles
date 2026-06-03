import { log } from '../logger';
import type { MemoryKind, MemoryScope } from '@shared/types/memory';
import type { ConsolidationPersistOutcome, ConsolidationExtractedMemory } from '@shared/types/consolidation';
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
  /** Invoked once when the runner reports a persistent `no-model` failure (D8). */
  onNoModel: () => void;
  /** Optional sink for the consolidation panel: the memories this pass extracted + their outcomes. */
  onResult?: (extracted: ConsolidationExtractedMemory[]) => void;
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

/**
 * Batch memory consolidation (D2/D5/D6). Claims a batch of unconsumed candidates under the write
 * lock, extracts durable memories via one privacy-gated `extract` sub-call (OUTSIDE the lock), runs
 * each through dedup → conflict-resolution → near-dup merge, then promotes/decays episodes and
 * regenerates the user profile. When auto-extraction is disabled it still runs maintenance so a
 * setting flip mid-session cannot strand episodes. The whole body is guarded — consolidation must
 * never crash the extension.
 *
 * Relation hints emitted by the extractor are not wired in v1: `resolveConflict` already discovers
 * `UPDATES` lineage from content, and `enrich`/`markInferred` are left for a later story (US-009).
 */
export async function runConsolidation(ctx: ConsolidationCtx): Promise<void> {
  const report = ctx.onResult ?? (() => {});
  try {
    if (!ctx.autoExtractEnabled) {
      await runMaintenance(ctx);
      report([]);
      return;
    }

    const candidates = await claimCandidates(ctx);

    if (candidates.length === 0) {
      await runMaintenance(ctx);
      report([]);
      return;
    }

    const claimedIds = candidates.map(c => c.id);
    const existing = loadExistingMemoriesForExtraction(ctx);
    const prompt = buildExtractionPrompt(candidates, existing);

    let extraction: MemorySubCallResult<ExtractionResult>;
    try {
      extraction = await ctx.runner.run<ExtractionResult>({
        purpose: 'extract',
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        prompt,
        schema: EXTRACTION_SCHEMA,
      });
    } catch (err) {
      await releaseCandidates(ctx, claimedIds);
      log('[MemoryConsolidation] extraction threw; released %d candidates: %O', claimedIds.length, err);
      return;
    }

    if (extraction.value === null) {
      await releaseCandidates(ctx, claimedIds);
      if (extraction.failure === 'no-model') ctx.onNoModel();
      return;
    }

    const result: ConsolidationExtractedMemory[] = [];
    for (const memory of extraction.value.memories) {
      try {
        const outcome = await persistExtracted(ctx, memory);
        result.push({ kind: memory.kind, scope: memory.scope, content: memory.content, outcome });
      } catch (err) {
        result.push({ kind: memory.kind, scope: memory.scope, content: memory.content, outcome: 'invalid' });
        log('[MemoryConsolidation] failed to persist one extracted memory; continuing batch: %O', err);
      }
    }

    await commitCandidates(ctx, claimedIds);
    await runMaintenance(ctx);
    await updateProfiles(ctx);

    report(result);
  } catch (err) {
    log('[MemoryConsolidation] pass failed (reason=%s): %O', ctx.reason, err);
  }
}
