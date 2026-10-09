import type { ContentInput, McpScope, RewindOption } from './session-types';
import type { McpServerStatusInfo } from '../shared/types/mcp';
import type { ToolsSnapshot } from '../shared/types/tools';
import type { ImageBlock, UserContentBlock } from '../shared/types/content';
import type { PermissionMode, ModelInfo } from '../shared/types/settings';
import type { SlashCommandInfo } from '../shared/types/commands';
import type { MemoryInjectionDisplay } from '../shared/types/context-injection';
import type { SteerTargetInfo } from '../shared/types/subagents';
import type { TeamService } from './team';
import type { ActivitySource } from './chat-panel/activity';
import type { TerminalAttachmentInfo } from '../shared/types/terminal-attachment';

/** What the transcript shows for a sent message: the typed text, its images and the terminal attachments sent with it. */
export interface UserBroadcast {
  content: string;
  contentBlocks?: UserContentBlock[];
  // the prompt starts with one formatted block per attachment, in this order
  terminalAttachments?: TerminalAttachmentInfo[];
}

/**
 * `unsent`: the prompt was refused or stopped before pi committed or queued it, so nothing it carried reached the conversation.
 * `withdrawn`: the session itself returned the prompt to the composer, its chips through `onWithdrawn`, before it reached the conversation.
 */
export type SendOutcome = 'sent' | 'unsent' | 'withdrawn';

/** What pi's `prompt()` makes of a text sent alone: an extension command it runs, the skill or template body it expands to, or text. */
export type SlashInvocation = { kind: 'command' } | { kind: 'expanded'; text: string } | { kind: 'text' };

/**
 * The session seam consumed by the rest of the extension (panels, message-router
 * handlers, settings managers). `PiSession` (pi harness backend) implements this so
 * `createSessionForPanel` returns it. The member set is audited from the real call sites;
 * deferred subsystems are still part of the contract and degrade gracefully (never throwing
 * into a live handler).
 */
export interface ChatSession extends ActivitySource {
  readonly currentSessionId: string | null;
  readonly persistenceSessionId: string | null;
  readonly memorySessionId: string;
  readonly teamService: TeamService | undefined;
  readonly processing: boolean;
  /** The running prompt's index, else the latest prompt's, per `session-store/prompt-index.ts`. */
  readonly currentPromptIndex: number;
  readonly conversationHead: string | null;
  readonly currentModel: string | null;

  /** A tool result's images while pi has not yet written its `toolResult` entry to the session file. */
  unpersistedToolResultImages(toolCallId: string): readonly ImageBlock[] | undefined;

  /** The plan-file path this session WRITES to (`computePlanFilePath`), from the live session id + first
   *  user message. The readable `<slug>-<id8>.md` target for plan-mode writes and bind-plan; consumers
   *  (view, delete) locate it by the stable `-<id8>` suffix, so it survives the slug changing. */
  getPlanFilePath(): string;

  /** The current on-disk plan-file content for this session (the canonical plan), or null when the
   *  session has no plan file yet. Located by the stable `-<id8>` suffix (`findSessionPlanFiles`), so it
   *  survives the first-message slug drifting — same lookup as view/delete. */
  getPlanContent(): Promise<string | null>;

  /** The session's EXISTING plan file on disk (the in-use one, matched by the stable `-<id8>` suffix via
   *  `findSessionPlanFiles`), or null when the session has never bound a plan. Bind-plan overwrites this
   *  in place rather than the recomputed slug path, so binding again never orphans a drifted-slug file. */
  getActivePlanFilePath(): Promise<string | null>;

  getModelInfo(model?: string): ModelInfo | undefined;

  /** Whether this session is on, starting on, or switching to stored session `sessionId`. */
  holdsSession(sessionId: string): boolean;
  /** True when a resume or fork target is pending, a turn is processing, or the live session has messages. */
  hasConversation(): boolean;
  /** Whether the started session has its file on disk; pi writes none before the conversation's first prompt. */
  hasSessionFile(): boolean;
  /** The stored session whose file this session is on, or opens at start (a resume or fork target); null while it has no file. */
  readonly storedSessionId: string | null;
  setResumeSession(sessionId: string | null): void;
  initializeEarly(): Promise<void>;
  /** The webview (re)started with an empty dialog queue, so nothing on screen can answer what this
   *  side is still awaiting. Called from the `ready` handler. */
  onWebviewReady(): void;

  /** `onWithdrawn` runs at most once: when pi queued the prompt into a running run and a stop, the budget, a new chat or a resume switch dropped it before it committed, or when the session's disposal returned it before pi queued it or opened a run with it. */
  sendMessage(
    prompt: ContentInput,
    _agentId?: string,
    correlationId?: string,
    userBroadcast?: UserBroadcast,
    onWithdrawn?: () => void,
  ): Promise<SendOutcome>;
  /** Resolves `text` as pi would when it starts the prompt, for a caller that puts blocks ahead of it. */
  resolveSlashInvocation(text: string): Promise<SlashInvocation>;
  /** `typed` is what the user typed, which a UserPromptSubmit hook gets when `content` is a rewrite of it. */
  queueInput(content: ContentInput, messageId?: string, typed?: string): 'queued' | 'flushed' | false;
  interrupt(): Promise<void>;
  cancel(): void;
  /** Stops one running shell call; the turn continues, unlike interrupt/cancel which tear it down. */
  cancelToolCall(toolUseId: string, note?: string): boolean;
  cancelAutoCompact(): Promise<void>;
  /** Manually compact the conversation, optionally focusing the summary with `instructions` (US-030). */
  compact(instructions?: string): Promise<void>;
  reset(): void;
  clear(): void;
  dispose(): Promise<void>;
  /** The user's stop of one subagent; false when it had already finished. */
  stopSubagent(agentId: string): boolean;
  steerSubagent(agentId: string, message: string, images?: ImageBlock[], requestId?: string): Promise<void>;
  /** Routes a user `/steer` to a subagent or, failing that, a live team member. */
  steerTarget(agentId: string, message: string, images: ImageBlock[] | undefined, requestId: string): Promise<void>;
  listSteerTargets(): SteerTargetInfo[];

  sendBtw(btwId: string, question: string): Promise<void>;
  cancelBtw(btwId: string): void;

  getMemoryInjection(promptIndex: number): Promise<MemoryInjectionDisplay | undefined>;
  requestContextUsage(): Promise<void>;

  disableThinkingForNextQuery(): void;
  restoreThinkingConfig(): void;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): void;

  /** Push the account state (model, dollar-metered flag) to the webview.
   *  Callers own the timing: it is derived state with no publisher of its own. */
  publishAccountInfo(): void;

  getSupportedModels(): Promise<ModelInfo[]>;
  getSupportedCommands(): Promise<SlashCommandInfo[]>;

  /** The live effective system prompt text, for the clickable `/context` system-prompt preview.
   *  Returns undefined when unavailable (e.g. when the session fails to start). */
  getSystemPromptText(): Promise<string | undefined>;

  /** Markdown describing an MCP tool (name/server/description/schema) for the clickable `/context`
   *  preview. Returns undefined when the tool is unknown or MCP isn't on this backend. */
  getMcpToolInfoMarkdown(piName: string): string | undefined;

  getMcpServerStatus(): Promise<McpServerStatusInfo[]>;
  setMcpServers(scope: McpScope): void;
  /** Register a listener fired whenever live MCP runtime status changes (connect/disconnect/list-change),
   * so the webview reflects connecting → connected without a manual refresh. */
  setMcpStatusListener(listener: () => void): void;

  /** The Tools-panel snapshot (per-group master state + every tool's live enabled state). */
  getToolStatus(): ToolsSnapshot;
  /** Recompute + re-apply the active tool set after a tool/group toggle; effective next turn. */
  refreshActiveTools(): void;
  reconnectMcpServerLive(serverName: string): Promise<boolean>;
  reauthenticateMcpServerLive(serverName: string): Promise<boolean>;
  signOutMcpServerLive(serverName: string): Promise<void>;

  rewindFiles(userMessageId: string, option?: RewindOption, promptContent?: string): Promise<void>;
  undoRewind(preRewindId: string): Promise<void>;
  seedCheckpoints(userMessageIds: Iterable<string>): void;
  /** False for a chat with no project folder: its files are never checkpointed, so only its conversation can be rewound. */
  readonly fileCheckpoints: boolean;
  getAccumulatedCost(): number;

  /**
   * Resolve a pending pi-extension `ctx.ui.*` dialog from a webview `extensionUiResponse` (US-026).
   */
  resolveExtensionUiResponse?(requestId: string, value: string | boolean | null): void;

  /**
   * Resolve once any in-flight session replacement (from `reset()`/`clear()`) has fully completed —
   * the old underlying session is disposed and can no longer write. Resolved when nothing is pending;
   * REJECTS when a replacement failed or was cancelled, i.e. the old session is still installed.
   */
  whenReplaced(): Promise<void>;

  /**
   * Release this panel's session because its file is about to be deleted, and resolve once the old
   * underlying session can no longer write to it. The panel's own webview is told it was cleared.
   * Rejects if the panel could not let go — the caller must then not delete the file.
   */
  detachFromDeletedSession(): Promise<void>;

  /**
   * Another process took the cross-process lease on stored session `sessionId`: stop writing to it at
   * once, then detach. A session this panel no longer holds is ignored.
   */
  onSessionLeaseLost(sessionId: string): void;

  /**
   * Another process asked for stored session `sessionId`: stop its turn, finish this panel's writes, detach
   * and tell the user, then release the lease. A session this panel no longer holds, or a disposed panel, is ignored.
   */
  onSessionReleaseRequested(sessionId: string): Promise<void>;

  /** The panel's identity across reloads, which the lease owner record of every session this panel holds names. */
  setPanelToken(token: string | null): void;
}
