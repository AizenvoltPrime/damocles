import * as vscode from 'vscode';
import type { MemoryEntry, MemoryTier } from '@shared/types/memory';
import type { MemoryInjectionDisplay, MemoryInjectionEntry, MemoryTierInjection, MemoryScoreBreakdown, QueryExpansionMode, ExpansionDecision } from '@shared/types/context-injection';
import type { DatabaseInstance, FtsMatchRow } from '../types';
import { log } from '../../logger';
import { RetrievalConfidenceTracker } from '../../shared/retrieval-confidence';
import { expandQuery } from '../query-expansion';
import { FTS_STOPWORDS } from '../../shared/fts-stopwords';
import { openInjectionDatabase, insertMemoryInjection, getMemoryInjection as getPersistedMemoryInjection } from '../injection-database';
import { SessionMemoryManager } from './session-memory-manager';
import { ProjectMemoryManager } from './project-memory-manager';
import { GlobalMemoryManager } from './global-memory-manager';
import { ObservationManager } from './observation-manager';

interface TierBudgets {
  session: number;
  project: number;
  global: number;
  observation: number;
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

function getBudgets(): TierBudgets {
  const config = vscode.workspace.getConfiguration('damocles.memory');
  return {
    session: config.get<number>('sessionTokenBudget', 1000),
    project: config.get<number>('projectTokenBudget', 800),
    global: config.get<number>('globalTokenBudget', 500),
    observation: config.get<number>('observationTokenBudget', 500),
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
const ACCESS_BOOST_DENOMINATOR = Math.log2(21);
const EXPANSION_MATCH_RATIO_THRESHOLD = 0.15;
const EXPANSION_MIN_STORE_SIZE = 15;
const STALENESS_THRESHOLD = 3;

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

function computeAccessBoost(accessCount: number, recency: number): number {
  return (Math.log2(1 + accessCount) / ACCESS_BOOST_DENOMINATOR) * recency;
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
): { score: number; breakdown: MemoryScoreBreakdown } {
  const ftsRelevance = ftsScores?.get(memory.id) ?? 0;
  const recency = computeRecency(memory.updatedAt);
  const fileProximity = activeFile && memoryMentionsFile(memory, activeFile) ? 1 : 0;
  const tierWeight = TIER_WEIGHT[memory.tier];
  const accessBoost = computeAccessBoost(memory.accessCount ?? 0, recency);
  const stalenessPenalty = computeStalenessPenalty(memory);

  const raw = ftsScores
    ? ftsRelevance * 0.5 + recency * 0.15 + tierWeight * 0.15 + fileProximity * 0.1 + accessBoost * 0.1
    : fileProximity * 0.4 + recency * 0.25 + tierWeight * 0.25 + accessBoost * 0.1;

  return {
    score: raw * stalenessPenalty,
    breakdown: { ftsRelevance, recency, tierWeight, fileProximity, accessBoost, stalenessPenalty },
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

function selectByBudget(
  memories: MemoryEntry[],
  budget: number,
  activeFile: string | null,
  rawFtsRanks: Map<string, number> | null,
): ScoredMemory[] {
  const ftsScores = rawFtsRanks ? normalizeForTier(memories, rawFtsRanks) : null;
  const scored = memories.map(m => {
    const { score, breakdown } = scoreMemory(m, ftsScores, activeFile);
    return { memory: m, score, scoreBreakdown: breakdown, estimatedTokens: 0 };
  });
  scored.sort((a, b) => b.score - a.score);

  const selected: ScoredMemory[] = [];
  let tokens = 0;
  for (const item of scored) {
    const cost = estimateTokens(formatMemoryEntry(item.memory));
    if (tokens + cost > budget) break;
    item.estimatedTokens = cost;
    selected.push(item);
    tokens += cost;
  }
  return selected;
}

function formatMemoryEntry(m: MemoryEntry): string {
  if (m.tier === 'observation' && m.title) {
    const files = [...(m.filesRead ?? []), ...(m.filesModified ?? [])];
    const fileHint = files.length > 0 ? ` (${files.slice(0, 2).join(', ')})` : '';
    const staleHint = (m.fileChangeCount ?? 0) >= STALENESS_THRESHOLD ? ' [stale]' : '';
    return `- [${m.id}] ${m.title}${fileHint}${staleHint}`;
  }
  return `- ${m.content}`;
}

function formatScoredList(scored: ScoredMemory[]): string {
  return scored.map(s => formatMemoryEntry(s.memory)).join('\n');
}

function buildTierMetadata(
  tier: MemoryTier,
  baseBudget: number,
  effectiveBudget: number,
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
  }));
  const tokensUsed = scored.reduce((sum, s) => sum + s.estimatedTokens, 0);
  return { tier, budget: baseBudget, effectiveBudget, tokensUsed, entries, totalAvailable };
}


function getQueryExpansionMode(): QueryExpansionMode {
  const config = vscode.workspace.getConfiguration('damocles.memory');
  return config.get<QueryExpansionMode>('queryExpansion', 'adaptive');
}

function shouldExpand(firstPassMatchCount: number, totalCandidates: number): { expand: boolean; reason: string } {
  if (totalCandidates < EXPANSION_MIN_STORE_SIZE) return { expand: false, reason: `store too small (<${EXPANSION_MIN_STORE_SIZE} entries)` };
  if (firstPassMatchCount === 0) return { expand: true, reason: 'zero matches from ' + totalCandidates + ' entries' };
  const ratio = firstPassMatchCount / totalCandidates;
  if (ratio >= EXPANSION_MATCH_RATIO_THRESHOLD) return { expand: false, reason: 'match ratio ' + ratio.toFixed(2) + ' >= ' + EXPANSION_MATCH_RATIO_THRESHOLD };
  return { expand: true, reason: 'match ratio ' + ratio.toFixed(2) + ' < ' + EXPANSION_MATCH_RATIO_THRESHOLD };
}

function buildFtsQuery(prompt: string, expandedTerms?: string[]): string | null {
  const tokens = prompt.trim().toLowerCase().split(/\s+/)
    .filter(t => t.length > 1 && !FTS_STOPWORDS.has(t))
    .map(t => t.replace(/[^a-z0-9._-]/g, ''))
    .filter(t => t.length > 0);

  if (expandedTerms && expandedTerms.length > 0) {
    const expandedTokens = expandedTerms.flatMap(term =>
      term.trim().toLowerCase().split(/\s+/)
        .filter(t => t.length > 1 && !FTS_STOPWORDS.has(t))
        .map(t => t.replace(/[^a-z0-9._-]/g, ''))
        .filter(t => t.length > 0)
    );
    const existing = new Set(tokens);
    for (const t of expandedTokens) {
      if (!existing.has(t)) {
        tokens.push(t);
        existing.add(t);
      }
    }
  }

  const capped = tokens.slice(0, 32);
  if (capped.length === 0) return null;
  return capped.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export class InjectionManager {
  private managers: MemoryManagers;
  private db: DatabaseInstance;
  private firstMessageSessions: Set<string>;
  private confidenceTrackers = new Map<string, RetrievalConfidenceTracker>();
  private injectionDbs = new Map<string, DatabaseInstance>();

  constructor(managers: MemoryManagers, db: DatabaseInstance) {
    this.managers = managers;
    this.db = db;
    this.firstMessageSessions = new Set();
  }

  persistInjection(sessionId: string, promptIndex: number, display: MemoryInjectionDisplay): void {
    try {
      const db = this.getOrOpenInjectionDb(sessionId);
      if (!db) return;
      insertMemoryInjection(db, promptIndex, display);
    } catch (err) {
      log('[InjectionManager] Failed to persist injection for session %s prompt %d: %O', sessionId, promptIndex, err);
    }
  }

  getPersistedInjection(sessionId: string, promptIndex: number): MemoryInjectionDisplay | undefined {
    try {
      const db = this.getOrOpenInjectionDb(sessionId);
      if (!db) return undefined;
      return getPersistedMemoryInjection(db, promptIndex);
    } catch (err) {
      log('[InjectionManager] Failed to retrieve injection for session %s prompt %d: %O', sessionId, promptIndex, err);
      return undefined;
    }
  }

  private getOrOpenInjectionDb(sessionId: string): DatabaseInstance | undefined {
    let db = this.injectionDbs.get(sessionId);
    if (!db) {
      db = openInjectionDatabase(sessionId);
      if (!db) return undefined;
      this.injectionDbs.set(sessionId, db);
    }
    return db;
  }

  closeInjectionDatabases(): void {
    for (const db of this.injectionDbs.values()) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
    this.injectionDbs.clear();
  }

  isFirstMessageOfSession(sessionId: string): boolean {
    return !this.firstMessageSessions.has(sessionId);
  }

  markFirstMessageSent(sessionId: string): void {
    this.firstMessageSessions.add(sessionId);
  }

  private getConfidenceTracker(workspace: string): RetrievalConfidenceTracker {
    let tracker = this.confidenceTrackers.get(workspace);
    if (!tracker) {
      tracker = new RetrievalConfidenceTracker(this.db, 'memory', workspace);
      this.confidenceTrackers.set(workspace, tracker);
    }
    return tracker;
  }

  private queryFtsRanks(
    userPrompt: string | undefined,
    workspace: string,
    sessionId: string | null,
    expandedTerms?: string[],
  ): { ranks: Map<string, number>; rawScores: number[]; ftsQuery: string } | null {
    if (!userPrompt) return null;

    const ftsQuery = buildFtsQuery(userPrompt, expandedTerms);
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
      const rawScores: number[] = [];
      for (const row of rows) {
        const absRank = Math.abs(row.rank);
        ranks.set(row.id, absRank);
        rawScores.push(absRank);
      }
      return { ranks, rawScores, ftsQuery };
    } catch (err) {
      log(`[InjectionManager] FTS5 query failed, falling back to heuristic scoring: ${err}`);
      return null;
    }
  }

  async buildInjectionContext(
    sessionId: string | null,
    workspace: string,
    activeFile: string | null,
    userPrompt?: string,
  ): Promise<{ context: string; metadata: MemoryInjectionDisplay | null }> {
    const expansionMode = getQueryExpansionMode();
    const baseBudgets = getBudgets();

    const sessionMemories = sessionId ? this.managers.session.list(sessionId) : [];
    const projectMemories = this.managers.project.list(workspace);
    const globalMemories = this.managers.global.list();
    const recentObservations = sessionId ? this.managers.observation.getRecent(sessionId, 5) : [];
    const totalCandidates = sessionMemories.length + projectMemories.length + globalMemories.length + recentObservations.length;

    let expandedTerms: string[] | undefined;
    let ftsResult: ReturnType<InjectionManager['queryFtsRanks']> = null;
    let expansionDecision: ExpansionDecision | null = null;

    if (expansionMode === 'always' && userPrompt) {
      expandedTerms = await expandQuery(userPrompt);
      ftsResult = this.queryFtsRanks(userPrompt, workspace, sessionId, expandedTerms);
      expansionDecision = {
        mode: 'always',
        triggered: (expandedTerms?.length ?? 0) > 0,
        reason: null,
        firstPassMatches: 0,
        firstPassCandidates: totalCandidates,
      };
    } else if (expansionMode === 'adaptive' && userPrompt) {
      const firstPass = this.queryFtsRanks(userPrompt, workspace, sessionId);
      const firstPassMatches = firstPass?.ranks.size ?? 0;
      const decision = shouldExpand(firstPassMatches, totalCandidates);

      if (decision.expand) {
        expandedTerms = await expandQuery(userPrompt);
        ftsResult = expandedTerms.length > 0 ? this.queryFtsRanks(userPrompt, workspace, sessionId, expandedTerms) : firstPass;
      } else {
        ftsResult = firstPass;
      }

      expansionDecision = {
        mode: 'adaptive',
        triggered: decision.expand && (expandedTerms?.length ?? 0) > 0,
        reason: decision.reason,
        firstPassMatches,
        firstPassCandidates: totalCandidates,
      };
    } else {
      ftsResult = this.queryFtsRanks(userPrompt, workspace, sessionId);
      if (expansionMode === 'off') {
        expansionDecision = {
          mode: 'off',
          triggered: false,
          reason: null,
          firstPassMatches: ftsResult?.ranks.size ?? 0,
          firstPassCandidates: totalCandidates,
        };
      }
    }

    const ftsRanks = ftsResult?.ranks ?? null;

    let confidenceMultiplier = 1.0;
    if (ftsResult) {
      const tracker = this.getConfidenceTracker(workspace);
      confidenceMultiplier = tracker.computeConfidence(ftsResult.rawScores, totalCandidates);
      tracker.recordQueryScores(ftsResult.rawScores, totalCandidates);
      log('[InjectionManager] Confidence: %s (scores=%d, candidates=%d, expansion=%s)',
        confidenceMultiplier.toFixed(2), ftsResult.rawScores.length, totalCandidates, expansionDecision?.mode ?? 'none');
    }

    const budgets = this.scaleBudgets(baseBudgets, confidenceMultiplier);

    const scoredSession = selectByBudget(sessionMemories, budgets.session, activeFile, ftsRanks);
    const scoredProject = selectByBudget(projectMemories, budgets.project, activeFile, ftsRanks);
    const scoredGlobal = selectByBudget(globalMemories, budgets.global, activeFile, ftsRanks);
    const scoredObservations = selectByBudget(recentObservations, budgets.observation, activeFile, ftsRanks);

    const hasContent = scoredSession.length > 0 || scoredProject.length > 0 ||
      scoredGlobal.length > 0 || scoredObservations.length > 0;

    const handoffContext = this.buildHandoffContext(sessionId, workspace, activeFile, budgets, ftsRanks);

    const buildMetadata = (): MemoryInjectionDisplay => {
      const tierData: MemoryTierInjection[] = [
        buildTierMetadata('session', baseBudgets.session, budgets.session, scoredSession, sessionMemories.length),
        buildTierMetadata('project', baseBudgets.project, budgets.project, scoredProject, projectMemories.length),
        buildTierMetadata('global', baseBudgets.global, budgets.global, scoredGlobal, globalMemories.length),
        buildTierMetadata('observation', baseBudgets.observation, budgets.observation, scoredObservations, recentObservations.length),
      ];
      const totalTokensUsed = tierData.reduce((sum, t) => sum + t.tokensUsed, 0);
      const totalBudget = budgets.session + budgets.project + budgets.global + budgets.observation;
      return {
        tiers: tierData,
        totalTokensUsed,
        totalBudget,
        ftsQuery: ftsResult?.ftsQuery ?? null,
        expandedTerms: expandedTerms ?? null,
        confidenceMultiplier,
        hasHandoffContext: !!handoffContext,
        expansionDecision,
      };
    };

    if (!hasContent) {
      return { context: handoffContext, metadata: buildMetadata() };
    }

    const parts: string[] = [];
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
      memoryParts.push(`<recent_observations count="${scoredObservations.length}">\n${formatScoredList(scoredObservations)}\n</recent_observations>`);
    }

    parts.push(`<damocles_memory>\n${memoryParts.join('\n')}\n</damocles_memory>`);

    if (handoffContext) {
      parts.push(handoffContext);
    }

    return { context: parts.join('\n\n'), metadata: buildMetadata() };
  }

  private scaleBudgets(base: TierBudgets, confidenceMultiplier: number): TierBudgets {
    return {
      session: Math.max(100, Math.floor(base.session * confidenceMultiplier)),
      project: Math.max(100, Math.floor(base.project * confidenceMultiplier)),
      global: Math.max(100, Math.floor(base.global * confidenceMultiplier)),
      observation: Math.max(100, Math.floor(base.observation * confidenceMultiplier)),
    };
  }

  private buildHandoffContext(
    sessionId: string | null,
    workspace: string,
    activeFile: string | null,
    budgets: TierBudgets,
    ftsRanks: Map<string, number> | null,
  ): string {
    if (!sessionId || !this.isFirstMessageOfSession(sessionId)) return '';

    const recentObs = this.managers.observation.getRecentForWorkspace(workspace, 5);
    const ranked = selectByBudget(recentObs, budgets.observation, activeFile, ftsRanks);
    if (ranked.length === 0) return '';

    return `<damocles_session_handoff>\n<relevant_observations>\n${formatScoredList(ranked)}\n</relevant_observations>\n</damocles_session_handoff>`;
  }
}
