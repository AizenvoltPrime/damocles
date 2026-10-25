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
import type { ChatReviewSnapshot, CommentPlace, DraftComment, ReviewFileDiff, ReviewSubmitOutcome } from './pi-session/chat-review';
import type { ChatScope } from './pi-session/chat-changes';
import type { SessionWorktree } from './pi-session/session-worktree';
import type { McpUserResourcePort } from './pi-session/mcp/tool-source';
import type { ChatAttachmentInfo } from '../shared/types/chat-attachment';
import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { LiveSnapshot } from './pi-session/pi-stream-adapter';

/** What the transcript shows for a sent message: the typed text, its images and the attachments sent with it. */
export interface UserBroadcast {
  content: string;
  contentBlocks?: UserContentBlock[];
  // the prompt starts with one formatted block per attachment, in this order
  terminalAttachments?: ChatAttachmentInfo[];
  // the prompt's last images are the attachments' own, which their chips stand for
  attachmentImageCount?: number;
}

/**
 * `unsent`: the prompt was refused or stopped before pi committed or queued it, so nothing it carried reached the conversation.
 * `withdrawn`: the session itself returned the prompt to the composer, its chips through `onWithdrawn`, before it reached the conversation.
 */
export type SendOutcome = 'sent' | 'unsent' | 'withdrawn';

/** A send claimed before its content is built (`ChatSession.beginSend`). */
export interface SendTicket {
  /** Aborted once a Stop, New chat, resume switch or disposal stopped the send; one that pi did not hold yet went back to the composer. */
  readonly signal: AbortSignal;
  /** Frees the session for the next send when this one ends without `sendMessage`; a no-op after `sendMessage` took it. */
  end: () => void;
}

/**
 * What became of a resume: pi bound the conversation, could not (the session told the user `reason`), or the panel let go of
 * it first; `deferred` when the panel has not started, so it holds no other conversation and its start opens this one.
 */
export type ResumeOutcome =
  | { readonly kind: 'switched' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'deferred' };

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
  /** Whether a turn is running, the lifecycle `sessionStateChanged` and the webview's spinner follow. */
  readonly turnRunning: boolean;
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

  /** Where the chat works (AD12): its place, read-only state, isolation and `worktreeState`. */
  readonly worktree: SessionWorktree;
  /** D61's note naming the chat's new working folder, delivered with the next prompt. */
  noteWorkingFolder(folder: string): void;
  /** Whether this session is on, starting on, or switching to stored session `sessionId`. */
  holdsSession(sessionId: string): boolean;
  /** True when a resume or fork target is pending, a turn is processing, or the live session has messages. */
  hasConversation(): boolean;
  /** Whether the started session has its file on disk; pi writes none before the conversation's first prompt. */
  hasSessionFile(): boolean;
  /** The stored session whose file this session is on, or opens at start (a resume or fork target); null while it has no file. */
  readonly storedSessionId: string | null;
  setResumeSession(sessionId: string | null): void;
  /**
   * Opens the stored session `setResumeSession` named. A started or starting panel resolves once pi holds it, could not open
   * it (the panel then holds what it held before and the target's lease is released), or let go of it first. A panel that
   * has not started resolves `deferred` at once: the caller shows the conversation, then starts the session, which opens it
   * or tells the user why it could not and keeps it as the target. Never rejects.
   */
  openResumeTarget(sessionId: string): Promise<ResumeOutcome>;
  /**
   * A `deferred` open whose replay read no file of `sessionId` showed none of it, so the panel lets go of it while no start
   * has bound it, and its start opens a new conversation. Whether it let go.
   */
  letGoOfUnreadTarget(sessionId: string): boolean;
  /** The review tab's changed files in a scope (D60); fresh reads again whatever changed (a user's open, a hand-off). */
  chatReviewSnapshot(scope: ChatScope, opts?: { readonly fresh?: boolean }): Promise<ChatReviewSnapshot>;
  /** One file's diff in the review tab's scope, as git prints it; missing when the file is not listed there. */
  chatReviewFileDiff(scope: ChatScope, filePath: string): Promise<ReviewFileDiff>;
  /** What a new comment's line is checked against at send, read from core's diff now; undefined when the comment's diff is not the current one. */
  chatReviewAnchor(place: CommentPlace): Promise<string | undefined>;
  /** The drafts whose line changed or left its scope's diff since they were made (D60's one staleness rule). */
  chatReviewStale(drafts: readonly DraftComment[]): Promise<DraftComment[]>;
  /** The review comments as one user message composed from core's own diff; a running chat queues it. */
  submitReview(drafts: readonly DraftComment[]): Promise<ReviewSubmitOutcome>;
  initializeEarly(): Promise<void>;
  /** The webview (re)started with an empty dialog queue, so nothing on screen can answer what this
   *  side is still awaiting. Called from the `ready` handler. */
  onWebviewReady(): void;
  /** A replay of `sessionId` rebuilt its subagent cards from their files; when it is the bound conversation, its live runs are posted again. */
  replayLiveAgents(sessionId: string): void;
  /** The count of live events emitted so far, and a live event's own number; undefined for any other message. */
  readonly eventSeq: number;
  eventSeqOf(message: object): number | undefined;
  /** Settles once no resume, restore or hand-off switch is pending (`openResumeTarget`'s outcome). */
  whenConversationSettled(): Promise<void>;
  /** The conversation pi holds with its in-memory branch and live snapshot, read in one step; undefined with no runtime. */
  liveConversation(): { readonly sessionId: string; readonly stored: boolean; readonly branch: readonly SessionEntry[]; readonly sessionManager: AgentSession["sessionManager"]; readonly snapshot: LiveSnapshot } | undefined;

  /**
   * Claims the session's one send for a message whose content still needs reading, so a Stop, New chat, resume
   * switch or disposal meanwhile returns it (`returnUnsent`'s text, then `onWithdrawn`) and aborts the ticket's
   * signal. Null, with the refusal reported, while another send or a compaction holds the session.
   */
  beginSend(correlationId: string, userBroadcast: UserBroadcast, onWithdrawn: () => void): SendTicket | null;
  /**
   * `onWithdrawn` runs at most once, whenever the prompt goes back to the composer without committing: a Stop, New
   * chat, resume switch or disposal before pi held it, a New chat, resume switch or disposal before pi accepted it, or
   * pi's queue dropped after pi queued it. `ticket` continues a `beginSend`, whose `onWithdrawn` then applies.
   * `target` is the conversation the send was written for, absent when the sender showed none; a send for any other
   * conversation than the one pi would prompt goes back to the composer (docs/invariants.md, "A send names its conversation").
   */
  sendMessage(
    prompt: ContentInput,
    target?: string,
    correlationId?: string,
    userBroadcast?: UserBroadcast,
    onWithdrawn?: () => void,
    ticket?: SendTicket,
  ): Promise<SendOutcome>;
  /** Resolves `text` as pi would when it starts the prompt, for a caller that puts blocks ahead of it. */
  resolveSlashInvocation(text: string): Promise<SlashInvocation>;
  /**
   * `typed` is what the user typed, which a UserPromptSubmit hook gets when `content` is a rewrite of it.
   * `otherConversation`: the message names another conversation than the running one (`sendMessage`'s `target`), so it was not queued.
   */
  queueInput(content: ContentInput, messageId?: string, typed?: string, target?: string): 'queued' | 'flushed' | 'otherConversation' | false;
  interrupt(): Promise<void>;
  cancel(): void;
  /** Stops one running shell call; the turn continues, unlike interrupt/cancel which tear it down. */
  cancelToolCall(toolUseId: string, note?: string): boolean;
  cancelAutoCompact(): Promise<void>;
  /** Manually compact the conversation, optionally focusing the summary with `instructions` (US-030). `onAccepted` runs only when it is not refused; `target` as `sendMessage`'s. */
  compact(instructions?: string, onAccepted?: () => void, target?: string): Promise<void>;
  reset(): void;
  clear(): void;
  dispose(): Promise<void>;
  /** The user's stop of one subagent; false when it had already finished. */
  stopSubagent(agentId: string): boolean;
  steerSubagent(agentId: string, message: string, images?: ImageBlock[], requestId?: string): Promise<void>;
  /** Routes a user `/steer` to a subagent or, failing that, a live team member. */
  steerTarget(agentId: string, message: string, images: ImageBlock[] | undefined, requestId: string): Promise<void>;
  listSteerTargets(): SteerTargetInfo[];

  /** `target` as `sendMessage`'s: the aside reads the conversation the question was asked in, or none. */
  sendBtw(btwId: string, question: string, target?: string): Promise<void>;
  cancelBtw(btwId: string): void;

  getMemoryInjection(promptIndex: number): Promise<MemoryInjectionDisplay | undefined>;
  requestContextUsage(): Promise<void>;

  disableThinkingForNextQuery(): void;
  restoreThinkingConfig(): void;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Resolves once the switch was committed or refused and the committed model was published; a session disposed meanwhile resolves without publishing. */
  setModel(model?: string): Promise<void>;
  /** The end of an OpenAI sign-in: applies a model pick that asked for it when `signedIn`, and drops that pick either way. */
  openaiSignInEnded(signedIn: boolean): Promise<void>;

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
  /** The MCP panel's own resource requests, which resource exposure never restricts (D13); null before the folder resolves. */
  mcpUserResources(): McpUserResourcePort | null;
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
