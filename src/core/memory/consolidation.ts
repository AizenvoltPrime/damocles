import { log } from '../logger';
import { buildFtsMatchQuery } from './text-tokenize';
import { USEFULNESS_RUBRIC } from './rubric';
import { listKnownWorkspaces, matchKnownWorkspace, sameWorkspace, workspaceContaining } from './workspaces';
import { estimateTokens } from './token-estimate';
import type { MemoryKind, MemoryScope } from '@shared/types/memory';
import type {
  ConsolidationPersistOutcome,
  ConsolidationExtractedMemory,
  ConsolidationResult,
  ConsolidationTrigger,
  ConsolidationPhaseEvent,
  ConsolidationFailure,
} from '@shared/types/consolidation';
import { MAX_FAILED_ANSWERS } from '@shared/consolidation';
import type { DatabaseInstance, MemoryRow } from './types';
import type { MemoryWriteQueue } from './write-queue';
import type { MemorySubCallRunner, MemorySubCallResult } from './subcall-runner';
import type { FactGraphManager } from './managers/fact-graph-manager';
import type { ProfileManager } from './managers/profile-manager';
import type { SettingsStore } from '../../platform/settings-store';
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
  /** Set on a later pass of a run: the turns that run already declined (see {@link ConsolidationCtx.declinedInRun}). */
  declinedInRun?: Set<string>;
  /** Set on a later pass of a manual run: the run's result over its earlier passes, folded with each pass's own. */
  runSoFar?: ConsolidationResult;
}

/**
 * Folds a mid-pass request into the single pending slot. Two requests targeting different sessions
 * broaden to a global `idle` pass (which claims all unconsumed candidates). `forceExtract` is OR-ed
 * so a manual "Run now" folded into an auto pass still forces extraction even with auto-extract off.
 * The declined turns are united, so a pass serving a run's later pass never counts a turn that run counted.
 */
export function mergePendingConsolidation(
  existing: PendingConsolidationRequest | null,
  incoming: PendingConsolidationRequest,
): PendingConsolidationRequest {
  const forceExtract = (existing?.forceExtract ?? false) || (incoming.forceExtract ?? false);
  const force = forceExtract ? { forceExtract: true } : {};
  if (!existing) return { ...incoming, ...force };
  const declined = existing.declinedInRun || incoming.declinedInRun
    ? { declinedInRun: new Set([...(existing.declinedInRun ?? []), ...(incoming.declinedInRun ?? [])]) }
    : {};
  // Only the pass that just ended queues a run's next pass, so at most one side carries a result so far.
  const runSoFar = incoming.runSoFar ?? existing.runSoFar;
  const run = runSoFar ? { runSoFar } : {};
  if (existing.sessionId === incoming.sessionId) return { ...existing, ...force, ...declined, ...run };
  return { reason: 'idle', ...force, ...declined, ...run };
}

/**
 * Folds one pass into its run's result: memories and counts add up, the run ends when its last pass
 * ends, and it fails with the last pass's failure, since a run only continues after a pass that did not fail.
 */
export function accumulateRunResult(soFar: ConsolidationResult | undefined, pass: ConsolidationResult): ConsolidationResult {
  if (!soFar) return pass;
  const extracted = [...soFar.extracted, ...pass.extracted];
  const status = pass.status === 'failed' ? 'failed' : extracted.length > 0 ? 'extracted' : 'empty';
  return {
    ranAt: pass.ranAt,
    trigger: soFar.trigger,
    status,
    extracted,
    maintenance: {
      promoted: soFar.maintenance.promoted + pass.maintenance.promoted,
      decayed: soFar.maintenance.decayed + pass.maintenance.decayed,
      pruned: soFar.maintenance.pruned + pass.maintenance.pruned,
    },
    candidatesReviewed: soFar.candidatesReviewed + pass.candidatesReviewed,
    ...(pass.failure ? { failure: pass.failure } : {}),
  };
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
  settings: SettingsStore;
  factGraph: FactGraphManager;
  profileManager: ProfileManager;
  reason: ConsolidationReason;
  sessionId?: string;
  /** Folder for legacy candidates stored without one: the consolidating window's default folder. */
  fallbackWorkspace: () => string;
  /** The window's open folders; with the stored workspaces they bound where an extraction may be filed. */
  openFolders: () => readonly string[];
  /** Folders that are never a project, such as the home-directory bucket of a window with no folder open. */
  nonProjectFolders: () => readonly string[];
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
  /** Picks the extraction probe turn; defaults to `Math.random`. */
  random?: () => number;
  /**
   * Turns declined on their own call by an earlier pass of the same run (a manual Run now and the passes it
   * queues, or one automatic run). The claim skips them and the pass adds the ones it declines, so a run
   * counts a turn's failed answer at most once.
   */
  declinedInRun?: Set<string>;
}

/**
 * A pass's context once its batch is claimed: `workspace` is the folder every claimed turn ran in,
 * `knownWorkspaces` the folders an extraction may name (starting with `workspace`).
 */
interface ClaimedPassCtx extends ConsolidationCtx {
  workspace: string;
  knownWorkspaces: string[];
}

/** A candidate claimed for this consolidation pass. */
interface ClaimedCandidate {
  id: string;
  userText: string;
  assistantText: string;
  /** The session that produced this turn, or null for a sessionless capture. */
  sessionId: string | null;
  /** Files the turn's tool calls touched. */
  files: string[];
}

interface ClaimedRow {
  id: string;
  user_text: string;
  assistant_text: string;
  session_id: string | null;
  files: string;
}

function parseFiles(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
}

/** One memory the extractor asked to durably store. */
export interface ExtractedMemory {
  kind: string;
  content: string;
  scope: string;
  /** For a project item about another known repository: that repository's workspace. Null means not set. */
  workspace?: string | null;
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
        typeof (m as { scope?: unknown }).scope === 'string' &&
        ((m as { workspace?: unknown }).workspace == null || typeof (m as { workspace?: unknown }).workspace === 'string'),
    )
  );
}

const CANDIDATE_BATCH_LIMIT = 50;

/** Enough extraction calls in one pass to isolate one failing turn from a full batch by halving. */
export const MAX_EXTRACT_CALLS_PER_PASS: number = 2 * Math.ceil(Math.log2(CANDIDATE_BATCH_LIMIT)) + 1;

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

export const EXTRACTION_SYSTEM_PROMPT: string = `Extract memories from this conversation that a future agent needs. Most conversations contain none: an empty memories array is the normal answer.

${USEFULNESS_RUBRIC}

Fields:
- kind: 'fact'|'preference'|'episode'. Use 'episode' for time-bound context such as the current focus.
- scope: 'project' for one repository, 'global' for the machine or the user across projects, 'session' for this conversation only.
- workspace: only for a project item about a repository other than the conversation workspace. Name it exactly as listed under "Known workspaces", and use each turn's files to tell which repository a fact is about. Omit it for the conversation workspace.
- content: one self-contained statement with its reason, readable without the conversation.

You are given the memories ALREADY stored. Do NOT re-extract anything already captured there, even if reworded. Only emit a memory if it is genuinely NEW, or if it UPDATES/CONTRADICTS an existing one (in which case state the corrected fact).
Only extract facts the user stated or confirmed, or that were verified in tool output, never speculation.
Return at most 10 memories.`;

/** Cap on existing memories primed into the extraction prompt to suppress duplicates. */
const EXISTING_MEMORY_LIMIT = 40;

/** The `extract` schema. `workspace` is an enum of the pass's known workspaces, so the model cannot invent a path. */
export function buildExtractionSchema(knownWorkspaces: readonly string[]): Record<string, unknown> {
  return {
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
            workspace: { enum: [...knownWorkspaces] },
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
}

/**
 * Atomically reserves the oldest unconsumed candidates that fit within {@link CANDIDATE_TOKEN_BUDGET}
 * (select-then-update in one write-lock callback so two passes never double-claim a row). Always
 * claims at least one turn so an oversized turn can't stall the queue (clipped at prompt-build time).
 * Scopes to one session when `sessionId` is supplied and skips the run's declined turns. A successful pass
 * commits the reservation; a failure releases it — so `consumed = 1` means "in-flight or done", never "lost".
 *
 * A batch holds one folder's turns only, the folder of the oldest unconsumed candidate, so the pass
 * files every extraction under the folder its conversation ran in. Other folders wait for a later pass.
 */
function claimCandidates(ctx: ConsolidationCtx): Promise<{ candidates: ClaimedCandidate[]; workspace: string | null }> {
  return ctx.writeQueue.run(() => {
    const declined = ctx.declinedInRun && ctx.declinedInRun.size > 0 ? [...ctx.declinedInRun] : null;
    const claimable = declined
      ? 'consumed = 0 AND set_aside_at IS NULL AND id NOT IN (SELECT value FROM json_each(?))'
      : 'consumed = 0 AND set_aside_at IS NULL';
    const sessionWhere = ctx.sessionId !== undefined ? `${claimable} AND session_id = ?` : claimable;
    const sessionParams: unknown[] = [
      ...(declined ? [JSON.stringify(declined)] : []),
      ...(ctx.sessionId !== undefined ? [ctx.sessionId] : []),
    ];

    const head = ctx.db
      .prepare(`SELECT workspace FROM memory_candidates WHERE ${sessionWhere} ORDER BY created_at LIMIT 1`)
      .get(...sessionParams) as { workspace: string | null } | undefined;
    if (!head) return { candidates: [], workspace: null };

    const rows = ctx.db
      .prepare(
        `SELECT id, user_text, assistant_text, session_id, files FROM memory_candidates
          WHERE ${sessionWhere} AND workspace IS ? ORDER BY created_at LIMIT ?`,
      )
      .all(...sessionParams, head.workspace, CANDIDATE_BATCH_LIMIT) as ClaimedRow[];

    if (rows.length === 0) return { candidates: [], workspace: null };

    const claimed: ClaimedCandidate[] = [];
    let tokens = 0;
    for (const r of rows) {
      const cost = estimateTokens(r.user_text) + estimateTokens(r.assistant_text);
      if (claimed.length > 0 && tokens + cost > CANDIDATE_TOKEN_BUDGET) break;
      claimed.push({
        id: r.id,
        userText: r.user_text,
        assistantText: r.assistant_text,
        sessionId: r.session_id,
        files: parseFiles(r.files),
      });
      tokens += cost;
    }

    const ids = claimed.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    // Stamp the lease in the same transaction as the reservation so claim and ownership can't diverge.
    ctx.db
      .prepare(`UPDATE memory_candidates SET consumed = 1, claimed_by = ?, claimed_at = ? WHERE id IN (${placeholders})`)
      .run(ctx.instanceId, Date.now(), ...ids);

    return { candidates: claimed, workspace: head.workspace ?? ctx.fallbackWorkspace() };
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

/**
 * Settles a turn declined on its own call: it gains one failed answer when the model answered other input
 * this pass or the turn already holds one, and is set aside at {@link MAX_FAILED_ANSWERS}, else released.
 * True when set aside. Called at most once per turn per run (see {@link ConsolidationCtx.declinedInRun}).
 */
function settleDeclinedTurn(ctx: ConsolidationCtx, id: string, modelAnswered: boolean): Promise<boolean> {
  return ctx.writeQueue.run(() => {
    ctx.db
      .prepare('UPDATE memory_candidates SET failed_attempts = failed_attempts + 1 WHERE id = ? AND (? = 1 OR failed_attempts > 0)')
      .run(id, modelAnswered ? 1 : 0);
    const setAside = ctx.db
      .prepare(
        `UPDATE memory_candidates SET consumed = 0, claimed_by = NULL, claimed_at = NULL, set_aside_at = ?
          WHERE id = ? AND failed_attempts >= ?`,
      )
      .run(Date.now(), id, MAX_FAILED_ANSWERS);
    if (Number(setAside.changes) > 0) return true;
    ctx.db
      .prepare('UPDATE memory_candidates SET consumed = 0, claimed_by = NULL, claimed_at = NULL WHERE id = ?')
      .run(id);
    return false;
  });
}

/** Turns set aside after {@link MAX_FAILED_ANSWERS} failed answers, waiting for the user's Retry. */
export function countSetAsideCandidates(db: DatabaseInstance): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM memory_candidates WHERE set_aside_at IS NOT NULL').get() as { n: number };
  return row.n;
}

/** Returns every set-aside turn to the queue with a fresh attempt count. Resolves to how many were returned. */
export function retrySetAsideCandidates(db: DatabaseInstance, writeQueue: MemoryWriteQueue): Promise<number> {
  return writeQueue.run(() => {
    const result = db
      .prepare('UPDATE memory_candidates SET set_aside_at = NULL, failed_attempts = 0 WHERE set_aside_at IS NOT NULL')
      .run();
    return Number(result.changes);
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
function loadExistingMemoriesForExtraction(ctx: ClaimedPassCtx, candidates: ClaimedCandidate[]): string[] {
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

function buildExtractionPrompt(pass: ClaimedPassCtx, candidates: ClaimedCandidate[], existing: string[]): string {
  const turns = candidates
    .map((c, index) => {
      const user = clipTurnText(c.userText.trim()) || '(empty)';
      const assistant = clipTurnText(c.assistantText.trim()) || '(empty)';
      const files = c.files.length > 0 ? `\nFiles: ${c.files.join(', ')}` : '';
      return `Turn ${index + 1}:${files}\nUser: ${user}\nAssistant: ${assistant}`;
    })
    .join('\n\n');

  const header =
    `Conversation workspace: ${pass.workspace}\n` +
    `Known workspaces:\n${pass.knownWorkspaces.map(w => `- ${w}`).join('\n')}`;
  const stored = existing.length > 0
    ? `\n\nAlready-stored memories (do NOT re-extract these):\n${existing.map(c => `- ${c}`).join('\n')}`
    : '';
  return `${header}${stored}\n\nConversation:\n${turns}`;
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
function toNewMemoryFields(
  memory: ExtractedMemory,
  pass: Pick<ClaimedPassCtx, 'workspace' | 'knownWorkspaces'>,
  sessionId: string | null,
): NewMemoryFields | null {
  if (memory.kind === 'observation') return null;
  if (!VALID_KINDS.has(memory.kind as MemoryKind)) return null;
  if (!VALID_SCOPES.has(memory.scope as MemoryScope)) return null;
  const content = memory.content.trim();
  if (!content) return null;

  const kind = memory.kind as MemoryKind;
  const scope = memory.scope as MemoryScope;

  if (scope === 'session' && !sessionId) return null;

  let workspace = pass.workspace;
  if (scope === 'project' && memory.workspace != null) {
    const named = matchKnownWorkspace(memory.workspace, pass.knownWorkspaces);
    if (!named) return null;
    workspace = named;
  }

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
async function persistExtracted(ctx: ClaimedPassCtx, fields: NewMemoryFields): Promise<ConsolidationPersistOutcome> {
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
  const dups = findNearDuplicates(ctx.db, row, getDedupThreshold(ctx.settings));
  if (dups.length > 0) {
    const result = await mergeNearDuplicates(ctx.db, ctx.writeQueue, ctx.runner, row, dups);
    merged = result.merged > 0;
  }

  return merged ? 'merged' : superseded ? 'superseded' : 'inserted';
}

/** The overlay row for an extracted item; `workspace` is set only when it was filed under a folder other than the pass's. */
function extractedDisplay(
  pass: ClaimedPassCtx,
  memory: ExtractedMemory,
  fields: NewMemoryFields | null,
): Omit<ConsolidationExtractedMemory, 'outcome'> {
  const base = { kind: memory.kind, scope: memory.scope, content: memory.content };
  return fields?.workspace && !sameWorkspace(fields.workspace, pass.workspace) ? { ...base, workspace: fields.workspace } : base;
}

/**
 * The folders an extraction may be filed under: the conversation workspace, the open folders, and the
 * known workspaces holding a file a claimed turn touched. A wider list lets the model file a fact under
 * a repository the turns never touched.
 */
function extractionWorkspaces(ctx: ConsolidationCtx, workspace: string, candidates: readonly ClaimedCandidate[]): string[] {
  const open = ctx.openFolders();
  const files = candidates.flatMap(c => c.files);
  const offered = listKnownWorkspaces(ctx.db, open, ctx.nonProjectFolders()).filter(
    w => matchKnownWorkspace(w, open) !== null || files.some(f => workspaceContaining(f, [w]) !== null),
  );
  return [workspace, ...offered.filter(w => !sameWorkspace(w, workspace))];
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

async function updateProfiles(ctx: ClaimedPassCtx): Promise<void> {
  await ctx.profileManager.updateProfile('project', ctx.workspace);
  await ctx.profileManager.updateProfile('global', '');
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Part of the claimed batch the model answered for, persisted once the pass's extraction calls end. */
interface AnsweredBatch {
  pass: ClaimedPassCtx;
  candidates: ClaimedCandidate[];
  memories: ExtractedMemory[];
}

/** Why a call declined its turns: no valid result, a provider rejection of the request, or a hostile shape. */
type DeclineCause = 'unanswered' | 'rejected' | 'invalid-shape';

/** Why some claimed turns got no answer: a call that threw, no model, a refused credential, no reply, or a decline. */
type ExtractFailure =
  | { kind: 'thrown'; detail: string }
  | { kind: 'no-model' }
  | { kind: 'credential' }
  | { kind: 'unreachable' }
  | { kind: 'declined'; cause: DeclineCause };

interface ExtractRound {
  answered: AnsweredBatch[];
  failure: ExtractFailure | null;
}

/** A part of the batch waiting for its call. The two halves of one split share `split`. */
interface QueuedPart {
  batch: ClaimedCandidate[];
  split?: { declined: number };
  probe?: true;
}

/**
 * Extracts the claimed batch within {@link MAX_EXTRACT_CALLS_PER_PASS} calls. The decision rule, also in
 * "Memory consolidation" in docs/invariants.md:
 * - A declined part (`unanswered`, `rejected` or an invalid shape) of more than one turn is retried as two
 *   halves, and both halves of a split are sent before either is split again.
 * - Once both halves of a split decline and no call of the pass was answered, one queued turn picked at
 *   random is sent alone as a probe; if it declines too the failure is systemic and the pass stops.
 * - Only a turn declined on its own call is counted, once per run, at the end of the pass, and only when a
 *   call was answered this pass or the turn already holds a count. A run is a manual Run now with the passes
 *   it queues, or one automatic run; a later pass of the run never claims a turn the run declined. At
 *   {@link MAX_FAILED_ANSWERS}, so after three separate runs, it is set aside.
 * - No model, a refused credential, no reply or a throw releases every unsettled turn uncounted and stops.
 * `open` holds the claimed turns not yet released or set aside; this removes the ones it settles.
 */
async function extractInHalves(
  ctx: ConsolidationCtx,
  workspace: string,
  candidates: ClaimedCandidate[],
  open: Set<string>,
  onProgress: (settledTurns: number) => void,
): Promise<ExtractRound> {
  const round: ExtractRound = { answered: [], failure: null };
  const declinedAlone: ClaimedCandidate[] = [];
  const queue: QueuedPart[] = [{ batch: candidates }];
  let settled = 0;
  const release = async (parts: QueuedPart[]): Promise<void> => {
    const ids = parts.flatMap(p => p.batch).map(c => c.id);
    await releaseCandidates(ctx, ids);
    for (const id of ids) open.delete(id);
    settled += ids.length;
  };

  for (let calls = 0; queue.length > 0; calls++) {
    if (calls >= MAX_EXTRACT_CALLS_PER_PASS) {
      log('[MemoryConsolidation] extraction call limit reached; released %d turn(s) for the next pass', queue.flatMap(p => p.batch).length);
      await release(queue.splice(0));
      break;
    }
    const part = queue.shift()!;
    const batch = part.batch;
    const pass: ClaimedPassCtx = { ...ctx, workspace, knownWorkspaces: extractionWorkspaces(ctx, workspace, batch) };
    const prompt = buildExtractionPrompt(pass, batch, loadExistingMemoriesForExtraction(pass, batch));
    let extraction: MemorySubCallResult<ExtractionResult>;
    try {
      extraction = await ctx.runner.run<ExtractionResult>({
        purpose: 'extract',
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        prompt,
        schema: buildExtractionSchema(pass.knownWorkspaces),
      });
    } catch (err) {
      log('[MemoryConsolidation] extraction threw; releasing %d turn(s): %O', open.size, err);
      round.failure = { kind: 'thrown', detail: errorDetail(err) };
      await release([part, ...queue.splice(0)]);
      break;
    }
    // Keep the lease fresh across a pass of several extraction calls.
    await renewClaims(ctx, [...open]);

    if (extraction.value !== null && isExtractionResult(extraction.value)) {
      round.answered.push({ pass, candidates: batch, memories: extraction.value.memories });
      settled += batch.length;
      onProgress(settled);
      continue;
    }
    if (extraction.value === null && extraction.failure !== 'unanswered' && extraction.failure !== 'rejected') {
      round.failure = extraction.failure === 'no-model' || extraction.failure === 'credential' ? { kind: extraction.failure } : { kind: 'unreachable' };
      await release([part, ...queue.splice(0)]);
      break;
    }

    const cause: DeclineCause = extraction.value !== null ? 'invalid-shape' : extraction.failure === 'rejected' ? 'rejected' : 'unanswered';
    if (cause === 'invalid-shape') log('[MemoryConsolidation] extraction returned an invalid shape for %d turn(s)', batch.length);
    round.failure ??= { kind: 'declined', cause };
    if (batch.length === 1) {
      declinedAlone.push(batch[0]!);
      settled += 1;
    } else {
      const middle = Math.ceil(batch.length / 2);
      const split = { declined: 0 };
      queue.push({ batch: batch.slice(0, middle), split }, { batch: batch.slice(middle), split });
    }
    onProgress(settled);

    if (part.probe) {
      log('[MemoryConsolidation] the probe declined too; releasing %d turn(s) uncounted', queue.flatMap(p => p.batch).length);
      await release(queue.splice(0));
      break;
    }
    if (part.split && ++part.split.declined === 2 && round.answered.length === 0) {
      const probe = pickProbe(queue, ctx.random ?? Math.random);
      if (!probe) {
        log('[MemoryConsolidation] both halves declined with nothing answered; stopping the split');
        break;
      }
      for (const queued of queue) queued.batch = queued.batch.filter(c => c !== probe);
      queue.splice(0, queue.length, { batch: [probe], probe: true }, ...queue.filter(q => q.batch.length > 0));
    }
  }

  const modelAnswered = round.answered.length > 0;
  for (const turn of declinedAlone) {
    ctx.declinedInRun?.add(turn.id);
    if (await settleDeclinedTurn(ctx, turn.id, modelAnswered)) {
      log('[MemoryConsolidation] set aside turn %s after %d failed answers', turn.id, MAX_FAILED_ANSWERS);
    }
    open.delete(turn.id);
  }
  return round;
}

/** A queued turn picked by `random`, to be sent alone; null when the queue is empty. */
function pickProbe(queue: readonly QueuedPart[], random: () => number): ClaimedCandidate | null {
  const turns = queue.flatMap(p => p.batch);
  if (turns.length === 0) return null;
  return turns[Math.min(turns.length - 1, Math.floor(random() * turns.length))]!;
}

/** The failure card for a pass in which the model answered for none of the claimed turns. */
function extractFailureOf(failure: ExtractFailure | null): ConsolidationFailure {
  if (failure?.kind === 'no-model') return { kind: 'no-model', phase: 'extract' };
  if (failure?.kind === 'thrown') return { kind: 'error', detail: failure.detail, phase: 'extract' };
  const reason = failure?.kind === 'declined' ? failure.cause : failure?.kind === 'credential' ? 'credential' : 'unreachable';
  return { kind: 'error', reason, phase: 'extract' };
}

/** The extract phase's failure reason for the stepper: a token the panel localizes, or a thrown error's text. */
function extractFailureReason(failure: ExtractFailure | null): string {
  if (failure?.kind === 'thrown') return failure.detail;
  if (failure?.kind === 'declined') return failure.cause;
  return failure?.kind ?? 'unreachable';
}

/**
 * Batch memory consolidation. Claims unconsumed candidates under the write lock, extracts durable
 * memories via privacy-gated `extract` sub-calls (outside the lock; see {@link extractInHalves}), runs each through
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

  // Claimed turns not yet committed, released or set aside. The outer catch releases them, so a throw
  // anywhere after the claim never strands a turn at consumed=1 and never reverts a committed one.
  const open = new Set<string>();

  try {
    // PHASE 1 — CLAIM. Reclaim expired/stranded claims first so a crashed sibling's batch re-enters
    // and can be claimed in this same pass, while a fresh live claim stays protected by its lease.
    await reclaimExpiredClaims(ctx);

    let candidates: ClaimedCandidate[] = [];
    let workspace: string | null = null;
    if (ctx.autoExtractEnabled) {
      ({ candidates, workspace } = await claimCandidates(ctx));
    }
    candidatesReviewed = candidates.length;
    phase({ phase: 'claim', status: 'done', meta: { count: candidatesReviewed } });

    // Nothing to extract: auto-extract off, or an empty queue. Run maintenance only, end `empty`.
    if (!ctx.autoExtractEnabled || candidates.length === 0 || workspace === null) {
      const reason = !ctx.autoExtractEnabled ? 'auto-extract-off' : 'no-queued-turns';
      phase({ phase: 'extract', status: 'skipped', meta: { reason } });
      phase({ phase: 'persist', status: 'skipped', meta: { reason } });
      maintenance = await runMaintenancePhase(ctx, phase);
      phase({ phase: 'profiles', status: 'skipped', meta: { reason } });
      return done({ status: 'empty' });
    }

    for (const c of candidates) open.add(c.id);

    // PHASE 2 — EXTRACT (one LLM call per part of the batch; the slow step, ~5–20s each).
    const extractProgress = (done: number): void =>
      phase({ phase: 'extract', status: 'active', meta: { count: candidatesReviewed, done, total: candidatesReviewed } });
    extractProgress(0);
    const round = await extractInHalves(ctx, workspace, candidates, open, extractProgress);
    if (round.failure?.kind === 'no-model') ctx.onNoModel();

    if (round.answered.length === 0) {
      // Every claimed turn is released or set aside; still run maintenance (pure SQL) so an extraction
      // failure doesn't strand maintainable episodes.
      phase({ phase: 'extract', status: 'failed', meta: { reason: extractFailureReason(round.failure) } });
      phase({ phase: 'persist', status: 'skipped' });
      maintenance = await runMaintenancePhase(ctx, phase);
      phase({ phase: 'profiles', status: 'skipped' });
      // Failed even when a turn was set aside, so a systemic failure backs off instead of re-running.
      return done({ status: 'failed', failure: extractFailureOf(round.failure) });
    }
    const total = round.answered.reduce((n, batch) => n + batch.memories.length, 0);
    phase({ phase: 'extract', status: 'done', meta: { count: total } });

    // PHASE 3 — PERSIST (per-item; streams done/total as each extracted memory resolves). Each
    // answered part commits once its memories are persisted.
    phase({ phase: 'persist', status: 'active', meta: { done: 0, total } });
    const extracted: ConsolidationExtractedMemory[] = [];
    for (const batch of round.answered) {
      const sessionId = ctx.sessionId ?? uniqueNonNullSession(batch.candidates);
      for (const memory of batch.memories) {
        const fields = toNewMemoryFields(memory, batch.pass, sessionId);
        try {
          const outcome = fields ? await persistExtracted(batch.pass, fields) : 'invalid';
          extracted.push({ ...extractedDisplay(batch.pass, memory, fields), outcome });
        } catch (err) {
          extracted.push({ ...extractedDisplay(batch.pass, memory, fields), outcome: 'invalid' });
          log('[MemoryConsolidation] failed to persist one extracted memory; continuing batch: %O', err);
        }
        // Keep the lease fresh so a long per-item persist can't outlive the TTL and get double-extracted.
        await renewClaims(ctx, [...open]);
        phase({ phase: 'persist', status: 'active', meta: { done: extracted.length, total } });
      }
      const ids = batch.candidates.map(c => c.id);
      await commitCandidates(ctx, ids);
      for (const id of ids) open.delete(id);
    }
    phase({ phase: 'persist', status: 'done', meta: { done: extracted.length, total } });

    // PHASE 4 — MAINTAIN (pure SQL).
    maintenance = await runMaintenancePhase(ctx, phase);

    // PHASE 5 — PROFILES (2 LLM calls). A failure here doesn't downgrade the pass — the memories are
    // already persisted, so the status stays `extracted`.
    phase({ phase: 'profiles', status: 'active', meta: { total: 2 } });
    try {
      await updateProfiles(round.answered[0]!.pass);
      phase({ phase: 'profiles', status: 'done', meta: { done: 2, total: 2 } });
    } catch (err) {
      phase({ phase: 'profiles', status: 'failed', meta: { reason: errorDetail(err) } });
      log('[MemoryConsolidation] profile regeneration failed (memories already persisted): %O', err);
    }

    return done({ status: extracted.length > 0 ? 'extracted' : 'empty', extracted });
  } catch (err) {
    // Catch-all keeps the function total: a throw becomes a terminal `failed` result rather than
    // crashing the host. Release the claimed turns still open first; the release is wrapped so its own
    // failure can't mask the original error.
    if (open.size > 0) {
      try {
        await releaseCandidates(ctx, [...open]);
        log('[MemoryConsolidation] outer catch released %d uncommitted candidate(s)', open.size);
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
