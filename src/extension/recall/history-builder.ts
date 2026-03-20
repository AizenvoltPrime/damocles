import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';
import { readSessionEntries } from '../session';
import { getSessionDir, getSessionFilePath } from '../session/paths';
import { readSessionFileLines, parseAllSessionEntries } from '../session/parsing';
import type { ClaudeSessionEntry, JsonlContentBlock } from '../session/types';
import { isContentBlockArray } from '../session/types';
import type { StructuredTurn, ToolCallRecord, TurnContentBlock, RecallTrajectory, NodeState, TaskNode, NodeSummary } from './types';
import { extractFilesTouched } from './types';
import { parseAgentResult } from './agent-text';

export interface SessionLeafState {
  leafUuid: string | null;
  lastUserUuid: string | null;
  planFilePath: string | null;
}

export interface SessionData {
  history: StructuredTurn[];
  trajectories: Map<number, RecallTrajectory>;
  leafState: SessionLeafState;
  nodeState: NodeState;
}

export async function readNodeFileEntries(workspacePath: string, sessionId: string): Promise<ClaudeSessionEntry[]> {
  try {
    const sessionDir = await getSessionDir(workspacePath);
    const nodesDir = path.join(sessionDir, sessionId, 'nodes');
    const files = await fs.promises.readdir(nodesDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    const allNodeEntries: ClaudeSessionEntry[] = [];
    for (const file of jsonlFiles) {
      try {
        const lines = await readSessionFileLines(path.join(nodesDir, file));
        const entries = parseAllSessionEntries(lines);
        allNodeEntries.push(...entries);
      } catch {
        continue;
      }
    }

    return allNodeEntries;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

export function mergeEntriesByTimestamp(main: ClaudeSessionEntry[], node: ClaudeSessionEntry[]): ClaudeSessionEntry[] {
  const filtered = main.filter(e => e.type !== 'node-turn-ref');
  const nodeFiltered = node.filter(e => e.type !== 'queue-operation');
  const combined = [...filtered, ...nodeFiltered];
  const timeCache = new Map<ClaudeSessionEntry, number>();
  for (const entry of combined) {
    timeCache.set(entry, entry.timestamp ? new Date(entry.timestamp).getTime() : 0);
  }
  combined.sort((a, b) => timeCache.get(a)! - timeCache.get(b)!);
  return combined;
}

export async function buildSessionData(workspacePath: string, sessionId: string): Promise<SessionData> {
  const mainEntries = await readSessionEntries(workspacePath, sessionId);
  const nodeEntries = await readNodeFileEntries(workspacePath, sessionId);
  const entries = nodeEntries.length > 0
    ? mergeEntriesByTimestamp(mainEntries, nodeEntries)
    : mainEntries;
  const nodeState = extractNodeState(entries);
  const history = buildHistoryFromEntries(entries);
  applyNodeIdsToHistory(history, nodeState);
  applyTurnIndices(history, entries);
  return {
    history,
    trajectories: extractTrajectoriesFromEntries(entries),
    leafState: extractLeafState(mainEntries),
    nodeState,
  };
}

export function extractNodeState(entries: ClaudeSessionEntry[]): NodeState {
  const defaultState: NodeState = { nodes: [], activeNodeId: null };

  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = entries[i] as unknown as Record<string, unknown>;
    if (raw['type'] === 'node-state' && typeof raw['data'] === 'string') {
      try {
        const parsed = JSON.parse(raw['data'] as string) as NodeState;
        if (parsed && Array.isArray(parsed.nodes)) {
          return parsed;
        }
      } catch {
        log('[HistoryBuilder] Failed to parse node-state checkpoint');
      }
    }
  }

  const nodes = new Map<string, TaskNode>();
  let activeNodeId: string | null = null;

  for (const entry of entries) {
    const raw = entry as unknown as Record<string, unknown>;
    const type = raw['type'] as string;

    if (type === 'node-created') {
      const nodeId = raw['nodeId'] as string;
      nodes.set(nodeId, {
        nodeId,
        title: (raw['title'] as string) ?? 'Untitled',
        status: 'ACTIVE',
        keyEntities: (raw['keyEntities'] as string[]) ?? [],
        turnIndices: [],
        createdAt: (raw['timestamp'] as string) ?? new Date().toISOString(),
        closedAt: null,
        summary: null,
        relatedClosedNodeIds: [],
        manuallyDisconnectedNodeIds: [],
        seedContext: null,
        seedContextPrompt: null,
      });
      activeNodeId = nodeId;
    }

    if (type === 'node-closed') {
      const nodeId = raw['nodeId'] as string;
      const node = nodes.get(nodeId);
      if (node) {
        node.status = 'CLOSED';
        node.closedAt = (raw['timestamp'] as string) ?? new Date().toISOString();
        node.summary = (raw['summary'] as NodeSummary) ?? null;
        if (activeNodeId === nodeId) activeNodeId = null;
      }
    }

    if (type === 'node-reopened') {
      const nodeId = raw['nodeId'] as string;
      const node = nodes.get(nodeId);
      if (node) {
        node.status = 'ACTIVE';
        node.closedAt = null;
        node.summary = null;
        activeNodeId = nodeId;
      }
    }

    if (type === 'node-seed-context') {
      const nodeId = raw['nodeId'] as string;
      const node = nodes.get(nodeId);
      if (node && typeof raw['seedContext'] === 'string') {
        node.seedContext = raw['seedContext'] as string;
        node.seedContextPrompt = typeof raw['seedContextPrompt'] === 'string'
          ? raw['seedContextPrompt'] as string
          : null;
      }
    }
  }

  if (nodes.size === 0) return defaultState;

  log('[HistoryBuilder] Reconstructed %d nodes from entries (no checkpoint) — turnIndices will be empty, turns may appear as orphans', nodes.size);
  return { nodes: [...nodes.values()], activeNodeId };
}

function applyNodeIdsToHistory(history: StructuredTurn[], nodeState: NodeState): void {
  const indexToNodeId = new Map<number, string>();
  for (const node of nodeState.nodes) {
    for (const idx of node.turnIndices) {
      indexToNodeId.set(idx, node.nodeId);
    }
  }
  for (const turn of history) {
    if (turn.nodeId === null || turn.nodeId === undefined) {
      const mapped = indexToNodeId.get(turn.promptIndex);
      if (mapped) turn.nodeId = mapped;
    }
  }
}

export function applyTurnIndices(history: StructuredTurn[], entries: ClaudeSessionEntry[]): void {
  const indexMap = new Map<number, { summary: string; keywords: string[] }>();
  for (const entry of entries) {
    const raw = entry as unknown as Record<string, unknown>;
    if (raw['type'] === 'turn-index' && typeof raw['promptIndex'] === 'number') {
      const rawKeywords = raw['keywords'];
      indexMap.set(raw['promptIndex'] as number, {
        summary: (raw['summary'] as string) ?? '',
        keywords: Array.isArray(rawKeywords) ? rawKeywords as string[] : [],
      });
    }
  }
  for (const turn of history) {
    const idx = indexMap.get(turn.promptIndex);
    if (idx) {
      turn.summary = idx.summary;
      turn.keywords = idx.keywords;
    }
  }
}

function normalizeTrajectory(raw: RecallTrajectory): RecallTrajectory {
  return {
    ...raw,
    contextTurns: raw.contextTurns ?? [],
    seedContext: raw.seedContext ?? null,
    relatedSummaries: raw.relatedSummaries ?? [],
    orientation: raw.orientation ?? null,
  };
}

export function extractTrajectoriesFromEntries(entries: ClaudeSessionEntry[]): Map<number, RecallTrajectory> {
  const trajectories = new Map<number, RecallTrajectory>();
  for (const entry of entries) {
    if (entry.type === 'recall-trajectory') {
      const raw = entry as unknown as { promptIndex: number; trajectory: RecallTrajectory };
      if (typeof raw.promptIndex === 'number' && raw.trajectory) {
        trajectories.set(raw.promptIndex, normalizeTrajectory(raw.trajectory));
      }
    }
  }
  return trajectories;
}

export function extractLeafState(entries: ClaudeSessionEntry[]): SessionLeafState {
  let leafUuid: string | null = null;
  let lastUserUuid: string | null = null;
  let planFilePath: string | null = null;

  for (const entry of entries) {
    if (entry.type === 'plan-path' && entry.planPath) {
      planFilePath = entry.planPath;
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry?.uuid) continue;

    if (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'node-turn-ref') {
      if (!leafUuid) {
        leafUuid = entry.uuid;
      }
      if (!lastUserUuid && (entry.type === 'user' || entry.type === 'node-turn-ref')) {
        lastUserUuid = entry.uuid;
      }
      if (leafUuid && lastUserUuid) break;
    }
  }

  return { leafUuid, lastUserUuid, planFilePath };
}

function extractToolResultContent(name: string, rawContent: string | unknown): string {
  const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
  if (name === 'Agent') {
    const parts = parseAgentResult(content);
    if (parts) {
      const prefix = parts.prompt ? `[Agent prompt: ${parts.prompt}]\n` : '';
      return prefix + parts.texts.join('\n');
    }
  }
  return content;
}

export function buildHistoryFromEntries(entries: ClaudeSessionEntry[]): StructuredTurn[] {
  const turns: StructuredTurn[] = [];
  let currentUser: { text: string; timestamp: string } | null = null;
  let assistantResponse = '';
  let toolCalls: ToolCallRecord[] = [];
  let contentBlocks: TurnContentBlock[] = [];
  let promptIndex = 0;
  const pendingToolCalls = new Map<string, ToolCallRecord>();
  const earlyToolResults = new Map<string, string | unknown>();
  const seenToolUseIds = new Set<string>();

  function flushTurn(): void {
    if (!currentUser) return;
    turns.push({
      promptIndex,
      timestamp: currentUser.timestamp,
      userMessage: currentUser.text,
      assistantResponse,
      toolCalls,
      contentBlocks,
      thinkingBlocks: [],
      filesTouched: extractFilesTouched(toolCalls),
      nodeId: null,
      summary: null,
      keywords: null,
    });
    promptIndex++;
    currentUser = null;
    assistantResponse = '';
    toolCalls = [];
    contentBlocks = [];
    pendingToolCalls.clear();
    earlyToolResults.clear();
    seenToolUseIds.clear();
  }

  for (const entry of entries) {
    if (entry.type === 'user' && entry.message && !entry.isMeta && !entry.isInjected) {
      const content = entry.message.content;

      if (Array.isArray(content)) {
        const blocks = content as JsonlContentBlock[];
        const hasToolResult = blocks.some(b => b.type === 'tool_result');
        if (hasToolResult) {
          for (const block of blocks) {
            if (block.type === 'tool_result') {
              const pending = pendingToolCalls.get(block.tool_use_id);
              if (pending) {
                pending.result = extractToolResultContent(pending.name, block.content);
                pendingToolCalls.delete(block.tool_use_id);
              } else {
                earlyToolResults.set(block.tool_use_id, block.content);
              }
            }
          }
          continue;
        }

        const textBlock = blocks.find((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string');
        if (textBlock) {
          flushTurn();
          currentUser = { text: textBlock.text, timestamp: entry.timestamp ?? new Date().toISOString() };
        }
      } else if (typeof content === 'string') {
        flushTurn();
        currentUser = { text: content, timestamp: entry.timestamp ?? new Date().toISOString() };
      }
    }

    if (entry.type === 'assistant' && entry.message && currentUser) {
      const content = entry.message.content;
      if (isContentBlockArray(content)) {
        for (const block of content as JsonlContentBlock[]) {
          if (block.type === 'text') {
            assistantResponse += block.text;
            const last = contentBlocks[contentBlocks.length - 1];
            if (last && last.type === 'text') {
              last.content += block.text;
            } else {
              contentBlocks.push({ type: 'text', content: block.text });
            }
          } else if (block.type === 'tool_use') {
            if (seenToolUseIds.has(block.id)) continue;
            seenToolUseIds.add(block.id);

            const record: ToolCallRecord = {
              name: block.name,
              input: block.input,
              result: '',
            };

            const earlyResult = earlyToolResults.get(block.id);
            if (earlyResult !== undefined) {
              record.result = extractToolResultContent(record.name, earlyResult);
              earlyToolResults.delete(block.id);
            } else {
              pendingToolCalls.set(block.id, record);
            }

            const index = toolCalls.length;
            toolCalls.push(record);
            contentBlocks.push({ type: 'tool_call', index });
          }
        }
      }
    }
  }

  flushTurn();

  log('[HistoryBuilder] Built %d turns from session %s', turns.length, entries[0]?.sessionId ?? 'unknown');
  return turns;
}

export function isRecallFromEntries(entries: ClaudeSessionEntry[]): boolean {
  for (const entry of entries.slice(0, 10)) {
    if (entry.type === 'context-strategy' && (entry as unknown as Record<string, unknown>)['contextStrategy'] === 'recall') {
      return true;
    }
  }
  return false;
}

export async function isRecallSession(workspacePath: string, sessionId: string): Promise<boolean> {
  try {
    const filePath = await getSessionFilePath(workspacePath, sessionId);
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const limit = Math.min(lines.length, 15);
    for (let i = 0; i < limit; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry['type'] === 'context-strategy' && entry['contextStrategy'] === 'recall') {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}
