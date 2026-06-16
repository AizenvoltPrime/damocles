import * as vscode from "vscode";
import { ClaudeSession } from "../claude-session";
import type { ChatSession } from "../claude-session";
import { PiSession } from "../pi-session/pi-session";
import { getEffectiveHarness } from "../pi-session/harness";
import { PermissionHandler } from "../permission-handler";
import { ensureSessionDir } from "../session";
import { log } from "../logger";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { McpServerConfig } from "../../shared/types/mcp";
import type { PluginConfig } from "../../shared/types/plugins";
import type { MemoryService } from "../memory";
import type { BrowserService } from "../browser";
import { TeamService } from "../team";
import type { CompassService } from "../compass";
import { COMPASS_AGENT_PROMPT } from "../compass/system-prompt";
import type { WebviewHost } from "./types";
import { RecallService } from "../recall";
import type { RecallConfig } from "../recall/types";
import type { ForkContext, ForkSpawnArgs } from "../../shared/types/session";
import type { EffortLevel } from "../../shared/types/settings";

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
  getPreferOpenAIApiKey: () => boolean;
  resolveThinkingForPanel: (panelId: string, model: string) => {
    thinkingDisabled: boolean;
    effort: EffortLevel | null;
    maxThinkingTokens: number | null;
  };
  buildRecallConfig: (panelId: string) => RecallConfig;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
  setupSessionWatcher: () => Promise<void>;
  addOrUpdateSession: (sessionId: string) => Promise<void>;
  getMemoryService: () => MemoryService | null;
  getBrowserService: () => BrowserService | null;
  getChromeEnabled: () => boolean;
  getCompassService: () => CompassService | null;
  onAssistantTextFinal?: (text: string) => void;
  secrets: vscode.SecretStorage;
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
  private readonly getPreferOpenAIApiKey: SessionManagerConfig["getPreferOpenAIApiKey"];
  private readonly resolveThinkingForPanel: SessionManagerConfig["resolveThinkingForPanel"];
  private readonly buildRecallConfig: SessionManagerConfig["buildRecallConfig"];
  private readonly postMessage: SessionManagerConfig["postMessage"];
  private readonly setupSessionWatcher: SessionManagerConfig["setupSessionWatcher"];
  private readonly addOrUpdateSession: SessionManagerConfig["addOrUpdateSession"];
  private readonly getMemoryService: SessionManagerConfig["getMemoryService"];
  private readonly getBrowserService: SessionManagerConfig["getBrowserService"];
  private readonly getChromeEnabled: SessionManagerConfig["getChromeEnabled"];
  private readonly getCompassService: SessionManagerConfig["getCompassService"];
  private readonly onAssistantTextFinal: SessionManagerConfig["onAssistantTextFinal"];
  private readonly secrets: vscode.SecretStorage;

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
    this.getPreferOpenAIApiKey = config.getPreferOpenAIApiKey;
    this.resolveThinkingForPanel = config.resolveThinkingForPanel;
    this.buildRecallConfig = config.buildRecallConfig;
    this.postMessage = config.postMessage;
    this.setupSessionWatcher = config.setupSessionWatcher;
    this.addOrUpdateSession = config.addOrUpdateSession;
    this.getMemoryService = config.getMemoryService;
    this.getBrowserService = config.getBrowserService;
    this.getChromeEnabled = config.getChromeEnabled;
    this.getCompassService = config.getCompassService;
    this.onAssistantTextFinal = config.onAssistantTextFinal;
    this.secrets = config.secrets;
  }

  async createSessionForPanel(
    host: WebviewHost,
    permissionHandler: PermissionHandler,
    panelId: string,
    onSpawnFork?: (args: ForkSpawnArgs) => Promise<void>,
    forkContext?: ForkContext,
  ): Promise<ChatSession> {
    await Promise.all([
      this.getMcpConfigLoaded() ? undefined : this.loadMcpConfig(),
      this.getPluginConfigLoaded() ? undefined : this.loadPluginConfig(),
      ensureSessionDir(this.workspacePath),
    ]);

    const activeModel = this.getActiveModelForPanel(panelId);

    if (getEffectiveHarness() === "pi") {
      return new PiSession({
        cwd: this.workspacePath,
        permissionHandler,
        onMessage: (message) => this.postMessage(host, message),
        onSessionIdChange: (sessionId) => {
          // Memory/recall consolidation moves to pi in a later phase — emit the session + watcher only.
          this.postMessage(host, { type: "sessionStarted", sessionId: sessionId || "" });
          void this.setupSessionWatcher();
          if (sessionId) void this.addOrUpdateSession(sessionId);
        },
        model: activeModel,
        panelId,
        resolveThinking: (model) => this.resolveThinkingForPanel(panelId, model),
        getPreferOpenAIApiKey: this.getPreferOpenAIApiKey,
        secrets: this.secrets,
        ...(onSpawnFork !== undefined ? { onSpawnFork } : {}),
        ...(forkContext !== undefined ? { forkContext } : {}),
        ...(this.onAssistantTextFinal !== undefined ? { onAssistantTextFinal: this.onAssistantTextFinal } : {}),
      });
    }

    const providerEnv = this.getActiveProviderEnvForPanel(panelId);
    const activeBetas = this.getActiveBetasForPanel(panelId);
    const memoryService = this.getMemoryService();
    const browserService = this.getBrowserService();
    const mcpServers = this.getEnabledMcpServers();
    const recallConfig = this.buildRecallConfig(panelId);
    const recallService = new RecallService(this.workspacePath, recallConfig);

    let session: ChatSession | undefined;

    const compassService = this.getCompassService();

    const teamService = new TeamService({
      cwd: this.workspacePath,
      onMessage: (message) => this.postMessage(host, message),
      getSessionId: () => session?.memorySessionId ?? null,
      getModel: () => this.getActiveModelForPanel(panelId),
      getPermissionMode: () => permissionHandler.getPermissionMode(),
      getCompassContext: () => {
        if (!compassService?.isEnabled) return null;
        const mcp = compassService.getMcpServerConfig(
          () => session?.memorySessionId ?? '',
          this.workspacePath,
        );
        return mcp ? { mcpServer: mcp, promptSuffix: COMPASS_AGENT_PROMPT } : null;
      },
      getModelInfo: (modelValue: string) => session?.getModelInfo(modelValue),
    });

    session = new ClaudeSession({
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
            if (ms?.isEnabled) {
              void (async () => {
                await ms.ensureInitialized();
                ms.migrateSessionId(panelId, stableId);
                await ms.consolidateSession(stableId);
              })().catch(err => log("[SessionManager] consolidateSession failed: %O", err));
            }
          }
        } else {
          this.postMessage(host, { type: "sessionStarted", sessionId: sessionId || "" });
          void this.setupSessionWatcher();
          if (sessionId) {
            void this.addOrUpdateSession(sessionId);
            const ms = this.getMemoryService();
            if (ms?.isEnabled) {
              void (async () => {
                await ms.ensureInitialized();
                ms.migrateSessionId(panelId, sessionId);
                await ms.consolidateSession(sessionId);
              })().catch(err => log("[SessionManager] consolidateSession failed: %O", err));
            }
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
      ...(memoryService ? { memoryService } : {}),
      ...(browserService ? { browserService } : {}),
      recallService,
      panelId,
      ...(this.getChromeEnabled() ? { chromeEnabled: true } : {}),
      teamService,
      ...(compassService ? { compassService } : {}),
      ...(this.onAssistantTextFinal !== undefined ? { onAssistantTextFinal: this.onAssistantTextFinal } : {}),
      ...(onSpawnFork !== undefined ? { onSpawnFork } : {}),
      ...(forkContext !== undefined ? { forkContext } : {}),
      resolveThinking: (model) => this.resolveThinkingForPanel(panelId, model),
      secrets: this.secrets,
    });

    return session;
  }
}
