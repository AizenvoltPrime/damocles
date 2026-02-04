import * as vscode from "vscode";
import { ClaudeSession } from "../claude-session";
import { PermissionHandler } from "../permission-handler";
import { ensureSessionDir } from "../session";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { McpServerConfig } from "../../shared/types/mcp";
import type { PluginConfig } from "../../shared/types/plugins";
import type { MemoryService } from "../memory";

export interface SessionManagerConfig {
  workspacePath: string;
  getEnabledMcpServers: () => Record<string, McpServerConfig>;
  getMcpConfigLoaded: () => boolean;
  loadMcpConfig: () => Promise<void>;
  getEnabledPlugins: () => PluginConfig[];
  getPluginConfigLoaded: () => boolean;
  loadPluginConfig: () => Promise<void>;
  getActiveProviderEnvForPanel: (panelId: string) => Record<string, string> | undefined;
  postMessage: (panel: vscode.WebviewPanel, message: ExtensionToWebviewMessage) => void;
  setupSessionWatcher: () => void;
  addOrUpdateSession: (sessionId: string) => Promise<void>;
  getMemoryService: () => MemoryService | null;
}

export class SessionManager {
  private readonly workspacePath: string;
  private readonly getEnabledMcpServers: SessionManagerConfig["getEnabledMcpServers"];
  private readonly getMcpConfigLoaded: SessionManagerConfig["getMcpConfigLoaded"];
  private readonly loadMcpConfig: SessionManagerConfig["loadMcpConfig"];
  private readonly getEnabledPlugins: SessionManagerConfig["getEnabledPlugins"];
  private readonly getPluginConfigLoaded: SessionManagerConfig["getPluginConfigLoaded"];
  private readonly loadPluginConfig: SessionManagerConfig["loadPluginConfig"];
  private readonly getActiveProviderEnvForPanel: SessionManagerConfig["getActiveProviderEnvForPanel"];
  private readonly postMessage: SessionManagerConfig["postMessage"];
  private readonly setupSessionWatcher: SessionManagerConfig["setupSessionWatcher"];
  private readonly addOrUpdateSession: SessionManagerConfig["addOrUpdateSession"];
  private readonly getMemoryService: SessionManagerConfig["getMemoryService"];

  constructor(config: SessionManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.getEnabledMcpServers = config.getEnabledMcpServers;
    this.getMcpConfigLoaded = config.getMcpConfigLoaded;
    this.loadMcpConfig = config.loadMcpConfig;
    this.getEnabledPlugins = config.getEnabledPlugins;
    this.getPluginConfigLoaded = config.getPluginConfigLoaded;
    this.loadPluginConfig = config.loadPluginConfig;
    this.getActiveProviderEnvForPanel = config.getActiveProviderEnvForPanel;
    this.postMessage = config.postMessage;
    this.setupSessionWatcher = config.setupSessionWatcher;
    this.addOrUpdateSession = config.addOrUpdateSession;
    this.getMemoryService = config.getMemoryService;
  }

  async createSessionForPanel(
    panel: vscode.WebviewPanel,
    permissionHandler: PermissionHandler,
    panelId: string
  ): Promise<ClaudeSession> {
    if (!this.getMcpConfigLoaded()) {
      await this.loadMcpConfig();
    }
    if (!this.getPluginConfigLoaded()) {
      await this.loadPluginConfig();
    }

    await ensureSessionDir(this.workspacePath);

    const providerEnv = this.getActiveProviderEnvForPanel(panelId);
    const memoryService = this.getMemoryService();
    const mcpServers = this.getEnabledMcpServers();

    const session = new ClaudeSession({
      cwd: this.workspacePath,
      permissionHandler: permissionHandler,
      onMessage: (message) => this.postMessage(panel, message),
      onSessionIdChange: (sessionId) => {
        this.postMessage(panel, { type: "sessionStarted", sessionId: sessionId || "" });
        this.setupSessionWatcher();
        if (sessionId) {
          void this.addOrUpdateSession(sessionId);
          const ms = this.getMemoryService();
          if (ms?.isEnabled) ms.migrateSessionId(panelId, sessionId);
        }
      },
      mcpServers,
      plugins: this.getEnabledPlugins(),
      ...(providerEnv !== undefined ? { providerEnv } : {}),
      ...(memoryService?.isEnabled ? { memoryService } : {}),
      panelId,
    });

    return session;
  }
}
