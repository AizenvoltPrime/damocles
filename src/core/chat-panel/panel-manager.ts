import * as path from "path";
import type { Disposable } from "../../platform/disposable";
import type { Platform } from "../../platform/platform";
import type { PanelHost } from "../../platform/window-service";
import { PermissionHandler } from "../permission-handler";
import { IdeContextManager } from "./ide-context-manager";
import { log } from "../logger";
import { t } from "../l10n";
import { perfSpan, type PerfSpan } from "../perf";
import type { ChatSession } from "../chat-session";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../shared/types/messages";
import type { ForkContext, ForkSpawnArgs, StoredSession } from "../../shared/types/session";
import type { AttachedView, HostInstance } from "./types";
import type { PromptTarget } from "./webview-prompts";
import { claimStoredSession } from "./session-ownership";
import { settingsFolderOf, type FolderChange, type FolderTarget, type WorkspaceFolderRegistry } from "../workspace-folders/folder-registry";
import { HOST_THEME_STYLE_ID } from "../../shared/host-theme";
import { PanelActivity, type PanelActivityListener, type PanelTurnSettledListener, type UsageThresholdListener } from "./activity";
import type { UsageThresholdCrossing } from "../pi-session/usage-thresholds";
import { SETTINGS_VIEW_MESSAGE_TYPES, SETTINGS_VIEW_REQUEST_TYPES } from "../../shared/settings-view-messages";

/** Why a panel changes folder. Only `'user'` asks before discarding a conversation. */
export type FolderSwitchReason = "user" | "resume" | "restore" | "folderRemoved";

/** Runs on the panel's instance inside the folder task, before queued webview messages are delivered and before a replacement session starts. */
export type AfterFolderSwitch = (instance: HostInstance) => Promise<void>;

/** The folder key the chat webview persisted; the panel manager accepts it only if that folder is open. */
export function restoredWorkspaceFolderKey(state: unknown): string | undefined {
  const raw = (state as { workspaceFolderKey?: unknown } | null)?.workspaceFolderKey;
  return typeof raw === "string" ? raw : undefined;
}

/** Open from the moment a webview's HTML is built until its next `ready`. */
const htmlToReadySpans = new WeakMap<PanelHost, PerfSpan>();

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
  queue: Array<{ message: WebviewToExtensionMessage; view?: AttachedView }>;
}

export interface PanelManagerConfig {
  platform: Platform;
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
}

export class PanelManager {
  private panels: Map<string, HostInstance> = new Map();
  private hostCounter = 0;
  private lastActivePanelId: string | null = null;
  private readonly allClosedListeners: Set<() => void> = new Set();
  private readonly resourceRoot: string;
  private readonly platform: Platform;
  private readonly createSessionForPanel: PanelManagerConfig["createSessionForPanel"];
  private readonly handleWebviewMessage: PanelManagerConfig["handleWebviewMessage"];
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
  private readonly activity = new PanelActivity();
  /** At most one settings view per panel. */
  private readonly attachments = new Map<string, AttachedView>();
  private readonly attachmentListeners = new Set<(panelId: string) => void>();

  constructor(config: PanelManagerConfig) {
    this.platform = config.platform;
    this.resourceRoot = config.platform.paths.resourceRoot;
    this.createSessionForPanel = config.createSessionForPanel;
    this.handleWebviewMessage = config.handleWebviewMessage;
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
    this.folderChangeSubscription = this.folderRegistry.onDidChange((change) => {
      this.onFoldersChanged(change).catch((err) => log("[PanelManager] workspace folder change failed: %O", err));
    });
  }

  getPanels(): Map<string, HostInstance> {
    return this.panels;
  }

  /** Fires once each time a panel's session is bound, then on every change of its activity or stored session id. */
  onActivity(listener: PanelActivityListener): Disposable {
    return this.activity.onActivity(listener);
  }

  onTurnSettled(listener: PanelTurnSettledListener): Disposable {
    return this.activity.onTurnSettled(listener);
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
    host.setHtml(this.getHtmlContent(host));
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
    host.setHtml(this.getHtmlContent(host));
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

  async restorePanel(host: PanelHost, workspaceFolderKey: string | undefined): Promise<void> {
    host.setHtml(this.getHtmlContent(host));
    try {
      await this.initializeHost(host, workspaceFolderKey !== undefined ? { initialFolderKey: workspaceFolderKey } : undefined);
    } catch (err) {
      log(`[PanelManager] Failed to restore panel: ${err}`);
      host.setHtml(this.getErrorHtml(host));
    }
  }

  initializeHost(
    host: PanelHost,
    options?: { forkContext?: ForkContext; sourcePanelId?: string; initialFolderKey?: string },
  ): Promise<string> {
    return this.trackOpening(this.setUpHost(host, options));
  }

  private async setUpHost(
    host: PanelHost,
    options?: { forkContext?: ForkContext; sourcePanelId?: string; initialFolderKey?: string },
  ): Promise<string> {
    const panelId = `host-${++this.hostCounter}`;
    const disposables: Disposable[] = [];

    const gate: MessageGate = { open: false, queue: [] };
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
        if (gate.open) {
          this.handleWebviewMessage(message, panelId);
        } else {
          gate.queue.push({ message });
        }
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
    // A fork continues its source's conversation, whose session file lives under the source's folder.
    const folder = source?.folder
      ?? (options?.initialFolderKey !== undefined ? this.folderRegistry.resolve(options.initialFolderKey) : undefined)
      ?? this.folderRegistry.defaultTarget();

    const permissionHandler = new PermissionHandler(this.platform, panelId, settingsFolderOf(folder));
    permissionHandler.setPostMessage((msg) => this.postMessage(host, msg));
    if (source) {
      permissionHandler.setPermissionMode(source.permissionHandler.getPermissionMode());
      permissionHandler.setDangerouslySkipPermissions(source.permissionHandler.getDangerouslySkipPermissions());
    }

    permissionHandler.setWorkspacePath(folder.projectScope ? folder.fsPath : null);
    permissionHandler.setCwd(folder.fsPath);

    const ideContextManager = new IdeContextManager(this.platform.editor, (context) => {
      this.postMessage(host, { type: "ideContextUpdate", context });
    });

    this.initPanelModel(panelId);

    if (options?.sourcePanelId) {
      this.inheritSettingsFromPanel(options.sourcePanelId, panelId);
    }

    for (const msg of this.getInitialMessages(folder)) {
      this.postMessage(host, msg);
    }

    const session = await this.createSessionForPanel(host, permissionHandler, panelId, folder, options?.forkContext);

    const instance: HostInstance = {
      host,
      session,
      folder,
      panelToken: null,
      permissionHandler,
      ideContextManager,
      disposables,
      webviewReady,
      ...(options?.forkContext ? { forkContext: options.forkContext } : {}),
    };
    if (closed) {
      // The host closed while the session was being created, before the panel was registered.
      this.releasePanel(panelId, instance);
      this.messageGates.delete(panelId);
      return panelId;
    }
    this.panels.set(panelId, instance);
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
          e.affects("damocles.effortByModel") ||
          e.affects("damocles.maxThinkingTokens")
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
    for (const { message, view } of gate.queue.splice(0)) {
      if (view !== undefined && this.attachments.get(panelId) !== view) continue;
      this.handleWebviewMessage(message, panelId, view);
    }
  }

  /** The plan-mode hook and the activity forwarding drive the session they were bound with, so both are re-bound whenever the session is replaced. */
  private bindSessionCallbacks(panelId: string, instance: HostInstance): void {
    const { session, host, permissionHandler } = instance;
    // A session that replaced another (a folder switch, a recovery) names the same panel in its lease owner records.
    session.setPanelToken(instance.panelToken);
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
    // The key comes from the webview, so only a folder that is open right now is accepted.
    const target = this.folderRegistry.resolve(key);
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
      // A restore lands in a webview that has just loaded, so it has no conversation on screen to clear.
      await this.adoptSession(panelId, instance, session, target, reason !== "restore");
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
  ): Promise<void> {
    const moved = folder.key !== instance.folder.key;
    instance.session = session;
    instance.folder = folder;
    if (moved && this.lastActivePanelId === panelId) this.notifyActivePanelChanged();
    const { permissionHandler, host } = instance;
    permissionHandler.setWorkspacePath(folder.projectScope ? folder.fsPath : null);
    permissionHandler.setCwd(folder.fsPath);
    this.bindSessionCallbacks(panelId, instance);
    // A new conversation resets what clearing does; mode, model and reasoning stay.
    permissionHandler.resetForNewConversation(settingsFolderOf(folder));
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
      if (moved) {
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
    try {
      void host.postMessage(message);
    } catch {
      // Host was disposed - will be cleaned up by onDidDispose handler
    }
    if (this.attachments.size > 0 && SETTINGS_VIEW_MESSAGE_TYPES.has(message.type)) this.viewOfHost(host)?.post(message);
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
    if (!gate.open) {
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
    if (this.lastActivePanelId) {
      const instance = this.panels.get(this.lastActivePanelId);
      if (instance) {
        this.postMessage(instance.host, message);
        return true;
      }
    }
    if (this.panels.size === 1) {
      const first = this.panels.values().next();
      if (!first.done) {
        this.postMessage(first.value.host, message);
        return true;
      }
    }
    for (const [, instance] of this.panels) {
      if (instance.host.visible) {
        this.postMessage(instance.host, message);
        return true;
      }
    }
    return false;
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

  /** Starts the `panel.html→ready` span; its result must be what is given to `host.setHtml`. */
  getHtmlContent(host: PanelHost): string {
    htmlToReadySpans.set(host, perfSpan("panel.html→ready"));
    const scriptUri = host.asResourceUri(path.join(this.resourceRoot, "dist", "webview", "assets", "index.js"));
    const styleUri = host.asResourceUri(path.join(this.resourceRoot, "dist", "webview", "assets", "index.css"));
    const logoUri = host.asResourceUri(path.join(this.resourceRoot, "resources", "icon.png"));

    const nonce = this.getNonce();
    // style-src allows 'unsafe-inline', so the element needs no nonce.
    const themeCss = host.themeCssSource();
    const themeStyle = themeCss === "" ? "" : `\n  <style id="${HOST_THEME_STYLE_ID}">${themeCss}</style>`;
    const workerSrc = host.workerSrc === undefined ? "" : ` worker-src ${host.workerSrc};`;

    // CSP: `script-src` stays nonce-locked (no inline/remote script — no RCE). `img-src ... https:` is
    // a deliberate widening so WebFetch can render inline images from extracted web pages. The tradeoff
    // is that any rendered markdown can load remote https images (a tracking/IP-leak vector); this is the
    // standard posture for chat webviews that render web content, and the web tools are opt-in.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${host.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; font-src ${host.cspSource}; img-src ${host.cspSource} data: https:;${workerSrc}">
  <link href="${styleUri}" rel="stylesheet">${themeStyle}
  <title>Damocles</title>
</head>
<body>
  <div id="app" data-logo-uri="${logoUri}"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // Reads the desktop design tokens from the host theme style first and VS Code's theme variables otherwise.
  private getErrorHtml(host: PanelHost): string {
    const logoUri = host.asResourceUri(path.join(this.resourceRoot, "resources", "icon.png"));
    const themeCss = host.themeCssSource();
    const themeStyle = themeCss === "" ? "" : `
  <style id="${HOST_THEME_STYLE_ID}">${themeCss}</style>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${host.cspSource};">
  <title>Damocles</title>
  <style>
    body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: var(--d-bg, var(--vscode-editor-background)); color: var(--d-text, var(--vscode-foreground)); font-family: var(--d-font, var(--vscode-font-family, system-ui, sans-serif)); }
    .error-container { text-align: center; max-width: 360px; }
    img { width: 48px; height: 48px; opacity: 0.5; margin-bottom: 16px; }
    h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 12px; opacity: 0.7; margin: 0; }
  </style>${themeStyle}
</head>
<body>
  <div class="error-container">
    <img src="${logoUri}" alt="">
    <h2>Session failed to restore</h2>
    <p>Close this tab and open a new Damocles panel.</p>
  </div>
</body>
</html>`;
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
