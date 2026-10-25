import * as path from "path";
import type { Disposable } from "../../platform/disposable";
import type { PlatformWithWorktrees } from "../worktrees/host";
import type { PanelHost } from "../../platform/window-service";
import { PermissionHandler, type ChatPermissions } from "../permission-handler";
import { IdeContextManager } from "./ide-context-manager";
import { MAX_PENDING_TERMINAL_ATTACHMENT_CHARS, TerminalAttachmentManager } from "./terminal-attachment-manager";
import type { ChatAttachmentInput } from "../../shared/types/chat-attachment";
import { log } from "../logger";
import { mentionInChat, type MentionTarget } from "./mention-resolver";
import { t } from "../l10n";
import { perfSpan, type PerfSpan } from "../perf";
import type { ChatSession } from "../chat-session";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../shared/types/messages";
import type { ForkContext, ForkSpawnArgs, StoredSession } from "../../shared/types/session";
import type { AttachedView, HostInstance, ViewJoinGate } from "./types";
import type { PromptTarget } from "./webview-prompts";
import { claimStoredSession } from "./session-ownership";
import { PanelWorktrees, type PanelWorktreeStateEvent, type WorktreeOptIn } from "./panel-worktrees";
import { sessionLeaseBlocker } from "../pi-session/session-store/session-lease";
import { folderContains } from "../worktrees/records";
import type { ChatPlace, WorktreeAction, WorktreeFinishAction } from "../../shared/types/messages";
import type { UserContentBlock } from "../../shared/types/content";
import { settingsFolderOf, type FolderChange, type FolderTarget, type WorkspaceFolderRegistry } from "../workspace-folders/folder-registry";
import { chatPageHtml, ERROR_PAGE_STRINGS, errorPageHtml } from "../../shared/panel-html";
import { readContributedConfiguration } from "../config/read-contributed-configuration";
import { writableKeysOf } from "./settings-view-scope";
import { PanelActivity, type PanelActivityListener, type PanelChatChangesListener, type PanelTurnSettledListener, type UsageThresholdListener } from "./activity";
import type { UsageThresholdCrossing } from "../pi-session/usage-thresholds";
import { SETTINGS_VIEW_MESSAGE_TYPES, SETTINGS_VIEW_REQUEST_TYPES } from "../../shared/settings-view-messages";

/** Why a panel changes folder. Only `'user'` asks before discarding a conversation. */
/** chatMove: a hand-off (D61) or a worktree chat's first send, which keeps or has no conversation, so nothing is asked. */
export type FolderSwitchReason = "user" | "resume" | "restore" | "folderRemoved" | "chatMove";

/** Runs on the panel's instance inside the folder task, before queued webview messages are delivered and before a replacement session starts. */
export type AfterFolderSwitch = (instance: HostInstance) => Promise<void>;

/** Open from the moment a webview's HTML is built until its next `ready`. */
const htmlToReadySpans = new WeakMap<PanelHost, PerfSpan>();

interface HostSetUp {
  readonly settled: Promise<void>;
  readonly start: (setUp: Promise<unknown>) => void;
}

/** Calls `listener` when `read` answers differently after one of the host's view-state events. */
function onViewStateChange(host: PanelHost, read: () => boolean, listener: () => void): Disposable {
  let prev = read();
  return host.onDidChangeViewState(() => {
    const now = read();
    if (now !== prev) {
      prev = now;
      listener();
    }
  });
}

/** Settles when `work` settles or `signal` aborts, whichever comes first; never rejects. */
async function settledOrAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  let onAbort = (): void => undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([work.then(() => undefined, () => undefined), aborted]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Webview messages that arrive while the panel has no usable session wait here, in order; `view` marks one from an attached view. */
interface MessageGate {
  open: boolean;
  // A `ready` is being handled; it restores the conversation every later message addresses, so they wait for it.
  readying: boolean;
  queue: Array<{ message: WebviewToExtensionMessage; view?: AttachedView }>;
}

export interface PanelManagerConfig {
  platform: PlatformWithWorktrees;
  createSessionForPanel: (
    host: PanelHost,
    permissionHandler: PermissionHandler,
    panelId: string,
    folder: FolderTarget,
    forkContext?: ForkContext,
  ) => Promise<ChatSession>;
  folderRegistry: WorkspaceFolderRegistry;
  /** Re-push what depends on the panel's folder (slash commands, tools, MCP, Compass, @-mention files). */
  sendFolderState: (instance: HostInstance) => Promise<void>;
  /** Release a folder that left the workspace, once no panel targets it any more. */
  releaseFolder: (key: string) => Promise<void>;
  /** `view` is set for a message an attached view sent through `dispatchFromView`. */
  handleWebviewMessage: (message: WebviewToExtensionMessage, panelId: string, view?: AttachedView) => Promise<void>;
  joinView: (panelId: string, gate: ViewJoinGate) => Promise<void>;
  sendCurrentSettings: (host: PanelHost, permissionHandler: PermissionHandler, folder: FolderTarget) => Promise<void>;
  getStoredSessions: () => Promise<{ sessions: StoredSession[]; hasMore: boolean; nextOffset: number }>;
  invalidateSessionsCache: () => void;
  initPanelModel: (panelId: string) => void;
  cleanupPanelModel: (panelId: string) => void;
  cleanupPanelThinking: (panelId: string) => void;
  sendThinkingForPanel: (host: PanelHost, panelId: string, folder: FolderTarget) => void;
  getInitialMessages: (folder: FolderTarget) => ExtensionToWebviewMessage[];
  /** Fires when the last-focused panel, or that panel's folder, changes. */
  onActivePanelChanged?: () => void;
  inheritSettingsFromPanel: (sourcePanelId: string, newPanelId: string) => void;
  /** Full-session replay (pi fork resumes a pre-truncated branched session — US-013c). */
  loadHistory: (cwd: string, sessionId: string, host: PanelHost, session: ChatSession) => Promise<string[] | null>;
  /** The stored sessions listed under the open project `projectKey` so far (a worktree's share count). */
  storedSessionsOf: (projectKey: string) => Promise<readonly StoredSession[]>;
  /** `storedSessionsOf` once none is still being parsed (removing deleted worktree records). */
  completeStoredSessionsOf: (projectKey: string) => Promise<readonly StoredSession[]>;
}

/** How a host is set up: a fork of a panel, a folder the webview saved, or a new chat bound to a live chat worktree. */
interface HostSetUpOptions {
  forkContext?: ForkContext;
  sourcePanelId?: string;
  initialFolderKey?: string;
  worktree?: { readonly projectKey: string; readonly worktreeId: string };
  // what the chat's ended core published (a desktop engine restart), in place of the folder's defaults
  permissions?: ChatPermissions;
}

export class PanelManager {
  private panels: Map<string, HostInstance> = new Map();
  private hostCounter = 0;
  private lastActivePanelId: string | null = null;
  private readonly allClosedListeners: Set<() => void> = new Set();
  private readonly resourceRoot: string;
  private readonly platform: PlatformWithWorktrees;
  private readonly createSessionForPanel: PanelManagerConfig["createSessionForPanel"];
  private readonly handleWebviewMessage: PanelManagerConfig["handleWebviewMessage"];
  private readonly joinViewOf: PanelManagerConfig["joinView"];
  /** The panel posts waiting while a view joins its host, each with the session whose live events it may hold. */
  private readonly joins = new Map<PanelHost, { readonly session: ChatSession; held: ExtensionToWebviewMessage[] | undefined }>();
  private readonly sendCurrentSettings: PanelManagerConfig["sendCurrentSettings"];
  private readonly getStoredSessions: PanelManagerConfig["getStoredSessions"];
  private readonly initPanelModel: PanelManagerConfig["initPanelModel"];
  private readonly cleanupPanelModel: PanelManagerConfig["cleanupPanelModel"];
  private readonly cleanupPanelThinking: PanelManagerConfig["cleanupPanelThinking"];
  private readonly sendThinkingForPanel: PanelManagerConfig["sendThinkingForPanel"];
  private readonly getInitialMessages: PanelManagerConfig["getInitialMessages"];
  private readonly onActivePanelChanged: PanelManagerConfig["onActivePanelChanged"];
  private readonly inheritSettingsFromPanel: PanelManagerConfig["inheritSettingsFromPanel"];
  private readonly loadHistory: PanelManagerConfig["loadHistory"];
  private readonly folderRegistry: WorkspaceFolderRegistry;
  private readonly sendFolderState: PanelManagerConfig["sendFolderState"];
  private readonly releaseFolder: PanelManagerConfig["releaseFolder"];
  private readonly messageGates = new Map<string, MessageGate>();
  /** Per-panel tail of folder work, so switches and removals on one panel never interleave. */
  private readonly folderChains = new Map<string, Promise<unknown>>();
  private readonly folderChangeSubscription: Disposable;
  /** Session disposals still running; `dispose()` awaits them, so a panel closed first still releases its lease before exit. */
  private readonly closingSessions = new Set<Promise<void>>();
  /** One entry per panel being opened or set up, removed as it settles; a host prompt waits for these before opening a panel. */
  private readonly opening = new Set<Promise<void>>();
  /** Each host's setup, made by whenSetUp or initializeHost, whichever asks first, so a host asked about while core creates it waits too. */
  private readonly setUps = new WeakMap<PanelHost, HostSetUp>();
  private readonly activity = new PanelActivity();
  /** At most one settings view per panel. */
  private readonly attachments = new Map<string, AttachedView>();
  private readonly attachmentListeners = new Set<(panelId: string) => void>();
  private readonly restoreRetryListeners = new Set<(panelId: string) => void>();
  private readonly permissionsListeners = new Set<(panelId: string) => void>();
  /** Opt-ins, held first prompts, hand-offs and owned working folders (slice 12a). */
  readonly worktrees: PanelWorktrees;

  constructor(config: PanelManagerConfig) {
    this.platform = config.platform;
    this.resourceRoot = config.platform.paths.resourceRoot;
    this.createSessionForPanel = config.createSessionForPanel;
    this.handleWebviewMessage = config.handleWebviewMessage;
    this.joinViewOf = config.joinView;
    this.sendCurrentSettings = config.sendCurrentSettings;
    this.getStoredSessions = config.getStoredSessions;
    this.initPanelModel = config.initPanelModel;
    this.cleanupPanelModel = config.cleanupPanelModel;
    this.cleanupPanelThinking = config.cleanupPanelThinking;
    this.sendThinkingForPanel = config.sendThinkingForPanel;
    this.getInitialMessages = config.getInitialMessages;
    this.onActivePanelChanged = config.onActivePanelChanged;
    this.inheritSettingsFromPanel = config.inheritSettingsFromPanel;
    this.loadHistory = config.loadHistory;
    this.folderRegistry = config.folderRegistry;
    this.sendFolderState = config.sendFolderState;
    this.releaseFolder = config.releaseFolder;
    this.worktrees = new PanelWorktrees({
      platform: this.platform,
      folderRegistry: this.folderRegistry,
      panels: () => this.panels,
      moveTo: (panelId, key, afterSwitch) => this.switchPanelFolder(panelId, key, "chatMove", afterSwitch),
      post: (panelId, message) => {
        const instance = this.panels.get(panelId);
        if (instance) this.postMessage(instance.host, message);
      },
      dispatch: (panelId, message) => this.handleWebviewMessage(message, panelId),
      resumeInto: (instance, sessionId, beforeOpen) => this.resumeInto(instance, sessionId, beforeOpen),
      releaseFolder: (key) => this.releaseFolder(key),
      sessionsClosed: async () => {
        await Promise.all([...this.closingSessions]);
      },
      storedSessionsOf: config.storedSessionsOf,
      completeStoredSessionsOf: config.completeStoredSessionsOf,
    });
    this.folderChangeSubscription = this.folderRegistry.onDidChange((change) => {
      this.onFoldersChanged(change).catch((err) => log("[PanelManager] workspace folder change failed: %O", err));
    });
    // Activity reports every bind and stored session change; the retry's own open clears it once it settled.
    this.activity.onActivity((panelId) => this.dropRestoreRetry(panelId));
  }

  /** A pending restore retry stands for the panel only while it holds no conversation of its own. */
  private dropRestoreRetry(panelId: string): void {
    const instance = this.panels.get(panelId);
    if (instance?.restoreRetry === undefined) return;
    const { session, restoreRetry } = instance;
    if (!session.hasConversation() || session.holdsSession(restoreRetry)) return;
    delete instance.restoreRetry;
    this.restoreRetryChanged(panelId);
  }

  getPanels(): Map<string, HostInstance> {
    return this.panels;
  }

  /** Mentions a file in a loaded chat's composer under the one mention rule (mention-resolver.ts); false when refused. */
  async mentionFile(panelId: string, target: MentionTarget): Promise<boolean> {
    const instance = this.panels.get(panelId);
    if (!instance) throw new Error('The chat is not loaded');
    return mentionInChat(
      { folders: this.folderRegistry, confinement: this.platform.confinement, notifications: this.platform.notifications, post: (message) => this.postMessage(instance.host, message) },
      target,
      instance.folder.fsPath,
    );
  }

  /**
   * Adds terminal output or a commit to a loaded chat's composer as a pending attachment; the host has already capped and
   * cleaned it. False when refused.
   */
  addTerminalAttachment(panelId: string, attachment: ChatAttachmentInput): boolean {
    const instance = this.panels.get(panelId);
    if (!instance) throw new Error('The chat is not loaded');
    if (instance.terminalAttachments.add(attachment)) return true;
    const limit = MAX_PENDING_TERMINAL_ATTACHMENT_CHARS.toLocaleString(this.platform.localization.language);
    void this.platform.notifications.warn(attachment.kind === 'commit'
      ? t('Not added to the chat: with this commit its attachments would pass {0} characters. Send or remove an attachment first.', limit)
      : t('Not added to the chat: its attached terminal output would pass {0} characters. Send or remove an attachment first.', limit));
    return false;
  }

  /** Puts text in a loaded chat's composer after its draft, which it never replaces; nothing is sent. */
  async appendToComposer(panelId: string, text: string): Promise<void> {
    const instance = this.panels.get(panelId);
    if (!instance) throw new Error("The chat is not loaded");
    await instance.webviewReady;
    // The ready gate also settles when the panel closes, which leaves no composer to write into.
    if (this.panels.get(panelId) !== instance) return;
    this.postMessage(instance.host, { type: "composerAppend", text });
  }

  /** Fires once each time a panel's session is bound, then on every change of its activity or stored session id. */
  onActivity(listener: PanelActivityListener): Disposable {
    return this.activity.onActivity(listener);
  }

  onTurnSettled(listener: PanelTurnSettledListener): Disposable {
    return this.activity.onTurnSettled(listener);
  }

  /** What each panel's chat changed (D60), on every recompute; only a host with HostCapabilities.chatReview reports it. */
  onChatChanges(listener: PanelChatChangesListener): Disposable {
    return this.activity.onChatChanges(listener);
  }

  /** A subscription usage window crossed 80% or 95%; process-wide, not tied to a panel. */
  onUsageThreshold(listener: UsageThresholdListener): Disposable {
    return this.activity.onUsageThreshold(listener);
  }

  /** Reports a crossing the runtime's `UsageMonitor` raised to every `onUsageThreshold` listener. */
  usageThresholdCrossed(crossing: UsageThresholdCrossing): void {
    this.activity.usageThresholdCrossed(crossing);
  }

  /** The stored session whose file the panel is on or is about to open; undefined while none exists. */
  sessionIdOf(panelId: string): string | undefined {
    return this.panels.get(panelId)?.session.storedSessionId ?? undefined;
  }

  hasConversation(panelId: string): boolean {
    return this.panels.get(panelId)?.session.hasConversation() ?? false;
  }

  /** A restore its lease refused scheduled its retry, or ran it (`HostInstance.restoreRetry`). */
  onRestoreRetry(listener: (panelId: string) => void): Disposable {
    this.restoreRetryListeners.add(listener);
    return { dispose: (): void => { this.restoreRetryListeners.delete(listener); } };
  }

  restoreRetryChanged(panelId: string): void {
    for (const listener of [...this.restoreRetryListeners]) listener(panelId);
  }

  /** A panel's permission mode or YOLO changed (`PermissionHandler.getPermissions`). */
  onPermissionsChanged(listener: (panelId: string) => void): Disposable {
    this.permissionsListeners.add(listener);
    return { dispose: (): void => { this.permissionsListeners.delete(listener); } };
  }

  onAllPanelsClosed(callback: () => void): Disposable {
    this.allClosedListeners.add(callback);
    return { dispose: (): void => { this.allClosedListeners.delete(callback); } };
  }

  /** Opens a chat panel on the default folder; resolves its panel id. */
  show(): Promise<string> {
    return this.trackOpening(this.openDefaultPanel());
  }

  private async openDefaultPanel(): Promise<string> {
    const host = await this.platform.window.createPanelInOwnColumn({
      kind: "chat",
      title: "Damocles",
      localResourceRoots: this.getLocalResourceRoots(),
    });
    this.showChatPage(host);
    host.setIcon(path.join(this.resourceRoot, "resources", "icon.png"));

    return this.initializeHost(host);
  }

  /**
   * The chat panel a host prompt renders in: the last active one, else any open one, else one still being opened,
   * else a new one on the default folder. Resolves once its webview is ready; undefined when it closed or the
   * signal aborted first.
   */
  async promptTarget(signal: AbortSignal | undefined): Promise<PromptTarget | undefined> {
    const panelId = await this.promptPanelId(signal);
    if (panelId === undefined) return undefined;
    const instance = this.panels.get(panelId);
    if (!instance) return undefined;
    if (instance.webviewReady) await settledOrAborted(instance.webviewReady, signal);
    if (signal?.aborted || this.panels.get(panelId) !== instance) return undefined;
    return { panelId, host: instance.host };
  }

  // A panel registers only once its session exists, well after its webview shows, so one still opening is waited for.
  private async promptPanelId(signal: AbortSignal | undefined): Promise<string | undefined> {
    for (;;) {
      const open = this.lastActivePanelId ?? this.findFallbackActivePanelId() ?? this.panels.keys().next().value;
      if (open !== undefined) return open;
      if (this.opening.size === 0) return this.show();
      await settledOrAborted(Promise.race(this.opening), signal);
      if (signal?.aborted) return undefined;
    }
  }

  private trackOpening(work: Promise<string>): Promise<string> {
    const settled: Promise<void> = work.then(() => undefined, () => undefined).then(() => {
      this.opening.delete(settled);
    });
    this.opening.add(settled);
    return work;
  }

  async showForked(args: ForkSpawnArgs): Promise<HostInstance | null> {
    const forkContext: ForkContext = {
      sourceSdkSessionId: args.sourceSdkSessionId,
      forkAtUuid: args.forkAtUuid,
      consumed: false,
      ...(args.piBranchedSessionId ? { piBranchedSessionId: args.piBranchedSessionId } : {}),
    };

    const sourceColumn = this.panels.get(args.sourcePanelId)?.host.column;

    const host = this.platform.window.createPanel({
      kind: "chat",
      title: "Damocles",
      localResourceRoots: this.getLocalResourceRoots(),
      ...(sourceColumn !== undefined ? { column: sourceColumn } : {}),
    });
    this.showChatPage(host);
    host.setIcon(path.join(this.resourceRoot, "resources", "icon.png"));

    const newPanelId = await this.initializeHost(host, {
      forkContext,
      sourcePanelId: args.sourcePanelId,
    });

    // Detached on purpose: the source rewind awaits showForked, so it must not block on the new panel's
    // webview mounting (replayForkedHistory awaits that internally).
    void this.replayForkedHistory(host, newPanelId, args);

    return this.panels.get(newPanelId) ?? null;
  }

  /**
   * Replay a forked panel's branched transcript (and prefill) once its webview has mounted — gated on
   * `webviewReady` so the extension-initiated push isn't dropped before the webview's listener exists.
   * The gate settles on dispose, so a panel closed before mount just makes this bail.
   */
  private async replayForkedHistory(host: PanelHost, panelId: string, args: ForkSpawnArgs): Promise<void> {
    await this.panels.get(panelId)?.webviewReady;
    const instance = this.panels.get(panelId);
    if (!instance) return; // closed before it mounted

    try {
      // A first-message fork has no branched session (fresh panel + prefill only).
      if (args.piBranchedSessionId) await this.loadHistory(instance.folder.fsPath, args.piBranchedSessionId, host, instance.session);
    } catch (err) {
      log("[PanelManager.replayForkedHistory] history replay failed: %O", err);
      this.postMessage(host, {
        type: "rewindError",
        message: `Failed to replay forked history: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (args.promptContent && args.promptContent.length > 0) {
      this.postMessage(host, { type: "prefillInput", text: args.promptContent });
    }
  }

  async restorePanel(host: PanelHost, workspaceFolderKey: string | undefined, permissions?: ChatPermissions): Promise<void> {
    this.showChatPage(host);
    try {
      await this.initializeHost(host, {
        ...(workspaceFolderKey !== undefined ? { initialFolderKey: workspaceFolderKey } : {}),
        ...(permissions ? { permissions } : {}),
      });
    } catch (err) {
      log(`[PanelManager] Failed to restore panel: ${err}`);
      this.showErrorPage(host);
    }
  }

  /**
   * Opens a new chat on `host` bound to the live chat worktree `worktreeId` of the open project `projectKey`; its first
   * session starts in the working folder. Resolves the panel id; rejects, with no panel left registered, when the worktree is
   * refused or the session cannot start.
   */
  async startInWorktree(host: PanelHost, projectKey: string, worktreeId: string): Promise<string> {
    this.showChatPage(host);
    return this.initializeHost(host, { worktree: { projectKey, worktreeId } });
  }

  initializeHost(
    host: PanelHost,
    options?: HostSetUpOptions,
  ): Promise<string> {
    const setUp = this.trackOpening(this.setUpHost(host, options));
    this.setUpOf(host).start(setUp);
    return setUp;
  }

  /** Settles, never rejecting, once core finished setting the host up, registered or not; ask only for a host core sets up. */
  whenSetUp(host: PanelHost): Promise<void> {
    return this.setUpOf(host).settled;
  }

  private setUpOf(host: PanelHost): HostSetUp {
    let entry = this.setUps.get(host);
    if (!entry) {
      let start!: (setUp: Promise<unknown>) => void;
      const settled = new Promise<void>((resolve) => {
        start = (setUp) => resolve(setUp.then(() => undefined, () => undefined));
      });
      entry = { settled, start };
      this.setUps.set(host, entry);
    }
    return entry;
  }

  private async setUpHost(
    host: PanelHost,
    options?: HostSetUpOptions,
  ): Promise<string> {
    const panelId = `host-${++this.hostCounter}`;
    const disposables: Disposable[] = [];

    const gate: MessageGate = { open: false, readying: false, queue: [] };
    this.messageGates.set(panelId, gate);

    // Resolves when the webview posts its first `ready` message (mounted + listener live). VS Code drops
    // extension→webview posts sent before that, so only extension-INITIATED pushes (the fork replay) await
    // this gate; every other push is already triggered BY the webview's own `ready`.
    let signalWebviewReady!: () => void;
    const webviewReady = new Promise<void>((resolve) => { signalWebviewReady = resolve; });
    // Settle via the disposables list so BOTH teardown paths (onDidDispose and dispose()) release a
    // detached replay still awaiting a webview that never mounted.
    disposables.push({ dispose: () => signalWebviewReady() });

    disposables.push(
      host.onMessage((received) => {
        const message = received as WebviewToExtensionMessage;
        if (message.type === "ready") {
          signalWebviewReady();
          htmlToReadySpans.get(host)?.end();
          htmlToReadySpans.delete(host);
        }
        gate.queue.push({ message });
        this.drainGate(panelId, gate);
      }),
    );

    // Subscribed before the first await: a host does not call a dispose listener added after it closed.
    let closed = false;
    disposables.push(
      host.onDispose(() => {
        closed = true;
        const instance = this.panels.get(panelId);
        if (!instance) return;
        this.detachPanelView(panelId);
        this.releasePanel(panelId, instance);
        this.worktrees.panelClosed(panelId);
        this.panels.delete(panelId);
        this.messageGates.delete(panelId);
        this.folderChains.delete(panelId);
        if (this.lastActivePanelId === panelId) {
          this.setLastActivePanel(this.findFallbackActivePanelId());
        }
        if (this.panels.size === 0) {
          for (const cb of this.allClosedListeners) {
            try {
              cb();
            } catch (err) {
              log("[PanelManager] allClosed listener error:", err);
            }
          }
        }
      }),
    );

    const source = options?.sourcePanelId ? this.panels.get(options.sourcePanelId) : undefined;
    // A fork continues its source's conversation, whose session file lives under the source's folder. A new chat in a worktree
    // is bound before its session exists, so no session ever starts in the project folder for it.
    let folder: FolderTarget;
    try {
      folder = options?.worktree
        ? this.worktrees.bindNewPanel(panelId, options.worktree.projectKey, options.worktree.worktreeId)
        : source?.folder
          ?? (options?.initialFolderKey !== undefined ? this.folderRegistry.resolve(options.initialFolderKey) : undefined)
          ?? this.folderRegistry.defaultTarget();
    } catch (err) {
      disposables.forEach((d) => d.dispose());
      this.messageGates.delete(panelId);
      throw err;
    }

    const permissionHandler = new PermissionHandler(this.platform, panelId, settingsFolderOf(folder));
    permissionHandler.setPostMessage((msg) => this.postMessage(host, msg));
    // Before the session is created, which takes its tool set from the mode.
    const inherited = source?.permissionHandler.getPermissions() ?? options?.permissions;
    if (inherited) {
      permissionHandler.setPermissionMode(inherited.permissionMode);
      permissionHandler.setDangerouslySkipPermissions(inherited.dangerouslySkipPermissions);
    }
    permissionHandler.setPermissionsListener(() => {
      for (const listener of [...this.permissionsListeners]) listener(panelId);
    });

    permissionHandler.setWorkspacePath(folder.projectScope ? folder.fsPath : null);
    permissionHandler.setCwd(folder.fsPath);

    const ideContextManager = new IdeContextManager(this.platform.editor, (context) => {
      this.postMessage(host, { type: "ideContextUpdate", context });
    }, (filePath) => {
      // AD12's wrong-copy guard: a worktree chat takes IDE context only from files in its working folder.
      const current = this.panels.get(panelId)?.folder ?? folder;
      return current.ownerKey === undefined || folderContains(current.fsPath, filePath);
    });
    const terminalAttachments = new TerminalAttachmentManager((attachments, added) => {
      this.postMessage(host, { type: "terminalAttachmentsUpdate", attachments, ...(added ? { focusComposer: true as const } : {}) });
    });

    this.initPanelModel(panelId);

    if (options?.sourcePanelId) {
      this.inheritSettingsFromPanel(options.sourcePanelId, panelId);
    }

    for (const msg of this.getInitialMessages(folder)) {
      this.postMessage(host, msg);
    }

    let session: ChatSession;
    try {
      session = await this.createSessionForPanel(host, permissionHandler, panelId, folder, options?.forkContext);
    } catch (err) {
      // Nothing registered the panel yet, so its worktree hold and what it set up go here.
      this.worktrees.panelClosed(panelId);
      ideContextManager.dispose();
      disposables.forEach((d) => d.dispose());
      void permissionHandler.dispose().catch((disposeErr: unknown) => log("[PanelManager] permission handler dispose failed: %O", disposeErr));
      this.cleanupPanelModel(panelId);
      this.messageGates.delete(panelId);
      throw err;
    }

    const instance: HostInstance = {
      host,
      session,
      folder,
      panelToken: null,
      permissionHandler,
      ideContextManager,
      terminalAttachments,
      disposables,
      webviewReady,
      ...(options?.forkContext ? { forkContext: options.forkContext } : {}),
      ...(options?.permissions ? { permissionsHandedBack: true } : {}),
    };
    if (closed) {
      // The host closed while the session was being created, before the panel was registered.
      this.releasePanel(panelId, instance);
      this.worktrees.panelClosed(panelId);
      this.messageGates.delete(panelId);
      if (options?.worktree) throw new Error("The chat closed before its session started");
      return panelId;
    }
    this.panels.set(panelId, instance);
    if (options?.worktree) this.worktrees.markUsed(options.worktree.worktreeId);
    this.bindSessionCallbacks(panelId, instance);
    this.applyFolderTitle(instance);

    if (host.active) {
      this.setLastActivePanel(panelId);
    }

    disposables.push(
      onViewStateChange(host, () => host.active, () => {
        if (host.active) {
          this.setLastActivePanel(panelId);
        }
      }),
    );

    this.openGate(panelId);

    // The folder may have left the workspace while the session was being created, after its removal
    // released it; anything this panel started there meanwhile has to be released again.
    if (!this.folderRegistry.resolve(folder.key)) {
      this.movePanelOffRemovedFolders(panelId, new Set([folder.key]))
        .then(async (moved) => {
          if (moved && !this.folderRegistry.resolve(folder.key) && !this.isTargeted(folder.key)) {
            await this.releaseFolder(folder.key);
          }
        })
        .catch((err) => log("[PanelManager] moving %s off a removed folder failed: %O", panelId, err));
    }

    disposables.push(
      onViewStateChange(host, () => host.visible, () => {
        if (host.visible) {
          this.postMessage(host, { type: "panelFocused" });
          this.getStoredSessions()
            .then(({ sessions, hasMore, nextOffset }) => {
              this.postMessage(host, {
                type: "storedSessions",
                sessions,
                hasMore,
                nextOffset,
                isFirstPage: true,
              });
            })
            .catch(() => {});
        }
      }),
    );

    disposables.push(
      this.platform.settings.onDidChange("damocles", (e) => {
        const current = this.panels.get(panelId);
        if (!current) return;
        void this.sendCurrentSettings(host, permissionHandler, current.folder);
        if (
          e.affects("damocles.thinkingDisabled") ||
          e.affects("damocles.effortByModel")
        ) {
          this.sendThinkingForPanel(host, panelId, current.folder);
        }
      }),
      // A grant changes whether the Workspace section can be written even when no setting changed.
      this.platform.trust.onDidGrantTrust(() => {
        const current = this.panels.get(panelId);
        if (current) void this.sendCurrentSettings(host, permissionHandler, current.folder);
      }),
    );

    return panelId;
  }

  onDidChangeWorktreeState(listener: (event: PanelWorktreeStateEvent) => void): Disposable {
    return this.worktrees.onDidChangeState(listener);
  }

  /** D30's opt-in for a new chat, from the New menu; nothing is created before its first send. */
  setWorktreeOptIn(panelId: string, optIn: WorktreeOptIn): Promise<void> {
    return this.worktrees.setOptIn(panelId, optIn);
  }

  /** D61's hand-off from the palette or the header button; core re-checks that the chat is idle. */
  chatMove(panelId: string, to: ChatPlace): Promise<void> {
    return this.worktrees.chatMove(panelId, to);
  }

  /**
   * D33: holds the worktree for a finish action, after its last question; dispose in finally. Undefined, holding nothing, when a
   * loaded chat working in it is busy now (D33). While held, its chats show `finishing` and core refuses their sends.
   */
  beginWorktreeFinish(worktreeId: string, action: WorktreeFinishAction): Disposable | undefined {
    return this.worktrees.beginFinish(worktreeId, action);
  }

  /** The Setup terminal's Restart of worktree `worktreeId` (D32). */
  retrySetup(worktreeId: string): Promise<void> {
    return this.worktrees.retrySetup(worktreeId);
  }

  /** The first prompt the chat holds for its worktree, for the host to keep as the chat's draft when it unloads or quits. */
  heldPrompt(panelId: string): UserContentBlock[] | undefined {
    return this.worktrees.heldPrompt(panelId);
  }

  /** Puts a draft the host kept back into the chat's composer, once its webview listens. */
  async restoreDraft(panelId: string, content: UserContentBlock[]): Promise<void> {
    const instance = this.panels.get(panelId);
    if (!instance) throw new Error("The chat is not loaded");
    await instance.webviewReady;
    // The ready gate also settles when the panel closes, which leaves nothing to restore into.
    if (this.panels.get(panelId) !== instance) return;
    this.postMessage(instance.host, { type: "promptReturned", content, reason: "heldPromptKept" });
  }

  worktreeAction(panelId: string, action: WorktreeAction): Promise<void> {
    return this.worktrees.action(panelId, action);
  }

  /** Settles once no panel holds the folder and core released its per-folder services (rule 14). */
  whenFolderReleased(fsPath: string): Promise<void> {
    return this.worktrees.whenFolderReleased(fsPath);
  }

  /** Settles once the unused worktree a closed chat was creating or setting up for its held first prompt is discarded. */
  whenWorktreeDiscarded(panelId: string): Promise<void> {
    return this.worktrees.whenDiscarded(panelId);
  }

  // A hand-off's afterSwitch: the new session continues the stored conversation, as a resume does. `beforeOpen` gives the
  // session what its start must write first. False when it did not open, which the caller tells the user; a session that
  // has not started opens it in the start the folder switch runs after this.
  private async resumeInto(instance: HostInstance, sessionId: string, beforeOpen?: (session: ChatSession) => void): Promise<boolean> {
    const panelId = [...this.panels].find(([, candidate]) => candidate === instance)?.[0];
    if (panelId === undefined) return false;
    const refusal = claimStoredSession(this.platform.notifications, this.panels, { panelId, session: instance.session }, sessionId);
    if (refusal) return false;
    beforeOpen?.(instance.session);
    const outcome = await instance.session.openResumeTarget(sessionId);
    if (outcome.kind !== "switched" && outcome.kind !== "deferred") return false;
    this.postMessage(instance.host, { type: "resumeAccepted", sessionId, continued: true });
    const rewindableIds = await this.loadHistory(instance.folder.fsPath, sessionId, instance.host, instance.session);
    instance.session.seedCheckpoints(rewindableIds ?? []);
    this.postMessage(instance.host, { type: "sessionStarted", sessionId, stored: rewindableIds !== null });
    return true;
  }

  /** Dispose what the panel owns; the session's disposal is tracked until it settles, so `dispose()` awaits it. */
  private releasePanel(panelId: string, instance: HostInstance): void {
    this.disposeSession(instance.session).catch((err: unknown) => log("[PanelManager] session dispose failed: %O", err));
    instance.permissionHandler.dispose().catch((err: unknown) => log("[PanelManager] permission handler dispose failed: %O", err));
    instance.ideContextManager.dispose();
    instance.disposables.forEach((d) => d.dispose());
    this.cleanupPanelModel(panelId);
    this.cleanupPanelThinking(panelId);
  }

  private disposeSession(session: ChatSession): Promise<void> {
    this.activity.unbind(session);
    const disposed = session.dispose();
    const settled = disposed.then(() => undefined, () => undefined);
    this.closingSessions.add(settled);
    void settled.then(() => this.closingSessions.delete(settled));
    return disposed;
  }

  private openGate(panelId: string): void {
    const gate = this.messageGates.get(panelId);
    if (!gate) return;
    gate.open = true;
    this.drainGate(panelId, gate);
  }

  private drainGate(panelId: string, gate: MessageGate): void {
    while (gate.open && !gate.readying) {
      const next = gate.queue.shift();
      if (!next) return;
      const { message, view } = next;
      if (view !== undefined && this.attachments.get(panelId) !== view) continue;
      if (message.type !== "ready") {
        this.handleWebviewMessage(message, panelId, view);
        continue;
      }
      gate.readying = true;
      void this.handleWebviewMessage(message, panelId).finally(() => {
        gate.readying = false;
        this.drainGate(panelId, gate);
      });
    }
  }

  /** The plan-mode hook and the activity forwarding drive the session they were bound with, so both are re-bound whenever the session is replaced. */
  private bindSessionCallbacks(panelId: string, instance: HostInstance): void {
    const { session, host, permissionHandler } = instance;
    // A session that replaced another (a folder switch, a recovery) names the same panel in its lease owner records.
    session.setPanelToken(instance.panelToken);
    this.worktrees.bind(panelId, instance);
    permissionHandler.setOnPlanModeActivated(async () => {
      await session.setPermissionMode("plan");
      await this.sendCurrentSettings(host, permissionHandler, instance.folder);
    });
    this.activity.bind(panelId, session);
  }

  /** The folder of the last-focused panel, if that panel is still open. */
  getActivePanelFolder(): FolderTarget | undefined {
    return this.lastActivePanelId ? this.panels.get(this.lastActivePanelId)?.folder : undefined;
  }

  private setLastActivePanel(panelId: string | null): void {
    if (this.lastActivePanelId === panelId) return;
    this.lastActivePanelId = panelId;
    this.notifyActivePanelChanged();
  }

  private notifyActivePanelChanged(): void {
    try {
      this.onActivePanelChanged?.();
    } catch (err) {
      log("[PanelManager] active panel listener error: %O", err);
    }
  }

  private isTargeted(key: string): boolean {
    for (const [, instance] of this.panels) if (instance.folder.key === key) return true;
    return false;
  }

  applyFolderTitle(instance: HostInstance): void {
    instance.host.setFolderLabel(this.folderRegistry.isMultiRoot ? instance.folder.label : undefined);
  }

  postWorkspaceFolderState(panelId: string): void {
    const instance = this.panels.get(panelId);
    if (instance) this.postWorkspaceFolderUpdate(instance, false);
  }

  private postWorkspaceFolderUpdate(instance: HostInstance, switched: boolean): void {
    this.postMessage(instance.host, {
      type: "workspaceFolderUpdate",
      folders: this.folderRegistry.folderInfos(),
      panelFolderKey: instance.folder.key,
      defaultFolderKey: this.folderRegistry.defaultTarget().key,
      ...(switched ? { switched: true } : {}),
    });
  }

  /** Run `task` after every earlier folder task on the panel settles. */
  private enqueueFolderTask<T>(panelId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.folderChains.get(panelId) ?? Promise.resolve()).then(task);
    // The chain only orders tasks; each caller still receives its own task's rejection through `run`.
    this.folderChains.set(panelId, run.then(() => undefined, () => undefined));
    return run;
  }

  /**
   * Move the panel to the open folder `key` with a fresh session. Resolves to the panel's instance once
   * it targets `key`, or undefined when the key is not open, the user cancelled, the panel closed, or no
   * session could be created there.
   * Callers continue with the returned instance: the session they held before is disposed. `afterSwitch`
   * runs once the panel targets `key`, before messages the webview sent meanwhile reach the new session.
   */
  switchPanelFolder(
    panelId: string,
    key: string,
    reason: FolderSwitchReason,
    afterSwitch?: AfterFolderSwitch,
  ): Promise<HostInstance | undefined> {
    return this.enqueueFolderTask(panelId, () => this.runFolderSwitch(panelId, key, reason, afterSwitch));
  }

  private async runFolderSwitch(
    panelId: string,
    key: string,
    reason: FolderSwitchReason,
    afterSwitch: AfterFolderSwitch | undefined,
  ): Promise<HostInstance | undefined> {
    const instance = this.panels.get(panelId);
    if (!instance) return undefined;
    // The key comes from the webview, so only a folder that is open right now is accepted; a user switch only to a project,
    // never into a chat's working folder (AD12 Folders).
    const target = reason === "user" ? this.folderRegistry.targets().find((t) => t.key === key) : this.folderRegistry.resolve(key);
    if (!target) {
      log("[PanelManager] Ignoring a switch of %s to a folder key that is not open: %s", panelId, key);
      this.postWorkspaceFolderUpdate(instance, false);
      return undefined;
    }
    if (target.key === instance.folder.key) {
      this.postWorkspaceFolderUpdate(instance, false);
      await afterSwitch?.(instance);
      return instance;
    }
    const movingSession = instance.session.storedSessionId;
    if (reason === "chatMove" && movingSession !== null && sessionLeaseBlocker(movingSession)) {
      this.postWorkspaceFolderUpdate(instance, false);
      return undefined;
    }
    if (reason === "user" && instance.session.hasConversation()) {
      const confirm = t("Start new conversation");
      const choice = await this.platform.notifications.warn(
        t("Switch this panel to {0}? This starts a new conversation. The current one stays in history.", target.label),
        { modal: true },
        confirm,
      );
      if (this.panels.get(panelId) !== instance) return undefined;
      if (choice !== confirm) {
        this.postWorkspaceFolderUpdate(instance, false);
        return undefined;
      }
    }
    return this.replaceSession(panelId, instance, target, reason, afterSwitch);
  }

  private async replaceSession(
    panelId: string,
    instance: HostInstance,
    target: FolderTarget,
    reason: FolderSwitchReason,
    afterSwitch?: AfterFolderSwitch,
  ): Promise<HostInstance | undefined> {
    const gate = this.messageGates.get(panelId);
    if (gate) gate.open = false;
    // Every await below can outlive the panel, and a closed panel's session is already disposed.
    const open = (): boolean => this.panels.get(panelId) === instance;
    try {
      // Read before dispose, which drops the live session id; a failed switch resumes this conversation.
      const previousSessionId = instance.session.hasConversation() ? instance.session.persistenceSessionId : null;
      // Disposed first: it aborts the turn, its subagents and its team, which all run in the old folder.
      await this.disposeSession(instance.session);
      let session: ChatSession;
      try {
        session = await this.createSessionForPanel(instance.host, instance.permissionHandler, panelId, target);
      } catch (err) {
        this.reportSessionFailure(panelId, instance, target, err);
        const recovered = open() ? await this.recoverSession(panelId, instance, previousSessionId) : undefined;
        if (recovered && open() && reason !== "restore") await recovered.initializeEarly();
        return undefined;
      }
      if (!open()) {
        await this.disposeSession(session);
        return undefined;
      }
      // A restore lands in a webview that has just loaded, so it has no conversation on screen to clear. A chatMove keeps the
      // conversation (resumed in afterSwitch), and the worktree state says where the chat now works.
      await this.adoptSession(panelId, instance, session, target, reason !== "restore" && reason !== "chatMove", reason);
      if (!open()) return undefined;
      await afterSwitch?.(instance);
      if (!open()) return undefined;
      // The `ready` handler starts a restored panel's session after posting its lists.
      if (reason !== "restore") await session.initializeEarly();
      return open() ? instance : undefined;
    } finally {
      this.openGate(panelId);
    }
  }

  /** Install `session` on `folder` as the panel's new conversation and re-push what depends on either. */
  private async adoptSession(
    panelId: string,
    instance: HostInstance,
    session: ChatSession,
    folder: FolderTarget,
    switched: boolean,
    reason?: FolderSwitchReason,
  ): Promise<void> {
    const moved = folder.key !== instance.folder.key;
    // An opt-in belongs to the folder it was made in; only the worktree moves keep it.
    if (moved && reason !== "chatMove") this.worktrees.folderChanged(panelId);
    if (moved && folder.ownerKey === undefined) this.worktrees.dropHold(panelId);
    instance.session = session;
    instance.folder = folder;
    // The editor's context was filtered against the folder the panel left (AD12's wrong-copy guard).
    if (moved) instance.ideContextManager.refresh();
    if (moved && this.lastActivePanelId === panelId) this.notifyActivePanelChanged();
    const { permissionHandler, host } = instance;
    permissionHandler.setWorkspacePath(folder.projectScope ? folder.fsPath : null);
    permissionHandler.setCwd(folder.fsPath);
    this.bindSessionCallbacks(panelId, instance);
    // A new conversation resets what clearing does; mode, model and reasoning stay. A chatMove continues the conversation, so the
    // chat keeps its YOLO too, and a restore moving a panel an engine restart reopened keeps the YOLO that restart handed it.
    if (reason === "chatMove") permissionHandler.dropSessionApprovals();
    else if (reason !== "restore" || instance.permissionsHandedBack !== true) permissionHandler.resetForNewConversation(settingsFolderOf(folder));
    await this.sendCurrentSettings(host, permissionHandler, folder);
    this.applyFolderTitle(instance);
    this.postWorkspaceFolderUpdate(instance, switched);
    await this.sendFolderState(instance);
  }

  /** Logged and shown in the panel; the caller then treats the switch as not having happened. */
  private reportSessionFailure(panelId: string, instance: HostInstance, folder: FolderTarget, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    log("[PanelManager] Could not create a session for %s in %s: %s", panelId, folder.fsPath, detail);
    if (this.panels.get(panelId) !== instance) return;
    this.postMessage(instance.host, {
      type: "error",
      message: t("Damocles could not start a session in {0}: {1}", folder.label, detail),
    });
  }

  /**
   * The old session is already disposed when a switch fails to create the new one, and the webview never
   * re-sends the folder it already shows. The panel resumes the conversation on screen, or starts fresh
   * and resets the webview when there is none it can resume. Resolves to the session it installed, if any.
   */
  private async recoverSession(panelId: string, instance: HostInstance, previousSessionId: string | null): Promise<ChatSession | undefined> {
    // A removed folder is already released, so a session there would build a runtime nobody releases.
    const folder = this.folderRegistry.resolve(instance.folder.key) ?? this.folderRegistry.defaultTarget();
    let session: ChatSession;
    try {
      session = await this.createSessionForPanel(instance.host, instance.permissionHandler, panelId, folder);
    } catch (err) {
      this.reportSessionFailure(panelId, instance, folder, err);
      if (this.panels.get(panelId) === instance) this.postWorkspaceFolderUpdate(instance, false);
      return undefined;
    }
    if (this.panels.get(panelId) !== instance) {
      await this.disposeSession(session);
      return undefined;
    }
    // The conversation's file is in its own folder's session dir, so it resumes only there.
    const resumed = previousSessionId !== null
      && folder.key === instance.folder.key
      && claimStoredSession(this.platform.notifications, this.panels, { panelId, session }, previousSessionId) === undefined;
    if (!resumed) {
      await this.adoptSession(panelId, instance, session, folder, true);
      return session;
    }
    instance.session = session;
    this.bindSessionCallbacks(panelId, instance);
    // The old session unsubscribed before its turn aborted, so the webview never heard the turn end.
    this.postMessage(instance.host, { type: "sessionCancelled" });
    this.postMessage(instance.host, { type: "processing", isProcessing: false });
    this.postWorkspaceFolderUpdate(instance, false);
    return session;
  }

  private async onFoldersChanged(change: FolderChange): Promise<void> {
    const removed = new Set(change.removed.map((t) => t.key));
    if (removed.size > 0) {
      const moves = [...this.panels.keys()].map((panelId) => this.movePanelOffRemovedFolders(panelId, removed));
      for (const result of await Promise.allSettled(moves)) {
        if (result.status === "rejected") log("[PanelManager] moving a panel off a removed folder failed: %O", result.reason);
      }
      const releases = [...removed].map((key) => this.releaseFolder(key));
      for (const result of await Promise.allSettled(releases)) {
        if (result.status === "rejected") log("[PanelManager] releasing a removed folder failed: %O", result.reason);
      }
    }
    for (const [panelId, instance] of this.panels) {
      // The registry rebuilds its targets on every change, and a rename keeps the key but not the label.
      const current = this.folderRegistry.resolve(instance.folder.key);
      if (current) {
        const relabelled = current.label !== instance.folder.label;
        instance.folder = current;
        if (relabelled && this.lastActivePanelId === panelId) this.notifyActivePanelChanged();
      }
      this.applyFolderTitle(instance);
      this.postWorkspaceFolderUpdate(instance, false);
    }
  }

  /** Queued behind any switch in flight, so the check sees the folder that switch landed on. */
  private movePanelOffRemovedFolders(panelId: string, removed: ReadonlySet<string>): Promise<boolean> {
    return this.enqueueFolderTask(panelId, async () => {
      const instance = this.panels.get(panelId);
      if (!instance || !removed.has(instance.folder.key)) return false;
      const from = instance.folder;
      const to = this.folderRegistry.defaultTarget();
      const moved = await this.replaceSession(panelId, instance, to, "folderRemoved");
      // The home target leaves the registry when the first folder opens, which the user did not remove.
      if (moved && from.projectScope) {
        void this.platform.notifications.warn(t(
          "The workspace folder {0} was removed, so a Damocles panel moved to {1} and started a new conversation. The previous one stays in history.",
          from.label,
          to.label,
        ));
      }
      return moved !== undefined;
    });
  }

  postMessage(host: PanelHost, message: ExtensionToWebviewMessage): void {
    const held = this.joins.get(host)?.held;
    if (held) {
      held.push(message);
      return;
    }
    this.deliver(host, message);
  }

  private deliver(host: PanelHost, message: ExtensionToWebviewMessage): void {
    try {
      void host.postMessage(message);
    } catch {
      // Host was disposed - will be cleaned up by onDidDispose handler
    }
    if (this.attachments.size === 0 || !SETTINGS_VIEW_MESSAGE_TYPES.has(message.type)) return;
    const view = this.viewOfHost(host);
    // a scope tab lists only the keys its scope writes
    if (view?.scope !== undefined && message.type === "settingsUpdate") view.post({ ...message, writableKeys: writableKeysOf(view.scope, readContributedConfiguration(this.resourceRoot)) });
    else view?.post(message);
  }

  /**
   * A view main made for this panel's host joins its chat (views.join): `viewKey` must be the panel's token. Resolves the
   * panel id, or undefined when no open panel holds that host and token. Never changes the panel's token.
   */
  async joinView(host: PanelHost, viewKey: string): Promise<string | undefined> {
    const found = [...this.panels].find(([, instance]) => instance.host === host);
    if (!found || found[1].panelToken === null || found[1].panelToken !== viewKey) return undefined;
    const [panelId, instance] = found;
    if (this.joins.has(host)) throw new Error("A view is already joining this chat");
    const join: { readonly session: ChatSession; held: ExtensionToWebviewMessage[] | undefined } = { session: instance.session, held: undefined };
    this.joins.set(host, join);
    let released = false;
    const gate: ViewJoinGate = {
      post: (message) => this.deliver(host, message),
      hold: () => {
        join.held ??= [];
      },
      release: (snapshotSeq) => {
        if (released) return;
        released = true;
        const held = join.held ?? [];
        this.joins.delete(host);
        for (const message of held) {
          const seq = join.session.eventSeqOf(message);
          if (seq === undefined || seq > snapshotSeq) this.deliver(host, message);
        }
      },
    };
    try {
      await this.joinViewOf(panelId, gate);
    } finally {
      // a join that failed before its release delivers everything it held
      gate.release(-1);
    }
    return panelId;
  }

  /**
   * Attaches a settings view to an open panel, replacing (and detaching) any view attached before. From then on the
   * panel's messages of a SETTINGS_VIEW_MESSAGES type are copied to the view. Disposing the result detaches it.
   */
  attachView(panelId: string, view: AttachedView): Disposable {
    if (!this.panels.has(panelId)) throw new Error(`No open chat panel ${panelId}`);
    const previous = this.attachments.get(panelId);
    this.attachments.set(panelId, view);
    if (previous !== view) {
      previous?.detached();
      this.notifyAttachmentChanged(panelId);
    }
    return { dispose: (): void => this.detachView(panelId, view) };
  }

  attachedView(panelId: string): AttachedView | undefined {
    return this.attachments.get(panelId);
  }

  /** Fires after a panel's attached view changed: attached, replaced or detached. */
  onDidChangeAttachment(listener: (panelId: string) => void): Disposable {
    this.attachmentListeners.add(listener);
    return { dispose: (): void => { this.attachmentListeners.delete(listener); } };
  }

  /**
   * Runs a message from the panel's attached view through the router with the panel's context, after messages the
   * chat queued before it. Only SETTINGS_VIEW_REQUESTS types run; anything else, or a panel with no view, is dropped.
   */
  async dispatchFromView(panelId: string, message: WebviewToExtensionMessage): Promise<void> {
    const view = this.attachments.get(panelId);
    const gate = this.messageGates.get(panelId);
    if (!view || !gate) {
      log("[PanelManager] dropping a settings view message for %s, which has no attached view", panelId);
      return;
    }
    // The type is the only part logged: view messages carry API keys and prompt answers.
    if (!SETTINGS_VIEW_REQUEST_TYPES.has(message.type)) {
      log("[PanelManager] refusing a settings view message of type %s", JSON.stringify(String(message.type).slice(0, 64)));
      return;
    }
    if (!gate.open || gate.readying) {
      gate.queue.push({ message, view });
      return;
    }
    await this.handleWebviewMessage(message, panelId, view);
  }

  private detachView(panelId: string, view: AttachedView): void {
    if (this.attachments.get(panelId) !== view) return;
    this.detachPanelView(panelId);
  }

  private detachPanelView(panelId: string): void {
    const view = this.attachments.get(panelId);
    if (!view) return;
    this.attachments.delete(panelId);
    view.detached();
    this.notifyAttachmentChanged(panelId);
  }

  private notifyAttachmentChanged(panelId: string): void {
    for (const listener of [...this.attachmentListeners]) {
      try {
        listener(panelId);
      } catch (err) {
        log("[PanelManager] attachment listener error: %O", err);
      }
    }
  }

  private viewOfHost(host: PanelHost): AttachedView | undefined {
    for (const [panelId, view] of this.attachments) {
      if (this.panels.get(panelId)?.host === host) return view;
    }
    return undefined;
  }

  broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of this.panels) {
      this.postMessage(instance.host, message);
    }
  }

  postToActivePanel(message: ExtensionToWebviewMessage): boolean {
    const host = this.activePanelHost();
    if (host === undefined) return false;
    this.postMessage(host, message);
    return true;
  }

  /** The panel last active, else the only one, else a visible one; undefined when none qualifies. */
  activePanelHost(): PanelHost | undefined {
    const last = this.lastActivePanelId ? this.panels.get(this.lastActivePanelId) : undefined;
    if (last) return last.host;
    if (this.panels.size === 1) return this.panels.values().next().value?.host;
    for (const [, instance] of this.panels) {
      if (instance.host.visible) return instance.host;
    }
    return undefined;
  }

  private findFallbackActivePanelId(): string | null {
    for (const [id, instance] of this.panels) {
      if (instance.host.active) return id;
    }
    for (const [id, instance] of this.panels) {
      if (instance.host.visible) return id;
    }
    return null;
  }

  getLocalResourceRoots(): string[] {
    return [
      path.join(this.resourceRoot, "dist", "webview"),
      path.join(this.resourceRoot, "resources"),
    ];
  }

  // The `panel.html→ready` span starts where the page is handed to the host.
  private showChatPage(host: PanelHost): void {
    if (!host.showPage) {
      host.setHtml(this.getHtmlContent(host));
      return;
    }
    htmlToReadySpans.set(host, perfSpan("panel.html→ready"));
    host.showPage({ kind: "chat" });
  }

  private showErrorPage(host: PanelHost): void {
    if (host.showPage) {
      host.showPage({ kind: "error" });
      return;
    }
    host.setHtml(errorPageHtml({
      cspSource: host.cspSource,
      logoUri: host.asResourceUri(path.join(this.resourceRoot, "resources", "icon.png")),
      themeCss: host.themeCssSource(),
      strings: ERROR_PAGE_STRINGS,
    }));
  }

  /** Starts the `panel.html→ready` span; its result must be what is given to `host.setHtml`. */
  getHtmlContent(host: PanelHost): string {
    htmlToReadySpans.set(host, perfSpan("panel.html→ready"));
    return chatPageHtml({
      cspSource: host.cspSource,
      ...(host.workerSrc !== undefined ? { workerSrc: host.workerSrc } : {}),
      nonce: this.getNonce(),
      scriptUri: host.asResourceUri(path.join(this.resourceRoot, "dist", "webview", "assets", "index.js")),
      styleUri: host.asResourceUri(path.join(this.resourceRoot, "dist", "webview", "assets", "index.css")),
      logoUri: host.asResourceUri(path.join(this.resourceRoot, "resources", "icon.png")),
      themeCss: host.themeCssSource(),
    });
  }

  newSession(): void {
    for (const [, instance] of this.panels) {
      instance.session.reset();
      this.postMessage(instance.host, { type: "processing", isProcessing: false });
      this.postMessage(instance.host, { type: "sessionCleared" });
    }
  }

  cancelSession(): void {
    for (const [, instance] of this.panels) {
      instance.session.cancel();
    }
  }

  /**
   * Resolves once every session this manager created is disposed, those of panels closed earlier included,
   * which is when their session leases are released.
   */
  dispose(): Promise<void> {
    this.folderChangeSubscription.dispose();
    for (const panelId of [...this.attachments.keys()]) this.detachPanelView(panelId);
    for (const [panelId, instance] of this.panels) {
      this.releasePanel(panelId, instance);
      instance.host.close();
    }
    this.panels.clear();
    this.worktrees.dispose();
    this.messageGates.clear();
    this.folderChains.clear();
    return Promise.all([...this.closingSessions]).then(() => undefined);
  }

  private getNonce(): string {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
