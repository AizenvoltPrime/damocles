import { ClaudeSession } from "../claude-session";
import { PermissionHandler } from "../permission-handler";
import { ensureSessionDir } from "../session";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { McpServerConfig } from "../../shared/types/mcp";
import type { PluginConfig } from "../../shared/types/plugins";
import type { MemoryService } from "../memory";
import type { BrowserService } from "../browser";
import type { WebviewHost } from "./types";
import { RecallService } from "../recall";
import type { RecallConfig } from "../recall/types";

export interface SessionManagerConfig {
  workspacePath: string;
  getEnabledMcpServers: () => Record<string, McpServerConfig>;
  getMcpConfigLoaded: () => boolean;
  loadMcpConfig: () => Promise<void>;
  getEnabledPlugins: () => PluginConfig[];
  getPluginConfigLoaded: () => boolean;
  loadPluginConfig: () => Promise<void>;
  getActiveProviderEnvForPanel: (panelId: string) => Record<string, string> | undefined;
  getActiveModelForPanel: (panelId: string) => string;
  getActiveBetasForPanel: (panelId: string) => string[];
  buildRecallConfig: (panelId: string) => RecallConfig;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
  setupSessionWatcher: () => Promise<void>;
  addOrUpdateSession: (sessionId: string) => Promise<void>;
  getMemoryService: () => MemoryService | null;
  getBrowserService: () => BrowserService | null;
  getChromeEnabled: () => boolean;
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
  private readonly getActiveModelForPanel: SessionManagerConfig["getActiveModelForPanel"];
  private readonly getActiveBetasForPanel: SessionManagerConfig["getActiveBetasForPanel"];
  private readonly buildRecallConfig: SessionManagerConfig["buildRecallConfig"];
  private readonly postMessage: SessionManagerConfig["postMessage"];
  private readonly setupSessionWatcher: SessionManagerConfig["setupSessionWatcher"];
  private readonly addOrUpdateSession: SessionManagerConfig["addOrUpdateSession"];
  private readonly getMemoryService: SessionManagerConfig["getMemoryService"];
  private readonly getBrowserService: SessionManagerConfig["getBrowserService"];
  private readonly getChromeEnabled: SessionManagerConfig["getChromeEnabled"];

  constructor(config: SessionManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.getEnabledMcpServers = config.getEnabledMcpServers;
    this.getMcpConfigLoaded = config.getMcpConfigLoaded;
    this.loadMcpConfig = config.loadMcpConfig;
    this.getEnabledPlugins = config.getEnabledPlugins;
    this.getPluginConfigLoaded = config.getPluginConfigLoaded;
    this.loadPluginConfig = config.loadPluginConfig;
    this.getActiveProviderEnvForPanel = config.getActiveProviderEnvForPanel;
    this.getActiveModelForPanel = config.getActiveModelForPanel;
    this.getActiveBetasForPanel = config.getActiveBetasForPanel;
    this.buildRecallConfig = config.buildRecallConfig;
    this.postMessage = config.postMessage;
    this.setupSessionWatcher = config.setupSessionWatcher;
    this.addOrUpdateSession = config.addOrUpdateSession;
    this.getMemoryService = config.getMemoryService;
    this.getBrowserService = config.getBrowserService;
    this.getChromeEnabled = config.getChromeEnabled;
  }

  async createSessionForPanel(
    host: WebviewHost,
    permissionHandler: PermissionHandler,
    panelId: string
  ): Promise<ClaudeSession> {
    await Promise.all([
      this.getMcpConfigLoaded() ? undefined : this.loadMcpConfig(),
      this.getPluginConfigLoaded() ? undefined : this.loadPluginConfig(),
      ensureSessionDir(this.workspacePath),
    ]);

    const providerEnv = this.getActiveProviderEnvForPanel(panelId);
    const activeModel = this.getActiveModelForPanel(panelId);
    const activeBetas = this.getActiveBetasForPanel(panelId);
    const memoryService = this.getMemoryService();
    const browserService = this.getBrowserService();
    const mcpServers = this.getEnabledMcpServers();
    const recallConfig = this.buildRecallConfig(panelId);
    const recallService = new RecallService(this.workspacePath, recallConfig);

    const session = new ClaudeSession({
      cwd: this.workspacePath,
      permissionHandler: permissionHandler,
      onMessage: (message) => this.postMessage(host, message),
      onSessionIdChange: (sessionId) => {
        if (recallService.isEnabled) {
          const stableId = recallService.persistenceSessionId;
          if (stableId) {
            this.postMessage(host, { type: "sessionStarted", sessionId: stableId });
            void this.setupSessionWatcher();
            void this.addOrUpdateSession(stableId);
            const ms = this.getMemoryService();
            if (ms?.isEnabled) ms.migrateSessionId(panelId, stableId);
          }
        } else {
          this.postMessage(host, { type: "sessionStarted", sessionId: sessionId || "" });
          void this.setupSessionWatcher();
          if (sessionId) {
            void this.addOrUpdateSession(sessionId);
            const ms = this.getMemoryService();
            if (ms?.isEnabled) ms.migrateSessionId(panelId, sessionId);
          }
        }
      },
      onSessionPersisted: (sessionId) => {
        void this.setupSessionWatcher();
        void this.addOrUpdateSession(sessionId);
      },
      mcpServers,
      plugins: this.getEnabledPlugins(),
      ...(providerEnv !== undefined ? { providerEnv } : {}),
      model: activeModel,
      betas: activeBetas,
      ...(memoryService?.isEnabled ? { memoryService } : {}),
      ...(browserService ? { browserService } : {}),
      recallService,
      panelId,
      ...(this.getChromeEnabled() ? { chromeEnabled: true } : {}),
    });

    return session;
  }
}
