import * as vscode from 'vscode';
import type { MemoryEntry, MemoryScope } from '@shared/types/memory';
import type {
  MemoryInjectionDisplay,
  MemoryInjectionEntry,
  MemoryInjectionGroup,
  MemoryScoreBreakdown,
} from '@shared/types/context-injection';
import type { DatabaseInstance, FtsMatchRow, MemoryRow } from '../types';
import { rowToEntry } from '../types';
import { log } from '../../logger';
import { buildFtsMatchQuery } from '../text-tokenize';
import {
  openInjectionDatabase,
  insertMemoryInjection,
  getMemoryInjection as getPersistedMemoryInjection,
  deleteInjectionDatabaseFile,
  renameInjectionDatabaseFile,
  sweepStaleInjectionDatabases,
  injectionDbName,
} from '../injection-database';
import { estimateTokens, truncateToChars } from '../token-estimate';
import type { ProfileManager } from './profile-manager';
import type { MemorySubCallRunner } from '../subcall-runner';

interface CatalogLimits {
  session: number;
  project: number;
  global: number;
  observation: number;
  pinnedTokenBudget: number;
  tokenBudget: number;
}

type GroupLabel = 'session' | 'project' | 'global' | 'observations';

type RerankRelevance = 'high' | 'medium' | 'low';

const RELEVANCE_RANK: Record<RerankRelevance, number> = { high: 3, medium: 2, low: 1 };

/**
 * Ungraded rows sort at a neutral position (between medium and low) so a high-BM25 row the LLM
 * didn't grade keeps its standing instead of sinking below explicitly-low grades. Distinct from
 * {@link RELEVANCE_RANK}, which only dedups grades.
 */
const RERANK_SORT_WEIGHT: Record<RerankRelevance, number> = { high: 3, medium: 2, low: 0 };
const UNGRADED_SORT_WEIGHT = 1;
function rerankSortWeight(relevance: RerankRelevance | undefined): number {
  return relevance === undefined ? UNGRADED_SORT_WEIGHT : RERANK_SORT_WEIGHT[relevance];
}

interface InjectRerankResult {
  results: Array<{ id: string; relevance: RerankRelevance; reason?: string }>;
}

/** The runner's `T` is an unvalidated cast; a hallucinated shape would throw at `value.results`. */
function isInjectRerankResult(v: unknown): v is InjectRerankResult {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as { results?: unknown }).results) &&
    (v as { results: unknown[] }).results.every(
      (r) => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string',
    )
  );
}

const INJECT_RERANK_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          relevance: { enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
        },
        required: ['id', 'relevance'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const INJECT_RERANK_SYSTEM_PROMPT =
  'Grade how relevant each candidate memory is to the user query. ' +
  'Return every candidate id exactly once with a relevance of high, medium, or low ' +
  'and a brief reason. Judge by semantic relevance, not keyword overlap.';

function getConfig<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('damocles.memory').get<T>(key, fallback) ?? fallback;
}

function getCatalogLimits(): CatalogLimits {
  return {
    session: getConfig('catalogSessionLimit', 15),
    project: getConfig('catalogProjectLimit', 15),
    global: getConfig('catalogGlobalLimit', 10),
    observation: getConfig('catalogObservationLimit', 20),
    pinnedTokenBudget: getConfig('pinnedTokenBudget', 500),
    tokenBudget: getConfig('catalogTokenBudget', 2000),
  };
}

/** Graded file proximity. A field earns FULL credit (1) only with directory context (a
 * ≥2-trailing-segment suffix like `foo/bar.ts` or the full path); a bare-filename match earns
 * PARTIAL credit (0.4) since common leaf names like `index.ts` shouldn't score as a confident hit. */
const FILE_PROXIMITY_FULL = 1;
const FILE_PROXIMITY_PARTIAL = 0.4;

function computeFileProximity(memory: MemoryEntry, activeFile: string): number {
  const normalizedActive = activeFile.replace(/\\/g, '/').toLowerCase();
  const segments = normalizedActive.split('/').filter(Boolean);
  const fileName = segments[segments.length - 1] ?? '';
  if (!fileName) return 0;

  // ≥2-trailing-segment suffixes of the active path (includes the full path). Empty for a bare
  // filename with no directory context — such a file can only earn partial credit.
  const fullSuffixes: string[] = [];
  for (let start = 0; start <= segments.length - 2; start++) {
    fullSuffixes.push(segments.slice(start).join('/'));
  }

  const checkFields = [
    memory.content,
    ...(memory.filesRead ?? []),
    ...(memory.filesModified ?? []),
  ].map(field => field.replace(/\\/g, '/').toLowerCase());

  if (checkFields.some(field => fullSuffixes.some(suffix => field.includes(suffix)))) {
    return FILE_PROXIMITY_FULL;
  }
  if (checkFields.some(field => field.includes(fileName))) {
    return FILE_PROXIMITY_PARTIAL;
  }
  return 0;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RETRIEVAL_BOOST_DENOMINATOR = Math.log2(11);
const STALENESS_THRESHOLD = 3;
const CONTENT_TRUNCATION_LIMIT = 300;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RERANK_CANDIDATE_CAP = 30;

/**
 * Sentinel `workspace` bucket for global-scoped retrievals: global memories surface in every
 * workspace, so their counts are recorded here (not siloed by the active workspace) and unioned in
 * when scoring anywhere. Cannot collide with a real filesystem path.
 */
const GLOBAL_RETRIEVAL_WORKSPACE = '__damocles_global_scope__';
const RERANK_TIMEOUT_MS = 2000;
const RERANK_SNIPPET_CHARS = 160;

const SCOPE_WEIGHT: Record<MemoryScope, number> = {
  session: 1.0,
  project: 0.8,
  global: 0.6,
};

function computeRecency(updatedAt: number): number {
  return 1 / (1 + (Date.now() - updatedAt) / SEVEN_DAYS_MS);
}

/**
 * This boost creates a retrieved→boosted→retrieved feedback loop, intentionally log-damped:
 * `log2(1 + count)` grows sub-linearly, normalized by `log2(11)`, so the marginal boost saturates
 * near 1 (~10 retrievals). With the 0.1 weight in {@link scoreMemory} and the 30-day window,
 * runaway self-reinforcement is bounded.
 */
function computeRetrievalBoost(memoryId: string, retrievalCounts: Map<string, number>): number {
  const count = retrievalCounts.get(memoryId) ?? 0;
  if (count === 0) return 0;
  return Math.log2(1 + count) / RETRIEVAL_BOOST_DENOMINATOR;
}

function computeSourceCountBoost(memory: MemoryEntry): number {
  return 0.05 * Math.log2(1 + (memory.sourceCount ?? 1));
}

function computeStalenessPenalty(memory: MemoryEntry): number {
  if (memory.kind !== 'observation') return 1.0;
  const count = memory.fileChangeCount ?? 0;
  if (count < STALENESS_THRESHOLD) return 1.0;
  return 0.3 + 0.7 * Math.exp(-0.25 * count);
}

interface ScoredMemory {
  memory: MemoryEntry;
  score: number;
  scoreBreakdown: MemoryScoreBreakdown;
  estimatedTokens: number;
  rerankRelevance?: RerankRelevance;
  reason?: string;
}

function scoreMemory(
  memory: MemoryEntry,
  ftsScores: Map<string, number> | null,
  activeFile: string | null,
  retrievalCounts: Map<string, number>,
): { score: number; breakdown: MemoryScoreBreakdown } {
  const ftsRelevance = ftsScores?.get(memory.id) ?? 0;
  const recency = computeRecency(memory.updatedAt);
  const fileProximity = activeFile ? computeFileProximity(memory, activeFile) : 0;
  const scopeWeight = SCOPE_WEIGHT[memory.scope ?? 'project'];
  const retrievalBoost = computeRetrievalBoost(memory.id, retrievalCounts);
  const sourceCountBoost = computeSourceCountBoost(memory);
  const stalenessPenalty = computeStalenessPenalty(memory);

  const raw = ftsScores
    ? ftsRelevance * 0.5 + recency * 0.15 + scopeWeight * 0.15 + fileProximity * 0.1 + retrievalBoost * 0.1 + sourceCountBoost
    : fileProximity * 0.4 + recency * 0.25 + scopeWeight * 0.25 + retrievalBoost * 0.1 + sourceCountBoost;

  return {
    score: raw * stalenessPenalty,
    breakdown: { ftsRelevance, recency, scopeWeight, fileProximity, retrievalBoost, sourceCountBoost, stalenessPenalty },
  };
}

function normalizeForGroup(
  memories: MemoryEntry[],
  rawRanks: Map<string, number>,
): Map<string, number> | null {
  const ids = new Set(memories.map(m => m.id));
  let min = Infinity, max = -Infinity;
  let matchCount = 0;
  for (const [id, rank] of rawRanks) {
    if (!ids.has(id)) continue;
    matchCount++;
    if (rank < min) min = rank;
    if (rank > max) max = rank;
  }
  if (min === Infinity) return null;
  const range = max - min;
  // Min-max normalization gives the best match a full 1.0. Scale by matchCount/3 so a sparse-match
  // group can't reach full confidence on a lone lexical hit — one hit maxes at 1/3, two at 2/3.
  const damping = matchCount < 3 ? matchCount / 3 : 1;
  const normalized = new Map<string, number>();
  for (const [id, rank] of rawRanks) {
    if (!ids.has(id)) continue;
    normalized.set(id, (range > 0 ? (rank - min) / range : 1) * damping);
  }
  return normalized;
}

function selectTopN(
  memories: MemoryEntry[],
  limit: number,
  activeFile: string | null,
  rawFtsRanks: Map<string, number> | null,
  retrievalCounts: Map<string, number>,
  excludeIds: Set<string>,
): ScoredMemory[] {
  const filtered = memories.filter(m => !excludeIds.has(m.id));
  const ftsScores = rawFtsRanks ? normalizeForGroup(filtered, rawFtsRanks) : null;
  const scored = filtered.map(m => {
    const { score, breakdown } = scoreMemory(m, ftsScores, activeFile, retrievalCounts);
    return { memory: m, score, scoreBreakdown: breakdown, estimatedTokens: estimateTokens(formatMemoryEntry(m)) };
  });
  // Composite score desc, tiebroken by BM25 relevance desc so ordering stays deterministic on collisions.
  scored.sort((a, b) => b.score - a.score || b.scoreBreakdown.ftsRelevance - a.scoreBreakdown.ftsRelevance);
  return scored.slice(0, limit);
}

function formatMemoryEntry(m: MemoryEntry): string {
  if (m.kind === 'observation' && m.title) {
    const files = [...(m.filesRead ?? []), ...(m.filesModified ?? [])];
    const fileHint = files.length > 0 ? ` (${files.slice(0, 2).join(', ')})` : '';
    const staleHint = (m.fileChangeCount ?? 0) >= STALENESS_THRESHOLD ? ' [stale]' : '';
    return `- [${m.id}] ${m.title}${fileHint}${staleHint}`;
  }
  if (m.content.length > CONTENT_TRUNCATION_LIMIT) {
    return `- [${m.id}] ${truncateToChars(m.content, CONTENT_TRUNCATION_LIMIT)}...[Use get_memory_details for full content]`;
  }
  return `- [${m.id}] ${m.content}`;
}

function formatPinnedEntry(m: MemoryEntry): string {
  if (m.kind === 'observation' && m.title) {
    const staleHint = (m.fileChangeCount ?? 0) >= STALENESS_THRESHOLD ? ' [stale]' : '';
    return `- [${m.id}] ${m.title}${staleHint}\n  ${m.content}`;
  }
  return `- [${m.id}] ${m.content}`;
}

function formatScoredList(scored: ScoredMemory[]): string {
  return scored.map(s => formatMemoryEntry(s.memory)).join('\n');
}

function toInjectionEntry(scored: ScoredMemory, isPinned: boolean): MemoryInjectionEntry {
  const m = scored.memory;
  return {
    id: m.id,
    scope: m.scope ?? 'project',
    kind: m.kind ?? 'fact',
    title: m.title ?? null,
    content: m.content,
    score: scored.score,
    scoreBreakdown: scored.scoreBreakdown,
    estimatedTokens: scored.estimatedTokens,
    isStale: (m.fileChangeCount ?? 0) >= STALENESS_THRESHOLD,
    isPinned,
    ...(m.sourceCount !== undefined ? { sourceCount: m.sourceCount } : {}),
    ...(scored.rerankRelevance ? { rerankRelevance: scored.rerankRelevance } : {}),
    ...(scored.reason ? { reason: scored.reason } : {}),
  };
}

function buildGroup(
  label: GroupLabel,
  entryLimit: number,
  scored: ScoredMemory[],
  totalAvailable: number,
): MemoryInjectionGroup {
  const entries = scored.map(s => toInjectionEntry(s, false));
  const tokensUsed = scored.reduce((sum, s) => sum + s.estimatedTokens, 0);
  return { label, entryLimit, tokensUsed, entries, totalAvailable };
}

interface CandidateRows {
  session: MemoryEntry[];
  project: MemoryEntry[];
  global: MemoryEntry[];
  observations: MemoryEntry[];
}

type ScoredGroups = Record<GroupLabel, ScoredMemory[]>;

/**
 * Bounds the total SIZE of the catalog (per-group limits already bound COUNT; pinned has its own
 * budget). Drops lowest-scored entries across all four groups until the summed tokens fit `budget`,
 * rebuilding each group in its original order — only membership shrinks.
 */
function enforceTokenBudget(groups: ScoredGroups, budget: number): ScoredGroups {
  const labels: GroupLabel[] = ['session', 'project', 'global', 'observations'];

  let total = 0;
  for (const label of labels) {
    for (const s of groups[label]) total += s.estimatedTokens;
  }
  if (total <= budget) return groups;

  // Drop lowest-value first. When a rerank ran, its relevance dominates raw BM25 score, so a
  // rerank-promoted (but low-BM25) entry is not evicted ahead of an ungraded higher-BM25 one.
  const flat = labels.flatMap(label => groups[label].map(entry => ({ label, entry })));
  const ascending = [...flat].sort(
    (a, b) =>
      rerankSortWeight(a.entry.rerankRelevance) - rerankSortWeight(b.entry.rerankRelevance) ||
      a.entry.score - b.entry.score,
  );

  const dropped = new Set<ScoredMemory>();
  let remaining = total;
  for (const { entry } of ascending) {
    if (remaining <= budget) break;
    dropped.add(entry);
    remaining -= entry.estimatedTokens;
  }

  const result = {} as ScoredGroups;
  for (const label of labels) {
    result[label] = groups[label].filter(s => !dropped.has(s));
  }
  return result;
}

export const __test: { enforceTokenBudget: typeof enforceTokenBudget } = { enforceTokenBudget };

/**
 * Build the rerank candidate pool by sampling each non-empty group proportionally to its size (not a
 * positional slice, which could starve small groups). Each gets a quota of
 * `max(2, round(cap * size / total))`, contributing its top-N by BM25 order. If summed quotas exceed
 * `cap`, the largest are trimmed first, never below 2; if min-2 across all groups already exceeds
 * `cap`, groups are taken 2-at-a-time in order until the cap is exhausted.
 */
function buildRerankPool(groups: ScoredGroups, cap: number): ScoredMemory[] {
  const labels: GroupLabel[] = ['session', 'project', 'global', 'observations'];
  const nonEmpty = labels.filter(label => groups[label].length > 0);
  const totalSize = nonEmpty.reduce((sum, label) => sum + groups[label].length, 0);

  // Degenerate cap: can't give every group its min-2 → take 2 each in order until exhausted.
  if (nonEmpty.length * 2 > cap) {
    const pool: ScoredMemory[] = [];
    for (const label of nonEmpty) {
      if (pool.length >= cap) break;
      const take = Math.min(2, cap - pool.length);
      pool.push(...groups[label].slice(0, take));
    }
    return pool.slice(0, cap);
  }

  // Proportional quotas, floored at 2 per group and capped at the group's size.
  const quota = new Map<GroupLabel, number>();
  for (const label of nonEmpty) {
    const proportional = Math.round((cap * groups[label].length) / totalSize);
    quota.set(label, Math.min(groups[label].length, Math.max(2, proportional)));
  }

  // If quotas overshoot the cap, trim the largest first, never below 2.
  const quotaSum = () => nonEmpty.reduce((sum, label) => sum + quota.get(label)!, 0);
  while (quotaSum() > cap) {
    const trimmable = nonEmpty.filter(label => quota.get(label)! > 2);
    if (trimmable.length === 0) break; // everything at floor 2 — cap still honored via slice below
    const largest = trimmable.reduce((a, b) => (quota.get(b)! > quota.get(a)! ? b : a));
    quota.set(largest, quota.get(largest)! - 1);
  }

  const pool: ScoredMemory[] = [];
  for (const label of nonEmpty) {
    pool.push(...groups[label].slice(0, quota.get(label)!));
  }
  return pool.slice(0, cap);
}

/**
 * Owns the per-turn `<damocles_memory>` catalog: queries live memory rows directly (never the
 * per-scope managers, which leak superseded/forgotten rows), ranks by BM25-first scoring, optionally
 * reorders with a hard-capped blocking LLM rerank, and prepends profile + handoff context on the
 * first message of a session. Also persists per-prompt display snapshots.
 */
export class InjectionManager {
  private db: DatabaseInstance;
  private profileManager: ProfileManager;
  private runner: MemorySubCallRunner;
  private firstMessageSessions: Set<string>;
  /**
   * Cache of the DB-backed first-message decision per session: distinguishes a genuinely-new session
   * from one whose prompt-0 row survives across a restart, so profile/handoff isn't re-injected.
   */
  private firstMessageResolved = new Map<string, boolean>();
  private injectionDbs = new Map<string, DatabaseInstance>();
  private pendingDbOpens = new Map<string, Promise<DatabaseInstance | undefined>>();
  private disposed = false;

  constructor(db: DatabaseInstance, profileManager: ProfileManager, runner: MemorySubCallRunner) {
    this.db = db;
    this.profileManager = profileManager;
    this.runner = runner;
    this.firstMessageSessions = new Set();
  }

  async persistInjection(sessionId: string, promptIndex: number, display: MemoryInjectionDisplay): Promise<void> {
    try {
      const db = await this.getOrOpenInjectionDb(sessionId);
      if (!db) return;
      insertMemoryInjection(db, promptIndex, display);
    } catch (err) {
      log('[InjectionManager] Failed to persist injection for session %s prompt %d: %O', sessionId, promptIndex, err);
    }
  }

  async getPersistedInjection(sessionId: string, promptIndex: number): Promise<MemoryInjectionDisplay | undefined> {
    try {
      const db = await this.getOrOpenInjectionDb(sessionId);
      if (!db) return undefined;
      return getPersistedMemoryInjection(db, promptIndex);
    } catch (err) {
      log('[InjectionManager] Failed to retrieve injection for session %s prompt %d: %O', sessionId, promptIndex, err);
      return undefined;
    }
  }

  private async getOrOpenInjectionDb(sessionId: string): Promise<DatabaseInstance | undefined> {
    const existing = this.injectionDbs.get(sessionId);
    if (existing) return existing;

    const pending = this.pendingDbOpens.get(sessionId);
    if (pending) return pending;

    const openPromise = openInjectionDatabase(sessionId).then(db => {
      this.pendingDbOpens.delete(sessionId);
      // Dispose may have run while this open was in flight; caching now would leak an unclosed handle.
      if (db && this.disposed) { try { db.close(); } catch { /* ignore */ } return undefined; }
      if (db) this.injectionDbs.set(sessionId, db);
      return db ?? undefined;
    }, err => {
      this.pendingDbOpens.delete(sessionId);
      throw err;
    });
    this.pendingDbOpens.set(sessionId, openPromise);
    return openPromise;
  }

  closeInjectionDatabases(): void {
    this.disposed = true;
    for (const db of this.injectionDbs.values()) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
    this.injectionDbs.clear();
    this.pendingDbOpens.clear();
  }

  // Close and drop the live handle so the OS releases the file lock before any fs op (Windows can't
  // delete/rename an open SQLite file). Awaits an in-flight open so it doesn't reopen post-op.
  private async closeAndEvict(sessionId: string): Promise<void> {
    const pending = this.pendingDbOpens.get(sessionId);
    if (pending) {
      try { await pending; } catch { /* open failure already logged */ }
    }
    const db = this.injectionDbs.get(sessionId);
    if (db) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
    this.injectionDbs.delete(sessionId);
    this.pendingDbOpens.delete(sessionId);
  }

  private evictFirstMessageCache(sessionId: string): void {
    this.firstMessageSessions.delete(sessionId);
    this.firstMessageResolved.delete(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.closeAndEvict(sessionId);
    this.evictFirstMessageCache(sessionId);
    await deleteInjectionDatabaseFile(sessionId);
  }

  async renameSession(oldId: string, newId: string): Promise<void> {
    await this.closeAndEvict(oldId);
    await this.closeAndEvict(newId);
    if (this.firstMessageSessions.has(oldId)) this.firstMessageSessions.add(newId);
    const resolved = this.firstMessageResolved.get(oldId);
    if (resolved !== undefined) this.firstMessageResolved.set(newId, resolved);
    this.evictFirstMessageCache(oldId);
    await renameInjectionDatabaseFile(oldId, newId);
  }

  async sweepStaleDatabases(): Promise<void> {
    const swept = await sweepStaleInjectionDatabases();
    if (swept.length === 0) return;
    const sweptNames = new Set(swept);
    for (const sessionId of [...this.injectionDbs.keys()]) {
      if (sweptNames.has(injectionDbName(sessionId))) void this.closeAndEvict(sessionId);
    }
    for (const sessionId of [...this.firstMessageResolved.keys(), ...this.firstMessageSessions]) {
      if (sweptNames.has(injectionDbName(sessionId))) this.evictFirstMessageCache(sessionId);
    }
    log('[InjectionManager] Swept %d stale injection database(s)', swept.length);
  }

  /**
   * Synchronous first-message check. Prefers the cached DB-backed decision so a mid-session restart
   * doesn't re-trigger profile/handoff; falls back to the in-memory set when not yet resolved.
   */
  isFirstMessageOfSession(sessionId: string): boolean {
    const resolved = this.firstMessageResolved.get(sessionId);
    if (resolved !== undefined) return resolved;
    return !this.firstMessageSessions.has(sessionId);
  }

  /**
   * Resolve whether this is the first message of `sessionId`, consulting the persisted injection DB
   * so a restart mid-session is not treated as a fresh session. Result cached; read-only against the DB.
   */
  private async resolveFirstMessage(sessionId: string): Promise<boolean> {
    const cached = this.firstMessageResolved.get(sessionId);
    if (cached !== undefined) return cached;

    // Known this process → a prior turn already sent the first message.
    if (this.firstMessageSessions.has(sessionId)) {
      this.firstMessageResolved.set(sessionId, false);
      return false;
    }

    // Otherwise any persisted injection row means the first message was handled before this restart.
    let isFirst = true;
    const db = await this.getOrOpenInjectionDb(sessionId);
    if (db) {
      const row = db.prepare('SELECT 1 FROM memory_injections LIMIT 1').get();
      if (row) isFirst = false;
    }
    this.firstMessageResolved.set(sessionId, isFirst);
    return isFirst;
  }

  markFirstMessageSent(sessionId: string): void {
    this.firstMessageSessions.add(sessionId);
    this.firstMessageResolved.set(sessionId, false);
  }

  pinMemory(id: string): boolean {
    const result = this.db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  unpinMemory(id: string): boolean {
    const result = this.db.prepare('UPDATE memories SET pinned = 0 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  recordRetrievals(ids: string[], workspace: string): void {
    if (ids.length === 0) return;
    const now = Date.now();

    const placeholders = ids.map(() => '?').join(',');
    const scopeRows = this.db
      .prepare(`SELECT id, scope FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as { id: string; scope: string }[];
    const scopeById = new Map(scopeRows.map(r => [r.id, r.scope]));

    const stmt = this.db.prepare('INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, ?, ?)');
    for (const id of ids) {
      const bucket = scopeById.get(id) === 'global' ? GLOBAL_RETRIEVAL_WORKSPACE : workspace;
      stmt.run(id, bucket, now);
    }
    const cutoff = now - THIRTY_DAYS_MS;
    this.db.prepare('DELETE FROM memory_retrievals WHERE retrieved_at < ?').run(cutoff);
  }

  getRetrievalCounts(workspace: string): Map<string, number> {
    const cutoff = Date.now() - THIRTY_DAYS_MS;

    const rows = this.db.prepare(
      'SELECT memory_id, COUNT(*) as count FROM memory_retrievals WHERE workspace IN (?, ?) AND retrieved_at > ? GROUP BY memory_id'
    ).all(workspace, GLOBAL_RETRIEVAL_WORKSPACE, cutoff) as { memory_id: string; count: number }[];

    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.memory_id, row.count);
    }
    return counts;
  }

  private queryFtsRanks(
    userPrompt: string | undefined,
    workspace: string,
    sessionId: string | null,
  ): { ranks: Map<string, number>; ftsQuery: string } | null {
    if (!userPrompt) return null;

    const ftsQuery = buildFtsMatchQuery(userPrompt);
    if (!ftsQuery) return null;

    try {
      const params: unknown[] = [ftsQuery, workspace];
      let sessionClause = '';
      if (sessionId) {
        sessionClause = " OR (m.session_id = ? AND m.scope = 'session')";
        params.push(sessionId);
      }

      const rows = this.db.prepare(`
        SELECT m.id, fts.rank
        FROM memories_fts fts
        JOIN memories m ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
          AND m.is_latest = 1 AND m.forgotten = 0
          AND (m.workspace = ? ${sessionClause} OR m.scope = 'global')
      `).all(...params) as FtsMatchRow[];

      if (rows.length === 0) return null;

      const ranks = new Map<string, number>();
      for (const row of rows) {
        ranks.set(row.id, Math.abs(row.rank));
      }
      return { ranks, ftsQuery };
    } catch (err) {
      log(`[InjectionManager] FTS5 query failed, falling back to heuristic scoring: ${err}`);
      return null;
    }
  }

  /**
   * Load candidate rows as four bounded per-scope pools, each `ORDER BY updated_at DESC LIMIT 3 *
   * <entry limit>`, so rows scanned per turn are bounded by config regardless of store size. The 3x
   * headroom lets scoring/rerank promote an older-but-relevant row over a merely-recent one.
   */
  private loadCandidates(workspace: string, sessionId: string | null, limits: CatalogLimits): CandidateRows {
    // Shared live/decay filter; `kind` is constrained per-pool below.
    const baseWhere = "is_latest = 1 AND forgotten = 0 AND kind != 'note' AND (forget_after IS NULL OR forget_after >= ?)";

    // Session-scoped rows for THIS session only; empty when there is no active session.
    let session: MemoryEntry[] = [];
    if (sessionId) {
      const rows = this.db.prepare(
        `SELECT * FROM memories
         WHERE ${baseWhere} AND kind != 'observation'
           AND scope = 'session' AND session_id = ?
         ORDER BY updated_at DESC LIMIT ?`
      ).all(Date.now(), sessionId, 3 * limits.session) as MemoryRow[];
      session = rows.map(rowToEntry);
    }

    const projectRows = this.db.prepare(
      `SELECT * FROM memories
       WHERE ${baseWhere} AND kind != 'observation'
         AND scope = 'project' AND workspace = ?
       ORDER BY updated_at DESC LIMIT ?`
    ).all(Date.now(), workspace, 3 * limits.project) as MemoryRow[];

    // Global-scoped rows surface in every workspace (no workspace predicate).
    const globalRows = this.db.prepare(
      `SELECT * FROM memories
       WHERE ${baseWhere} AND kind != 'observation'
         AND scope = 'global'
       ORDER BY updated_at DESC LIMIT ?`
    ).all(Date.now(), 3 * limits.global) as MemoryRow[];

    // Observations visible in this workspace (or global); the SQL LIMIT bounds the scan.
    const obsParams: unknown[] = [Date.now(), workspace];
    let obsSessionClause = '';
    if (sessionId) {
      obsSessionClause = " OR (session_id = ? AND scope = 'session')";
      obsParams.push(sessionId);
    }
    obsParams.push(3 * limits.observation);
    const observationRows = this.db.prepare(
      `SELECT * FROM memories
       WHERE ${baseWhere} AND kind = 'observation'
         AND (workspace = ? ${obsSessionClause} OR scope = 'global')
       ORDER BY updated_at DESC LIMIT ?`
    ).all(...obsParams) as MemoryRow[];

    return {
      session,
      project: projectRows.map(rowToEntry),
      global: globalRows.map(rowToEntry),
      observations: observationRows.map(rowToEntry),
    };
  }

  /** Pinned memories skip the `forget_after` predicate: a user pin overrides decay, so a pinned episode past its TTL still injects. */
  private loadPinnedMemories(workspace: string, sessionId: string | null): MemoryEntry[] {
    const params: unknown[] = [workspace];
    let sessionClause = '';
    if (sessionId) {
      sessionClause = " OR (session_id = ? AND scope = 'session')";
      params.push(sessionId);
    }

    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE pinned = 1 AND is_latest = 1 AND forgotten = 0 AND (workspace = ? ${sessionClause} OR scope = 'global') ORDER BY updated_at DESC`
    ).all(...params) as MemoryRow[];

    return rows.map(rowToEntry);
  }

  async buildMemoryCatalog(
    sessionId: string | null,
    workspace: string,
    activeFile: string | null,
    userPrompt?: string,
  ): Promise<{ context: string; metadata: MemoryInjectionDisplay | null }> {
    const limits = getCatalogLimits();
    const retrievalCounts = this.getRetrievalCounts(workspace);

    // Resolve the first-message decision once per turn and reuse for both profile and handoff gating.
    const isFirstMessage = sessionId ? await this.resolveFirstMessage(sessionId) : false;

    const candidates = this.loadCandidates(workspace, sessionId, limits);

    const pinnedMemories = this.loadPinnedMemories(workspace, sessionId);
    const pinnedIds = new Set(pinnedMemories.map(m => m.id));

    const ftsResult = this.queryFtsRanks(userPrompt, workspace, sessionId);
    const ftsRanks = ftsResult?.ranks ?? null;

    // Pinned has its own token budget. `continue` not `break`: a single oversized pinned entry must
    // not starve smaller ones after it — skip it and keep filling.
    let pinnedTokensUsed = 0;
    const pinnedForInjection: MemoryEntry[] = [];
    for (const m of pinnedMemories) {
      const cost = estimateTokens(formatPinnedEntry(m));
      if (pinnedTokensUsed + cost > limits.pinnedTokenBudget) continue;
      pinnedForInjection.push(m);
      pinnedTokensUsed += cost;
    }

    let scoredSession = selectTopN(candidates.session, limits.session, activeFile, ftsRanks, retrievalCounts, pinnedIds);
    let scoredProject = selectTopN(candidates.project, limits.project, activeFile, ftsRanks, retrievalCounts, pinnedIds);
    let scoredGlobal = selectTopN(candidates.global, limits.global, activeFile, ftsRanks, retrievalCounts, pinnedIds);
    let scoredObservations = selectTopN(candidates.observations, limits.observation, activeFile, ftsRanks, retrievalCounts, pinnedIds);

    let rerankApplied = false;
    if (userPrompt && this.injectRerankEnabled()) {
      const reranked = await this.rerankGroups(userPrompt, {
        session: scoredSession,
        project: scoredProject,
        global: scoredGlobal,
        observations: scoredObservations,
      });
      if (reranked) {
        scoredSession = reranked.session;
        scoredProject = reranked.project;
        scoredGlobal = reranked.global;
        scoredObservations = reranked.observations;
        rerankApplied = true;
      }
    }

    // Aggregate token-budget enforcement: drops lowest-scored entries across all groups until the
    // summed size fits; pinned excluded (separate budget above).
    ({ session: scoredSession, project: scoredProject, global: scoredGlobal, observations: scoredObservations } =
      enforceTokenBudget(
        { session: scoredSession, project: scoredProject, global: scoredGlobal, observations: scoredObservations },
        limits.tokenBudget,
      ));

    const hasContent = scoredSession.length > 0 || scoredProject.length > 0 ||
      scoredGlobal.length > 0 || scoredObservations.length > 0 || pinnedForInjection.length > 0;

    const profileContext = this.buildProfileContext(sessionId, workspace, isFirstMessage);
    const handoffContext = this.buildHandoffContext(sessionId, isFirstMessage, candidates.observations, activeFile, ftsRanks, retrievalCounts);

    const buildMetadata = (): MemoryInjectionDisplay => {
      const groups: MemoryInjectionGroup[] = [
        buildGroup('session', limits.session, scoredSession, candidates.session.length),
        buildGroup('project', limits.project, scoredProject, candidates.project.length),
        buildGroup('global', limits.global, scoredGlobal, candidates.global.length),
        buildGroup('observations', limits.observation, scoredObservations, candidates.observations.length),
      ];
      const totalTokensUsed = groups.reduce((sum, g) => sum + g.tokensUsed, 0) + pinnedTokensUsed;

      const pinnedEntries: MemoryInjectionEntry[] = pinnedForInjection.map(m => {
        const { score, breakdown } = scoreMemory(m, null, activeFile, retrievalCounts);
        return toInjectionEntry(
          { memory: m, score, scoreBreakdown: breakdown, estimatedTokens: estimateTokens(formatPinnedEntry(m)) },
          true,
        );
      });

      return {
        groups,
        totalTokensUsed,
        ftsQuery: ftsResult?.ftsQuery ?? null,
        hasHandoffContext: !!handoffContext,
        hasProfile: !!profileContext,
        rerankApplied,
        pinnedEntries,
        pinnedBudget: limits.pinnedTokenBudget,
        pinnedTokensUsed,
      };
    };

    const prefixParts: string[] = [];
    if (profileContext) prefixParts.push(profileContext);
    if (handoffContext) prefixParts.push(handoffContext);

    if (!hasContent) {
      return { context: prefixParts.join('\n\n'), metadata: buildMetadata() };
    }

    const memoryParts: string[] = [];

    if (scoredSession.length > 0) {
      memoryParts.push(`<session_memories>\n${formatScoredList(scoredSession)}\n</session_memories>`);
    }
    if (scoredProject.length > 0) {
      memoryParts.push(`<project_memories>\n${formatScoredList(scoredProject)}\n</project_memories>`);
    }
    if (scoredGlobal.length > 0) {
      memoryParts.push(`<global_memories>\n${formatScoredList(scoredGlobal)}\n</global_memories>`);
    }
    if (scoredObservations.length > 0) {
      memoryParts.push(`<recent_observations>\n${formatScoredList(scoredObservations)}\n</recent_observations>`);
    }
    if (pinnedForInjection.length > 0) {
      const pinnedContent = pinnedForInjection.map(m => formatPinnedEntry(m)).join('\n');
      memoryParts.push(`<pinned_memories>\n${pinnedContent}\n</pinned_memories>`);
    }

    const parts: string[] = [...prefixParts];
    parts.push(`<damocles_memory>\n${memoryParts.join('\n')}\n</damocles_memory>`);

    return { context: parts.join('\n\n'), metadata: buildMetadata() };
  }

  private injectRerankEnabled(): boolean {
    return getConfig<'off' | 'blocking'>('rerank.injectMode', 'off') === 'blocking';
  }

  private buildProfileContext(sessionId: string | null, workspace: string, isFirstMessage: boolean): string {
    if (!sessionId || !isFirstMessage) return '';
    return this.profileManager.buildProfileInjection(workspace, getConfig('profile.tokenBudget', 400));
  }

  private buildHandoffContext(
    sessionId: string | null,
    isFirstMessage: boolean,
    observations: MemoryEntry[],
    activeFile: string | null,
    ftsRanks: Map<string, number> | null,
    retrievalCounts: Map<string, number>,
  ): string {
    if (!sessionId || !isFirstMessage) return '';

    const ranked = selectTopN(observations, 5, activeFile, ftsRanks, retrievalCounts, new Set());
    if (ranked.length === 0) return '';

    return `<damocles_session_handoff>\n<relevant_observations>\n${formatScoredList(ranked)}\n</relevant_observations>\n</damocles_session_handoff>`;
  }

  /**
   * Reorder the four scored groups via a single hard-capped (~2s) blocking LLM rerank; on timeout,
   * null, or failure the BM25 order is preserved. Only invoked when `rerank.injectMode` is `blocking`.
   */
  private async rerankGroups(
    userPrompt: string,
    groups: Record<GroupLabel, ScoredMemory[]>,
  ): Promise<Record<GroupLabel, ScoredMemory[]> | null> {
    const all = [...groups.session, ...groups.project, ...groups.global, ...groups.observations];
    if (all.length < 2) return null;

    // Proportional per-group sampling so a large group can't crowd small groups out of the graded pool.
    const pool = buildRerankPool(groups, RERANK_CANDIDATE_CAP);
    const items = pool.map(s => ({
      id: s.memory.id,
      title: s.memory.title ?? null,
      snippet: truncateToChars(s.memory.content, RERANK_SNIPPET_CHARS),
    }));
    const prompt = `Query: ${userPrompt}\n\nCandidates:\n${JSON.stringify(items)}`;

    let value: InjectRerankResult | null;
    try {
      const result = await this.runner.run<InjectRerankResult>({
        purpose: 'rerank',
        systemPrompt: INJECT_RERANK_SYSTEM_PROMPT,
        prompt,
        schema: INJECT_RERANK_SCHEMA,
        timeoutMs: RERANK_TIMEOUT_MS,
      });
      value = result.value;
    } catch (err) {
      log('[InjectionManager] Inject-rerank failed, keeping BM25 order: %O', err);
      value = null;
    }

    if (!isInjectRerankResult(value)) return null;

    const graded = new Map<string, { relevance: RerankRelevance; reason?: string }>();
    for (const item of value.results) {
      if (!(item.relevance in RELEVANCE_RANK)) continue;
      const existing = graded.get(item.id);
      if (!existing || RELEVANCE_RANK[item.relevance] > RELEVANCE_RANK[existing.relevance]) {
        graded.set(item.id, { relevance: item.relevance, ...(item.reason ? { reason: item.reason } : {}) });
      }
    }
    if (graded.size === 0) return null;

    const reorder = (scored: ScoredMemory[]): ScoredMemory[] =>
      scored
        .map((s, bm25Index) => {
          const grade = graded.get(s.memory.id);
          return {
            entry: {
              ...s,
              ...(grade ? { rerankRelevance: grade.relevance } : {}),
              ...(grade?.reason ? { reason: grade.reason } : {}),
            },
            bm25Index,
            relevance: grade?.relevance,
          };
        })
        .sort((a, b) => rerankSortWeight(b.relevance) - rerankSortWeight(a.relevance) || a.bm25Index - b.bm25Index)
        .map(x => x.entry);

    return {
      session: reorder(groups.session),
      project: reorder(groups.project),
      global: reorder(groups.global),
      observations: reorder(groups.observations),
    };
  }
}
