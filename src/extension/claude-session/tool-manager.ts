import { log } from '../logger';
import type { PermissionHandler } from '../permission-handler';
import type { MessageCallbacks, StreamedToolInfo, ToolPermissionResult } from './types';
import type { PermissionUpdate } from '../../shared/types/permissions';
import { normalizeToolResult, TOOL_METADATA_REGISTRY, enrichResultWithDownloadedFiles } from './utils';
import { readAgentData } from '../session';
import { TOOL_AGENT } from '../../shared/tool-names';

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
  private pendingAgentToolIds: string[] = [];
  /** Map of agentToolId -> agentId for active subagents */
  private activeSubagents: Map<string, string> = new Map();
  /** Set of agentToolIds that have already received model updates */
  private subagentsWithModel: Set<string> = new Set();
  /** Stored Agent tool inputs for retrieval at SubagentStart (prompt, run_in_background, etc.) */
  private pendingAgentInputs: Map<string, Record<string, unknown>> = new Map();
  /** SDK task_ids that belong to background agents */
  private backgroundTaskIds: Set<string> = new Set();

  private permissionHandler: PermissionHandler;
  private callbacks: MessageCallbacks;
  private cwd: string;
  private onToolCompleted?: (toolName: string, toolUseId: string, result: string, parentToolUseId: string | null) => void;
  private isRecallModeActive?: () => boolean;

  constructor(
    permissionHandler: PermissionHandler,
    callbacks: MessageCallbacks,
    cwd: string
  ) {
    this.permissionHandler = permissionHandler;
    this.callbacks = callbacks;
    this.cwd = cwd;
  }

  setOnToolCompleted(callback: (toolName: string, toolUseId: string, result: string, parentToolUseId: string | null) => void): void {
    this.onToolCompleted = callback;
  }

  setIsRecallModeActive(check: () => boolean): void {
    this.isRecallModeActive = check;
  }

  /** Handle canUseTool callback from SDK */
  async handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    context: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string },
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

  /** Check whether a tool_use_id belongs to a subagent (has a parentToolUseId) */
  isSubagentTool(toolUseId: string): boolean {
    const info = this.streamedToolIds.get(toolUseId);
    if (info === undefined) return false;
    return info.parentToolUseId !== null;
  }

  /** Check if any Agent tool calls are still in-flight (for parallel subagent coordination) */
  hasActiveAgentTools(): boolean {
    for (const info of this.streamedToolIds.values()) {
      if (info.toolName === TOOL_AGENT) return true;
    }
    return false;
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

      if (toolName === TOOL_AGENT) {
        this.pendingAgentToolIds.push(toolUseId);
        if (input && typeof input === 'object') {
          this.pendingAgentInputs.set(toolUseId, input as Record<string, unknown>);
        }
      }

      // Event-driven model discovery: trigger on first tool_use for a subagent
      if (parentToolUseId && this.activeSubagents.has(parentToolUseId) && !this.subagentsWithModel.has(parentToolUseId)) {
        this.subagentsWithModel.add(parentToolUseId);
        const agentId = this.activeSubagents.get(parentToolUseId)!;
        this.sendSubagentModelUpdate(parentToolUseId, agentId);
      }
    }
  }

  /** Reverse lookup: find the agentToolId for a given SDK agent_id */
  getToolUseIdForAgent(agentId: string): string | null {
    for (const [toolUseId, id] of this.activeSubagents) {
      if (id === agentId) return toolUseId;
    }
    return null;
  }

  /** Retrieve stored Agent tool input (prompt, run_in_background, etc.). Remains available until resetTurn(). */
  getAgentInput(toolUseId: string): Record<string, unknown> | undefined {
    return this.pendingAgentInputs.get(toolUseId);
  }

  /** Register an SDK task_id as belonging to a background agent */
  registerBackgroundTask(taskId: string): void {
    this.backgroundTaskIds.add(taskId);
  }

  /** Check whether an SDK task_id belongs to a background agent */
  isBackgroundTask(taskId: string): boolean {
    return this.backgroundTaskIds.has(taskId);
  }

  /** Correlate a subagent with its parent Agent tool - returns tool_use_id or null */
  correlateSubagentStart(agentId: string): string | null {
    const toolUseId = this.pendingAgentToolIds.shift() ?? null;
    if (toolUseId && agentId) {
      this.activeSubagents.set(toolUseId, agentId);
    }
    return toolUseId;
  }

  /** Handle PostToolUse hook - notify UI of tool completion */
  async handlePostToolUse(toolName: string | undefined, toolUseId: string | undefined, response: unknown, agentId?: string): Promise<void> {
    if (toolName && toolUseId) {
      const toolInfo = this.streamedToolIds.get(toolUseId);
      let parentToolUseId = toolInfo?.parentToolUseId ?? null;
      if (!toolInfo && agentId) {
        parentToolUseId = this.getToolUseIdForAgent(agentId);
        log('[ToolManager.handlePostToolUse] Derived parentToolUseId=%s from agentId=%s (tool not in streamedToolIds)', parentToolUseId, agentId);
      }
      this.streamedToolIds.delete(toolUseId);
      const serializedResult = normalizeToolResult(toolName, response);
      const enrichedResult = toolName.startsWith('mcp__')
        ? await enrichResultWithDownloadedFiles(serializedResult)
        : serializedResult;

      const config = TOOL_METADATA_REGISTRY.get(toolName);
      if (config?.extract && response && typeof response === 'object') {
        const metadata = config.extract(response);
        if (metadata) {
          this.callbacks.onMessage({ type: 'toolMetadata', toolUseId, metadata });
        }
      }

      this.callbacks.onMessage({
        type: 'toolCompleted',
        toolUseId,
        toolName,
        result: enrichedResult,
        parentToolUseId,
      });
      if (this.onToolCompleted) {
        log('[ToolManager.handlePostToolUse] Firing onToolCompleted: tool=%s, toolUseId=%s, resultLen=%d', toolName, toolUseId, enrichedResult.length);
        this.onToolCompleted(toolName, toolUseId, enrichedResult, parentToolUseId);
      }

      if (toolName === TOOL_AGENT) {
        const isQueuedToRunning = typeof response === 'object' && response !== null
          && (response as Record<string, unknown>)['status'] === 'queued_to_running';
        if (!isQueuedToRunning) {
          this.sendSubagentDataUpdate(toolUseId, response);
        }
      }
    }
  }

  /** Read agent JSONL and send full conversation messages to webview (on Agent tool completion) */
  private sendSubagentDataUpdate(agentToolId: string, response: unknown): void {
    if (typeof response !== 'object' || response === null) return;
    const agentId = (response as Record<string, unknown>)['agentId'];
    if (typeof agentId !== 'string' || !agentId) return;

    if (this.isRecallModeActive?.()) {
      log('[ToolManager.sendSubagentDataUpdate] Recall mode active — deferring to onSubagentDataReady (agentToolId=%s, agentId=%s)',
        agentToolId, agentId);
      return;
    }

    readAgentData(this.cwd, agentId)
      .then(agentData => {
        log('[ToolManager.sendSubagentDataUpdate] agentToolId=%s, agentId=%s, messages=%d',
          agentToolId, agentId, agentData.messages.length);

        if (agentData.messages.length > 0) {
          this.callbacks.onMessage({
            type: 'subagentMessagesUpdate',
            agentToolId,
            messages: agentData.messages,
          });
        }
      })
      .catch(err => {
        log('[ToolManager] Failed to read agent data:', err);
      });
  }

  /** Read agent JSONL and send model update (event-driven, on first tool_use) */
  private sendSubagentModelUpdate(agentToolId: string, agentId: string): void {
    readAgentData(this.cwd, agentId)
      .then(agentData => {
        if (agentData.model) {
          this.callbacks.onMessage({
            type: 'subagentModelUpdate',
            agentToolId,
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
    this.pendingAgentToolIds = [];
    this.activeSubagents.clear();
    this.subagentsWithModel.clear();
    this.pendingAgentInputs.clear();
    this.backgroundTaskIds.clear();
  }
}
