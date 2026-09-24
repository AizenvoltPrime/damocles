import * as vscode from "vscode";
import * as path from "path";
import { PanelManager } from "./panel-manager";
import { StorageManager } from "./storage-manager";
import { HistoryManager } from "./history-manager";
import { SettingsManager } from "./settings-manager";
import { WorkspaceManager } from "./workspace-manager";
import { SessionManager } from "./session-manager";
import { MessageRouter } from "./message-router/index";
import { MemoryService } from "../memory";
import { BrowserService } from "../browser";
import type { CompassService } from "../compass";
import { CompassRegistry } from "../compass/compass-registry";
import { CompassViews } from "../compass/compass-views";
import { VoiceService } from "../voice/service";
import { OPENAI_PREFER_API_KEY_STATE } from "../pi-session/openai-auth";
import { PiRuntime } from "../pi-session/pi-runtime";
import { WorkspaceFolderRegistry, homeDirectory } from "../workspace-folders/folder-registry";
import type { FolderTarget } from "../workspace-folders/folder-registry";
import type { WebviewHost } from "./types";
import type { ChatSession } from "../chat-session";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import { log } from "../logger";

export class ChatPanelProvider {
  private readonly panelManager: PanelManager;
  private readonly storageManager: StorageManager;
  private readonly historyManager: HistoryManager;
  private readonly settingsManager: SettingsManager;
  private readonly workspaceManager: WorkspaceManager;
  private readonly sessionManager: SessionManager;
  private readonly messageRouter: MessageRouter;
  private readonly memoryService: MemoryService;
  private readonly browserService: BrowserService;
  private readonly compassRegistry: CompassRegistry;
  private readonly compassViews: CompassViews;
  private readonly voiceService: VoiceService;
  private readonly folderRegistry: WorkspaceFolderRegistry;

  private readonly extensionUri: vscode.Uri;
  private readonly context: vscode.ExtensionContext;

  constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this.extensionUri = extensionUri;
    this.context = context;
    const homeDir = homeDirectory();
    this.folderRegistry = new WorkspaceFolderRegistry(context.workspaceState);

    const postMessage = (host: WebviewHost, message: unknown) => {
      this.panelManager.postMessage(host, message as Parameters<typeof this.panelManager.postMessage>[1]);
    };

    this.settingsManager = new SettingsManager({
      postMessage,
      secrets: context.secrets,
      workspaceState: context.workspaceState,
      folders: () => this.folderRegistry.targets(),
    });

    this.storageManager = new StorageManager({
      folders: () => this.folderRegistry.targets(),
      isMultiRoot: () => this.folderRegistry.isMultiRoot,
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
    });

    this.historyManager = new HistoryManager({
      postMessage,
    });

    this.workspaceManager = new WorkspaceManager({
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
    });

    this.memoryService = new MemoryService(extensionUri.fsPath);
    this.memoryService.setConsolidationBroadcast((msg) => this.panelManager.broadcast(msg));
    this.memoryService.setFallbackWorkspace(() => this.folderRegistry.defaultTarget().fsPath);
    this.memoryService.setWorkspaceRoots(this.folderRegistry.targets().map((t) => t.fsPath));
    this.browserService = new BrowserService();
    this.voiceService = new VoiceService({ extensionRoot: extensionUri.fsPath });
    this.voiceService.registerWithExtension(context);
    this.compassRegistry = new CompassRegistry({
      damoclesDir: path.join(homeDir, ".damocles"),
      extensionPath: extensionUri.fsPath,
    });
    this.compassRegistry.onStatusChange((folderKey, status) => {
      this.postToFolderPanels(folderKey, { type: "compassStatusUpdate", status });
    });
    this.compassRegistry.onProgress((folderKey, event) => {
      this.postToFolderPanels(folderKey, {
        type: "compassBuildProgress",
        current: event.current,
        total: event.total,
        phase: event.phase,
        ...(event.label ? { label: event.label } : {}),
      });
    });
    this.compassViews = new CompassViews({
      acquireActive: () => {
        const service = this.compassFor(this.compassViewsTarget().key);
        this.refreshCompassViews();
        return service;
      },
    });
    this.compassViews.register();
    this.compassRegistry.onDidChangeServices(() => this.refreshCompassViews());
    this.browserService.onElementPickedFromToolbar((element) => {
      const delivered = this.panelManager.postToActivePanel({ type: 'browserElementPicked', element });
      if (!delivered) {
        vscode.window.showWarningMessage("Damocles: No active chat panel — open a chat panel to receive picked elements.");
      }
    });

    this.sessionManager = new SessionManager({
      getEnabledMcpServers: (folderKey) => this.settingsManager.getEnabledMcpServers(folderKey),
      getMcpConfigLoaded: () => this.settingsManager.getMcpConfigLoaded(),
      loadMcpConfig: () => this.settingsManager.loadMcpConfig(),
      getActiveModelForPanel: (panelId) => this.settingsManager.getActiveModelForPanel(panelId),
      getDefaultModel: () => this.settingsManager.getDefaultModel(),
      getPreferOpenAIApiKey: () => this.context.workspaceState.get<boolean>(OPENAI_PREFER_API_KEY_STATE, false),
      resolveThinkingForPanel: (panelId, model) => {
        const config = vscode.workspace.getConfiguration("damocles");
        return {
          thinkingDisabled: this.settingsManager.resolveThinkingDisabled(panelId, model, config),
          effort: this.settingsManager.resolveThinkingEffort(panelId, model, config),
          maxThinkingTokens: this.settingsManager.resolveMaxThinkingTokens(panelId, model, config),
        };
      },
      postMessage,
      setupSessionWatcher: (folderKey) => this.storageManager.setupSessionWatcher(folderKey),
      addOrUpdateSession: (sessionId, folderKey) => this.storageManager.addOrUpdateSession(sessionId, folderKey),
      getMemoryService: () => this.memoryService,
      getRawBrowserService: () => this.browserService,
      getCompassService: (folderKey) => this.startCompassFor(folderKey),
      onAssistantTextFinal: (text) => this.dispatchTtsForReply(text),
      secrets: this.context.secrets,
    });

    this.messageRouter = new MessageRouter({
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
      storageManager: this.storageManager,
      historyManager: this.historyManager,
      settingsManager: this.settingsManager,
      workspaceManager: this.workspaceManager,
      context: this.context,
      memoryService: this.memoryService,
      browserService: this.browserService,
      compassRegistry: this.compassRegistry,
      voiceService: this.voiceService,
      folderRegistry: this.folderRegistry,
      switchPanelFolder: (panelId, folderKey, reason, afterSwitch) =>
        this.panelManager.switchPanelFolder(panelId, folderKey, reason, afterSwitch),
      postWorkspaceFolderState: (panelId) => this.panelManager.postWorkspaceFolderState(panelId),
    });

    this.panelManager = new PanelManager({
      extensionUri: this.extensionUri,
      folderRegistry: this.folderRegistry,
      createSessionForPanel: async (host, permissionHandler, panelId, folder, forkContext) => {
        const onSpawnFork = (args: import("../../shared/types/session").ForkSpawnArgs) =>
          this.panelManager.showForked(args).then(() => undefined);
        const session = await this.sessionManager.createSessionForPanel(
          host,
          permissionHandler,
          panelId,
          folder,
          onSpawnFork,
          forkContext,
        );
        // The session start may have started this folder's index before the panel joined the map.
        for (const msg of this.compassStatusMessages(folder.key)) this.panelManager.postMessage(host, msg);
        // Live MCP status: push fresh runtime status to this panel whenever a server connects/disconnects,
        // so the panel reflects connecting → connected automatically (no manual refresh).
        session.setMcpStatusListener(() => {
          this.pushMcpStatus(session, host, folder.key);
        });
        return session;
      },
      handleWebviewMessage: (message, panelId) =>
        this.messageRouter.handleWebviewMessage(message, panelId),
      sendCurrentSettings: (host, permissionHandler) =>
        this.settingsManager.sendCurrentSettings(host, permissionHandler),
      getStoredSessions: () => this.storageManager.getStoredSessions(),
      invalidateSessionsCache: () => this.storageManager.invalidateSessionsCache(),
      initPanelModel: (panelId) => this.settingsManager.initPanelModel(panelId),
      cleanupPanelModel: (panelId) => this.settingsManager.cleanupPanelModel(panelId),
      cleanupPanelThinking: (panelId) => this.settingsManager.cleanupPanelThinking(panelId),
      sendThinkingForPanel: (host, panelId) => this.settingsManager.sendThinkingForPanel(host, panelId),
      getInitialMessages: (folder) => this.compassStatusMessages(folder.key),
      onActivePanelChanged: () => this.refreshCompassViews(),
      sendFolderState: async (instance) => {
        await this.workspaceManager.sendCustomSlashCommands(instance.host, instance.folder);
        this.panelManager.postMessage(instance.host, { type: "toolStatus", data: instance.session.getToolStatus() });
        this.settingsManager.sendMcpConfig(instance.host, instance.folder.key);
        for (const msg of this.compassStatusMessages(instance.folder.key)) this.panelManager.postMessage(instance.host, msg);
        // The webview keeps the @-mention file list it already loaded until a new list replaces it.
        await this.workspaceManager.sendWorkspaceFiles(instance.host, instance.folder);
      },
      releaseFolder: (key) => this.releaseFolder(key),
      inheritSettingsFromPanel: (sourcePanelId, newPanelId) => {
        this.settingsManager.setActiveModelForPanel(newPanelId, this.settingsManager.getActiveModelForPanel(sourcePanelId));
        this.settingsManager.copyPanelThinkingStateTo(sourcePanelId, newPanelId);
      },
      loadHistory: (cwd, sessionId, host, session) =>
        this.historyManager.loadSessionHistory(cwd, sessionId, host, session),
    });

    // A removed folder's resources are released by `releaseFolder`, once no session runs there.
    this.context.subscriptions.push(this.folderRegistry.onDidChange(({ added, removed, relabelled }) => {
      this.refreshCompassViews();
      if (added.length === 0 && removed.length === 0 && !relabelled) return;
      this.memoryService.setWorkspaceRoots(this.folderRegistry.targets().map((t) => t.fsPath));
      this.storageManager.reloadFolders().catch((err) => log("[ChatPanelProvider] Failed to re-list sessions: %O", err));
    }));

    void this.storageManager.setupSessionWatcher();

    // A single-folder window indexes its folder at startup, before any panel targets it.
    if (!this.folderRegistry.isMultiRoot) this.startCompassFor(this.folderRegistry.defaultTarget().key);
    this.refreshCompassViews();

    this.settingsManager.setOnMcpConfigChange(() => this.refeedMcpPanels());

    this.context.subscriptions.push(this.folderRegistry.onDidChange(({ added, removed }) => {
      if (added.length === 0 && removed.length === 0) return;
      this.settingsManager.handleMcpFoldersChanged().catch((err) => log("[ChatPanelProvider] MCP reload after a folder change failed:", err));
    }));

    // Granting workspace trust unblocks workspace `.mcp.json` servers (M3). The re-read has to come
    // first: trust decides what `loadConfig` samples, not only what the trust gate withholds
    // afterwards. It picks the fold that ranks repo-authored sources, runs the gitignore check that
    // an untrusted workspace skips, and records which sources actually outrank `~/.damocles/mcp.json`.
    // None of those recover on their own, so the re-feed and the broadcast below both wait for it.
    // A watcher firing in the same window takes the later generation and this load then assigns
    // nothing, so the broadcast can carry the pre-grant snapshot until that load's own change
    // notification lands.
    this.context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(async () => {
        await this.settingsManager.loadMcpConfig();
        this.refeedMcpPanels();
      }),
    );

    this.settingsManager.onDefaultModelChanged(() => {
      for (const [panelId, instance] of this.panelManager.getPanels()) {
        this.settingsManager.sendModelForPanel(instance.host, panelId);
        this.settingsManager.sendThinkingForPanel(instance.host, panelId);
      }
    });
    this.settingsManager.setupMcpWatcher();

    this.settingsManager.loadMcpConfig().catch((err) => {
      log("[ChatPanelProvider] Error pre-loading MCP config:", err);
    });
    this.settingsManager.loadBrowserState();
  }

  getPanelManager(): PanelManager {
    return this.panelManager;
  }

  getBrowserService(): BrowserService {
    return this.browserService;
  }

  getVoiceService(): VoiceService {
    return this.voiceService;
  }

  /**
   * Push runtime MCP status to one panel. `sendMcpStatus` awaits a live SDK round-trip, so it can
   * reject on a server that is mid-teardown; every caller here is a fire-and-forget listener, and an
   * unhandled rejection from one would be an unhandled promise rejection in the extension host.
   */
  private pushMcpStatus(session: ChatSession, host: WebviewHost, folderKey: string): void {
    this.settingsManager.sendMcpStatus(session, host, folderKey).catch(err => {
      log('[ChatPanelProvider] Failed to push MCP status: %s', err instanceof Error ? err.message : 'Unknown error');
    });
  }

  /**
   * Give every panel its own folder's MCP list and scope, so a folder's servers never reach another
   * folder's panels. Live connections reconcile with no session restart (US-014.9).
   */
  private refeedMcpPanels(): void {
    for (const [, instance] of this.panelManager.getPanels()) {
      const folderKey = instance.folder.key;
      this.panelManager.postMessage(instance.host, this.settingsManager.buildMcpConfigUpdate(folderKey));
      instance.session.setMcpServers(this.settingsManager.getEnabledMcpServers(folderKey));
      // The config update describes config only, so every enabled server reads as `idle` until real
      // status is pushed.
      this.pushMcpStatus(instance.session, instance.host, folderKey);
    }
  }

  /** The steps run independently, so one failing leaks none of the folder's other resources. */
  private async releaseFolder(key: string): Promise<void> {
    const steps: Array<() => unknown> = [
      () => this.workspaceManager.disposeFolder(key),
      () => this.compassRegistry.release(key),
      () => (PiRuntime.exists ? PiRuntime.get().disposeFolder(key) : undefined),
    ];
    for (const result of await Promise.allSettled(steps.map(async (step) => step()))) {
      if (result.status === "rejected") log("[ChatPanelProvider] releasing folder %s failed: %O", key, result.reason);
    }
  }

  private compassStatusMessages(folderKey: string): ExtensionToWebviewMessage[] {
    const service = this.compassFor(folderKey);
    return service?.isEnabled ? [{ type: "compassStatusUpdate", status: service.getStatus() }] : [];
  }

  /** The folder's Compass service, created without a worker; null for a folder that is not open or has no project. */
  private compassFor(folderKey: string): CompassService | null {
    const target = this.folderRegistry.resolve(folderKey);
    return target ? this.compassRegistry.acquire(target) : null;
  }

  /** As `compassFor`, and starts the folder's worker when Compass is enabled in a trusted window. */
  private startCompassFor(folderKey: string): CompassService | null {
    const target = this.folderRegistry.resolve(folderKey);
    return target ? this.compassRegistry.start(target) : null;
  }

  private postToFolderPanels(folderKey: string, message: ExtensionToWebviewMessage): void {
    for (const [, instance] of this.panelManager.getPanels()) {
      if (instance.folder.key === folderKey) this.panelManager.postMessage(instance.host, message);
    }
  }

  /** The last-focused panel's folder, or the default target when no panel has been focused. */
  private compassViewsTarget(): FolderTarget {
    return this.panelManager.getActivePanelFolder() ?? this.folderRegistry.defaultTarget();
  }

  private refreshCompassViews(): void {
    // The views never create a service themselves, so a folder no panel targets starts no worker.
    const target = this.compassViewsTarget();
    const service = this.compassRegistry.get(target.key) ?? null;
    this.compassViews.setActive(service, this.folderRegistry.isMultiRoot ? target.label : undefined);
  }

  private dispatchTtsForReply(text: string): void {
    const cfg = vscode.workspace.getConfiguration("damocles");
    if (!cfg.get<boolean>("voice.tts.enabled", false)) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    void (async () => {
      try {
        if (!this.voiceService.isReady()) await this.voiceService.start();
        if (!this.voiceService.isReady()) {
          log("[ChatPanelProvider] tts dispatch: voice service did not become ready");
          return;
        }
        const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        log(`[ChatPanelProvider] tts dispatch reply: req=${reqId} chars=${trimmed.length}`);
        this.voiceService.ttsRequest(reqId, trimmed);
      } catch (err) {
        log("[ChatPanelProvider] tts dispatch failed:", err);
      }
    })();
  }

  async show(): Promise<void> {
    await this.panelManager.show();
  }

  async restorePanel(panel: vscode.WebviewPanel, workspaceFolderKey: string | undefined): Promise<void> {
    await this.panelManager.restorePanel(panel, workspaceFolderKey);
  }

  async restoreBrowserPanel(panel: vscode.WebviewPanel, url: string): Promise<void> {
    await this.browserService.restorePanel(panel, url);
  }

  newSession(): void {
    this.panelManager.newSession();
  }

  cancelSession(): void {
    this.panelManager.cancelSession();
  }

  async reloadActiveSession(): Promise<void> {
    for (const [, instance] of this.panelManager.getPanels()) {
      instance.session.reset();
      this.panelManager.postMessage(instance.host, { type: "processing", isProcessing: false });
      this.panelManager.postMessage(instance.host, { type: "authFailureCleared" });
    }
  }

  /**
   * Tear down every owned service.
   *
   * RETURNS A PROMISE BECAUSE ONE OBLIGATION IS GENUINELY ASYNC. `BrowserService.dispose()` waits for
   * Chrome to exit so it does not outlive the extension host, and that guarantee only holds if the
   * wait is actually awaited — dropping the promise here (and again in `deactivate`) made the comment
   * asserting it false, leaving a headful Chromium running against the logged-in profile after the
   * host went away. The synchronous disposals still run first and unconditionally.
   */
  async dispose(): Promise<void> {
    this.compassViews.dispose();
    this.compassRegistry.dispose().catch((err: unknown) => log("[ChatPanelProvider] compass dispose error: %O", err));
    this.memoryService.dispose();
    const browserClosed = this.browserService.dispose().catch((err: unknown) => log('[ChatPanelProvider] browser dispose error: %O', err));
    this.storageManager.dispose();
    this.workspaceManager.dispose();
    this.settingsManager.dispose();
    this.voiceService.dispose();
    this.panelManager.dispose();
    this.folderRegistry.dispose();
    await browserClosed;
  }
}
