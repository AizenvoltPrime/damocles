import * as vscode from 'vscode';
import type { MemoryEntry, MemoryTier } from '@shared/types/memory';
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

function scoreMemory(memory: MemoryEntry, activeFile: string | null): number {
  const recency = 1 / (1 + (Date.now() - memory.updatedAt) / (24 * 60 * 60 * 1000));
  const fileProximity = activeFile && memoryMentionsFile(memory, activeFile) ? 1 : 0;
  const tierWeight: Record<MemoryTier, number> = {
    session: 1.0,
    project: 0.8,
    global: 0.6,
    observation: 0.5,
    note: 0.3,
  };
  const weight = tierWeight[memory.tier];
  const accessBoost = Math.min((memory.accessCount ?? 0) / 10, 0.5);
  return fileProximity * 0.4 + recency * 0.3 + weight * 0.2 + accessBoost * 0.1;
}

function selectByBudget(memories: MemoryEntry[], budget: number, activeFile: string | null): MemoryEntry[] {
  const scored = memories.map(m => ({ memory: m, score: scoreMemory(m, activeFile) }));
  scored.sort((a, b) => b.score - a.score);

  const selected: MemoryEntry[] = [];
  let tokens = 0;
  for (const { memory } of scored) {
    const cost = estimateTokens(memory.content);
    if (tokens + cost > budget) break;
    selected.push(memory);
    tokens += cost;
  }
  return selected;
}

function formatMemoryList(memories: MemoryEntry[]): string {
  return memories.map(m => {
    if (m.tier === 'observation' && m.title) {
      const files = [...(m.filesRead ?? []), ...(m.filesModified ?? [])];
      const fileHint = files.length > 0 ? ` (${files.slice(0, 2).join(', ')})` : '';
      return `- ${m.title}${fileHint}`;
    }
    return `- ${m.content}`;
  }).join('\n');
}

export class InjectionManager {
  private managers: MemoryManagers;
  private firstMessageSessions: Set<string>;

  constructor(managers: MemoryManagers) {
    this.managers = managers;
    this.firstMessageSessions = new Set();
  }

  isFirstMessageOfSession(sessionId: string): boolean {
    return !this.firstMessageSessions.has(sessionId);
  }

  markFirstMessageSent(sessionId: string): void {
    this.firstMessageSessions.add(sessionId);
  }

  buildInjectionContext(sessionId: string | null, workspace: string, activeFile: string | null): string {
    const budgets = getBudgets();
    const parts: string[] = [];

    const sessionMemories = sessionId ? this.managers.session.list(sessionId) : [];
    const projectMemories = this.managers.project.list(workspace);
    const globalMemories = this.managers.global.list();
    const recentObservations = sessionId ? this.managers.observation.getRecent(sessionId, 5) : [];

    const selectedSession = selectByBudget(sessionMemories, budgets.session, activeFile);
    const selectedProject = selectByBudget(projectMemories, budgets.project, activeFile);
    const selectedGlobal = selectByBudget(globalMemories, budgets.global, activeFile);
    const selectedObservations = selectByBudget(recentObservations, budgets.observation, activeFile);

    const hasContent = selectedSession.length > 0 || selectedProject.length > 0 ||
      selectedGlobal.length > 0 || selectedObservations.length > 0;

    if (!hasContent) {
      return this.buildHandoffContext(sessionId, workspace, activeFile, budgets);
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

    const handoffContext = this.buildHandoffContext(sessionId, workspace, activeFile, budgets);
    if (handoffContext) {
      parts.push(handoffContext);
    }

    return parts.join('\n\n');
  }

  private buildHandoffContext(sessionId: string | null, workspace: string, activeFile: string | null, budgets: TierBudgets): string {
    if (!sessionId || !this.isFirstMessageOfSession(sessionId)) return '';

    const recentObs = this.managers.observation.getRecentForWorkspace(workspace, 5);
    const ranked = selectByBudget(recentObs, budgets.observation, activeFile);
    if (ranked.length === 0) return '';

    return `<damocles_session_handoff>\n<relevant_observations>\n${formatMemoryList(ranked)}\n</relevant_observations>\n</damocles_session_handoff>`;
  }
}
