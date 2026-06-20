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
import { openInjectionDatabase, insertMemoryInjection, getMemoryInjection as getPersistedMemoryInjection } from '../injection-database';
import type { ProfileManager } from './profile-manager';
import type { MemorySubCallRunner } from '../subcall-runner';

interface CatalogLimits {
  project: number;
  global: number;
  observation: number;
  pinnedTokenBudget: number;
}

type GroupLabel = 'session' | 'project' | 'global' | 'observations';

type RerankRelevance = 'high' | 'medium' | 'low';

const RELEVANCE_RANK: Record<RerankRelevance, number> = { high: 3, medium: 2, low: 1 };

/**
 * Sort weight for the final ordering: ungraded rows sit at a NEUTRAL position (between medium and
 * low) so a high-BM25 row the LLM simply didn't grade keeps its BM25 standing instead of sinking
 * below explicitly-low grades. Distinct from {@link RELEVANCE_RANK}, which only dedups grades.
 */
const RERANK_SORT_WEIGHT: Record<RerankRelevance, number> = { high: 3, medium: 2, low: 0 };
const UNGRADED_SORT_WEIGHT = 1;
function rerankSortWeight(relevance: RerankRelevance | undefined): number {
  return relevance === undefined ? UNGRADED_SORT_WEIGHT : RERANK_SORT_WEIGHT[relevance];
}

interface InjectRerankResult {
  results: Array<{ id: string; relevance: RerankRelevance; reason?: string }>;
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getConfig<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('damocles.memory').get<T>(key, fallback) ?? fallback;
}

function getCatalogLimits(): CatalogLimits {
  return {
    project: getConfig('catalogProjectLimit', 15),
    global: getConfig('catalogGlobalLimit', 10),
    observation: getConfig('catalogObservationLimit', 20),
    pinnedTokenBudget: getConfig('pinnedTokenBudget', 500),
  };
}

function memoryMentionsFile(memory: MemoryEntry, activeFile: string): boolean {
  const normalizedActive = activeFile.replace(/\\/g, '/').toLowerCase();
  const fileName = normalizedActive.split('/').pop() ?? '';

  const checkFields = [
    memory.content,
    ...(memory.filesRead ?? []),
    ...(memory.filesModified ?? []),
  ];

  return checkFields.some(field => {
    const normalized = field.replace(/\\/g, '/').toLowerCase();
    return normalized.includes(fileName) || normalized.includes(normalizedActive);
  });
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RETRIEVAL_BOOST_DENOMINATOR = Math.log2(11);
const STALENESS_THRESHOLD = 3;
const CONTENT_TRUNCATION_LIMIT = 300;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const OBSERVATION_CANDIDATE_POOL_SIZE = 100;
const RERANK_CANDIDATE_CAP = 30;

/**
 * Sentinel `workspace` bucket for global-scoped retrievals. Global memories are surfaced across
 * every workspace, so their retrieval counts must not be siloed by the active workspace — they are
 * recorded here and unioned in when scoring in any workspace. The sentinel cannot collide with a
 * real filesystem path.
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
  const fileProximity = activeFile && memoryMentionsFile(memory, activeFile) ? 1 : 0;
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
  for (const [id, rank] of rawRanks) {
    if (!ids.has(id)) continue;
    if (rank < min) min = rank;
    if (rank > max) max = rank;
  }
  if (min === Infinity) return null;
  const range = max - min;
  const normalized = new Map<string, number>();
  for (const [id, rank] of rawRanks) {
    if (!ids.has(id)) continue;
    normalized.set(id, range > 0 ? (rank - min) / range : 1);
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
  scored.sort((a, b) => b.score - a.score);
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
    return `- [${m.id}] ${m.content.slice(0, CONTENT_TRUNCATION_LIMIT)}...[Use get_memory_details for full content]`;
  }
  return `- ${m.content}`;
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

/**
 * Owns the per-turn `<damocles_memory>` catalog: queries LIVE memory rows directly (never the
 * per-scope managers, which leak superseded/forgotten rows), ranks them by BM25-first scoring,
 * optionally reorders with a hard-capped blocking LLM rerank, and prepends profile + handoff
 * context on the first message of a session. Also persists per-prompt display snapshots.
 */
export class InjectionManager {
  private db: DatabaseInstance;
  private profileManager: ProfileManager;
  private runner: MemorySubCallRunner;
  private firstMessageSessions: Set<string>;
  private injectionDbs = new Map<string, DatabaseInstance>();
  private pendingDbOpens = new Map<string, Promise<DatabaseInstance | undefined>>();

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
    for (const db of this.injectionDbs.values()) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
    this.injectionDbs.clear();
    this.pendingDbOpens.clear();
  }

  isFirstMessageOfSession(sessionId: string): boolean {
    return !this.firstMessageSessions.has(sessionId);
  }

  markFirstMessageSent(sessionId: string): void {
    this.firstMessageSessions.add(sessionId);
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

  private loadCandidates(workspace: string, sessionId: string | null): CandidateRows {
    const params: unknown[] = [Date.now(), workspace];
    let sessionClause = '';
    if (sessionId) {
      sessionClause = " OR (session_id = ? AND scope = 'session')";
      params.push(sessionId);
    }

    const rows = this.db.prepare(
      `SELECT * FROM memories
       WHERE is_latest = 1 AND forgotten = 0 AND kind != 'note'
         AND (forget_after IS NULL OR forget_after >= ?)
         AND (workspace = ? ${sessionClause} OR scope = 'global')
       ORDER BY updated_at DESC`
    ).all(...params) as MemoryRow[];

    const result: CandidateRows = { session: [], project: [], global: [], observations: [] };
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (entry.kind === 'observation') {
        if (result.observations.length < OBSERVATION_CANDIDATE_POOL_SIZE) result.observations.push(entry);
      } else if (entry.scope === 'session') {
        result.session.push(entry);
      } else if (entry.scope === 'global') {
        result.global.push(entry);
      } else {
        result.project.push(entry);
      }
    }
    return result;
  }

  /**
   * Pinned memories deliberately skip the `forget_after` predicate that {@link loadCandidates}
   * applies: a user pin overrides time-based decay, so a pinned episode past its TTL still injects.
   */
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

    const candidates = this.loadCandidates(workspace, sessionId);

    const pinnedMemories = this.loadPinnedMemories(workspace, sessionId);
    const pinnedIds = new Set(pinnedMemories.map(m => m.id));

    const ftsResult = this.queryFtsRanks(userPrompt, workspace, sessionId);
    const ftsRanks = ftsResult?.ranks ?? null;

    let pinnedTokensUsed = 0;
    const pinnedForInjection: MemoryEntry[] = [];
    for (const m of pinnedMemories) {
      const cost = estimateTokens(formatPinnedEntry(m));
      if (pinnedTokensUsed + cost > limits.pinnedTokenBudget) break;
      pinnedForInjection.push(m);
      pinnedTokensUsed += cost;
    }

    let scoredSession = selectTopN(candidates.session, candidates.session.length, activeFile, ftsRanks, retrievalCounts, pinnedIds);
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

    const hasContent = scoredSession.length > 0 || scoredProject.length > 0 ||
      scoredGlobal.length > 0 || scoredObservations.length > 0 || pinnedForInjection.length > 0;

    const profileContext = this.buildProfileContext(sessionId, workspace);
    const handoffContext = this.buildHandoffContext(sessionId, candidates.observations, activeFile, ftsRanks, retrievalCounts);

    const buildMetadata = (): MemoryInjectionDisplay => {
      const groups: MemoryInjectionGroup[] = [
        buildGroup('session', candidates.session.length, scoredSession, candidates.session.length),
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

  private buildProfileContext(sessionId: string | null, workspace: string): string {
    if (!sessionId || !this.isFirstMessageOfSession(sessionId)) return '';
    return this.profileManager.buildProfileInjection(workspace, getConfig('profile.tokenBudget', 400));
  }

  private buildHandoffContext(
    sessionId: string | null,
    observations: MemoryEntry[],
    activeFile: string | null,
    ftsRanks: Map<string, number> | null,
    retrievalCounts: Map<string, number>,
  ): string {
    if (!sessionId || !this.isFirstMessageOfSession(sessionId)) return '';

    const ranked = selectTopN(observations, 5, activeFile, ftsRanks, retrievalCounts, new Set());
    if (ranked.length === 0) return '';

    return `<damocles_session_handoff>\n<relevant_observations>\n${formatScoredList(ranked)}\n</relevant_observations>\n</damocles_session_handoff>`;
  }

  /**
   * Reorder the four scored groups via a single hard-capped (~2s) blocking LLM rerank. On timeout,
   * null, or runner failure the BM25 order is preserved (graceful degrade). Only invoked when
   * `damocles.memory.rerank.injectMode` is `blocking` and a user prompt exists.
   */
  private async rerankGroups(
    userPrompt: string,
    groups: Record<GroupLabel, ScoredMemory[]>,
  ): Promise<Record<GroupLabel, ScoredMemory[]> | null> {
    const all = [...groups.session, ...groups.project, ...groups.global, ...groups.observations];
    if (all.length < 2) return null;

    const pool = all.slice(0, RERANK_CANDIDATE_CAP);
    const items = pool.map(s => ({
      id: s.memory.id,
      title: s.memory.title ?? null,
      snippet: s.memory.content.slice(0, RERANK_SNIPPET_CHARS),
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

    if (!value) return null;

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
