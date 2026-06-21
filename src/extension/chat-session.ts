import type { ContentInput, RewindOption } from './session-types';
import type { McpServerConfig, McpServerStatusInfo } from '../shared/types/mcp';
import type { ToolsSnapshot } from '../shared/types/tools';
import type { UserContentBlock } from '../shared/types/content';
import type { PermissionMode, ModelInfo } from '../shared/types/settings';
import type { SlashCommandInfo } from '../shared/types/commands';
import type { MemoryInjectionDisplay } from '../shared/types/context-injection';
import type { TeamService } from './team';

/**
 * The session seam consumed by the rest of the extension (panels, message-router
 * handlers, settings managers). `PiSession` (pi harness backend) implements this so
 * `createSessionForPanel` returns it. The member set is audited from the real call sites;
 * deferred subsystems are still part of the contract and degrade gracefully (never throwing
 * into a live handler).
 */
export interface ChatSession {
  readonly currentSessionId: string | null;
  readonly persistenceSessionId: string | null;
  readonly memorySessionId: string;
  readonly teamService: TeamService | undefined;
  readonly processing: boolean;
  readonly currentPromptIndex: number;
  readonly conversationHead: string | null;
  readonly currentModel: string | null;

  /** The plan-file path this session WRITES to (`computePlanFilePath`), from the live session id + first
   *  user message. The readable `<slug>-<id8>.md` target for plan-mode writes and bind-plan; consumers
   *  (view, delete) locate it by the stable `-<id8>` suffix, so it survives the slug changing. */
  getPlanFilePath(): string;

  getModelInfo(model?: string): ModelInfo | undefined;

  setResumeSession(sessionId: string | null): void;
  initializeEarly(): Promise<void>;

  sendMessage(
    prompt: ContentInput,
    _agentId?: string,
    correlationId?: string,
    userBroadcast?: { content: string; contentBlocks?: UserContentBlock[] },
    options?: { isInternal?: boolean },
  ): Promise<void>;
  queueInput(content: ContentInput, messageId?: string): 'queued' | 'flushed' | false;
  interrupt(): Promise<void>;
  cancel(): void;
  cancelAutoCompact(): Promise<void>;
  /** Manually compact the conversation, optionally focusing the summary with `instructions` (US-030). */
  compact(instructions?: string): Promise<void>;
  reset(): void;
  clear(): void;
  dispose(): Promise<void>;
  stopTask(taskId: string): Promise<void>;

  sendBtw(btwId: string, question: string): Promise<void>;
  cancelBtw(btwId: string): void;

  getMemoryInjection(promptIndex: number): Promise<MemoryInjectionDisplay | undefined>;
  requestContextUsage(): Promise<void>;

  disableThinkingForNextQuery(): void;
  restoreThinkingConfig(): void;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): void;

  getSupportedModels(): Promise<ModelInfo[]>;
  getSupportedCommands(): Promise<SlashCommandInfo[]>;

  /** The live effective system prompt text, for the clickable `/context` system-prompt preview.
   *  Returns undefined when unavailable (e.g. before a session starts). */
  getSystemPromptText(): string | undefined;

  /** Markdown describing an MCP tool (name/server/description/schema) for the clickable `/context`
   *  preview. Returns undefined when the tool is unknown or MCP isn't on this backend. */
  getMcpToolInfoMarkdown(piName: string): string | undefined;

  getMcpServerStatus(): Promise<McpServerStatusInfo[]>;
  setMcpServers(mcpServers: Record<string, McpServerConfig>): void;
  restartForMcpChanges(): void;
  /** Register a listener fired whenever live MCP runtime status changes (connect/disconnect/list-change),
   * so the webview reflects connecting → connected without a manual refresh. */
  setMcpStatusListener(listener: () => void): void;

  /** The Tools-panel snapshot (per-group master state + every tool's live enabled state). */
  getToolStatus(): ToolsSnapshot;
  /** Recompute + re-apply the active tool set after a tool/group toggle; effective next turn. */
  refreshActiveTools(): void;
  reconnectMcpServerLive(serverName: string): Promise<boolean>;

  rewindFiles(userMessageId: string, option?: RewindOption, promptContent?: string): Promise<void>;
  seedCheckpoints(userMessageIds: Iterable<string>): void;
  getAccumulatedCost(): number;

  /**
   * Resolve a pending pi-extension `ctx.ui.*` dialog from a webview `extensionUiResponse` (US-026).
   */
  resolveExtensionUiResponse?(requestId: string, value: string | boolean | null): void;

  /**
   * Resolve once any in-flight session replacement (from `reset()`/`clear()`) has fully completed —
   * the old underlying session is disposed and can no longer write. Used to sequence a destructive
   * file delete after the live session has stopped writing. No-op (resolved) when nothing is pending.
   */
  whenReplaced?(): Promise<void>;
}
