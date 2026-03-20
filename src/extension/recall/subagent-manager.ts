import * as crypto from 'crypto';
import { log } from '../logger';
import { initSubagentFile, persistSubagentEntry } from '../session';
import { TOOL_AGENT } from '../../shared/tool-names';
import type { ContentBlock } from '../../shared/types/content';
import { parseAgentResult } from './agent-text';
import type { FlushedAssistantData } from './turn-persistence';

export interface SubagentManagerDeps {
  cwd: string;
  getPersistenceSessionId: () => string;
  onSubagentDataReady: (agentToolUseId: string, agentId: string) => void;
}

interface PendingToolCall {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface PendingToolResult {
  toolUseId: string;
  toolName: string;
  content: string;
}

interface SubagentPersistState {
  agentId: string;
  model?: string;
  isBackground: boolean;
  prompt?: string;
  pendingToolCalls: PendingToolCall[];
  pendingToolResults: PendingToolResult[];
  blockPersistedForMessageId: string | null;
  pendingFinalResponse?: string;
  writeQueue: Promise<void>;
  initFailed?: boolean;
}

export class SubagentManager {
  private deps: SubagentManagerDeps;
  private activeSubagents: Map<string, SubagentPersistState> = new Map();

  constructor(deps: SubagentManagerDeps) {
    this.deps = deps;
  }

  onSubagentStart(toolUseId: string, agentId: string, isBackground?: boolean, prompt?: string): void {
    log('[SubagentManager.onSubagentStart] toolUseId=%s, agentId=%s, isBackground=%s', toolUseId, agentId, isBackground ?? false);
    const sessionId = this.deps.getPersistenceSessionId();
    const subState: SubagentPersistState = {
      agentId,
      isBackground: isBackground ?? false,
      ...(prompt !== undefined ? { prompt } : {}),
      pendingToolCalls: [],
      pendingToolResults: [],
      blockPersistedForMessageId: null,
      writeQueue: Promise.resolve(),
    };
    this.activeSubagents.set(toolUseId, subState);
    subState.writeQueue = initSubagentFile(this.deps.cwd, sessionId, agentId)
      .catch(err => {
        log('[SubagentManager] Failed to init subagent file:', err);
        subState.initFailed = true;
      });
  }

  onSubagentStop(agentId: string, lastAssistantMessage?: string): void {
    const found = this.findByAgentId(agentId);
    if (!found) return;
    const [toolUseId, subState] = found;
    if (!subState.isBackground) return;

    const sessionId = this.deps.getPersistenceSessionId();
    const cwd = this.deps.cwd;
    const model = subState.model ?? 'unknown';

    subState.writeQueue = subState.writeQueue
      .then(async () => {
        if (subState.initFailed) return;

        if (subState.prompt) {
          await persistSubagentEntry(cwd, sessionId, subState.agentId,
            buildAgentUserEntry(subState.prompt, sessionId, cwd));
        }

        for (const tc of subState.pendingToolCalls) {
          const result = subState.pendingToolResults.find(r => r.toolUseId === tc.toolUseId);
          await persistSubagentEntry(cwd, sessionId, subState.agentId,
            buildAgentAssistantEntry(
              { messageId: `msg_${tc.toolUseId}`, model, stopReason: 'tool_use' },
              [{ type: 'tool_use' as const, id: tc.toolUseId, name: tc.toolName, input: tc.input }],
              sessionId, cwd));
          if (result) {
            await persistSubagentEntry(cwd, sessionId, subState.agentId,
              buildAgentToolResultEntry(tc.toolUseId, result.content, sessionId, cwd));
          }
        }

        const orphanResults = subState.pendingToolResults.filter(
          r => !subState.pendingToolCalls.some(tc => tc.toolUseId === r.toolUseId)
        );
        for (const r of orphanResults) {
          await persistSubagentEntry(cwd, sessionId, subState.agentId,
            buildAgentAssistantEntry(
              { messageId: `msg_${r.toolUseId}`, model, stopReason: 'tool_use' },
              [{ type: 'tool_use' as const, id: r.toolUseId, name: r.toolName, input: {} }],
              sessionId, cwd));
          await persistSubagentEntry(cwd, sessionId, subState.agentId,
            buildAgentToolResultEntry(r.toolUseId, r.content, sessionId, cwd));
        }

        if (lastAssistantMessage) {
          const content = parseSubagentFinalContent(lastAssistantMessage);
          if (content.length > 0) {
            await persistSubagentEntry(cwd, sessionId, subState.agentId,
              buildAgentAssistantEntry(
                { messageId: `msg_final_${subState.agentId}`, model, stopReason: 'end_turn' },
                content, sessionId, cwd));
          }
        }
      })
      .then(() => {
        log('[SubagentManager.onSubagentStop] Background agent persisted: agentId=%s, tools=%d',
          subState.agentId, subState.pendingToolCalls.length);
        this.deps.onSubagentDataReady(toolUseId, subState.agentId);
        this.activeSubagents.delete(toolUseId);
      })
      .catch(err => log('[SubagentManager] Failed to write background agent data:', err));
  }

  onToolCall(toolName: string, toolUseId: string, input: Record<string, unknown>, parentToolUseId: string): boolean {
    const subState = this.activeSubagents.get(parentToolUseId);
    if (!subState || !subState.isBackground) return false;
    subState.pendingToolCalls.push({ toolUseId, toolName, input });
    return true;
  }

  onThinkingBlockComplete(messageId: string, model: string, thinking: string, parentToolUseId?: string): boolean {
    if (!parentToolUseId) return false;

    const subState = this.activeSubagents.get(parentToolUseId);
    if (!subState) return false;

    const sessionId = this.deps.getPersistenceSessionId();
    const cwd = this.deps.cwd;

    subState.blockPersistedForMessageId = messageId;
    const entry = buildAgentAssistantEntry(
      { messageId, model, stopReason: null },
      [{ type: 'thinking' as const, thinking }],
      sessionId,
      cwd,
    );
    subState.writeQueue = subState.writeQueue
      .then(() => {
        if (subState.initFailed) return;
        return persistSubagentEntry(cwd, sessionId, subState.agentId, entry);
      })
      .catch(err => log('[SubagentManager] Failed to write subagent thinking:', err));

    return true;
  }

  onToolResult(toolName: string, toolUseId: string, result: string, parentToolUseId?: string): boolean {
    if (parentToolUseId) {
      const subState = this.activeSubagents.get(parentToolUseId);
      if (subState) {
        subState.pendingToolResults.push({ toolUseId, toolName, content: result });
        return true;
      }
    }

    if (toolName === TOOL_AGENT) {
      const subState = this.activeSubagents.get(toolUseId);
      const parsed = subState ? parseAgentResult(result) : null;
      if (subState && parsed) {
        subState.pendingFinalResponse = result;
      }
    }

    return false;
  }

  persistAssistantData(data: FlushedAssistantData, parentToolUseId: string | null): boolean {
    if (!parentToolUseId) return false;

    const subState = this.activeSubagents.get(parentToolUseId);
    if (!subState) return false;

    const sessionId = this.deps.getPersistenceSessionId();
    const cwd = this.deps.cwd;

    if (!subState.model) {
      subState.model = data.model;
    }

    const toolResults = subState.pendingToolResults.splice(0);
    const strippedContent = subState.blockPersistedForMessageId === data.messageId
      ? data.content.filter(b => b.type !== 'thinking')
      : data.content;
    subState.blockPersistedForMessageId = null;

    const hasPendingFinal = subState.pendingFinalResponse !== undefined;
    const agentToolUseId = parentToolUseId;

    subState.writeQueue = subState.writeQueue
      .then(async () => {
        if (subState.initFailed) return;
        if (strippedContent.length > 0) {
          await persistSubagentEntry(cwd, sessionId, subState.agentId,
            buildAgentAssistantEntry({ messageId: data.messageId, model: data.model, stopReason: data.stopReason }, strippedContent, sessionId, cwd));
        }
        for (const tr of toolResults) {
          await persistSubagentEntry(cwd, sessionId, subState.agentId,
            buildAgentToolResultEntry(tr.toolUseId, tr.content, sessionId, cwd));
        }
        if (subState.pendingFinalResponse) {
          await this.writeSubagentFinalResponse(subState);
        }
      })
      .then(() => {
        if (hasPendingFinal) {
          this.deps.onSubagentDataReady(agentToolUseId, subState.agentId);
          this.activeSubagents.delete(agentToolUseId);
        }
      })
      .catch(err => log('[SubagentManager] Failed to write subagent assistant:', err));

    return true;
  }

  flushRemainingResponses(): void {
    for (const [toolUseId, subState] of this.activeSubagents.entries()) {
      if (!subState.pendingFinalResponse) continue;

      subState.writeQueue = subState.writeQueue
        .then(async () => {
          if (!subState.pendingFinalResponse) return;
          if (!subState.initFailed) {
            await this.writeSubagentFinalResponse(subState);
          }
          this.deps.onSubagentDataReady(toolUseId, subState.agentId);
          this.activeSubagents.delete(toolUseId);
        })
        .catch(err => log('[SubagentManager] Failed to write fallback subagent response:', err));
    }
  }

  reset(): void {
    this.activeSubagents.clear();
  }

  private findByAgentId(agentId: string): [string, SubagentPersistState] | null {
    for (const [toolUseId, state] of this.activeSubagents) {
      if (state.agentId === agentId) return [toolUseId, state];
    }
    return null;
  }

  private async writeSubagentFinalResponse(subState: SubagentPersistState): Promise<void> {
    const content = parseSubagentFinalContent(subState.pendingFinalResponse!);
    delete subState.pendingFinalResponse;
    if (content.length === 0) return;

    const sessionId = this.deps.getPersistenceSessionId();
    const cwd = this.deps.cwd;
    const model = subState.model ?? 'unknown';
    const messageId = `msg_final_${subState.agentId}`;
    const entry = buildAgentAssistantEntry(
      { messageId, model, stopReason: 'end_turn' },
      content,
      sessionId,
      cwd,
    );

    await persistSubagentEntry(cwd, sessionId, subState.agentId, entry);
  }
}

function parseSubagentFinalContent(result: string): ContentBlock[] {
  const parts = parseAgentResult(result);
  if (parts) return parts.texts.map(text => ({ type: 'text' as const, text }));

  try {
    JSON.parse(result);
    return [];
  } catch {
    const trimmed = result.trim();
    if (trimmed) return [{ type: 'text' as const, text: trimmed }];
  }

  return [];
}

function buildAgentUserEntry(
  prompt: string,
  sessionId: string,
  cwd: string,
): Record<string, unknown> {
  return {
    type: 'user',
    sessionId,
    cwd,
    message: { role: 'user', content: prompt },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

function buildAgentAssistantEntry(
  data: { messageId: string; model: string; stopReason: string | null },
  content: ContentBlock[],
  sessionId: string,
  cwd: string,
): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId,
    cwd,
    message: {
      id: data.messageId,
      model: data.model,
      type: 'message',
      role: 'assistant',
      content: content.map(block => {
        switch (block.type) {
          case 'thinking': return { type: 'thinking', thinking: block.thinking };
          case 'text': return { type: 'text', text: block.text };
          case 'tool_use': return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
          default: return block;
        }
      }),
      stop_reason: data.stopReason ?? 'end_turn',
    },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

function buildAgentToolResultEntry(
  toolUseId: string,
  content: string,
  sessionId: string,
  cwd: string,
): Record<string, unknown> {
  return {
    type: 'user',
    sessionId,
    cwd,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
}
