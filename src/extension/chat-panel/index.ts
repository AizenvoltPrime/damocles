import * as vscode from "vscode";
import { PanelManager } from "./panel-manager";
import { StorageManager } from "./storage-manager";
import { HistoryManager } from "./history-manager";
import { SettingsManager } from "./settings-manager";
import { WorkspaceManager } from "./workspace-manager";
import { SessionManager } from "./session-manager";
import { MessageRouter } from "./message-router/index";
import { PluginService } from "../PluginService";
import { MemoryService } from "../memory";
import type { WebviewHost } from "./types";
import { log } from "../logger";

export class ChatPanelProvider {
  private readonly panelManager: PanelManager;
  private readonly storageManager: StorageManager;
  private readonly historyManager: HistoryManager;
  private readonly settingsManager: SettingsManager;
  private readonly workspaceManager: WorkspaceManager;
  private readonly sessionManager: SessionManager;
  private readonly messageRouter: MessageRouter;
  private readonly pluginService: PluginService;
  private readonly memoryService: MemoryService;
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
    });

    this.storageManager = new StorageManager({
      workspacePath: this.workspacePath,
      postMessage,
      getPanels: () => this.panelManager.getPanels(),
    });

    this.historyManager = new HistoryManager({
      workspacePath: this.workspacePath,
      postMessage,
    });

    this.workspaceManager = new WorkspaceManager({
      workspacePath: this.workspacePath,
      postMessage,
      broadcastToAllPanels: (message) => this.panelManager.broadcast(message),
      getEnabledPluginIds: () => this.settingsManager.getEnabledPluginIds(),
    });

    this.pluginService = new PluginService(this.workspacePath);
    this.memoryService = new MemoryService();

    this.sessionManager = new SessionManager({
      workspacePath: this.workspacePath,
      getEnabledMcpServers: () => this.settingsManager.getEnabledMcpServers(),
      getMcpConfigLoaded: () => this.settingsManager.getMcpConfigLoaded(),
      loadMcpConfig: () => this.settingsManager.loadMcpConfig(),
      getEnabledPlugins: () => this.settingsManager.getEnabledPlugins(),
      getPluginConfigLoaded: () => this.settingsManager.getPluginConfigLoaded(),
      loadPluginConfig: () => this.settingsManager.loadPluginConfig(this.pluginService),
      getActiveProviderEnvForPanel: (panelId) => this.settingsManager.getActiveProviderEnvForPanel(panelId),
      getActiveModelForPanel: (panelId) => this.settingsManager.getActiveModelForPanel(panelId),
      getActiveBetasForPanel: (panelId) => this.settingsManager.getActiveBetasForPanel(panelId),
      getActiveStrategyForPanel: (panelId) => this.settingsManager.getActiveStrategyForPanel(panelId),
      postMessage,
      setupSessionWatcher: () => this.storageManager.setupSessionWatcher(),
      addOrUpdateSession: (sessionId) => this.storageManager.addOrUpdateSession(sessionId),
      getMemoryService: () => this.memoryService,
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
    });

    this.panelManager = new PanelManager({
      extensionUri: this.extensionUri,
      createSessionForPanel: (host, permissionHandler, panelId) =>
        this.sessionManager.createSessionForPanel(host, permissionHandler, panelId),
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
    });

    this.storageManager.setupSessionWatcher();

    this.settingsManager.setOnMcpConfigChange(() => {
      const servers = this.settingsManager.getMcpServersForUI();
      this.panelManager.broadcast({ type: "mcpConfigUpdate", servers });
    });
    this.settingsManager.setupMcpWatcher(this.workspacePath);

    this.pluginService.setOnCacheInvalidate(async () => {
      try {
        await this.settingsManager.loadPluginConfig(this.pluginService);
        const plugins = this.settingsManager.getPluginsForUI();
        this.panelManager.broadcast({ type: "pluginConfigUpdate", plugins });
      } catch (err) {
        log("[ChatPanelProvider] Error broadcasting plugin config:", err);
      }
    });

    this.settingsManager.loadMcpConfig().catch((err) => {
      log("[ChatPanelProvider] Error pre-loading MCP config:", err);
    });
    this.settingsManager.loadPluginConfig(this.pluginService).catch((err) => {
      log("[ChatPanelProvider] Error pre-loading plugin config:", err);
    });
    this.settingsManager.loadProviderProfiles().catch((err) => {
      log("[ChatPanelProvider] Error loading provider profiles:", err);
    });
  }

  getPanelManager(): PanelManager {
    return this.panelManager;
  }

  async show(): Promise<void> {
    await this.panelManager.show();
  }

  async restorePanel(panel: vscode.WebviewPanel): Promise<void> {
    await this.panelManager.restorePanel(panel);
  }

  newSession(): void {
    this.panelManager.newSession();
  }

  cancelSession(): void {
    this.panelManager.cancelSession();
  }

  dispose(): void {
    this.memoryService.dispose();
    this.storageManager.dispose();
    this.workspaceManager.dispose();
    this.pluginService.dispose();
    this.settingsManager.dispose();
    this.panelManager.dispose();
  }
}
