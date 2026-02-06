import * as vscode from 'vscode';
import type { MemoryEntry, MemoryTier } from '@shared/types/memory';
import type { DatabaseInstance, FtsMatchRow } from '../types';
import { log } from '../../logger';
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

const TIER_WEIGHT: Record<MemoryTier, number> = {
  session: 1.0,
  project: 0.8,
  global: 0.6,
  observation: 0.5,
  note: 0.3,
};

function scoreMemoryFallback(memory: MemoryEntry, activeFile: string | null): number {
  const recency = 1 / (1 + (Date.now() - memory.updatedAt) / (24 * 60 * 60 * 1000));
  const fileProximity = activeFile && memoryMentionsFile(memory, activeFile) ? 1 : 0;
  const weight = TIER_WEIGHT[memory.tier];
  const accessBoost = Math.min((memory.accessCount ?? 0) / 10, 0.5);
  return fileProximity * 0.4 + recency * 0.3 + weight * 0.2 + accessBoost * 0.1;
}

function scoreMemoryWithPrompt(
  memory: MemoryEntry,
  ftsScores: Map<string, number>,
  activeFile: string | null,
): number {
  const ftsRelevance = ftsScores.get(memory.id) ?? 0;
  const recency = 1 / (1 + (Date.now() - memory.updatedAt) / (24 * 60 * 60 * 1000));
  const fileProximity = activeFile && memoryMentionsFile(memory, activeFile) ? 1 : 0;
  const weight = TIER_WEIGHT[memory.tier];
  const accessBoost = Math.min((memory.accessCount ?? 0) / 10, 0.5);
  return ftsRelevance * 0.4 + recency * 0.25 + weight * 0.15 + fileProximity * 0.1 + accessBoost * 0.1;
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
): MemoryEntry[] {
  const ftsScores = rawFtsRanks ? normalizeForTier(memories, rawFtsRanks) : null;
  const scored = memories.map(m => ({
    memory: m,
    score: ftsScores
      ? scoreMemoryWithPrompt(m, ftsScores, activeFile)
      : scoreMemoryFallback(m, activeFile),
  }));
  scored.sort((a, b) => b.score - a.score);

  const selected: MemoryEntry[] = [];
  let tokens = 0;
  for (const { memory } of scored) {
    const cost = estimateTokens(formatMemoryEntry(memory));
    if (tokens + cost > budget) break;
    selected.push(memory);
    tokens += cost;
  }
  return selected;
}

function formatMemoryEntry(m: MemoryEntry): string {
  if (m.tier === 'observation' && m.title) {
    const files = [...(m.filesRead ?? []), ...(m.filesModified ?? [])];
    const fileHint = files.length > 0 ? ` (${files.slice(0, 2).join(', ')})` : '';
    return `- [${m.id}] ${m.title}${fileHint}`;
  }
  return `- ${m.content}`;
}

function formatMemoryList(memories: MemoryEntry[]): string {
  return memories.map(formatMemoryEntry).join('\n');
}

const STOPWORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but',
  'his', 'by', 'from', 'they', 'we', 'her', 'she', 'or', 'an', 'will',
  'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up',
  'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make',
  'can', 'like', 'no', 'just', 'him', 'know', 'take', 'into', 'your',
  'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now', 'its',
  'also', 'after', 'how', 'our', 'two', 'way', 'did', 'has', 'am', 'is',
  'are', 'was', 'were', 'been', 'being', 'had', 'does', 'done', 'should',
  'help', 'please', 'want', 'need',
]);

function buildFtsQuery(prompt: string): string | null {
  const tokens = prompt.trim().toLowerCase().split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(t => t.replace(/[*^]/g, ''))
    .filter(t => t.length > 0)
    .slice(0, 16);
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export class InjectionManager {
  private managers: MemoryManagers;
  private db: DatabaseInstance;
  private firstMessageSessions: Set<string>;

  constructor(managers: MemoryManagers, db: DatabaseInstance) {
    this.managers = managers;
    this.db = db;
    this.firstMessageSessions = new Set();
  }

  isFirstMessageOfSession(sessionId: string): boolean {
    return !this.firstMessageSessions.has(sessionId);
  }

  markFirstMessageSent(sessionId: string): void {
    this.firstMessageSessions.add(sessionId);
  }

  private queryFtsRanks(userPrompt: string | undefined): Map<string, number> | null {
    if (!userPrompt) return null;

    const ftsQuery = buildFtsQuery(userPrompt);
    if (!ftsQuery) return null;

    try {
      const rows = this.db.prepare(`
        SELECT m.id, fts.rank
        FROM memories_fts fts
        JOIN memories m ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
      `).all(ftsQuery) as FtsMatchRow[];

      if (rows.length === 0) return null;

      const ranks = new Map<string, number>();
      for (const row of rows) {
        ranks.set(row.id, Math.abs(row.rank));
      }
      return ranks;
    } catch (err) {
      log(`[InjectionManager] FTS5 query failed, falling back to heuristic scoring: ${err}`);
      return null;
    }
  }

  buildInjectionContext(sessionId: string | null, workspace: string, activeFile: string | null, userPrompt?: string): string {
    const budgets = getBudgets();
    const ftsRanks = this.queryFtsRanks(userPrompt);
    const parts: string[] = [];

    const sessionMemories = sessionId ? this.managers.session.list(sessionId) : [];
    const projectMemories = this.managers.project.list(workspace);
    const globalMemories = this.managers.global.list();
    const recentObservations = sessionId ? this.managers.observation.getRecent(sessionId, 5) : [];

    const selectedSession = selectByBudget(sessionMemories, budgets.session, activeFile, ftsRanks);
    const selectedProject = selectByBudget(projectMemories, budgets.project, activeFile, ftsRanks);
    const selectedGlobal = selectByBudget(globalMemories, budgets.global, activeFile, ftsRanks);
    const selectedObservations = selectByBudget(recentObservations, budgets.observation, activeFile, ftsRanks);

    const hasContent = selectedSession.length > 0 || selectedProject.length > 0 ||
      selectedGlobal.length > 0 || selectedObservations.length > 0;

    if (!hasContent) {
      return this.buildHandoffContext(sessionId, workspace, activeFile, budgets, ftsRanks);
    }

    const memoryParts: string[] = [];

    if (selectedSession.length > 0) {
      memoryParts.push(`<session_memories>\n${formatMemoryList(selectedSession)}\n</session_memories>`);
    }
    if (selectedProject.length > 0) {
      memoryParts.push(`<project_memories>\n${formatMemoryList(selectedProject)}\n</project_memories>`);
    }
    if (selectedGlobal.length > 0) {
      memoryParts.push(`<global_memories>\n${formatMemoryList(selectedGlobal)}\n</global_memories>`);
    }
    if (selectedObservations.length > 0) {
      memoryParts.push(`<recent_observations count="${selectedObservations.length}">\n${formatMemoryList(selectedObservations)}\n</recent_observations>`);
    }

    parts.push(`<damocles_memory>\n${memoryParts.join('\n')}\n</damocles_memory>`);

    const handoffContext = this.buildHandoffContext(sessionId, workspace, activeFile, budgets, ftsRanks);
    if (handoffContext) {
      parts.push(handoffContext);
    }

    return parts.join('\n\n');
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

    return `<damocles_session_handoff>\n<relevant_observations>\n${formatMemoryList(ranked)}\n</relevant_observations>\n</damocles_session_handoff>`;
  }
}
