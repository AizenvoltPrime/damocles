import * as vscode from "vscode";
import { PermissionHandler } from "../permission-handler";
import { IdeContextManager } from "./ide-context-manager";
import { log } from "../logger";
import type { ChatSession } from "../chat-session";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../shared/types/messages";
import type { ForkContext, ForkSpawnArgs, StoredSession } from "../../shared/types/session";
import type { HostInstance, WebviewHost } from "./types";
import { createPanelHost } from "./types";
import { claimStoredSession } from "./session-ownership";
import type { FolderChange, FolderTarget, WorkspaceFolderRegistry } from "../workspace-folders/folder-registry";

/** Why a panel changes folder. Only `'user'` asks before discarding a conversation. */
export type FolderSwitchReason = "user" | "resume" | "restore" | "folderRemoved";

/**
 * Runs on the panel's instance inside the folder task, before queued webview messages are delivered.
 * Resolves true when it bound the panel to a stored session, which then starts on the first send.
 */
export type AfterFolderSwitch = (instance: HostInstance) => Promise<boolean>;

/** The folder key the chat webview persisted; the panel manager accepts it only if that folder is open. */
export function restoredWorkspaceFolderKey(state: unknown): string | undefined {
  const raw = (state as { workspaceFolderKey?: unknown } | null)?.workspaceFolderKey;
  return typeof raw === "string" ? raw : undefined;
}

/** Webview messages that arrive while the panel has no usable session wait here, in order. */
interface MessageGate {
  open: boolean;
  queue: WebviewToExtensionMessage[];
}

export interface PanelManagerConfig {
  extensionUri: vscode.Uri;
  createSessionForPanel: (
    host: WebviewHost,
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
  handleWebviewMessage: (message: WebviewToExtensionMessage, panelId: string) => Promise<void>;
  sendCurrentSettings: (host: WebviewHost, permissionHandler: PermissionHandler) => Promise<void>;
  getStoredSessions: () => Promise<{ sessions: StoredSession[]; hasMore: boolean; nextOffset: number }>;
  invalidateSessionsCache: () => void;
  initPanelModel: (panelId: string) => void;
  cleanupPanelModel: (panelId: string) => void;
  cleanupPanelThinking: (panelId: string) => void;
  sendThinkingForPanel: (host: WebviewHost, panelId: string) => void;
  getInitialMessages: (folder: FolderTarget) => ExtensionToWebviewMessage[];
  /** Fires when the last-focused panel, or that panel's folder, changes. */
  onActivePanelChanged?: () => void;
  inheritSettingsFromPanel: (sourcePanelId: string, newPanelId: string) => void;
  /** Full-session replay (pi fork resumes a pre-truncated branched session — US-013c). */
  loadHistory: (cwd: string, sessionId: string, host: WebviewHost, session: ChatSession) => Promise<void>;
}

export class PanelManager {
  private panels: Map<string, HostInstance> = new Map();
  private hostCounter = 0;
  private lastActivePanelId: string | null = null;
  private readonly allClosedListeners: Set<() => void> = new Set();
  private readonly extensionUri: vscode.Uri;
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
  private readonly folderChangeSubscription: vscode.Disposable;

  constructor(config: PanelManagerConfig) {
    this.extensionUri = config.extensionUri;
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

  onAllPanelsClosed(callback: () => void): vscode.Disposable {
    this.allClosedListeners.add(callback);
    return { dispose: (): void => { this.allClosedListeners.delete(callback); } };
  }

  async show(): Promise<void> {
    let targetColumn: vscode.ViewColumn;
    let lockEditorGroup = false;

    const existingColumn = this.findExistingPanelColumn();
    if (existingColumn) {
      targetColumn = existingColumn;
    } else {
      targetColumn = this.findUnusedColumn();
      lockEditorGroup = true;
    }

    const panel = vscode.window.createWebviewPanel(
      "damocles.chat",
      "Damocles",
      { viewColumn: targetColumn, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.getLocalResourceRoots(),
      },
    );

    const host = createPanelHost(panel);
    panel.webview.html = this.getHtmlContent(panel.webview);
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png");

    if (lockEditorGroup) {
      await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
    }

    await this.initializeHost(host);
  }

  async showForked(args: ForkSpawnArgs): Promise<HostInstance | null> {
    const forkContext: ForkContext = {
      sourceSdkSessionId: args.sourceSdkSessionId,
      forkAtUuid: args.forkAtUuid,
      consumed: false,
      ...(args.piBranchedSessionId ? { piBranchedSessionId: args.piBranchedSessionId } : {}),
    };

    const sourceInstance = this.panels.get(args.sourcePanelId);
    const targetColumn = sourceInstance?.host.viewColumn ?? vscode.ViewColumn.Active;

    const panel = vscode.window.createWebviewPanel(
      "damocles.chat",
      "Damocles",
      { viewColumn: targetColumn, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.getLocalResourceRoots(),
      },
    );

    const host = createPanelHost(panel);
    panel.webview.html = this.getHtmlContent(panel.webview);
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png");

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
  private async replayForkedHistory(host: WebviewHost, panelId: string, args: ForkSpawnArgs): Promise<void> {
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

  async restorePanel(panel: vscode.WebviewPanel, workspaceFolderKey: string | undefined): Promise<void> {
    panel.webview.html = this.getHtmlContent(panel.webview);
    const host = createPanelHost(panel);
    try {
      await this.initializeHost(host, workspaceFolderKey !== undefined ? { initialFolderKey: workspaceFolderKey } : undefined);
    } catch (err) {
      log(`[PanelManager] Failed to restore panel: ${err}`);
      panel.webview.html = this.getErrorHtml(panel.webview);
    }
  }

  async initializeHost(
    host: WebviewHost,
    options?: { forkContext?: ForkContext; sourcePanelId?: string; initialFolderKey?: string },
  ): Promise<string> {
    const panelId = `host-${++this.hostCounter}`;
    const disposables: vscode.Disposable[] = [];

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
      host.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
        if (message.type === "ready") signalWebviewReady();
        if (gate.open) {
          this.handleWebviewMessage(message, panelId);
        } else {
          gate.queue.push(message);
        }
      }),
    );

    const permissionHandler = new PermissionHandler(this.extensionUri);
    permissionHandler.setPostMessage((msg) => this.postMessage(host, msg));

    const source = options?.sourcePanelId ? this.panels.get(options.sourcePanelId) : undefined;
    if (source) {
      permissionHandler.setPermissionMode(source.permissionHandler.getPermissionMode());
      permissionHandler.setDangerouslySkipPermissions(source.permissionHandler.getDangerouslySkipPermissions());
    }

    // A fork continues its source's conversation, whose session file lives under the source's folder.
    const folder = source?.folder
      ?? (options?.initialFolderKey !== undefined ? this.folderRegistry.resolve(options.initialFolderKey) : undefined)
      ?? this.folderRegistry.defaultTarget();
    permissionHandler.setWorkspacePath(folder.projectScope ? folder.fsPath : null);

    const ideContextManager = new IdeContextManager("vscode-webview", (context) => {
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
      permissionHandler,
      ideContextManager,
      disposables,
      webviewReady,
      ...(options?.forkContext ? { forkContext: options.forkContext } : {}),
    };
    this.bindSessionCallbacks(instance);
    this.panels.set(panelId, instance);
    this.applyFolderTitle(instance);

    if (host.active) {
      this.setLastActivePanel(panelId);
    }

    disposables.push(
      host.onDidChangeActive(() => {
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
      host.onDidChangeVisibility(() => {
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
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("damocles")) {
          void this.sendCurrentSettings(host, permissionHandler);
        }
        if (
          e.affectsConfiguration("damocles.thinkingDisabled") ||
          e.affectsConfiguration("damocles.effortByModel") ||
          e.affectsConfiguration("damocles.maxThinkingTokens")
        ) {
          this.sendThinkingForPanel(host, panelId);
        }
      }),
    );

    disposables.push(
      host.onDidDispose(() => {
        const instance = this.panels.get(panelId);
        if (instance) {
          void instance.session.dispose();
          void instance.permissionHandler.dispose();
          instance.ideContextManager.dispose();
          instance.disposables.forEach((d) => d.dispose());
          this.cleanupPanelModel(panelId);
          this.cleanupPanelThinking(panelId);
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
        }
      }),
    );

    return panelId;
  }

  private openGate(panelId: string): void {
    const gate = this.messageGates.get(panelId);
    if (!gate) return;
    gate.open = true;
    for (const msg of gate.queue.splice(0)) {
      this.handleWebviewMessage(msg, panelId);
    }
  }

  /** The plan-mode hook drives the session it was bound with, so it is re-bound whenever the session is replaced. */
  private bindSessionCallbacks(instance: HostInstance): void {
    const { session, host, permissionHandler } = instance;
    permissionHandler.setOnPlanModeActivated(async () => {
      await session.setPermissionMode("plan");
      await this.sendCurrentSettings(host, permissionHandler);
    });
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
      const confirm = vscode.l10n.t("Start new conversation");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("Switch this panel to {0}? This starts a new conversation. The current one stays in history.", target.label),
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
      await instance.session.dispose();
      let session: ChatSession;
      try {
        session = await this.createSessionForPanel(instance.host, instance.permissionHandler, panelId, target);
      } catch (err) {
        this.reportSessionFailure(panelId, instance, target, err);
        if (open()) await this.recoverSession(panelId, instance, previousSessionId);
        return undefined;
      }
      if (!open()) {
        await session.dispose();
        return undefined;
      }
      // A restore lands in a webview that has just loaded, so it has no conversation on screen to clear.
      await this.adoptSession(panelId, instance, session, target, reason !== "restore");
      if (!open()) return undefined;
      const claimed = (await afterSwitch?.(instance)) ?? false;
      if (!open()) return undefined;
      // A claimed stored session starts on its target once the user sends, not now.
      if (!claimed) await session.initializeEarly();
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
    this.bindSessionCallbacks(instance);
    // A new conversation resets what clearing does; mode, model and reasoning stay.
    permissionHandler.resetForNewConversation();
    await this.sendCurrentSettings(host, permissionHandler);
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
      message: vscode.l10n.t("Damocles could not start a session in {0}: {1}", folder.label, detail),
    });
  }

  /**
   * The old session is already disposed when a switch fails to create the new one, and the webview never
   * re-sends the folder it already shows. The panel resumes the conversation on screen, or starts fresh
   * and resets the webview when there is none it can resume.
   */
  private async recoverSession(panelId: string, instance: HostInstance, previousSessionId: string | null): Promise<void> {
    // A removed folder is already released, so a session there would build a runtime nobody releases.
    const folder = this.folderRegistry.resolve(instance.folder.key) ?? this.folderRegistry.defaultTarget();
    let session: ChatSession;
    try {
      session = await this.createSessionForPanel(instance.host, instance.permissionHandler, panelId, folder);
    } catch (err) {
      this.reportSessionFailure(panelId, instance, folder, err);
      if (this.panels.get(panelId) === instance) this.postWorkspaceFolderUpdate(instance, false);
      return;
    }
    if (this.panels.get(panelId) !== instance) {
      await session.dispose();
      return;
    }
    // The conversation's file is in its own folder's session dir, so it resumes only there.
    const resumed = previousSessionId !== null
      && folder.key === instance.folder.key
      && claimStoredSession(this.panels, { panelId, session }, previousSessionId) === undefined;
    if (!resumed) {
      await this.adoptSession(panelId, instance, session, folder, true);
      return;
    }
    instance.session = session;
    this.bindSessionCallbacks(instance);
    // The old session unsubscribed before its turn aborted, so the webview never heard the turn end.
    this.postMessage(instance.host, { type: "sessionCancelled" });
    this.postMessage(instance.host, { type: "processing", isProcessing: false });
    this.postWorkspaceFolderUpdate(instance, false);
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
        void vscode.window.showWarningMessage(vscode.l10n.t(
          "The workspace folder {0} was removed, so a Damocles panel moved to {1} and started a new conversation. The previous one stays in history.",
          from.label,
          to.label,
        ));
      }
      return moved !== undefined;
    });
  }

  postMessage(host: WebviewHost, message: ExtensionToWebviewMessage): void {
    try {
      host.webview.postMessage(message);
    } catch {
      // Host was disposed - will be cleaned up by onDidDispose handler
    }
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

  getLocalResourceRoots(): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
      vscode.Uri.joinPath(this.extensionUri, "resources"),
    ];
  }

  getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "assets", "index.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "assets", "index.css"));
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png"));

    const nonce = this.getNonce();

    // CSP: `script-src` stays nonce-locked (no inline/remote script — no RCE). `img-src ... https:` is
    // a deliberate widening so WebFetch can render inline images from extracted web pages. The tradeoff
    // is that any rendered markdown can load remote https images (a tracking/IP-leak vector); this is the
    // standard posture for chat webviews that render web content, and the web tools are opt-in.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: https:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>Damocles</title>
</head>
<body>
  <div id="app" data-logo-uri="${logoUri}"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getErrorHtml(webview: vscode.Webview): string {
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${webview.cspSource};">
  <title>Damocles</title>
  <style>
    body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    .error-container { text-align: center; max-width: 360px; }
    img { width: 48px; height: 48px; opacity: 0.5; margin-bottom: 16px; }
    h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 12px; opacity: 0.7; margin: 0; }
  </style>
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

  dispose(): void {
    this.folderChangeSubscription.dispose();
    for (const [panelId, instance] of this.panels) {
      void instance.session.dispose();
      void instance.permissionHandler.dispose();
      instance.ideContextManager.dispose();
      instance.disposables.forEach((d) => d.dispose());
      this.cleanupPanelModel(panelId);
      this.cleanupPanelThinking(panelId);
      instance.host.close();
    }
    this.panels.clear();
    this.messageGates.clear();
    this.folderChains.clear();
  }

  private findExistingPanelColumn(): vscode.ViewColumn | undefined {
    for (const group of vscode.window.tabGroups.all) {
      if (group.tabs.length === 0) continue;
      const allClaudePanels = group.tabs.every((tab) => {
        if (tab.input instanceof vscode.TabInputWebview) {
          return tab.input.viewType.includes("damocles.chat");
        }
        return false;
      });
      if (allClaudePanels && group.viewColumn) {
        return group.viewColumn;
      }
    }
    return undefined;
  }

  private findUnusedColumn(): vscode.ViewColumn {
    const usedColumns = new Set<vscode.ViewColumn>();
    vscode.window.tabGroups.all.forEach((group) => {
      if (group.viewColumn !== undefined) {
        usedColumns.add(group.viewColumn);
      }
    });

    for (let col = vscode.ViewColumn.One; col <= vscode.ViewColumn.Nine; col++) {
      if (!usedColumns.has(col)) {
        return col;
      }
    }
    return vscode.ViewColumn.Beside;
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
