import type { Disposable } from "../../platform/disposable";
import type { Platform } from "../../platform/platform";
import type { PanelHost } from "../../platform/window-service";
import * as path from "path";
import { PanelManager } from "./panel-manager";
import { StorageManager } from "./storage-manager";
import { createSessionCatalog, type SessionCatalog } from "./session-catalog";
import { HistoryManager } from "./history-manager";
import { SettingsManager } from "./settings-manager";
import { WorkspaceManager } from "./workspace-manager";
import { SessionManager } from "./session-manager";
import { MessageRouter } from "./message-router/index";
import { WebviewPrompts } from "./webview-prompts";
import { MemoryService } from "../memory";
import { BrowserService } from "../browser";
import type { CompassService } from "../compass";
import { CompassRegistry } from "../compass/compass-registry";
import { VoiceService } from "../voice/service";
import { UsageStatsService } from "../usage-stats";
import { OPENAI_KEY_MOVED_MARKER_PATH, SUBCALL_USAGE_LEDGER_PATH, USAGE_INDEX_DB_PATH } from "../paths";
import { showOpenAIKeyMovedNotice } from "../pi-session/openai-key-migration";
import { PI_AGENT_DIR } from "../pi-session/agent-dir";
import { readClaudeAuthFromDisk } from "../pi-session/subscription";
import { OPENAI_PREFER_API_KEY_STATE } from "../pi-session/openai-auth";
import { PiRuntime } from "../pi-session/pi-runtime";
import { typesafeAuthStatus } from "./settings-manager/managers/explore-manager";
import { TYPESAFE_SECRET_KEY } from "../pi-session/custom-providers";
import { EXPLORE_SECRET_KEYS } from "../pi-session/explore-providers";
import { setSessionMetaCacheVersion } from "../pi-session/session-store";
import { WorkspaceFolderRegistry } from "../workspace-folders/folder-registry";
import type { FolderTarget } from "../workspace-folders/folder-registry";
import type { CompassViewsHandle, CompassViewsOptions } from "./types";
import type { ChatSession } from "../chat-session";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import { t } from "../l10n";
import { log } from "../logger";
import { perfSpan } from "../perf";
import { checkpointMaxFileSizeBytes } from "../pi-session/checkpoint-service";

/** What the host supplies beyond the platform. */
export interface ChatPanelHostDeps {
  /** Disposed when the extension deactivates. */
  subscriptions: Disposable[];
  createCompassViews: (options: CompassViewsOptions) => CompassViewsHandle;
}

export class ChatPanelProvider {
  private readonly panelManager: PanelManager;
  private readonly storageManager: StorageManager;
  private readonly sessionCatalog: SessionCatalog;
  private readonly historyManager: HistoryManager;
  private readonly settingsManager: SettingsManager;
  private readonly workspaceManager: WorkspaceManager;
  private readonly sessionManager: SessionManager;
  private readonly messageRouter: MessageRouter;
  private readonly memoryService: MemoryService;
  private readonly browserService: BrowserService;
  private readonly compassRegistry: CompassRegistry;
  private readonly compassViews: CompassViewsHandle;
  private readonly voiceService: VoiceService;
  private readonly usageStatsService: UsageStatsService;
  private readonly folderRegistry: WorkspaceFolderRegistry;
  private readonly webviewPrompts: WebviewPrompts;

  private readonly subscriptions: Disposable[];
  private readonly platform: Platform;
  private memoryJudgeReads = 0;

  constructor(platform: Platform, hostDeps: ChatPanelHostDeps) {
    this.subscriptions = hostDeps.subscriptions;
    this.platform = platform;
    this.folderRegistry = new WorkspaceFolderRegistry(platform.workspaceFolders, platform.state.workspace, platform.fileWatchers);

    const postMessage = (host: PanelHost, message: unknown) => {
      this.panelManager.postMessage(host, message as Parameters<typeof this.panelManager.postMessage>[1]);
    };

    this.settingsManager = new SettingsManager({
      postMessage,
      platform,
      folders: () => this.folderRegistry.targets(),
    });

    // Before the first session list: the persisted list metadata is only valid for the version that wrote it.
    setSessionMetaCacheVersion(platform.appInfo.version);
    this.storageManager = new StorageManager({
      folders: () => this.folderRegistry.targets(),
      isMultiRoot: () => this.folderRegistry.isMultiRoot,
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
      liveSession: (sessionId) => PiRuntime.liveSessionMutator(sessionId),
      fileWatchers: platform.fileWatchers,
    });

    this.historyManager = new HistoryManager({
      postMessage,
      maxCheckpointFileSizeBytes: () => checkpointMaxFileSizeBytes(platform.settings),
      modelReasons: async () => {
        // A panel restored at startup replays before its session creates the runtime, so the replay may create it.
        const models = await PiRuntime.unlessRetired()?.modelRuntimeReady();
        return models ? (provider, modelId) => models.getModel(provider, modelId)?.reasoning : undefined;
      },
    });

    this.workspaceManager = new WorkspaceManager({
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
      platform,
    });

    this.memoryService = new MemoryService(platform);
    this.memoryService.setConsolidationBroadcast((msg) => this.panelManager.broadcast(msg));
    this.sessionCatalog = createSessionCatalog({
      storage: this.storageManager,
      getPanels: () => this.panelManager.getPanels(),
      notifications: platform.notifications,
      memoryService: this.memoryService,
    });
    const stopJudgeUpdates = PiRuntime.onMemoryJudgeChange(() => this.broadcastMemoryJudge());
    this.subscriptions.push({ dispose: stopJudgeUpdates });
    // A sign-in or sign-out in another app or the pi CLI lands only in auth.json; the settings' Anthropic row reads this.
    const stopAuthUpdates = PiRuntime.onAuthFileChange(() => {
      this.panelManager.broadcast({ type: "claudeAuthStatusChanged", mode: readClaudeAuthFromDisk(PI_AGENT_DIR).mode });
    });
    this.subscriptions.push({ dispose: stopAuthUpdates });
    const stopUsageThresholds = PiRuntime.onUsageThreshold((crossing) => this.panelManager.usageThresholdCrossed(crossing));
    this.subscriptions.push({ dispose: stopUsageThresholds });
    // Before pi starts, the status is read from these secrets alone, so their changes are an input too.
    this.subscriptions.push(platform.secrets.onDidChange((key) => {
      if (key === TYPESAFE_SECRET_KEY || key === EXPLORE_SECRET_KEYS.openrouter) this.broadcastMemoryJudge();
    }));
    this.memoryService.setFallbackWorkspace(() => this.folderRegistry.defaultTarget().fsPath);
    this.memoryService.setWorkspaceRoots(this.folderRegistry.targets().map((t) => t.fsPath));
    this.browserService = new BrowserService(platform);
    this.voiceService = new VoiceService({ platform });
    this.voiceService.registerWithExtension(this.subscriptions);

    this.usageStatsService = new UsageStatsService({
      workerPath: platform.paths.workerEntry("usageStats"),
      paths: { sessionsDir: path.join(PI_AGENT_DIR, "sessions"), ledgerPath: SUBCALL_USAGE_LEDGER_PATH, dbPath: USAGE_INDEX_DB_PATH },
      notifications: platform.notifications,
    });
    this.compassRegistry = new CompassRegistry({ platform });
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
    this.compassViews = hostDeps.createCompassViews({
      viewsFolder: () => this.folderRegistry.defaultTarget().fsPath,
      acquireActive: () => {
        const service = this.compassFor(this.compassViewsTarget().key);
        this.refreshCompassViews();
        return service;
      },
    });
    this.compassViews.register();
    this.compassRegistry.onDidChangeServices(() => this.refreshCompassViews());
    this.browserService.onElementPickedFromToolbar((element, chat) => {
      const message = { type: 'browserElementPicked', element } as const;
      const delivered = chat === undefined ? this.panelManager.postToActivePanel(message) : this.postToChat(chat, message);
      if (!delivered) {
        platform.notifications
          .warn(t("Damocles: No chat panel is open. Open one to receive picked elements."))
          .catch((err: unknown) => log("[ChatPanelProvider] Could not show the no-panel notice:", err));
      }
    });

    this.sessionManager = new SessionManager({
      getEnabledMcpServers: (folderKey) => this.settingsManager.getEnabledMcpServers(folderKey),
      getMcpConfigLoaded: () => this.settingsManager.getMcpConfigLoaded(),
      loadMcpConfig: () => this.settingsManager.loadMcpConfig(),
      getActiveModelForPanel: (panelId) => this.settingsManager.getActiveModelForPanel(panelId),
      getDefaultModel: () => this.settingsManager.getDefaultModel(),
      getPreferOpenAIApiKey: () => this.platform.state.workspace.get<boolean>(OPENAI_PREFER_API_KEY_STATE, false),
      resolveThinkingForPanel: (panelId, model, folder) => {
        const settings = this.platform.settings;
        return {
          thinkingDisabled: this.settingsManager.resolveThinkingDisabled(panelId, model, settings, folder),
          effort: this.settingsManager.resolveThinkingEffort(panelId, model, settings, folder),
          maxThinkingTokens: this.settingsManager.resolveMaxThinkingTokens(panelId, model, settings, folder),
        };
      },
      postMessage,
      setupSessionWatcher: (folderKey) => this.storageManager.setupSessionWatcher(folderKey),
      addOrUpdateSession: (sessionId, folderKey) => this.storageManager.addOrUpdateSession(sessionId, folderKey),
      getMemoryService: () => this.memoryService,
      getRawBrowserService: () => this.browserService,
      getCompassService: (folderKey) => this.startCompassFor(folderKey),
      onAssistantTextFinal: (text) => this.dispatchTtsForReply(text),
      platform: this.platform,
    });

    this.webviewPrompts = new WebviewPrompts(
      {
        target: (signal) => this.panelManager.promptTarget(signal),
        attachedView: (panelId) => this.panelManager.attachedView(panelId),
      },
      (host, message) => this.panelManager.postMessage(host, message),
    );

    this.messageRouter = new MessageRouter({
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
      storageManager: this.storageManager,
      sessionCatalog: this.sessionCatalog,
      historyManager: this.historyManager,
      settingsManager: this.settingsManager,
      workspaceManager: this.workspaceManager,
      platform: this.platform,
      subscriptions: this.subscriptions,
      memoryService: this.memoryService,
      browserService: this.browserService,
      compassRegistry: this.compassRegistry,
      voiceService: this.voiceService,
      usageStatsService: this.usageStatsService,
      folderRegistry: this.folderRegistry,
      switchPanelFolder: (panelId, folderKey, reason, afterSwitch) =>
        this.panelManager.switchPanelFolder(panelId, folderKey, reason, afterSwitch),
      postWorkspaceFolderState: (panelId) => this.panelManager.postWorkspaceFolderState(panelId),
      webviewPrompts: this.webviewPrompts,
    });

    this.panelManager = new PanelManager({
      platform: this.platform,
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
      handleWebviewMessage: (message, panelId, view) =>
        this.messageRouter.handleWebviewMessage(message, panelId, view),
      sendCurrentSettings: (host, permissionHandler, folder) =>
        this.settingsManager.sendCurrentSettings(host, permissionHandler, folder),
      getStoredSessions: () => this.storageManager.getStoredSessions(),
      invalidateSessionsCache: () => this.storageManager.invalidateSessionsCache(),
      initPanelModel: (panelId) => this.settingsManager.initPanelModel(panelId),
      cleanupPanelModel: (panelId) => this.settingsManager.cleanupPanelModel(panelId),
      cleanupPanelThinking: (panelId) => this.settingsManager.cleanupPanelThinking(panelId),
      sendThinkingForPanel: (host, panelId, folder) => this.settingsManager.sendThinkingForPanel(host, panelId, folder),
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

    this.subscriptions.push(this.panelManager.onDidChangeAttachment((panelId) => this.webviewPrompts.resurface(panelId)));

    // A removed folder's resources are released by `releaseFolder`, once no session runs there.
    this.subscriptions.push(this.folderRegistry.onDidChange(({ added, removed, relabelled }) => {
      this.refreshCompassViews();
      if (added.length === 0 && removed.length === 0 && !relabelled) return;
      this.memoryService.setWorkspaceRoots(this.folderRegistry.targets().map((t) => t.fsPath));
      this.storageManager.reloadFolders().catch((err) => log("[ChatPanelProvider] Failed to re-list sessions: %O", err));
    }));

    void this.storageManager.setupSessionWatcher();

    showOpenAIKeyMovedNotice({
      secrets: platform.secrets,
      state: platform.state.global,
      notifications: platform.notifications,
      agentDir: PI_AGENT_DIR,
      markerPath: OPENAI_KEY_MOVED_MARKER_PATH,
      host: platform.appInfo.host,
      openAuthPanel: () => {
        void this.panelManager.promptTarget(undefined).then((target) => {
          if (!target) return;
          target.host.reveal();
          this.panelManager.postMessage(target.host, { type: "openOpenAIAuthPanel" });
        });
      },
    }).catch((err: unknown) => log("[ChatPanelProvider] OpenAI key-moved notice failed: %s", err instanceof Error ? err.message : String(err)));

    // A single-folder window indexes its folder at startup, before any panel targets it.
    if (!this.folderRegistry.isMultiRoot) {
      const compassSpan = perfSpan("compass.startFor");
      const compass = this.startCompassFor(this.folderRegistry.defaultTarget().key);
      compassSpan.end({ enabled: compass?.isEnabled ?? false });
    }
    this.refreshCompassViews();

    this.settingsManager.setOnMcpConfigChange(() => this.refeedMcpPanels());

    this.subscriptions.push(this.folderRegistry.onDidChange(({ added, removed }) => {
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
    this.subscriptions.push(
      this.platform.trust.onDidGrantTrust(() => {
        this.settingsManager.loadMcpConfig()
          .then(() => this.refeedMcpPanels())
          .catch((err: unknown) => log("[ChatPanelProvider] MCP reload after a trust grant failed:", err));
      }),
    );

    this.settingsManager.onDefaultModelChanged(() => {
      for (const [panelId, instance] of this.panelManager.getPanels()) {
        this.settingsManager.sendModelForPanel(instance.host, panelId);
        this.settingsManager.sendThinkingForPanel(instance.host, panelId, instance.folder);
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

  /** The stored conversations of the open folders; the desktop Chats list reads and edits them here. */
  getSessionCatalog(): SessionCatalog {
    return this.sessionCatalog;
  }

  getFolderRegistry(): WorkspaceFolderRegistry {
    return this.folderRegistry;
  }

  /** Host dialogs rendered in a chat panel's webview; the desktop DialogService delegates to it. */
  getWebviewPrompts(): WebviewPrompts {
    return this.webviewPrompts;
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
  private pushMcpStatus(session: ChatSession, host: PanelHost, folderKey: string): void {
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

  /** Post to the open chat panel hosted by `chat`; false when no open panel has that host. */
  private postToChat(chat: PanelHost, message: ExtensionToWebviewMessage): boolean {
    for (const [, instance] of this.panelManager.getPanels()) {
      if (instance.host !== chat) continue;
      this.panelManager.postMessage(instance.host, message);
      return true;
    }
    return false;
  }

  /** Reads overlap, so only the newest read is broadcast; an older one may have read state the newer one replaced. */
  private broadcastMemoryJudge(): void {
    const read = ++this.memoryJudgeReads;
    typesafeAuthStatus(this.platform)
      .then((msg) => {
        if (read === this.memoryJudgeReads) this.panelManager.broadcast(msg);
      })
      .catch((err: unknown) => log("[ChatPanelProvider] reading the memory judge status failed: %s", err instanceof Error ? err.message : String(err)));
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
    if (!this.platform.settings.get<boolean>("damocles.voice.tts.enabled", false)) return;
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

  async restorePanel(host: PanelHost, workspaceFolderKey: string | undefined): Promise<void> {
    await this.panelManager.restorePanel(host, workspaceFolderKey);
  }

  async restoreBrowserPanel(host: PanelHost, url: string): Promise<void> {
    await this.browserService.restorePanel(host, url);
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
   * Resolves only once Chrome has exited (`BrowserService.dispose()`), so it does not outlive the host,
   * every panel's session is disposed, which releases its session lease, and the memory database has
   * flushed its queued writes and closed. Callers must await it. The synchronous disposals still run
   * first and unconditionally.
   */
  async dispose(): Promise<void> {
    this.compassViews.dispose();
    this.compassRegistry.dispose().catch((err: unknown) => log("[ChatPanelProvider] compass dispose error: %O", err));
    const memoryClosed = this.memoryService.dispose();
    const browserClosed = this.browserService.dispose().catch((err: unknown) => log('[ChatPanelProvider] browser dispose error: %O', err));
    this.storageManager.dispose();
    this.workspaceManager.dispose();
    this.settingsManager.dispose();
    this.voiceService.dispose();
    this.usageStatsService.dispose();
    // Before the panels close, so each prompt is withdrawn from a webview that can still receive it.
    this.webviewPrompts.dispose();
    const sessionsDisposed = this.panelManager.dispose();
    this.folderRegistry.dispose();
    await Promise.all([browserClosed, sessionsDisposed, memoryClosed]);
  }
}
