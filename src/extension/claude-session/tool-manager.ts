import { log } from '../logger';
import type { PermissionHandler } from '../permission-handler';
import type { MessageCallbacks, StreamedToolInfo, ToolPermissionResult } from './types';
import type { PermissionUpdate } from '../../shared/types/permissions';
import { serializeToolResult } from './utils';
import { readAgentData } from '../session';

/**
 * ToolManager handles tool permission checking and correlation.
 *
 * Responsibilities:
 * - Track streamed tools for correlation with canUseTool callback
 * - Maintain FIFO queue for tool correlation (SDK doesn't pass tool_use_id in canUseTool)
 * - Handle tool abandonment when Claude changes course mid-stream
 * - Mark tool usage for turn-level tracking
 */
export class ToolManager {
  private streamedToolIds: Map<string, StreamedToolInfo> = new Map();
  private pendingToolQueue: Map<string, Array<{ toolUseId: string; parentToolUseId: string | null }>> = new Map();
  private toolsUsedThisTurn = false;
  private pendingTaskToolIds: string[] = [];
  /** Map of taskToolId -> agentId for active subagents */
  private activeSubagents: Map<string, string> = new Map();
  /** Set of taskToolIds that have already received model updates */
  private subagentsWithModel: Set<string> = new Set();

  private permissionHandler: PermissionHandler;
  private callbacks: MessageCallbacks;
  private cwd: string;
  private onToolCompleted?: (toolName: string, toolUseId: string, result: string) => void;

  constructor(
    permissionHandler: PermissionHandler,
    callbacks: MessageCallbacks,
    cwd: string
  ) {
    this.permissionHandler = permissionHandler;
    this.callbacks = callbacks;
    this.cwd = cwd;
  }

  setOnToolCompleted(callback: (toolName: string, toolUseId: string, result: string) => void): void {
    this.onToolCompleted = callback;
  }

  /** Handle canUseTool callback from SDK */
  async handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    context: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
    flushCallback: () => void
  ): Promise<ToolPermissionResult> {
    // Get the tool ID first
    const toolQueue = this.pendingToolQueue.get(toolName) ?? [];
    const queuedInfo = toolQueue.shift();
    if (queuedInfo) {
      this.pendingToolQueue.set(toolName, toolQueue);
    } else {
      log('[ToolManager] Warning: canUseTool called but no queued info for tool %s', toolName);
    }
    const toolUseId = queuedInfo?.toolUseId ?? null;
    const parentToolUseId = queuedInfo?.parentToolUseId ?? null;

    // Mark as approved BEFORE flush to prevent sendAbandonedTools from
    // abandoning this tool during flushPendingAssistant
    if (toolUseId) {
      const info = this.streamedToolIds.get(toolUseId);
      if (info) {
        info.approved = true;
      }
    }

    // Now safe to flush - the tool won't be abandoned
    flushCallback();

    const extendedContext = {
      ...context,
      toolUseID: toolUseId,
      parentToolUseId,
      ...(context.suggestions?.length ? { suggestions: context.suggestions } : {}),
    };
    const result = await this.permissionHandler.canUseTool(toolName, input, extendedContext);

    if (result.behavior === 'allow') {
      return {
        behavior: 'allow' as const,
        updatedInput: (result.updatedInput ?? input) as Record<string, unknown>,
        ...(result.updatedPermissions?.length ? { updatedPermissions: result.updatedPermissions } : {}),
      };
    }

    // Tool was denied - delete from tracking and notify
    if (toolUseId) {
      this.streamedToolIds.delete(toolUseId);
      log('[ToolManager] Tool denied, sending toolFailed:', toolName, toolUseId);
      this.callbacks.onMessage({
        type: 'toolFailed',
        toolUseId,
        toolName,
        error: result.message ?? 'Permission denied',
        isInterrupt: result.interrupt ?? false,
        parentToolUseId,
      });
    }
    return {
      behavior: 'deny' as const,
      message: result.message ?? 'Permission denied',
      ...(result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),
    };
  }

  /** Register a streamed tool for tracking */
  registerStreamedTool(id: string, info: StreamedToolInfo): void {
    this.streamedToolIds.set(id, info);
  }

  /** Queue tool info for correlation with canUseTool */
  queueToolInfo(toolName: string, info: { toolUseId: string; parentToolUseId: string | null }): void {
    const queue = this.pendingToolQueue.get(toolName) ?? [];
    queue.push(info);
    this.pendingToolQueue.set(toolName, queue);
  }

  /** Get and remove streamed tool info by ID */
  getAndRemoveStreamedTool(toolUseId: string): StreamedToolInfo | undefined {
    const info = this.streamedToolIds.get(toolUseId);
    if (info) {
      this.streamedToolIds.delete(toolUseId);
    }
    return info;
  }

  /** Get streamed tool info by ID without removing it */
  getStreamedToolInfo(toolUseId: string): StreamedToolInfo | undefined {
    return this.streamedToolIds.get(toolUseId);
  }

  /** Send abandoned tools for a specific message ID (only non-approved tools) */
  sendAbandonedTools(messageId: string): void {
    for (const [toolUseId, info] of this.streamedToolIds.entries()) {
      // Only abandon tools that were never approved (Claude changed course)
      if (info.messageId === messageId && !info.approved) {
        this.callbacks.onMessage({
          type: 'toolAbandoned',
          toolUseId,
          toolName: info.toolName,
          parentToolUseId: info.parentToolUseId,
        });
        this.streamedToolIds.delete(toolUseId);
      }
    }
  }

  /** Send abandoned for ALL remaining streamed tools (used on abort) */
  sendAllAbandonedTools(): void {
    for (const [toolUseId, info] of this.streamedToolIds.entries()) {
      this.callbacks.onMessage({
        type: 'toolAbandoned',
        toolUseId,
        toolName: info.toolName,
        parentToolUseId: info.parentToolUseId,
      });
    }
    this.streamedToolIds.clear();
  }

  /** Handle PreToolUse hook - mark tool as used and notify UI */
  handlePreToolUse(toolName: string | undefined, toolUseId: string | undefined, input: unknown): void {
    if (toolName) {
      this.toolsUsedThisTurn = true;
    }
    if (toolName && toolUseId) {
      const toolInfo = this.streamedToolIds.get(toolUseId);
      if (toolInfo) {
        toolInfo.approved = true;
      }
      const parentToolUseId = toolInfo?.parentToolUseId ?? null;
      this.callbacks.onMessage({
        type: 'toolPending',
        toolUseId,
        toolName,
        input,
        parentToolUseId,
      });

      if (toolName === 'Task') {
        this.pendingTaskToolIds.push(toolUseId);
      }

      // Event-driven model discovery: trigger on first tool_use for a subagent
      if (parentToolUseId && this.activeSubagents.has(parentToolUseId) && !this.subagentsWithModel.has(parentToolUseId)) {
        this.subagentsWithModel.add(parentToolUseId);
        const agentId = this.activeSubagents.get(parentToolUseId)!;
        this.sendSubagentModelUpdate(parentToolUseId, agentId);
      }
    }
  }

  /** Correlate a subagent with its parent Task tool - returns tool_use_id or null */
  correlateSubagentStart(agentId: string): string | null {
    const toolUseId = this.pendingTaskToolIds.shift() ?? null;
    if (toolUseId && agentId) {
      this.activeSubagents.set(toolUseId, agentId);
    }
    return toolUseId;
  }

  /** Handle PostToolUse hook - notify UI of tool completion */
  handlePostToolUse(toolName: string | undefined, toolUseId: string | undefined, response: unknown): void {
    if (toolName && toolUseId) {
      const toolInfo = this.streamedToolIds.get(toolUseId);
      const parentToolUseId = toolInfo?.parentToolUseId ?? null;
      this.streamedToolIds.delete(toolUseId);
      const serializedResult = serializeToolResult(response);
      this.callbacks.onMessage({
        type: 'toolCompleted',
        toolUseId,
        toolName,
        result: serializedResult,
        parentToolUseId,
      });
      if (this.onToolCompleted) {
        log('[ToolManager.handlePostToolUse] Firing onToolCompleted: tool=%s, toolUseId=%s, resultLen=%d', toolName, toolUseId, serializedResult.length);
        this.onToolCompleted(toolName, toolUseId, serializedResult);
      }

      if ((toolName === 'Edit' || toolName === 'Write') && response && typeof response === 'object') {
        const structuredPatch = (response as Record<string, unknown>)['structuredPatch'];
        if (Array.isArray(structuredPatch) && structuredPatch.length > 0) {
          const firstPatch = structuredPatch[0] as Record<string, unknown> | undefined;
          const editLineNumber = firstPatch?.['oldStart'];
          if (typeof editLineNumber === 'number') {
            this.callbacks.onMessage({
              type: 'toolMetadata',
              toolUseId,
              metadata: { editLineNumber },
            });
          }
        }
      }

      if (toolName === 'Task') {
        this.sendSubagentDataUpdate(toolUseId, response);
      }
    }
  }

  /** Read agent JSONL and send full conversation messages to webview (on Task completion) */
  private sendSubagentDataUpdate(taskToolId: string, response: unknown): void {
    if (typeof response !== 'object' || response === null) return;
    const agentId = (response as Record<string, unknown>)['agentId'];
    if (typeof agentId !== 'string' || !agentId) return;

    readAgentData(this.cwd, agentId)
      .then(agentData => {
        // Model is sent earlier via sendSubagentModelUpdate (on first tool_use)
        // Here we only send the full messages for conversation history
        if (agentData.messages.length > 0) {
          this.callbacks.onMessage({
            type: 'subagentMessagesUpdate',
            taskToolId,
            messages: agentData.messages,
          });
        }
      })
      .catch(err => {
        log('[ToolManager] Failed to read agent data:', err);
      });
  }

  /** Read agent JSONL and send model update (event-driven, on first tool_use) */
  private sendSubagentModelUpdate(taskToolId: string, agentId: string): void {
    readAgentData(this.cwd, agentId)
      .then(agentData => {
        if (agentData.model) {
          this.callbacks.onMessage({
            type: 'subagentModelUpdate',
            taskToolId,
            model: agentData.model,
          });
        }
      })
      .catch(err => {
        log('[ToolManager] Failed to read agent model:', err);
      });
  }

  /** Handle PostToolUseFailure hook - notify UI of tool failure */
  handlePostToolUseFailure(
    toolName: string | undefined,
    toolUseId: string | undefined,
    error: string | undefined,
    isInterrupt: boolean | undefined
  ): void {
    if (toolName && toolUseId) {
      const toolInfo = this.streamedToolIds.get(toolUseId);
      const parentToolUseId = toolInfo?.parentToolUseId ?? null;
      this.streamedToolIds.delete(toolUseId);
      this.callbacks.onMessage({
        type: 'toolFailed',
        toolUseId,
        toolName,
        error: error || 'Unknown error',
        ...(isInterrupt !== undefined ? { isInterrupt } : {}),
        parentToolUseId,
      });
    }
  }

  /** Mark that tools were used this turn */
  markToolUsed(): void {
    this.toolsUsedThisTurn = true;
  }

  /** Check if tools were used this turn */
  get hadToolsThisTurn(): boolean {
    return this.toolsUsedThisTurn;
  }

  /** Reset turn-level state */
  resetTurn(): void {
    this.toolsUsedThisTurn = false;
    this.streamedToolIds.clear();
    this.pendingToolQueue.clear();
    this.pendingTaskToolIds = [];
    this.activeSubagents.clear();
    this.subagentsWithModel.clear();
  }
}
