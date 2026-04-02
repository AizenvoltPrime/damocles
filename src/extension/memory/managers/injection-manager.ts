import * as vscode from 'vscode';
import type { MemoryEntry, MemoryTier } from '@shared/types/memory';
import type { MemoryInjectionDisplay, MemoryInjectionEntry, MemoryTierInjection, MemoryScoreBreakdown } from '@shared/types/context-injection';
import type { DatabaseInstance, FtsMatchRow, MemoryRow } from '../types';
import { rowToEntry } from '../types';
import { log } from '../../logger';
import { FTS_STOPWORDS } from '../../shared/fts-stopwords';
import { openInjectionDatabase, insertMemoryInjection, getMemoryInjection as getPersistedMemoryInjection } from '../injection-database';
import { SessionMemoryManager } from './session-memory-manager';
import { ProjectMemoryManager } from './project-memory-manager';
import { GlobalMemoryManager } from './global-memory-manager';
import { ObservationManager } from './observation-manager';

interface CatalogLimits {
  project: number;
  global: number;
  observation: number;
  pinnedTokenBudget: number;
}

interface MemoryManagers {
  session: SessionMemoryManager;
  project: ProjectMemoryManager;
  global: GlobalMemoryManager;
  observation: ObservationManager;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getCatalogLimits(): CatalogLimits {
  const config = vscode.workspace.getConfiguration('damocles.memory');
  return {
    project: config.get<number>('catalogProjectLimit', 15),
    global: config.get<number>('catalogGlobalLimit', 10),
    observation: config.get<number>('catalogObservationLimit', 20),
    pinnedTokenBudget: config.get<number>('pinnedTokenBudget', 500),
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

const TIER_WEIGHT: Record<MemoryTier, number> = {
  session: 1.0,
  project: 0.8,
  global: 0.6,
  observation: 0.5,
  note: 0.3,
};

function computeRecency(updatedAt: number): number {
  return 1 / (1 + (Date.now() - updatedAt) / SEVEN_DAYS_MS);
}

function computeRetrievalBoost(memoryId: string, retrievalCounts: Map<string, number>): number {
  const count = retrievalCounts.get(memoryId) ?? 0;
  if (count === 0) return 0;
  return Math.log2(1 + count) / RETRIEVAL_BOOST_DENOMINATOR;
}

function computeStalenessPenalty(memory: MemoryEntry): number {
  if (memory.tier !== 'observation') return 1.0;
  const count = memory.fileChangeCount ?? 0;
  if (count === 0) return 1.0;
  return 0.3 + 0.7 * Math.exp(-0.25 * count);
}

interface ScoredMemory {
  memory: MemoryEntry;
  score: number;
  scoreBreakdown: MemoryScoreBreakdown;
  estimatedTokens: number;
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
  const tierWeight = TIER_WEIGHT[memory.tier];
  const retrievalBoost = computeRetrievalBoost(memory.id, retrievalCounts);
  const stalenessPenalty = computeStalenessPenalty(memory);

  const raw = ftsScores
    ? ftsRelevance * 0.5 + recency * 0.15 + tierWeight * 0.15 + fileProximity * 0.1 + retrievalBoost * 0.1
    : fileProximity * 0.4 + recency * 0.25 + tierWeight * 0.25 + retrievalBoost * 0.1;

  return {
    score: raw * stalenessPenalty,
    breakdown: { ftsRelevance, recency, tierWeight, fileProximity, retrievalBoost, stalenessPenalty },
  };
}

function normalizeForTier(
  memories: MemoryEntry[],
  rawRanks: Map<string, number>,
): Map<string, number> | null {
  const tierIds = new Set(memories.map(m => m.id));
  let min = Infinity, max = -Infinity;
  for (const [id, rank] of rawRanks) {
    if (!tierIds.has(id)) continue;
    if (rank < min) min = rank;
    if (rank > max) max = rank;
  }
  if (min === Infinity) return null;
  const range = max - min;
  const normalized = new Map<string, number>();
  for (const [id, rank] of rawRanks) {
    if (!tierIds.has(id)) continue;
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
  const ftsScores = rawFtsRanks ? normalizeForTier(filtered, rawFtsRanks) : null;
  const scored = filtered.map(m => {
    const { score, breakdown } = scoreMemory(m, ftsScores, activeFile, retrievalCounts);
    return { memory: m, score, scoreBreakdown: breakdown, estimatedTokens: estimateTokens(formatMemoryEntry(m)) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function formatMemoryEntry(m: MemoryEntry): string {
  if (m.tier === 'observation' && m.title) {
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
  if (m.tier === 'observation' && m.title) {
    const staleHint = (m.fileChangeCount ?? 0) >= STALENESS_THRESHOLD ? ' [stale]' : '';
    return `- [${m.id}] ${m.title}${staleHint}\n  ${m.content}`;
  }
  return `- [${m.id}] ${m.content}`;
}

function formatScoredList(scored: ScoredMemory[]): string {
  return scored.map(s => formatMemoryEntry(s.memory)).join('\n');
}

function buildTierMetadata(
  tier: MemoryTier,
  entryLimit: number,
  scored: ScoredMemory[],
  totalAvailable: number,
): MemoryTierInjection {
  const entries: MemoryInjectionEntry[] = scored.map(s => ({
    id: s.memory.id,
    tier: s.memory.tier,
    title: s.memory.title ?? null,
    content: s.memory.content,
    score: s.score,
    scoreBreakdown: s.scoreBreakdown,
    estimatedTokens: s.estimatedTokens,
    isStale: (s.memory.fileChangeCount ?? 0) >= STALENESS_THRESHOLD,
    isPinned: false,
  }));
  const tokensUsed = scored.reduce((sum, s) => sum + s.estimatedTokens, 0);
  return { tier, entryLimit, tokensUsed, entries, totalAvailable };
}

function buildFtsQuery(prompt: string): string | null {
  const tokens = prompt.trim().toLowerCase().split(/\s+/)
    .filter(t => t.length > 1 && !FTS_STOPWORDS.has(t))
    .map(t => t.replace(/[^a-z0-9._-]/g, ''))
    .filter(t => t.length > 0);

  const capped = tokens.slice(0, 32);
  if (capped.length === 0) return null;
  return capped.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export class InjectionManager {
  private managers: MemoryManagers;
  private db: DatabaseInstance;
  private firstMessageSessions: Set<string>;
  private injectionDbs = new Map<string, DatabaseInstance>();
  private pendingDbOpens = new Map<string, Promise<DatabaseInstance | undefined>>();

  constructor(managers: MemoryManagers, db: DatabaseInstance) {
    this.managers = managers;
    this.db = db;
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
    const now = Date.now();
    const stmt = this.db.prepare('INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, ?, ?)');
    for (const id of ids) {
      stmt.run(id, workspace, now);
    }
    const cutoff = now - THIRTY_DAYS_MS;
    this.db.prepare('DELETE FROM memory_retrievals WHERE retrieved_at < ?').run(cutoff);
  }

  getRetrievalCounts(workspace: string): Map<string, number> {
    const cutoff = Date.now() - THIRTY_DAYS_MS;

    const rows = this.db.prepare(
      'SELECT memory_id, COUNT(*) as count FROM memory_retrievals WHERE workspace = ? AND retrieved_at > ? GROUP BY memory_id'
    ).all(workspace, cutoff) as { memory_id: string; count: number }[];

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

    const ftsQuery = buildFtsQuery(userPrompt);
    if (!ftsQuery) return null;

    try {
      const params: unknown[] = [ftsQuery, workspace];
      let sessionClause = '';
      if (sessionId) {
        sessionClause = ' OR m.session_id = ?';
        params.push(sessionId);
      }

      const rows = this.db.prepare(`
        SELECT m.id, fts.rank
        FROM memories_fts fts
        JOIN memories m ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
          AND (m.workspace = ? ${sessionClause} OR m.tier = 'global')
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

  private loadPinnedMemories(workspace: string, sessionId: string | null): MemoryEntry[] {
    const params: unknown[] = [workspace];
    let sessionClause = '';
    if (sessionId) {
      sessionClause = ' OR session_id = ?';
      params.push(sessionId);
    }

    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE pinned = 1 AND (workspace = ? ${sessionClause} OR tier = 'global') ORDER BY updated_at DESC`
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

    const sessionMemories = sessionId ? this.managers.session.list(sessionId) : [];
    const projectMemories = this.managers.project.list(workspace);
    const globalMemories = this.managers.global.list();
    const recentObservations = this.managers.observation.getRecentForWorkspace(workspace, OBSERVATION_CANDIDATE_POOL_SIZE);

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

    const scoredSession = selectTopN(sessionMemories, sessionMemories.length, activeFile, ftsRanks, retrievalCounts, pinnedIds);
    const scoredProject = selectTopN(projectMemories, limits.project, activeFile, ftsRanks, retrievalCounts, pinnedIds);
    const scoredGlobal = selectTopN(globalMemories, limits.global, activeFile, ftsRanks, retrievalCounts, pinnedIds);
    const scoredObservations = selectTopN(recentObservations, limits.observation, activeFile, ftsRanks, retrievalCounts, pinnedIds);

    const hasContent = scoredSession.length > 0 || scoredProject.length > 0 ||
      scoredGlobal.length > 0 || scoredObservations.length > 0 || pinnedForInjection.length > 0;

    const handoffContext = this.buildHandoffContext(sessionId, workspace, activeFile, ftsRanks, retrievalCounts);

    const buildMetadata = (): MemoryInjectionDisplay => {
      const tierData: MemoryTierInjection[] = [
        buildTierMetadata('session', sessionMemories.length, scoredSession, sessionMemories.length),
        buildTierMetadata('project', limits.project, scoredProject, projectMemories.length),
        buildTierMetadata('global', limits.global, scoredGlobal, globalMemories.length),
        buildTierMetadata('observation', limits.observation, scoredObservations, recentObservations.length),
      ];
      const totalTokensUsed = tierData.reduce((sum, t) => sum + t.tokensUsed, 0) + pinnedTokensUsed;

      const pinnedEntries: MemoryInjectionEntry[] = pinnedForInjection.map(m => {
        const { score, breakdown } = scoreMemory(m, null, activeFile, retrievalCounts);
        return {
          id: m.id,
          tier: m.tier,
          title: m.title ?? null,
          content: m.content,
          score,
          scoreBreakdown: breakdown,
          estimatedTokens: estimateTokens(formatPinnedEntry(m)),
          isStale: (m.fileChangeCount ?? 0) >= STALENESS_THRESHOLD,
          isPinned: true,
        };
      });

      return {
        tiers: tierData,
        totalTokensUsed,
        ftsQuery: ftsResult?.ftsQuery ?? null,
        hasHandoffContext: !!handoffContext,
        pinnedEntries,
        pinnedBudget: limits.pinnedTokenBudget,
        pinnedTokensUsed,
      };
    };

    if (!hasContent) {
      return { context: handoffContext, metadata: buildMetadata() };
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

    const parts: string[] = [];
    parts.push(`<damocles_memory>\n${memoryParts.join('\n')}\n</damocles_memory>`);

    if (handoffContext) {
      parts.push(handoffContext);
    }

    return { context: parts.join('\n\n'), metadata: buildMetadata() };
  }

  private buildHandoffContext(
    sessionId: string | null,
    workspace: string,
    activeFile: string | null,
    ftsRanks: Map<string, number> | null,
    retrievalCounts: Map<string, number>,
  ): string {
    if (!sessionId || !this.isFirstMessageOfSession(sessionId)) return '';

    const recentObs = this.managers.observation.getRecentForWorkspace(workspace, 5);
    const ranked = selectTopN(recentObs, 5, activeFile, ftsRanks, retrievalCounts, new Set());
    if (ranked.length === 0) return '';

    return `<damocles_session_handoff>\n<relevant_observations>\n${formatScoredList(ranked)}\n</relevant_observations>\n</damocles_session_handoff>`;
  }
}
