import type { ContentInput, RewindOption } from './types';
import type { McpServerConfig, McpServerStatusInfo } from '../../shared/types/mcp';
import type { ToolsSnapshot } from '../../shared/types/tools';
import type { UserContentBlock } from '../../shared/types/content';
import type { PermissionMode, ModelInfo } from '../../shared/types/settings';
import type { SlashCommandInfo } from '../../shared/types/commands';
import type { RemoteControlStatus } from '../../shared/types/remote-control';
import type { MemoryInjectionDisplay } from '../../shared/types/context-injection';
import type { RecallConfig, RecallTrajectory } from '../recall/types';
import type { RecallService } from '../recall';
import type { TeamService } from '../team';
import type { BrowserService } from '../browser';

/**
 * The session seam consumed by the rest of the extension (panels, message-router
 * handlers, settings managers). Both `ClaudeSession` (Claude Agent SDK backend) and
 * `PiSession` (pi harness backend) implement this so `createSessionForPanel` can return
 * either interchangeably. The member set is audited from the real call sites; deferred
 * subsystems are still part of the contract and degrade gracefully on backends that do
 * not implement them yet (never throwing into a live handler).
 */
export interface ChatSession {
  readonly currentSessionId: string | null;
  readonly persistenceSessionId: string | null;
  readonly memorySessionId: string;
  readonly teamService: TeamService | undefined;
  readonly recallService: RecallService | undefined;
  readonly processing: boolean;
  readonly currentPromptIndex: number;
  readonly conversationHead: string | null;
  readonly isRecallMode: boolean;
  readonly currentModel: string | null;
  readonly fastMode: boolean;
  readonly remoteControlStatus: RemoteControlStatus;
  planPath: string | null;

  getModelInfo(model?: string): ModelInfo | undefined;

  setResumeSession(sessionId: string | null): void;
  setRecallSession(sessionId: string): Promise<void>;
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
  reset(): void;
  clear(): void;
  dispose(): Promise<void>;
  stopTask(taskId: string): Promise<void>;

  sendBtw(btwId: string, question: string): Promise<void>;
  cancelBtw(btwId: string): void;

  getRecallService(): RecallService | undefined;
  getRecallTrajectory(promptIndex: number): RecallTrajectory | undefined;
  getMemoryInjection(promptIndex: number): Promise<MemoryInjectionDisplay | undefined>;
  refreshRecallConfig(config: RecallConfig): void;
  requestContextUsage(): Promise<void>;

  disableThinkingForNextQuery(): void;
  restoreThinkingConfig(): void;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setFastMode(enabled: boolean): void;
  setModel(model?: string): void;
  setBetas(betas: string[]): void;

  getSupportedModels(): Promise<ModelInfo[]>;
  getSupportedCommands(): Promise<SlashCommandInfo[]>;

  /** The live effective system prompt text, for the clickable `/context` system-prompt preview.
   *  Returns undefined when unavailable (e.g. before a session starts, or on the SDK fallback). */
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
  setProviderEnv(env: Record<string, string> | undefined): void;
  restartForProviderChange(): void;

  emitExploreHistory(sessionId: string): Promise<void>;
  setBrowserService(service?: BrowserService): void;

  enableRemoteControl(): Promise<void>;
  disableRemoteControl(): Promise<void>;

  rewindFiles(userMessageId: string, option?: RewindOption, promptContent?: string): Promise<void>;
  getCheckpointForMessage(assistantMessageId: string): string | undefined;
  seedCheckpoints(userMessageIds: Iterable<string>): void;
  getAccumulatedCost(): number;

  /**
   * Resolve a pending pi-extension `ctx.ui.*` dialog from a webview `extensionUiResponse` (US-026).
   * Optional: only the pi backend bridges extension UI; the SDK backend has no extension UI surface.
   */
  resolveExtensionUiResponse?(requestId: string, value: string | boolean | null): void;

  /**
   * Resolve once any in-flight session replacement (from `reset()`/`clear()`) has fully completed —
   * the old underlying session is disposed and can no longer write. Used to sequence a destructive
   * file delete after the live session has stopped writing. No-op (resolved) when nothing is pending.
   */
  whenReplaced?(): Promise<void>;
}
