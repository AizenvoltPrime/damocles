import * as vscode from "vscode";
import { PanelManager } from "./panel-manager";
import { StorageManager } from "./storage-manager";
import { HistoryManager } from "./history-manager";
import { SettingsManager } from "./settings-manager";
import { WorkspaceManager } from "./workspace-manager";
import { SessionManager } from "./session-manager";
import { MessageRouter } from "./message-router/index";
import { MemoryService } from "../memory";
import { ExploreService } from "../explore";
import { BrowserService } from "../browser";
import { loadTeamFromHistory } from "../team/history";
import { CompassService } from "../compass";
import { VoiceService } from "../voice/service";
import { OPENAI_PREFER_API_KEY_STATE } from "../pi-session/openai-auth";
import type { WebviewHost } from "./types";
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
  private readonly memoryExploreService: ExploreService;
  private readonly browserService: BrowserService;
  private readonly compassService: CompassService | null;
  private readonly voiceService: VoiceService;
  private readonly workspacePath: string;

  private readonly extensionUri: vscode.Uri;
  private readonly context: vscode.ExtensionContext;

  constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this.extensionUri = extensionUri;
    this.context = context;
    const homeDir = process.env["HOME"] || process.env["USERPROFILE"] || "";
    this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homeDir;

    const postMessage = (host: WebviewHost, message: unknown) => {
      this.panelManager.postMessage(host, message as Parameters<typeof this.panelManager.postMessage>[1]);
    };

    this.settingsManager = new SettingsManager({
      postMessage,
      secrets: context.secrets,
      workspaceState: context.workspaceState,
    });

    this.storageManager = new StorageManager({
      workspacePath: this.workspacePath,
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
    });

    this.historyManager = new HistoryManager({
      workspacePath: this.workspacePath,
      postMessage,
      loadTeamData: async (teamId: string, sessionId: string) => {
        return loadTeamFromHistory(this.workspacePath, sessionId, teamId);
      },
    });

    this.workspaceManager = new WorkspaceManager({
      workspacePath: this.workspacePath,
      postMessage,
      broadcastToAllPanels: (message) => this.panelManager.broadcast(message),
    });

    this.memoryService = new MemoryService(extensionUri.fsPath);
    this.memoryService.setDefaultBridgeCtxProvider(() => null);
    this.memoryExploreService = new ExploreService({
      cwd: this.workspacePath,
      onMessage: () => {},
      getCompassMcpServer: () => null,
      getSessionId: () => null,
      secrets: context.secrets,
    });
    this.memoryService.setExploreConfigProvider(() => this.memoryExploreService.getProviderConfig());
    this.memoryService.setConsolidationBroadcast((msg) => this.panelManager.broadcast(msg));
    this.browserService = new BrowserService();
    this.voiceService = new VoiceService({ extensionRoot: extensionUri.fsPath });
    this.voiceService.registerWithExtension(context);
    const hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    if (hasWorkspaceFolder) {
      const damoclesDir = require('path').join(homeDir, '.damocles');
      this.compassService = new CompassService(this.workspacePath, damoclesDir, extensionUri.fsPath);
      this.compassService.onStatusChange((status) => {
        this.panelManager.broadcast({ type: 'compassStatusUpdate', status });
      });
      this.compassService.onProgress((event) => {
        this.panelManager.broadcast({
          type: 'compassBuildProgress',
          current: event.current,
          total: event.total,
          phase: event.phase,
          ...(event.label ? { label: event.label } : {}),
        });
      });
      this.compassService.registerViews(context);
    } else {
      this.compassService = null;
    }
    this.browserService.onElementPickedFromToolbar((element) => {
      const delivered = this.panelManager.postToActivePanel({ type: 'browserElementPicked', element });
      if (!delivered) {
        vscode.window.showWarningMessage("Damocles: No active chat panel — open a chat panel to receive picked elements.");
      }
    });

    this.sessionManager = new SessionManager({
      workspacePath: this.workspacePath,
      getEnabledMcpServers: () => this.settingsManager.getEnabledMcpServers(),
      getMcpConfigLoaded: () => this.settingsManager.getMcpConfigLoaded(),
      loadMcpConfig: () => this.settingsManager.loadMcpConfig(),
      getActiveProviderEnvForPanel: (panelId) => this.settingsManager.getActiveProviderEnvForPanel(panelId),
      getActiveModelForPanel: (panelId) => this.settingsManager.getActiveModelForPanel(panelId),
      getActiveBetasForPanel: (panelId) => this.settingsManager.getActiveBetasForPanel(panelId),
      getPreferOpenAIApiKey: () => this.context.workspaceState.get<boolean>(OPENAI_PREFER_API_KEY_STATE, false),
      resolveThinkingForPanel: (panelId, model) => {
        const config = vscode.workspace.getConfiguration("damocles");
        return {
          thinkingDisabled: this.settingsManager.resolveThinkingDisabled(panelId, config),
          effort: this.settingsManager.resolveThinkingEffort(panelId, model, config),
          maxThinkingTokens: this.settingsManager.resolveMaxThinkingTokens(panelId, model, config),
        };
      },
      buildRecallConfig: (panelId) => this.settingsManager.buildRecallConfig(panelId),
      postMessage,
      setupSessionWatcher: () => this.storageManager.setupSessionWatcher(),
      addOrUpdateSession: (sessionId) => this.storageManager.addOrUpdateSession(sessionId),
      getMemoryService: () => this.memoryService,
      getBrowserService: () => this.settingsManager.getBrowserEnabled() ? this.browserService : null,
      getRawBrowserService: () => this.browserService,
      getCompassService: () => this.compassService,
      onAssistantTextFinal: (text) => this.dispatchTtsForReply(text),
      secrets: this.context.secrets,
    });

    this.messageRouter = new MessageRouter({
      workspacePath: this.workspacePath,
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
      storageManager: this.storageManager,
      historyManager: this.historyManager,
      settingsManager: this.settingsManager,
      workspaceManager: this.workspaceManager,
      context: this.context,
      memoryService: this.memoryService,
      browserService: this.browserService,
      ...(this.compassService ? { compassService: this.compassService } : {}),
      voiceService: this.voiceService,
    });

    this.panelManager = new PanelManager({
      extensionUri: this.extensionUri,
      createSessionForPanel: async (host, permissionHandler, panelId, forkContext) => {
        const onSpawnFork = (args: import("../../shared/types/session").ForkSpawnArgs) =>
          this.panelManager.showForked(args).then(() => undefined);
        const session = await this.sessionManager.createSessionForPanel(
          host,
          permissionHandler,
          panelId,
          onSpawnFork,
          forkContext,
        );
        this.settingsManager.setFastModeGetter(() => session.fastMode);
        // Live MCP status: push fresh runtime status to this panel whenever a server connects/disconnects,
        // so the panel reflects connecting → connected automatically (no manual refresh).
        session.setMcpStatusListener(() => {
          void this.settingsManager.sendMcpStatus(session, host);
        });
        return session;
      },
      handleWebviewMessage: (message, panelId) =>
        this.messageRouter.handleWebviewMessage(message, panelId),
      sendCurrentSettings: (host, permissionHandler) =>
        this.settingsManager.sendCurrentSettings(host, permissionHandler),
      getStoredSessions: () => this.storageManager.getStoredSessions(),
      invalidateSessionsCache: () => this.storageManager.invalidateSessionsCache(),
      initPanelProfile: (panelId) => this.settingsManager.initPanelProfile(panelId),
      cleanupPanelProfile: (panelId) => this.settingsManager.cleanupPanelProfile(panelId),
      initPanelModel: (panelId) => this.settingsManager.initPanelModel(panelId),
      cleanupPanelModel: (panelId) => this.settingsManager.cleanupPanelModel(panelId),
      initPanelBetas: (panelId) => this.settingsManager.initPanelBetas(panelId),
      cleanupPanelBetas: (panelId) => this.settingsManager.cleanupPanelBetas(panelId),
      initPanelStrategy: (panelId) => this.settingsManager.initPanelStrategy(panelId),
      cleanupPanelStrategy: (panelId) => this.settingsManager.cleanupPanelStrategy(panelId),
      cleanupPanelThinking: (panelId) => this.settingsManager.cleanupPanelThinking(panelId),
      sendThinkingForPanel: (host, panelId) => this.settingsManager.sendThinkingForPanel(host, panelId),
      getInitialMessages: () => {
        const msgs: ExtensionToWebviewMessage[] = [];
        if (this.compassService?.isEnabled) {
          msgs.push({ type: 'compassStatusUpdate', status: this.compassService.getStatus() });
        }
        return msgs;
      },
      inheritSettingsFromPanel: (sourcePanelId, newPanelId) => {
        this.settingsManager.setActiveModelForPanel(newPanelId, this.settingsManager.getActiveModelForPanel(sourcePanelId));
        this.settingsManager.setActiveBetasForPanel(newPanelId, this.settingsManager.getActiveBetasForPanel(sourcePanelId));
        this.settingsManager.setActiveStrategyForPanel(newPanelId, this.settingsManager.getActiveStrategyForPanel(sourcePanelId));
        this.settingsManager.setActiveProviderProfileForPanel(newPanelId, this.settingsManager.getActiveProviderProfileForPanel(sourcePanelId));
        this.settingsManager.copyPanelThinkingStateTo(sourcePanelId, newPanelId);
      },
      loadHistoryUntil: (sessionId, host, untilUuid) =>
        this.historyManager.loadSessionHistoryUntil(sessionId, host, untilUuid),
      loadHistory: (sessionId, host) =>
        this.historyManager.loadSessionHistory(sessionId, host),
    });

    void this.storageManager.setupSessionWatcher();

    if (this.compassService?.isEnabled) {
      this.compassService.ensureInitialized().catch(err => {
        log('[ChatPanelProvider] Compass init failed: %O', err);
      });
    }

    this.settingsManager.setOnMcpConfigChange(() => {
      const servers = this.settingsManager.getMcpServersForUI();
      this.panelManager.broadcast({ type: "mcpConfigUpdate", servers });
      // Reconcile live MCP connections on a .mcp.json change — no session restart (US-014.9).
      const enabled = this.settingsManager.getEnabledMcpServers();
      for (const [, instance] of this.panelManager.getPanels()) {
        instance.session.setMcpServers(enabled);
      }
    });

    // Granting workspace trust unblocks workspace `.mcp.json` servers (M3): getEnabledMcpServers reads
    // `vscode.workspace.isTrusted` live, so re-feed the now-trusted set, connect them, and refresh status.
    this.context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.panelManager.broadcast({ type: "mcpConfigUpdate", servers: this.settingsManager.getMcpServersForUI() });
        const enabled = this.settingsManager.getEnabledMcpServers();
        for (const [, instance] of this.panelManager.getPanels()) {
          instance.session.setMcpServers(enabled);
          void this.settingsManager.sendMcpStatus(instance.session, instance.host);
        }
      }),
    );

    this.settingsManager.onDefaultModelChanged(() => {
      for (const [panelId, instance] of this.panelManager.getPanels()) {
        this.settingsManager.sendModelForPanel(instance.host, panelId);
        this.settingsManager.sendThinkingForPanel(instance.host, panelId);
      }
    });
    this.settingsManager.setupMcpWatcher(this.workspacePath);

    this.settingsManager.loadMcpConfig().catch((err) => {
      log("[ChatPanelProvider] Error pre-loading MCP config:", err);
    });
    this.settingsManager.loadBrowserState();
    this.settingsManager.loadProviderProfiles().catch((err) => {
      log("[ChatPanelProvider] Error loading provider profiles:", err);
    });
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

  async restorePanel(panel: vscode.WebviewPanel): Promise<void> {
    await this.panelManager.restorePanel(panel);
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

  dispose(): void {
    this.compassService?.dispose()?.catch?.((err: unknown) => log('[ChatPanelProvider] compass dispose error: %O', err));
    this.memoryService.dispose();
    this.memoryExploreService.dispose();
    this.browserService.dispose();
    this.storageManager.dispose();
    this.workspaceManager.dispose();
    this.settingsManager.dispose();
    this.voiceService.dispose();
    this.panelManager.dispose();
  }
}
