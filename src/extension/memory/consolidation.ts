import { log } from '../logger';
import { buildFtsMatchQuery } from './text-tokenize';
import { estimateTokens } from './token-estimate';
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
  purgeForgottenRows,
  maybeVacuum,
  getDedupThreshold,
  type NewMemoryFields,
} from './dedup-decay';

/** Why consolidation ran — drives candidate scoping and is purely diagnostic otherwise. */
export type ConsolidationReason = 'switch' | 'idle' | 'start' | 'manual';

export interface PendingConsolidationRequest {
  reason: ConsolidationReason;
  sessionId?: string;
  forceExtract?: boolean;
}

/**
 * Folds a mid-pass request into the single pending slot. Two requests targeting different sessions
 * broaden to a global `idle` pass (which claims all unconsumed candidates). `forceExtract` is OR-ed
 * so a manual "Run now" folded into an auto pass still forces extraction even with auto-extract off.
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
  /**
   * Stable per-process identity of the window running this pass (e.g. `${pid}-${uuid8}`). Stamped
   * onto claimed candidates as the lease holder so {@link reclaimExpiredClaims} can tell a claim held
   * live in ANOTHER window apart from one this window stranded — the root fix for cross-window double
   * extraction against the shared global DB.
   */
  instanceId: string;
  runner: MemorySubCallRunner;
  factGraph: FactGraphManager;
  profileManager: ProfileManager;
  reason: ConsolidationReason;
  sessionId?: string;
  workspace: string;
  /** When false, the pass runs maintenance but extracts nothing. */
  autoExtractEnabled: boolean;
  /** Whether this pass was user-initiated ('manual') or background ('auto'). */
  trigger: ConsolidationTrigger;
  /** Invoked once when the runner reports a persistent `no-model` failure. */
  onNoModel: () => void;
  /** Live-progress stream: fires `active` then `done|skipped|failed` per phase, in Claim→Extract→Persist→Maintain→Profiles order. */
  onPhase?: (event: ConsolidationPhaseEvent) => void;
  /**
   * Whether the owning service has disposed. When true the pass short-circuits before claiming, so a
   * pass scheduled just before disposal cannot claim a batch the service will never release.
   */
  isDisposed?: () => boolean;
}

/** A candidate claimed for this consolidation pass. */
interface ClaimedCandidate {
  id: string;
  userText: string;
  assistantText: string;
  /** The session that produced this turn, or null for a sessionless capture. */
  sessionId: string | null;
}

interface ClaimedRow {
  id: string;
  user_text: string;
  assistant_text: string;
  session_id: string | null;
}

/** One memory the extractor asked to durably store. */
export interface ExtractedMemory {
  kind: string;
  content: string;
  scope: string;
  tags?: string[];
  relation?: { type: 'updates' | 'extends' | 'derives'; targetHint?: string };
}

/** Shape the `extract` sub-call is expected to return; validated by {@link isExtractionResult}. */
export interface ExtractionResult {
  memories: ExtractedMemory[];
}

/**
 * Runtime shape guard for the `extract` result. The runner casts the model's raw JSON without
 * validating it, so a malformed shape would otherwise reach the persist loop and throw past the
 * release path, stranding the claimed batch. A false result routes the pass down the release-and-fail path.
 */
export function isExtractionResult(v: unknown): v is ExtractionResult {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as { memories?: unknown }).memories) &&
    (v as { memories: unknown[] }).memories.every(
      m =>
        !!m &&
        typeof m === 'object' &&
        typeof (m as { kind?: unknown }).kind === 'string' &&
        typeof (m as { content?: unknown }).content === 'string' &&
        typeof (m as { scope?: unknown }).scope === 'string',
    )
  );
}

const CANDIDATE_BATCH_LIMIT = 50;

/**
 * How long a candidate claim stays valid before {@link reclaimExpiredClaims} reclaims it. Sized well
 * above the longest honest pass so a live claim in another window is never stolen, while a
 * crash-stranded one re-enters within one lease window.
 */
export const LEASE_TTL_MS: number = 15 * 60 * 1000;

const CHARS_PER_TOKEN = 4;

/**
 * Token budget for the candidate-text portion of one extraction prompt. A pass claims turns
 * oldest-first only while they fit, so the built prompt can never exceed the model context; the rest
 * roll into the next pass.
 */
export const CANDIDATE_TOKEN_BUDGET = 100_000;

/** Per-turn cap so a single oversized turn (claimed alone for progress) can't overflow the budget. */
const MAX_TURN_CHARS = (CANDIDATE_TOKEN_BUDGET * CHARS_PER_TOKEN) / 2;

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

export const EXTRACTION_SYSTEM_PROMPT: string =
  'Extract durable, reusable memories from this conversation. Prefer few high-value items. ' +
  "kind: 'fact'|'preference'|'episode'. " +
  "scope: 'project' for workspace-specific, 'global' for cross-project user preferences, " +
  "'session' for ephemeral. Use 'episode' for time-bound 'currently working on X'. " +
  'You are given the memories ALREADY stored. Do NOT re-extract anything already captured there — ' +
  'even if reworded. Only emit a memory if it is genuinely NEW, or if it UPDATES/CONTRADICTS an ' +
  'existing one (in which case state the corrected fact). ' +
  'Only extract facts the user stated or confirmed, or that were verified in tool output — never speculation. ' +
  'Return at most 10 memories. Return [] if nothing new is durable.';

/** Cap on existing memories primed into the extraction prompt to suppress duplicates. */
const EXISTING_MEMORY_LIMIT = 40;

export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          kind: { enum: ['fact', 'preference', 'episode'] },
          content: { type: 'string' },
          scope: { enum: ['session', 'project', 'global'] },
          tags: { type: 'array', items: { type: 'string' } },
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
};

/**
 * Atomically reserves the oldest unconsumed candidates that fit within {@link CANDIDATE_TOKEN_BUDGET}
 * (select-then-update in one write-lock callback so two passes never double-claim a row). Always
 * claims at least one turn so an oversized turn can't stall the queue (clipped at prompt-build time).
 * Scopes to one session when `sessionId` is supplied. A successful pass commits the reservation; a
 * failure releases it — so `consumed = 1` means "in-flight or done", never "lost".
 */
function claimCandidates(ctx: ConsolidationCtx): Promise<ClaimedCandidate[]> {
  return ctx.writeQueue.run(() => {
    const where = ctx.sessionId !== undefined ? 'consumed = 0 AND session_id = ?' : 'consumed = 0';
    const selectParams: unknown[] = ctx.sessionId !== undefined ? [ctx.sessionId] : [];

    const rows = ctx.db
      .prepare(`SELECT id, user_text, assistant_text, session_id FROM memory_candidates WHERE ${where} ORDER BY created_at LIMIT ?`)
      .all(...selectParams, CANDIDATE_BATCH_LIMIT) as ClaimedRow[];

    if (rows.length === 0) return [];

    const claimed: ClaimedCandidate[] = [];
    let tokens = 0;
    for (const r of rows) {
      const cost = estimateTokens(r.user_text) + estimateTokens(r.assistant_text);
      if (claimed.length > 0 && tokens + cost > CANDIDATE_TOKEN_BUDGET) break;
      claimed.push({ id: r.id, userText: r.user_text, assistantText: r.assistant_text, sessionId: r.session_id });
      tokens += cost;
    }

    const ids = claimed.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    // Stamp the lease in the same transaction as the reservation so claim and ownership can't diverge.
    ctx.db
      .prepare(`UPDATE memory_candidates SET consumed = 1, claimed_by = ?, claimed_at = ? WHERE id IN (${placeholders})`)
      .run(ctx.instanceId, Date.now(), ...ids);

    return claimed;
  });
}

/**
 * Releases a reserved batch back to `consumed = 0` so a failed/uncommitted pass leaves the candidates
 * for the next pass. Runs in the write lock for the same single-claimer guarantee as {@link claimCandidates}.
 */
function releaseCandidates(ctx: ConsolidationCtx, ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return ctx.writeQueue.run(() => {
    const placeholders = ids.map(() => '?').join(',');
    // Clear the lease too so the released batch carries no stale owner.
    ctx.db
      .prepare(`UPDATE memory_candidates SET consumed = 0, claimed_by = NULL, claimed_at = NULL WHERE id IN (${placeholders})`)
      .run(...ids);
  });
}

/**
 * Reclaims stranded/expired claims (reset to `consumed = 0`, lease NULLed) while leaving fresh live
 * claims untouched. A row is reclaimable when claimed-but-uncommitted (`consumed = 1 AND
 * reprocessed = 0`) AND either has no lease stamp (a legacy/crash strand) or its stamp predates the
 * TTL cutoff. A claim within the TTL is never reclaimed, so a window mid-extraction keeps its batch.
 */
export function reclaimExpiredClaims(ctx: ConsolidationCtx): Promise<number> {
  return ctx.writeQueue.run(() => {
    const cutoff = Date.now() - LEASE_TTL_MS;
    const result = ctx.db
      .prepare(
        `UPDATE memory_candidates
            SET consumed = 0, claimed_by = NULL, claimed_at = NULL
          WHERE consumed = 1 AND reprocessed = 0
            AND (claimed_at IS NULL OR claimed_at < ?)`,
      )
      .run(cutoff);
    const reclaimed = Number(result.changes);
    if (reclaimed > 0) {
      log('[MemoryConsolidation] Reclaimed %d expired/stranded candidate claim(s)', reclaimed);
    }
    return reclaimed;
  });
}

/**
 * Refreshes the lease stamp on an in-flight batch so a persist loop that runs longer than
 * {@link LEASE_TTL_MS} (many extracted items, each with its own LLM conflict/merge calls) is not
 * reclaimed and double-extracted by a sibling window. Only touches still-uncommitted rows this
 * instance owns.
 */
function renewClaims(ctx: ConsolidationCtx, ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return ctx.writeQueue.run(() => {
    const placeholders = ids.map(() => '?').join(',');
    ctx.db
      .prepare(
        `UPDATE memory_candidates SET claimed_at = ?
          WHERE reprocessed = 0 AND claimed_by = ? AND id IN (${placeholders})`,
      )
      .run(Date.now(), ctx.instanceId, ...ids);
  });
}

/**
 * Commits a reserved batch (`reprocessed = 1`) ONLY after the extracted memories are persisted, so a
 * crash before this leaves the batch `reprocessed = 0` for reclaim to re-extract. Re-extraction never
 * loses a turn but is only best-effort idempotent (dedup + the extraction-aware prompt catch most
 * repeats; a reworded LLM re-run can slip past to a near-dup the merge pass later consolidates). True
 * persist+commit atomicity isn't achievable — persistence spans multiple write-lock turns with LLM
 * calls between them.
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

/** Tokens of batch text fed into the existing-memory MATCH — a query, not a document, so capped small. */
const EXISTING_MATCH_TOKEN_CAP = 20;

/**
 * Loads the live fact/preference/episode memories most likely to overlap with this pass's extraction
 * (project rows for the workspace + all global rows) so the extractor can skip already-known info —
 * catching reworded duplicates that lexical dedup can't. An FTS MATCH over the batch text finds
 * old-but-relevant rows a recency window would miss; it's UNIONed with a most-recent-N fallback,
 * deduped by content, and capped at {@link EXISTING_MEMORY_LIMIT}. Only an empty MATCH falls back to
 * recency; a real DB error propagates.
 */
function loadExistingMemoriesForExtraction(ctx: ConsolidationCtx, candidates: ClaimedCandidate[]): string[] {
  const recentQuery = `SELECT content FROM memories
        WHERE is_latest = 1 AND forgotten = 0
          AND kind IN ('fact', 'preference', 'episode')
          AND (scope = 'global' OR (scope = 'project' AND workspace IS ?))
        ORDER BY updated_at DESC
        LIMIT ?`;

  const loadRecentOnly = (): string[] =>
    (ctx.db.prepare(recentQuery).all(ctx.workspace, EXISTING_MEMORY_LIMIT) as Array<{ content: string }>).map(
      r => r.content,
    );

  const batchText = candidates.map(c => `${c.userText} ${c.assistantText}`).join(' ');
  const match = buildFtsMatchQuery(batchText, EXISTING_MATCH_TOKEN_CAP);
  if (!match) {
    // No salient tokens in the batch — fall back to the recency window.
    log('[MemoryConsolidation] existing-memory MATCH empty; using most-recent-%d fallback', EXISTING_MEMORY_LIMIT);
    return loadRecentOnly();
  }

  const rows = ctx.db
    .prepare(
      `SELECT content, MIN(ord) AS best FROM (
         SELECT m.content AS content, f.rank AS ord
           FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
          WHERE memories_fts MATCH ?
            AND m.is_latest = 1 AND m.forgotten = 0
            AND m.kind IN ('fact', 'preference', 'episode')
            AND (m.scope = 'global' OR (m.scope = 'project' AND m.workspace IS ?))
         UNION ALL
         SELECT content, 1e18 AS ord FROM memories
          WHERE is_latest = 1 AND forgotten = 0
            AND kind IN ('fact', 'preference', 'episode')
            AND (scope = 'global' OR (scope = 'project' AND workspace IS ?))
       )
       GROUP BY content
       ORDER BY best
       LIMIT ?`,
    )
    .all(match, ctx.workspace, ctx.workspace, EXISTING_MEMORY_LIMIT) as Array<{ content: string }>;

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

/**
 * The single session id shared by the entire batch, or null when it's empty, mixed, or has any
 * sessionless row. A sessionless pass uses this to stamp `scope:'session'` extractions; a null result
 * forces session-scope items to be rejected rather than inserted with a NULL `session_id`.
 */
function uniqueNonNullSession(candidates: ClaimedCandidate[]): string | null {
  const first = candidates[0]?.sessionId ?? null;
  if (first === null) return null;
  return candidates.every(c => c.sessionId === first) ? first : null;
}

/**
 * Maps an extracted memory to persist-pipeline fields, or null when rejected as invalid. Beyond
 * kind/scope/content validity, two hard rejections:
 *  - `kind==='observation'` — the extractor can't legitimately emit one (schema/prompt don't offer
 *    it), so it can only be a prose-JSON fallback smuggling one in; observations stay agent-authored.
 *  - `scope==='session'` with no resolvable `sessionId` — a NULL-session session row is invisible and
 *    undeletable, so reject rather than insert one.
 */
function toNewMemoryFields(memory: ExtractedMemory, workspace: string, sessionId: string | null): NewMemoryFields | null {
  if (memory.kind === 'observation') return null;
  if (!VALID_KINDS.has(memory.kind as MemoryKind)) return null;
  if (!VALID_SCOPES.has(memory.scope as MemoryScope)) return null;
  const content = memory.content.trim();
  if (!content) return null;

  const kind = memory.kind as MemoryKind;
  const scope = memory.scope as MemoryScope;

  if (scope === 'session' && !sessionId) return null;

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
 * Persists one extracted memory: exact-dedup insert, then (for fact/preference) LLM conflict
 * resolution before near-duplicate soft-merge. Steps are top-level awaits, never inside a write-lock
 * callback, because {@link FactGraphManager.resolveConflict} self-acquires the lock and would deadlock.
 */
async function persistExtracted(
  ctx: ConsolidationCtx,
  memory: ExtractedMemory,
  batchSessionId: string | null,
): Promise<ConsolidationPersistOutcome> {
  const sessionId = ctx.sessionId ?? batchSessionId;
  const fields = toNewMemoryFields(memory, ctx.workspace, sessionId);
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
  // Hard-purge long-decayed/merged rows (never user-forgotten) before VACUUM so freed pages land on
  // the free list for maybeVacuum to reclaim.
  await purgeForgottenRows(ctx.db, ctx.writeQueue);
  // Re-decide facts deferred by a judge outage so a transient outage never leaves contradicting facts
  // co-latest permanently.
  await ctx.factGraph.sweepConflictChecks();
  await maybeVacuum(ctx.db, ctx.writeQueue);
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
 * Batch memory consolidation. Claims unconsumed candidates under the write lock, extracts durable
 * memories via one privacy-gated `extract` sub-call (outside the lock), runs each through
 * dedup → conflict-resolution → near-dup merge, then promotes/decays episodes and regenerates the
 * profile. Runs maintenance even when auto-extraction is off so a mid-session setting flip can't
 * strand episodes.
 *
 * Total function: every path (including the outer catch) returns a terminal {@link ConsolidationResult},
 * so a pass can never end without a result the panel can render. Live progress flows through the
 * {@link ConsolidationCtx.onPhase} stream; the terminal outcome is the return value. Extractor
 * relation hints are not wired in v1 — `resolveConflict` already discovers `UPDATES` lineage.
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

  // A pass scheduled just before disposal must not claim a batch the disposed service will never
  // release. Short-circuit before reclaim/claim.
  if (ctx.isDisposed?.()) return done({ status: 'empty' });

  // Hoisted to the try scope so the outer catch can release a batch claimed but not yet committed: a
  // throw anywhere between claim and commit releases it instead of stranding it at consumed=1.
  let claimedIds: string[] | null = null;
  let committed = false;

  try {
    // PHASE 1 — CLAIM. Reclaim expired/stranded claims first so a crashed sibling's batch re-enters
    // and can be claimed in this same pass, while a fresh live claim stays protected by its lease.
    await reclaimExpiredClaims(ctx);

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

    claimedIds = candidates.map(c => c.id);
    const batchSessionId = uniqueNonNullSession(candidates);
    const existing = loadExistingMemoriesForExtraction(ctx, candidates);
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
      // Release the batch, but still run maintenance (pure SQL) so an extraction failure doesn't
      // strand maintainable episodes. End `failed` for the panel's failure card.
      await releaseCandidates(ctx, claimedIds);
      phase({ phase: 'extract', status: 'failed', meta: { reason: errorDetail(err) } });
      log('[MemoryConsolidation] extraction threw; released %d candidates: %O', claimedIds.length, err);
      phase({ phase: 'persist', status: 'skipped' });
      maintenance = await runMaintenancePhase(ctx, phase);
      phase({ phase: 'profiles', status: 'skipped' });
      return done({ status: 'failed', failure: { kind: 'error', detail: errorDetail(err), phase: 'extract' } });
    }

    if (extraction.value === null) {
      // `no-model` is its own failure-card kind (with a Sign-in action); every other null collapses
      // to `error` with a consistent detail.
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

    // Hostile-shape guard: a malformed extraction would otherwise reach the persist loop and throw
    // past the release path, stranding the batch. Route it down the same release-and-fail path.
    if (!isExtractionResult(extraction.value)) {
      await releaseCandidates(ctx, claimedIds);
      phase({ phase: 'extract', status: 'failed', meta: { reason: 'invalid-shape' } });
      log('[MemoryConsolidation] extraction returned an invalid shape; released %d candidates', claimedIds.length);
      phase({ phase: 'persist', status: 'skipped' });
      maintenance = await runMaintenancePhase(ctx, phase);
      phase({ phase: 'profiles', status: 'skipped' });
      return done({ status: 'failed', failure: { kind: 'error', detail: 'extraction returned an invalid shape', phase: 'extract' } });
    }
    phase({ phase: 'extract', status: 'done', meta: { count: extraction.value.memories.length } });

    // PHASE 3 — PERSIST (per-item; streams done/total as each extracted memory resolves).
    const total = extraction.value.memories.length;
    phase({ phase: 'persist', status: 'active', meta: { done: 0, total } });
    const extracted: ConsolidationExtractedMemory[] = [];
    for (const memory of extraction.value.memories) {
      try {
        const outcome = await persistExtracted(ctx, memory, batchSessionId);
        extracted.push({ kind: memory.kind, scope: memory.scope, content: memory.content, outcome });
      } catch (err) {
        extracted.push({ kind: memory.kind, scope: memory.scope, content: memory.content, outcome: 'invalid' });
        log('[MemoryConsolidation] failed to persist one extracted memory; continuing batch: %O', err);
      }
      // Keep the lease fresh so a long per-item persist can't outlive the TTL and get double-extracted.
      await renewClaims(ctx, claimedIds);
      phase({ phase: 'persist', status: 'active', meta: { done: extracted.length, total } });
    }
    phase({ phase: 'persist', status: 'done', meta: { done: extracted.length, total } });

    await commitCandidates(ctx, claimedIds);
    committed = true;

    // PHASE 4 — MAINTAIN (pure SQL).
    maintenance = await runMaintenancePhase(ctx, phase);

    // PHASE 5 — PROFILES (2 LLM calls). A failure here doesn't downgrade the pass — the memories are
    // already persisted, so the status stays `extracted`.
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
    // Catch-all keeps the function total: a throw becomes a terminal `failed` result rather than
    // crashing the host. If a batch was claimed but not committed, release it here first so an
    // uncommitted throw always releases (guarded so a post-commit throw never reverts a committed
    // batch); the release is wrapped so its own failure can't mask the original error.
    if (claimedIds && claimedIds.length > 0 && !committed) {
      try {
        await releaseCandidates(ctx, claimedIds);
        log('[MemoryConsolidation] outer catch released %d uncommitted candidate(s)', claimedIds.length);
      } catch (releaseErr) {
        log('[MemoryConsolidation] outer catch FAILED to release candidates (will re-enter via lease reclaim): %O', releaseErr);
      }
    }
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
