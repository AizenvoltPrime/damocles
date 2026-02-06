import { ClaudeSession } from "../claude-session";
import { PermissionHandler } from "../permission-handler";
import { ensureSessionDir, appendSessionTitle } from "../session";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { McpServerConfig } from "../../shared/types/mcp";
import type { PluginConfig } from "../../shared/types/plugins";
import type { MemoryService } from "../memory";
import type { WebviewHost } from "./types";
import { log } from "../logger";
import { ContextDistillationService } from "../context-distillation";
import { registerDistillSession } from "../context-distillation/registry";

export interface SessionManagerConfig {
  workspacePath: string;
  getEnabledMcpServers: () => Record<string, McpServerConfig>;
  getMcpConfigLoaded: () => boolean;
  loadMcpConfig: () => Promise<void>;
  getEnabledPlugins: () => PluginConfig[];
  getPluginConfigLoaded: () => boolean;
  loadPluginConfig: () => Promise<void>;
  getActiveProviderEnvForPanel: (panelId: string) => Record<string, string> | undefined;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
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
    host: WebviewHost,
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
    const contextDistillation = new ContextDistillationService(this.workspacePath);
    contextDistillation.onTitleGenerated = async (persistenceSessionId, title) => {
      try {
        await appendSessionTitle(this.workspacePath, persistenceSessionId, title);
      } catch (err) {
        log('[SessionManager] Auto-naming failed:', err);
      }
    };
    contextDistillation.onHaikuProcessingChange = (isProcessing) => {
      this.postMessage(host, { type: "haikuProcessing", isProcessing });
    };

    const session = new ClaudeSession({
      cwd: this.workspacePath,
      permissionHandler: permissionHandler,
      onMessage: (message) => this.postMessage(host, message),
      onSessionIdChange: (sessionId) => {
        if (contextDistillation.isEnabled) {
          const stableId = contextDistillation.persistenceSessionId;
          if (stableId) {
            this.postMessage(host, { type: "sessionStarted", sessionId: stableId });
            void registerDistillSession(stableId);
            this.setupSessionWatcher();
            void this.addOrUpdateSession(stableId);
            const ms = this.getMemoryService();
            if (ms?.isEnabled) ms.migrateSessionId(panelId, stableId);
          }
        } else {
          this.postMessage(host, { type: "sessionStarted", sessionId: sessionId || "" });
          this.setupSessionWatcher();
          if (sessionId) {
            void this.addOrUpdateSession(sessionId);
            const ms = this.getMemoryService();
            if (ms?.isEnabled) ms.migrateSessionId(panelId, sessionId);
          }
        }
      },
      onSessionPersisted: (sessionId) => {
        this.setupSessionWatcher();
        void this.addOrUpdateSession(sessionId);
      },
      mcpServers,
      plugins: this.getEnabledPlugins(),
      ...(providerEnv !== undefined ? { providerEnv } : {}),
      ...(memoryService?.isEnabled ? { memoryService } : {}),
      contextDistillation,
      panelId,
    });

    return session;
  }
}
