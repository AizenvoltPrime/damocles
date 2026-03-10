import * as fs from 'fs';
import { log } from '../logger';
import { readSessionEntries } from '../session';
import { getSessionFilePath } from '../session/paths';
import type { ClaudeSessionEntry, JsonlContentBlock } from '../session/types';
import { isContentBlockArray } from '../session/types';
import type { StructuredTurn, ToolCallRecord, RecallTrajectory } from './types';

export interface SessionLeafState {
  leafUuid: string | null;
  lastUserUuid: string | null;
  planFilePath: string | null;
}

export interface SessionData {
  history: StructuredTurn[];
  trajectories: Map<number, RecallTrajectory>;
  leafState: SessionLeafState;
}

export async function buildSessionData(workspacePath: string, sessionId: string): Promise<SessionData> {
  const entries = await readSessionEntries(workspacePath, sessionId);
  return {
    history: buildHistoryFromEntries(entries),
    trajectories: extractTrajectoriesFromEntries(entries),
    leafState: extractLeafState(entries),
  };
}

export function extractTrajectoriesFromEntries(entries: ClaudeSessionEntry[]): Map<number, RecallTrajectory> {
  const trajectories = new Map<number, RecallTrajectory>();
  for (const entry of entries) {
    if (entry.type === 'recall-trajectory') {
      const raw = entry as unknown as { promptIndex: number; trajectory: RecallTrajectory };
      if (typeof raw.promptIndex === 'number' && raw.trajectory) {
        trajectories.set(raw.promptIndex, raw.trajectory);
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

    if (entry.type === 'user' || entry.type === 'assistant') {
      if (!leafUuid) {
        leafUuid = entry.uuid;
      }
      if (!lastUserUuid && entry.type === 'user') {
        lastUserUuid = entry.uuid;
      }
      if (leafUuid && lastUserUuid) break;
    }
  }

  return { leafUuid, lastUserUuid, planFilePath };
}

export function buildHistoryFromEntries(entries: ClaudeSessionEntry[]): StructuredTurn[] {
  const turns: StructuredTurn[] = [];
  let currentUser: { text: string; timestamp: string } | null = null;
  let assistantResponse = '';
  let toolCalls: ToolCallRecord[] = [];
  let thinkingBlocks: string[] = [];
  let promptIndex = 0;
  const pendingToolCalls = new Map<string, ToolCallRecord>();

  function flushTurn(): void {
    if (!currentUser) return;
    turns.push({
      promptIndex,
      timestamp: currentUser.timestamp,
      userMessage: currentUser.text,
      assistantResponse,
      toolCalls,
      thinkingBlocks,
    });
    promptIndex++;
    currentUser = null;
    assistantResponse = '';
    toolCalls = [];
    thinkingBlocks = [];
    pendingToolCalls.clear();
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
                pending.result = typeof block.content === 'string'
                  ? block.content.slice(0, 2000)
                  : JSON.stringify(block.content).slice(0, 2000);
                pendingToolCalls.delete(block.tool_use_id);
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
          } else if (block.type === 'thinking' && 'thinking' in block) {
            thinkingBlocks.push(block.thinking);
          } else if (block.type === 'tool_use') {
            const record: ToolCallRecord = {
              name: block.name,
              input: block.input,
              result: '',
            };
            toolCalls.push(record);
            pendingToolCalls.set(block.id, record);
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
