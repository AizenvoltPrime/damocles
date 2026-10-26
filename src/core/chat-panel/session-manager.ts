import type { PlatformWithWorktrees } from "../worktrees/host";
import type { ChatSession } from "../chat-session";
import { PiSession } from "../pi-session/pi-session";
import { PermissionHandler } from "../permission-handler";
import { log } from "../logger";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { McpScope } from "../session-types";
import type { MemoryService } from "../memory";
import type { BrowserService } from "../browser";
import { TeamService } from "../team";
import type { CompassService } from "../compass";
import type { PanelHost } from "../../platform/window-service";
import { settingsFolderOf, type FolderTarget } from "../workspace-folders/folder-registry";
import type { SettingsFolder } from "../../platform/settings-store";
import type { ForkContext, ForkSpawnArgs } from "../../shared/types/session";
import type { EffortLevel } from "../../shared/types/settings";

export interface SessionManagerConfig {
  getEnabledMcpServers: (folderKey: string) => McpScope;
  getMcpConfigLoaded: () => boolean;
  loadMcpConfig: () => Promise<void>;
  /** Undefined while the panel holds no model and `damocles.model` is unset, so the session may fall back to a signed-in one. */
  getConfiguredModelForPanel: (panelId: string) => string | undefined;
  getPreferOpenAIApiKey: () => boolean;
  resolveThinkingForPanel: (panelId: string, model: string, folder: SettingsFolder | undefined) => {
    thinkingDisabled: boolean;
    effort: EffortLevel | null;
  };
  /** A resumed conversation's recorded pi thinking level for its recorded model, which becomes the panel's. */
  restoreRecordedSelection: (panelId: string, model: string, thinkingLevel: string | undefined) => void;
  /** The model the panel's session shows, which becomes the panel's once the session committed it. */
  adoptSessionModel: (host: PanelHost, panelId: string, folder: FolderTarget, model: string, contextWindow: number, committed: boolean) => void;
  postMessage: (host: PanelHost, message: ExtensionToWebviewMessage) => void;
  setupSessionWatcher: (folderKey: string) => Promise<void>;
  addOrUpdateSession: (sessionId: string, folderKey: string) => Promise<void>;
  getMemoryService: () => MemoryService | null;
  /** The raw browser service, ungated by the enable flag, so its inert tools can be built once at session start. */
  getRawBrowserService: () => BrowserService;
  /** The folder's Compass service, or null for a folder with no project index. */
  getCompassService: (folderKey: string) => CompassService | null;
  onAssistantTextFinal?: (text: string, panelId: string) => void;
  platform: PlatformWithWorktrees;
}

export class SessionManager {
  private readonly getEnabledMcpServers: SessionManagerConfig["getEnabledMcpServers"];
  private readonly getMcpConfigLoaded: SessionManagerConfig["getMcpConfigLoaded"];
  private readonly loadMcpConfig: SessionManagerConfig["loadMcpConfig"];
  private readonly getConfiguredModelForPanel: SessionManagerConfig["getConfiguredModelForPanel"];
  private readonly getPreferOpenAIApiKey: SessionManagerConfig["getPreferOpenAIApiKey"];
  private readonly resolveThinkingForPanel: SessionManagerConfig["resolveThinkingForPanel"];
  private readonly restoreRecordedSelection: SessionManagerConfig["restoreRecordedSelection"];
  private readonly adoptSessionModel: SessionManagerConfig["adoptSessionModel"];
  private readonly postMessage: SessionManagerConfig["postMessage"];
  private readonly setupSessionWatcher: SessionManagerConfig["setupSessionWatcher"];
  private readonly addOrUpdateSession: SessionManagerConfig["addOrUpdateSession"];
  private readonly getMemoryService: SessionManagerConfig["getMemoryService"];
  private readonly getRawBrowserService: SessionManagerConfig["getRawBrowserService"];
  private readonly getCompassService: SessionManagerConfig["getCompassService"];
  private readonly onAssistantTextFinal: SessionManagerConfig["onAssistantTextFinal"];
  private readonly platform: PlatformWithWorktrees;

  constructor(config: SessionManagerConfig) {
    this.getEnabledMcpServers = config.getEnabledMcpServers;
    this.getMcpConfigLoaded = config.getMcpConfigLoaded;
    this.loadMcpConfig = config.loadMcpConfig;
    this.getConfiguredModelForPanel = config.getConfiguredModelForPanel;
    this.getPreferOpenAIApiKey = config.getPreferOpenAIApiKey;
    this.resolveThinkingForPanel = config.resolveThinkingForPanel;
    this.restoreRecordedSelection = config.restoreRecordedSelection;
    this.adoptSessionModel = config.adoptSessionModel;
    this.postMessage = config.postMessage;
    this.setupSessionWatcher = config.setupSessionWatcher;
    this.addOrUpdateSession = config.addOrUpdateSession;
    this.getMemoryService = config.getMemoryService;
    this.getRawBrowserService = config.getRawBrowserService;
    this.getCompassService = config.getCompassService;
    this.onAssistantTextFinal = config.onAssistantTextFinal;
    this.platform = config.platform;
  }

  async createSessionForPanel(
    host: PanelHost,
    permissionHandler: PermissionHandler,
    panelId: string,
    folder: FolderTarget,
    onSpawnFork?: (args: ForkSpawnArgs) => Promise<void>,
    forkContext?: ForkContext,
  ): Promise<ChatSession> {
    if (!this.getMcpConfigLoaded()) await this.loadMcpConfig();

    const configuredModel = this.getConfiguredModelForPanel(panelId);

    const piMemoryService = this.getMemoryService();
    const piCompassService = this.getCompassService(folder.key);
    const piBrowserService = this.getRawBrowserService();
    const onAssistantTextFinal = this.onAssistantTextFinal;

    // Team service: its deps reference the about-to-be-created PiSession lazily (resolved at call time).
    // eslint-disable-next-line prefer-const -- forward reference: the teamService deps closures capture piSession before it's assigned.
    let piSession: PiSession | undefined;
    const teamService = new TeamService({
      cwd: folder.fsPath,
      onMessage: (message) => {
        this.postMessage(host, message);
        piSession?.teamMessage(message);
      },
      getSessionId: () => piSession?.memorySessionId ?? null,
      getPermissionMode: () => permissionHandler.getPermissionMode(),
      resolveRoleModel: (role) => piSession!.resolveTeamRole(role),
      buildEngine: () => piSession!.buildTeamEngine(),
      recordInvocation: (data) => piSession!.recordAgentInvocation(data),
      parentBranch: () => piSession!.parentBranch(),
      assertResumableModel: (path, agentId) => piSession!.assertResumableModel(path, agentId),
      requestInterruptionCheck: () => piSession!.requestInterruptionCheck(),
    });

    piSession = new PiSession({
      cwd: folder.fsPath,
      settingsFolder: settingsFolderOf(folder),
      projectScope: folder.projectScope,
      permissionHandler,
      onMessage: (message) => this.postMessage(host, message),
      onSessionIdChange: (sessionId, stored, resumed) => {
        // The router posts a resumed conversation's sessionStarted once it replayed its history, so the webview never shows it early.
        if (!resumed) this.postMessage(host, { type: "sessionStarted", sessionId: sessionId || "", stored });
        void this.setupSessionWatcher(folder.key);
        if (sessionId) {
          this.addOrUpdateSession(sessionId, folder.key).catch((err) => log("[SessionManager] session list update failed for %s: %O", sessionId, err));
          const ms = this.getMemoryService();
          if (ms?.isEnabled) {
            void (async () => {
              await ms.ensureInitialized();
              await ms.migrateSessionId(panelId, sessionId);
              await ms.consolidateSession(sessionId);
            })().catch(err => log("[SessionManager] pi consolidateSession failed: %O", err));
          }
        }
      },
      // Refresh the picker/header when session metadata changes out-of-band (e.g. the auto AI title),
      // without re-posting sessionStarted or re-running consolidation.
      onSessionPersisted: (sessionId) => {
        this.addOrUpdateSession(sessionId, folder.key).catch((err) => log("[SessionManager] session list update failed for %s: %O", sessionId, err));
      },
      ...(configuredModel !== undefined ? { model: configuredModel } : {}),
      panelId,
      // This folder's scope, so its servers connect at session start. The shared user client reconciles
      // idempotently; an empty union would close servers another panel connected.
      mcpScope: this.getEnabledMcpServers(folder.key),
      resolveThinking: (model) => this.resolveThinkingForPanel(panelId, model, settingsFolderOf(folder)),
      onRecordedSelection: (model, thinkingLevel) => this.restoreRecordedSelection(panelId, model, thinkingLevel),
      onModelChange: (model, contextWindow, committed) => this.adoptSessionModel(host, panelId, folder, model, contextWindow, committed),
      getPreferOpenAIApiKey: this.getPreferOpenAIApiKey,
      secrets: this.platform.secrets,
      platform: this.platform,
      ...(piMemoryService ? { memoryService: piMemoryService } : {}),
      ...(piCompassService ? { compassService: piCompassService } : {}),
      browserService: piBrowserService,
      browserChat: host,
      teamService,
      ...(onSpawnFork !== undefined ? { onSpawnFork } : {}),
      ...(forkContext !== undefined ? { forkContext } : {}),
      ...(onAssistantTextFinal !== undefined ? { onAssistantTextFinal: (text: string) => onAssistantTextFinal(text, panelId) } : {}),
    });
    return piSession;
  }
}
