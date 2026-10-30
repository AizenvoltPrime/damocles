import type { Disposable } from "../../platform/disposable";
import type { PlatformWithWorktrees } from "../worktrees/host";
import type { PanelHost } from "../../platform/window-service";
import type { ChatPermissions } from "../permission-handler";
import * as path from "path";
import { PanelManager } from "./panel-manager";
import { onListingChange, StorageManager } from "./storage-manager";
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
import { OPENAI_KEY_MOVED_MARKER_PATH, SESSION_META_CACHE_DIR, SUBCALL_USAGE_LEDGER_PATH, USAGE_INDEX_DB_PATH } from "../paths";
import { showOpenAIKeyMovedNotice } from "../pi-session/openai-key-migration";
import { PI_AGENT_DIR } from "../pi-session/agent-dir";
import { OPENAI_API_KEY_SECRET, OPENAI_API_PROVIDER, readPreferOpenAIApiKey } from "../pi-session/openai-auth";
import { MEMORY_JUDGE_EFFORT_SETTING, MEMORY_JUDGE_SETTING } from "../../shared/memory-judge";
import { PiRuntime } from "../pi-session/pi-runtime";
import { effortBadgeApplies } from "../pi-session/pi-models";
import { memoryJudgeStatus } from "./settings-manager/managers/memory-judge-status";
import { providerAuthStatus } from "./settings-manager/managers/provider-keys";
import { keyProviderOfSecret, TYPESAFE_SECRET_KEY } from "../pi-session/custom-providers";
import { ACCOUNT_PROVIDER_IDS, type AccountProviderId } from "../../shared/settings-sections";
import { broadcastImageGenerationState } from "./message-router/handlers/settings-handlers";
import { publishPanelsAccountInfo, publishUnstartedPanelsAccountInfo, republishAccountInfo } from "./message-router/handlers/account-info";
import { openaiAuthStatusMessage } from "./message-router/handlers/openai-handlers";
import { MODEL_PICKER_SETTING } from "../../shared/model-vendor";
import { PROVIDER_SECRET_KEYS } from "../pi-session/explore-providers";
import { SessionMetaIndex } from "../pi-session/session-store";
import { WorkspaceFolderRegistry } from "../workspace-folders/folder-registry";
import type { FolderTarget } from "../workspace-folders/folder-registry";
import type { CompassViewsHandle, CompassViewsOptions } from "./types";
import type { ChatSession } from "../chat-session";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../shared/types/messages";
import { headlineOf, l } from "../l10n";
import type { LocalizedText } from "../../shared/localized-text";
import { log } from "../logger";
import { perfSpan } from "../perf";
import { checkpointMaxFileSizeBytes } from "../pi-session/checkpoint-service";
import { allJsonConfigWritesSettled } from "../config/json-config-write";
import { installWorktreeProjectLookup } from "../worktrees/personal-config";
import { openAppSettingsFor } from "./open-app-settings";
import { openTranscriptView } from "./transcript-view";
import { asClient, clientPrefersApiKey } from "../client-snapshots";
import { deviceHost, forEachDevice, hostForChange } from "./device-hosts";

/**
 * Settles once every config file write core started (MCP, settings and permission files), one queued meanwhile included,
 * has landed or failed; never rejects. A host's teardown awaits it after `ChatPanelProvider.dispose`, which can still write.
 */
export function flushCoreWrites(): Promise<void> {
  return allJsonConfigWritesSettled();
}

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
  private readonly platform: PlatformWithWorktrees;
  // the newest read of each account row, per row and device ("" on a local core)
  private readonly accountReads = new Map<string, number>();

  constructor(platform: PlatformWithWorktrees, hostDeps: ChatPanelHostDeps) {
    this.subscriptions = hostDeps.subscriptions;
    this.platform = platform;
    this.folderRegistry = new WorkspaceFolderRegistry(platform.workspaceFolders, platform.state.workspace, platform.fileWatchers);
    // D34 and rule 1: personal files and session lookups of a chat worktree resolve through its project; VS Code has no registry.
    const worktreeHost = platform.capabilities.worktrees ? platform.worktrees : undefined;
    if (worktreeHost) this.subscriptions.push(installWorktreeProjectLookup(worktreeHost.registry));

    const postMessage = (host: PanelHost, message: unknown, except?: readonly string[]) => {
      this.panelManager.postMessage(host, message as Parameters<typeof this.panelManager.postMessage>[1], except);
    };

    // MCP reads every folder a chat works in: the projects and the working folders loaded worktree chats hold (D34, rule 8).
    this.settingsManager = new SettingsManager({
      postMessage,
      platform,
      folders: () => [...this.folderRegistry.targets(), ...this.folderRegistry.ownedFolders()],
    });

    this.storageManager = new StorageManager({
      folders: () => this.folderRegistry.targets(),
      isMultiRoot: () => this.folderRegistry.isMultiRoot,
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
      liveSession: (sessionId) => PiRuntime.liveSessionMutator(sessionId),
      fileWatchers: platform.fileWatchers,
      metaIndex: new SessionMetaIndex({
        workerPath: platform.paths.workerEntry("sessionMetaIndex"),
        cacheDir: SESSION_META_CACHE_DIR,
        piPackageDir: path.join(platform.paths.resourceRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
      }),
    });

    this.historyManager = new HistoryManager({
      postMessage,
      maxCheckpointFileSizeBytes: () => checkpointMaxFileSizeBytes(platform.settings),
      modelReasons: async () => {
        // A panel restored at startup replays before its session creates the runtime, so the replay may create it.
        const models = await PiRuntime.unlessRetired()?.modelRuntimeReady();
        return models ? (provider, modelId) => {
          const model = models.getModel(provider, modelId);
          return model ? effortBadgeApplies(model) : undefined;
        } : undefined;
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
    const stopJudgeUpdates = PiRuntime.onMemoryJudgeChange((clientId) => this.broadcastMemoryJudge(clientId));
    this.subscriptions.push({ dispose: stopJudgeUpdates });
    // A sign-in or sign-out in another app or the pi CLI lands only in auth.json, which the account rows read themselves.
    const stopAuthUpdates = PiRuntime.onAuthFileChange((keySynced) => this.accountInputsChanged(keySynced ? "keySync" : "judge"));
    this.subscriptions.push({ dispose: stopAuthUpdates });
    // Another window's OpenAI key or prefer flag, or init's move of the key: the runtime published the sessions it holds and the judge status.
    const stopOpenAIKeyUpdates = PiRuntime.onOpenAICredentialChange(() => {
      void this.broadcastAccountState("the OpenAI auth status", "openai", () => openaiAuthStatusMessage(platform));
      publishUnstartedPanelsAccountInfo(() => this.panelManager.getPanels());
    });
    this.subscriptions.push({ dispose: stopOpenAIKeyUpdates });
    // Outside a run, a daemon's core reads the acting client's credentials and prefer flags, its auth.json in effect.
    const remote = platform.remote;
    if (remote) {
      this.subscriptions.push(remote.clients.onDidChange((change) => {
        // once the runtime observes clientAuth, its credentialsChanged publishes each delta that changes a provider, and one that changes none changes no row
        if (change.topic === "clientAuth" && !PiRuntime.observesClientAuth) this.accountInputsChanged("nothing");
        // once the runtime observes it, an acting client change republishes when pi's snapshot holds that client's credentials
        if (change.topic === "actingClient" && !PiRuntime.observesActingClient) this.accountInputsChanged("nothing");
        // a host's Allow YOLO switch changed on that client: its views show or hide the YOLO control at once
        if (change.topic === "clientPolicy" && change.clientId !== undefined) {
          const clientId = change.clientId;
          const capabilities = asClient(remote, clientId, () => platform.capabilities);
          for (const [, instance] of this.panelManager.getPanels()) {
            for (const view of instance.host.views?.() ?? []) {
              if (view.clientId === clientId && instance.host.viewHost) postMessage(instance.host.viewHost(view.viewKey), { type: "hostCapabilities", capabilities });
            }
          }
        }
      }));
      const stopActing = PiRuntime.onActingClientRefreshed(() => this.accountInputsChanged("nothing"));
      this.subscriptions.push({ dispose: stopActing });
    }
    // Before pi starts, the judge and the Anthropic row read auth.json directly; the runtime shares this watch once it exists.
    this.subscriptions.push(PiRuntime.watchAuthFile());
    const stopUsageThresholds = PiRuntime.onUsageThreshold((crossing) => this.panelManager.usageThresholdCrossed(crossing));
    this.subscriptions.push({ dispose: stopUsageThresholds });
    // Fires for this window's own writes too, so it is the one publisher of key provider status.
    this.subscriptions.push(platform.secrets.onDidChange((key) => {
      const provider = keyProviderOfSecret(key);
      if (provider) this.broadcastProviderAuthStatus(provider);
      // Until the runtime hears a secret itself, the judge status and the OpenAI row are read from these secrets and the judge setting
      // alone; from then on the runtime is the one publisher, so this one would post them a second time. On this computer's core it
      // hears the OpenAI key from its construction, before any account state is published, and the classifier keys from init.
      if (key === OPENAI_API_KEY_SECRET) {
        if (PiRuntime.observesOpenAIKey || PiRuntime.observesSecrets) return;
        void this.broadcastAccountState("the OpenAI auth status", "openai", () => openaiAuthStatusMessage(platform));
        this.broadcastMemoryJudge();
        return;
      }
      if (PiRuntime.observesSecrets) return;
      if (key === TYPESAFE_SECRET_KEY || key === PROVIDER_SECRET_KEYS.openrouter) this.broadcastMemoryJudge();
    }));
    // Image settings, Tools status and the key statuses' environment flag read the credentials pi holds, which only a finished sync reflects.
    const stopSyncUpdates = PiRuntime.onCustomProvidersSynced(({ accountChanged }) => {
      const getPanels = () => this.panelManager.getPanels();
      broadcastImageGenerationState({ getPanels, settingsManager: this.settingsManager });
      for (const provider of ACCOUNT_PROVIDER_IDS) this.broadcastProviderAuthStatus(provider);
      if (accountChanged) publishUnstartedPanelsAccountInfo(getPanels);
    });
    this.subscriptions.push({ dispose: stopSyncUpdates });
    // the judge status reads no picker setting, so this tells it nothing
    this.subscriptions.push(platform.settings.onDidChange(MODEL_PICKER_SETTING, (change) => publishPanelsAccountInfo(() => this.panelManager.getPanels(), change.clientId)));
    this.subscriptions.push(platform.settings.onDidChange("damocles.memory", (change) => {
      if (change.affects(MEMORY_JUDGE_SETTING) || change.affects(MEMORY_JUDGE_EFFORT_SETTING)) this.broadcastMemoryJudge(change.clientId);
    }));
    this.memoryService.setFallbackWorkspace(() => this.folderRegistry.defaultTarget().fsPath);
    this.memoryService.setWorkspaceRoots(this.folderRegistry.targets().map((t) => t.fsPath));
    this.browserService = new BrowserService(platform);
    this.voiceService = new VoiceService({ platform });
    this.voiceService.registerWithExtension(this.subscriptions);
    const onReplyNotSpoken = ({ reason, origin }: { reason: LocalizedText; origin: string }): void => this.noticeReplyNotSpoken(reason, origin);
    this.voiceService.on("replyNotSpoken", onReplyNotSpoken);
    this.subscriptions.push({ dispose: () => this.voiceService.off("replyNotSpoken", onReplyNotSpoken) });

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
          .warn(l("Damocles: No chat panel is open. Open one to receive picked elements."))
          .catch((err: unknown) => log("[ChatPanelProvider] Could not show the no-panel notice:", err));
      }
    });

    this.sessionManager = new SessionManager({
      getEnabledMcpServers: (folderKey) => this.settingsManager.getEnabledMcpServers(folderKey),
      getMcpConfigLoaded: () => this.settingsManager.getMcpConfigLoaded(),
      loadMcpConfig: () => this.settingsManager.loadMcpConfig(),
      getConfiguredModelForPanel: (panelId) => this.settingsManager.getConfiguredModelForPanel(panelId),
      getPreferOpenAIApiKey: () => {
        if (PiRuntime.exists) return PiRuntime.get().preferOpenAIApiKey();
        // a daemon's core: the pinned (else acting) client's own flag, from its clientAuth
        const remote = this.platform.remote;
        return remote ? clientPrefersApiKey(remote, OPENAI_API_PROVIDER) : readPreferOpenAIApiKey(this.platform.state);
      },
      resolveThinkingForPanel: (panelId, model, folder) => {
        const settings = this.platform.settings;
        return {
          thinkingDisabled: this.settingsManager.resolveThinkingDisabled(panelId, model, settings, folder),
          effort: this.settingsManager.resolveThinkingEffort(panelId, model, settings, folder),
        };
      },
      restoreRecordedSelection: (panelId, model, thinkingLevel) => this.settingsManager.restoreRecordedSelection(panelId, model, thinkingLevel),
      adoptSessionModel: (host, panelId, folder, model, contextWindow, committed) =>
        this.settingsManager.adoptSessionModel(host, panelId, folder, model, contextWindow, committed),
      postMessage,
      setupSessionWatcher: (folderKey) => this.storageManager.setupSessionWatcher(folderKey),
      addOrUpdateSession: (sessionId, folderKey) => this.storageManager.addOrUpdateSession(sessionId, folderKey),
      getMemoryService: () => this.memoryService,
      getRawBrowserService: () => this.browserService,
      getCompassService: (folderKey) => this.startCompassFor(folderKey),
      onAssistantTextFinal: (text, panelId) => this.dispatchTtsForReply(text, panelId),
      platform: this.platform,
    });

    this.webviewPrompts = new WebviewPrompts(
      {
        target: (signal) => this.panelManager.promptTarget(signal),
        attachedView: (panelId, clientId) => this.panelManager.attachedView(panelId, clientId),
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
      restoreRetryChanged: (panelId) => this.panelManager.restoreRetryChanged(panelId),
      webviewPrompts: this.webviewPrompts,
      withViewGate: (host, joining, run) => this.panelManager.withViewGate(host, joining, run),
      worktrees: () => this.panelManager.worktrees,
      broadcastAccountState: (what, row, read) => this.broadcastAccountState(what, row, read),
    });

    this.panelManager = new PanelManager({
      platform: this.platform,
      languagePreference: (clientId) => this.messageRouter.languagePreference(clientId),
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
      handleWebviewMessage: (message, panelId, view, viewKey) =>
        this.messageRouter.handleWebviewMessage(message, panelId, view, viewKey),
      joinView: (panelId, gate, host) => this.messageRouter.joinView(panelId, gate, host),
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
        this.settingsManager.sendToolStatus(instance.session, instance.host);
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
      storedSessionsOf: (projectKey) => this.storageManager.sessionsOf(projectKey),
      completeStoredSessionsOf: (projectKey) => this.storageManager.completeSessionsOf(projectKey),
    });
    // A chat created, deleted or handed off changes how many chats share a worktree, and which deleted records any chat uses.
    if (worktreeHost) this.subscriptions.push(this.storageManager.onDidChangeSessions(() => void this.panelManager.worktrees.storedSessionsChanged()));

    this.subscriptions.push(this.panelManager.onDidChangeAttachment((panelId) => this.webviewPrompts.resurface(panelId)));

    // A removed folder's resources are released by `releaseFolder`, once no session runs there.
    this.subscriptions.push(this.folderRegistry.onDidChange(({ added, removed, relabelled }) => {
      this.refreshCompassViews();
      if (added.length === 0 && removed.length === 0 && !relabelled) return;
      this.memoryService.setWorkspaceRoots(this.folderRegistry.targets().map((t) => t.fsPath));
      this.storageManager.reloadFolders().catch((err) => log("[ChatPanelProvider] Failed to re-list sessions: %O", err));
    }));

    void this.storageManager.setupSessionWatcher();
    // A new, deleted or adopted worktree changes which session dirs a project lists (AD12 Listing).
    if (worktreeHost) {
      const registry = worktreeHost.registry;
      this.subscriptions.push(onListingChange(registry, () => {
        this.storageManager.reloadFolders().catch((err) => log("[ChatPanelProvider] Failed to re-list sessions after a worktree change: %O", err));
      }));
      const announceUnreadable = (error: string): void => {
        platform.notifications
          .warn(l("Damocles can't read {0}, so worktree chats can't be created, moved or finished until it is fixed: {1}", registry.file, error))
          .catch((err: unknown) => log("[ChatPanelProvider] Could not show the registry notice: %O", err));
      };
      this.subscriptions.push(registry.onDidBecomeUnreadable(announceUnreadable));
      const unreadable = registry.unreadable();
      if (unreadable !== undefined) announceUnreadable(unreadable);
    }

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
    // A working folder's MCP state and watchers exist exactly while a loaded chat holds it.
    this.subscriptions.push(this.folderRegistry.onDidChangeOwned(() => {
      this.settingsManager.handleMcpFoldersChanged().catch((err) => log("[ChatPanelProvider] MCP reload after a working folder change failed:", err));
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

    this.settingsManager.onDefaultModelChanged((change) => {
      for (const [panelId, instance] of this.panelManager.getPanels()) {
        const target = hostForChange(instance.host, change);
        this.settingsManager.sendModelForPanel(target, panelId);
        this.settingsManager.sendThinkingForPanel(target, panelId, instance.folder);
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

  /** clientId: on a daemon's core, the one device whose views alone need it. */
  private broadcastMemoryJudge(clientId?: string): void {
    void this.broadcastAccountState("the memory judge status", "memoryJudge", () => memoryJudgeStatus(this.platform), clientId);
  }

  /**
   * An account input changed outside a flow of this process: posts the Claude and OpenAI rows, which no key sync posts, and
   * what the runtime did not publish for the change. `keySync`: its key sync publishes the judge status, every key provider's
   * row and the account state of started sessions and every other panel; `judge`: it told the judge status alone.
   */
  private accountInputsChanged(runtimePublished: "nothing" | "judge" | "keySync"): void {
    void this.broadcastAccountState("the Claude auth mode", undefined, async () => ({ type: "claudeAuthStatusChanged", mode: PiRuntime.claudeAuthStatus(this.platform.remote).mode }));
    void this.broadcastAccountState("the OpenAI auth status", "openai", () => openaiAuthStatusMessage(this.platform));
    if (runtimePublished === "keySync") return;
    for (const provider of ACCOUNT_PROVIDER_IDS) this.broadcastProviderAuthStatus(provider);
    const getPanels = () => this.panelManager.getPanels();
    if (runtimePublished === "judge") publishPanelsAccountInfo(getPanels);
    else republishAccountInfo(getPanels);
  }

  private broadcastProviderAuthStatus(provider: AccountProviderId): void {
    void this.broadcastAccountState(`the ${provider} key status`, `provider:${provider}`, () => providerAuthStatus(this.platform, provider));
  }

  /**
   * Posts state read from the account to every panel; on a daemon's core each device's views get it read as that device's
   * client (`forEachDevice`), and with `clientId` only that device's views do. Reads overlap, so with a `row` only a
   * device's newest read of it posts; an older one may have read state the newer one replaced. Undefined from `read` posts nothing.
   * Settles once every post was made or skipped; never rejects.
   */
  private broadcastAccountState(what: string, row: string | undefined, read: () => Promise<ExtensionToWebviewMessage | undefined>, clientId?: string): Promise<void> {
    // one read number per device for this broadcast, which every panel that device shows shares
    const reads = new Map<string, number>();
    const newest = (device: string | undefined): (() => boolean) => {
      if (row === undefined) return () => true;
      const key = `${row}\n${device ?? ""}`;
      const number = reads.get(key) ?? (this.accountReads.get(key) ?? 0) + 1;
      this.accountReads.set(key, number);
      reads.set(key, number);
      return () => this.accountReads.get(key) === number;
    };
    const send = (isNewest: () => boolean, post: (message: ExtensionToWebviewMessage) => void): Promise<void> =>
      read()
        .then((message) => {
          if (message && isNewest()) post(message);
        })
        .catch((err: unknown) => log("[ChatPanelProvider] reading %s failed: %s", what, err instanceof Error ? err.message : String(err)));
    const remote = this.platform.remote;
    if (!remote) return send(newest(undefined), (message) => this.panelManager.broadcast(message));
    const sends = [...this.panelManager.getPanels().values()].flatMap((instance) => {
      const host = clientId === undefined ? instance.host : deviceHost(instance.host, clientId);
      return forEachDevice(remote, host, (target) => send(newest(target.clientId), (message) => this.panelManager.postMessage(target, message)));
    });
    return Promise.all(sends).then(() => undefined);
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

  private dispatchTtsForReply(text: string, panelId: string): void {
    // A host without voice (desktop macOS) hides its settings, so a hand-set tts.enabled has nothing to speak with.
    if (!this.platform.capabilities.voice || !this.platform.settings.get<boolean>("damocles.voice.tts.enabled", false)) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // a daemon's core has no voice of its own: the client showing the chat speaks it, with its own consent
    const remote = this.platform.remote;
    if (remote) {
      const host = this.panelManager.getPanels().get(panelId)?.host;
      if (host) remote.speak(host, trimmed).catch((err) => log("[ChatPanelProvider] relaying a reply to speak failed:", err));
      return;
    }
    this.voiceService.speakReply(trimmed, panelId).catch((err) => log("[ChatPanelProvider] tts dispatch failed:", err));
  }

  /** This computer's core speaks a remote chat's reply (`user.voice.speak`), under this computer's voice settings and consent. */
  async speakForeign(viewId: string, text: string): Promise<void> {
    if (!this.platform.capabilities.voice || !this.platform.settings.get<boolean>("damocles.voice.tts.enabled", false)) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    await this.voiceService.speakReply(trimmed, viewId);
  }

  /** A remote chat view's voice message, run on this computer's voice service with replies posted to its foreign proxy. */
  dispatchForeign(host: PanelHost, message: WebviewToExtensionMessage): Promise<void> {
    return this.messageRouter.dispatchForeign(host, message);
  }

  private noticeReplyNotSpoken(reason: LocalizedText, panelId: string): void {
    // A failure with detail lines (a pip, import-check or install-instructions failure) runs to 30 lines; Settings > Voice shows them all.
    this.platform.notifications
      .warn(l("A reply could not be spoken: {0}", headlineOf(reason)), [l("Voice settings")])
      .then((choice) => {
        if (choice !== 0) return;
        const host = this.panelManager.getPanels().get(panelId)?.host ?? this.panelManager.activePanelHost();
        openAppSettingsFor(this.platform, (target, message) => this.panelManager.postMessage(target, message), host, "voice");
      })
      .catch((err: unknown) => log("[ChatPanelProvider] Could not show the reply-not-spoken notice:", err));
  }

  async show(): Promise<void> {
    await this.panelManager.show();
  }

  async restorePanel(host: PanelHost, workspaceFolderKey: string | undefined, permissions?: ChatPermissions): Promise<void> {
    await this.panelManager.restorePanel(host, workspaceFolderKey, permissions);
  }

  /** A new chat on `host` working in the live chat worktree `worktreeId` of project `projectKey`; rejects when refused. */
  startInWorktree(host: PanelHost, projectKey: string, worktreeId: string): Promise<string> {
    return this.panelManager.startInWorktree(host, projectKey, worktreeId);
  }

  /** A remote chat's session mirror copy on host, read-only: replayed on each ready, nothing written (transcript-view.ts). */
  openTranscript(host: PanelHost, filePath: string, sessionId: string): void {
    openTranscriptView(host, {
      file: filePath,
      capabilities: this.platform.capabilities,
      locale: () => this.messageRouter.languagePreference(),
      replay: (post, signal) => this.historyManager.replayTranscript(filePath, sessionId, post, signal),
    });
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
   * every panel's session is disposed, which releases its session lease, the memory database has
   * flushed its queued writes and closed, and the session metadata worker has committed and closed (at most
   * 2 s). Callers must await it. The synchronous disposals still run first and unconditionally.
   */
  async dispose(): Promise<void> {
    this.compassViews.dispose();
    this.compassRegistry.dispose().catch((err: unknown) => log("[ChatPanelProvider] compass dispose error: %O", err));
    const memoryClosed = this.memoryService.dispose();
    const browserClosed = this.browserService.dispose().catch((err: unknown) => log('[ChatPanelProvider] browser dispose error: %O', err));
    const storageClosed = this.storageManager.dispose();
    this.workspaceManager.dispose();
    this.settingsManager.dispose();
    this.voiceService.dispose();
    this.usageStatsService.dispose();
    // Before the panels close, so each prompt is withdrawn from a webview that can still receive it.
    this.webviewPrompts.dispose();
    const sessionsDisposed = this.panelManager.dispose();
    this.folderRegistry.dispose();
    await Promise.all([browserClosed, sessionsDisposed, memoryClosed, storageClosed]);
  }
}
