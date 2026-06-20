import * as vscode from "vscode";
import type { ChatSession } from "../chat-session";
import { PiSession } from "../pi-session/pi-session";
import { PermissionHandler } from "../permission-handler";
import { log } from "../logger";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { McpServerConfig } from "../../shared/types/mcp";
import type { MemoryService } from "../memory";
import type { BrowserService } from "../browser";
import { TeamService } from "../team";
import type { CompassService } from "../compass";
import type { WebviewHost } from "./types";
import type { ForkContext, ForkSpawnArgs } from "../../shared/types/session";
import type { EffortLevel } from "../../shared/types/settings";

export interface SessionManagerConfig {
  workspacePath: string;
  getEnabledMcpServers: () => Record<string, McpServerConfig>;
  getMcpConfigLoaded: () => boolean;
  loadMcpConfig: () => Promise<void>;
  getActiveModelForPanel: (panelId: string) => string;
  getPreferOpenAIApiKey: () => boolean;
  resolveThinkingForPanel: (panelId: string, model: string) => {
    thinkingDisabled: boolean;
    effort: EffortLevel | null;
    maxThinkingTokens: number | null;
  };
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
  setupSessionWatcher: () => Promise<void>;
  addOrUpdateSession: (sessionId: string) => Promise<void>;
  getMemoryService: () => MemoryService | null;
  /** The raw browser service, ungated by the enable flag. The pi path always holds it (enablement is
   * a live config read + active-set recompute), so its inert tools can be built once at session start. */
  getRawBrowserService: () => BrowserService;
  getCompassService: () => CompassService | null;
  onAssistantTextFinal?: (text: string) => void;
  secrets: vscode.SecretStorage;
}

export class SessionManager {
  private readonly workspacePath: string;
  private readonly getEnabledMcpServers: SessionManagerConfig["getEnabledMcpServers"];
  private readonly getMcpConfigLoaded: SessionManagerConfig["getMcpConfigLoaded"];
  private readonly loadMcpConfig: SessionManagerConfig["loadMcpConfig"];
  private readonly getActiveModelForPanel: SessionManagerConfig["getActiveModelForPanel"];
  private readonly getPreferOpenAIApiKey: SessionManagerConfig["getPreferOpenAIApiKey"];
  private readonly resolveThinkingForPanel: SessionManagerConfig["resolveThinkingForPanel"];
  private readonly postMessage: SessionManagerConfig["postMessage"];
  private readonly setupSessionWatcher: SessionManagerConfig["setupSessionWatcher"];
  private readonly addOrUpdateSession: SessionManagerConfig["addOrUpdateSession"];
  private readonly getMemoryService: SessionManagerConfig["getMemoryService"];
  private readonly getRawBrowserService: SessionManagerConfig["getRawBrowserService"];
  private readonly getCompassService: SessionManagerConfig["getCompassService"];
  private readonly onAssistantTextFinal: SessionManagerConfig["onAssistantTextFinal"];
  private readonly secrets: vscode.SecretStorage;

  constructor(config: SessionManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.getEnabledMcpServers = config.getEnabledMcpServers;
    this.getMcpConfigLoaded = config.getMcpConfigLoaded;
    this.loadMcpConfig = config.loadMcpConfig;
    this.getActiveModelForPanel = config.getActiveModelForPanel;
    this.getPreferOpenAIApiKey = config.getPreferOpenAIApiKey;
    this.resolveThinkingForPanel = config.resolveThinkingForPanel;
    this.postMessage = config.postMessage;
    this.setupSessionWatcher = config.setupSessionWatcher;
    this.addOrUpdateSession = config.addOrUpdateSession;
    this.getMemoryService = config.getMemoryService;
    this.getRawBrowserService = config.getRawBrowserService;
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
    if (!this.getMcpConfigLoaded()) await this.loadMcpConfig();

    const activeModel = this.getActiveModelForPanel(panelId);

    const piMemoryService = this.getMemoryService();
    const piCompassService = this.getCompassService();
    // The pi path always holds the (inert) browser service so its tools can be built once at session
    // start; browser availability is a live `damocles.browser.enabled` read + active-set recompute.
    const piBrowserService = this.getRawBrowserService();

    // Team service (US-024d): constructed here, handed to PiSession via SessionOptions.teamService.
    // Its deps reference the about-to-be-created PiSession lazily (resolved at call time) — the pi
    // engine + model resolvers live on PiSession (which owns the registry/auth/tools/gate).
    // eslint-disable-next-line prefer-const -- forward reference: the teamService deps closures capture piSession before it's assigned.
    let piSession: PiSession | undefined;
    const teamService = new TeamService({
      cwd: this.workspacePath,
      onMessage: (message) => this.postMessage(host, message),
      getSessionId: () => piSession?.memorySessionId ?? null,
      getPermissionMode: () => permissionHandler.getPermissionMode(),
      resolveLeadModel: () => piSession!.resolveTeamLead(),
      resolveSpecialistModel: (value) => piSession!.resolveTeamSpecialist(value),
      allowedSpecialistModels: () => piSession!.teamAllowedSpecialistModels(),
      buildEngine: () => piSession!.buildTeamEngine(),
    });

    piSession = new PiSession({
      cwd: this.workspacePath,
      permissionHandler,
      onMessage: (message) => this.postMessage(host, message),
      onSessionIdChange: (sessionId) => {
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
            })().catch(err => log("[SessionManager] pi consolidateSession failed: %O", err));
          }
        }
      },
      // Refresh the picker/header when session metadata changes out-of-band (e.g. the auto AI title
      // — US-012), without re-posting sessionStarted or re-running memory consolidation. The watcher
      // is already set up by onSessionIdChange at session start, so it isn't re-established here.
      onSessionPersisted: (sessionId) => {
        void this.addOrUpdateSession(sessionId);
      },
      model: activeModel,
      panelId,
      // Feed the persisted enabled MCP servers so they connect at session start; the process-scoped
      // client reconciles idempotently, so a second panel re-feeding the same set is a no-op (NOT an
      // empty set, which would close servers already connected by another panel — stuck "Connecting").
      mcpServers: this.getEnabledMcpServers(),
      resolveThinking: (model) => this.resolveThinkingForPanel(panelId, model),
      getPreferOpenAIApiKey: this.getPreferOpenAIApiKey,
      secrets: this.secrets,
      ...(piMemoryService ? { memoryService: piMemoryService } : {}),
      ...(piCompassService ? { compassService: piCompassService } : {}),
      browserService: piBrowserService,
      teamService,
      ...(onSpawnFork !== undefined ? { onSpawnFork } : {}),
      ...(forkContext !== undefined ? { forkContext } : {}),
      ...(this.onAssistantTextFinal !== undefined ? { onAssistantTextFinal: this.onAssistantTextFinal } : {}),
    });
    return piSession;
  }
}
