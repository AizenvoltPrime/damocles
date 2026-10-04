import type { Platform } from "../../../platform/platform";
import type { SettingsFolder, SettingsStore } from "../../../platform/settings-store";
import { settingsFolderOf, type FolderTarget } from "../../workspace-folders/folder-registry";
import type { ChatSession } from "../../chat-session";
import type { PermissionHandler } from "../../permission-handler";
import type { PanelHost } from "../../../platform/window-service";
import type { McpServerConfig, McpServerStatusInfo, McpToolExposureScope } from "../../../shared/types/mcp";
import type { McpScope } from "../../session-types";
import type { PermissionMode, EffortLevel, AutoCompactConfig, CacheWarmingMode } from "../../../shared/types/settings";
import type { PostMessageFn, SettingsManagerConfig } from "./types";
import { TOOL_GROUP_SETTINGS, type SwitchableToolGroup } from "../../../shared/types/tools";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";
import { updateConfigAtEffectiveScope, type SettingWrite } from "./utils";
import { MCP_TOOL_EXPOSURE_SETTING } from "../../../shared/types/mcp";
import { McpManager } from "./managers/mcp-manager";
import { log } from "../../logger";
import {
  addDamoclesMcpServer,
  updateDamoclesMcpServer,
  deleteDamoclesMcpServer,
} from "./managers/mcp-config-write";
import { BrowserManager } from "./managers/browser-manager";
import { ConfigManager } from "./managers/config-manager";
import { ModelManager } from "./managers/model-manager";
import { ThinkingManager } from "./managers/thinking-manager";
import { VoiceManager } from "./managers/voice-manager";
import { ExploreManager } from "./managers/explore-manager";
import type { VoiceProvider, VoiceConfig, VoiceMode, GpuPreference, TtsVoiceId } from "../../../shared/types/voice";
import type { TeamRole } from "../../pi-session/team-model-resolution";
import { PiRuntime } from "../../pi-session/pi-runtime";
import { IMAGE_ENABLED_SETTING, IMAGE_MODEL_SETTING, IMAGE_PROVIDER, isOfferedImageModel } from "../../pi-session/tools/image-tool-specs";

export type { SettingsManagerConfig };

export class SettingsManager {
  private readonly postMessage: PostMessageFn;
  private readonly platform: Platform;
  private readonly mcpManager: McpManager;
  private readonly browserManager: BrowserManager;
  private readonly configManager: ConfigManager;
  private readonly modelManager: ModelManager;
  private readonly thinkingManager: ThinkingManager;
  private readonly voiceManager: VoiceManager;
  private readonly exploreManager: ExploreManager;
  private settingWrites: Promise<unknown> = Promise.resolve();

  constructor(config: SettingsManagerConfig) {
    this.postMessage = config.postMessage;
    this.platform = config.platform;
    this.mcpManager = new McpManager(config.platform, config.folders);
    this.browserManager = new BrowserManager(config.platform);
    this.configManager = new ConfigManager(config.postMessage, config.platform);
    this.modelManager = new ModelManager(config.postMessage, config.platform);
    this.thinkingManager = new ThinkingManager(config.postMessage);
    this.voiceManager = new VoiceManager(config.postMessage, config.platform);
    this.exploreManager = new ExploreManager(config.postMessage, config.platform);
  }

  setOnMcpConfigChange(callback: () => void): void {
    this.mcpManager.setOnConfigChange(callback);
  }

  setupMcpWatcher(): void {
    this.mcpManager.setupWatcher();
  }

  /** Re-watch and reload after a folder add or remove; the reload notifies the config-change callback. */
  async handleMcpFoldersChanged(): Promise<void> {
    return this.mcpManager.handleFoldersChanged();
  }

  dispose(): void {
    this.mcpManager.dispose();
    this.browserManager.dispose();
    this.modelManager.dispose();
  }

  /**
   * Wires a callback that fires when `damocles.model` is mutated outside the
   * webview (VS Code Settings UI, settings.json edit). Callers refresh panel
   * UI state — defaults section reasoning-effort capabilities track the
   * default model and would otherwise render against stale capabilities.
   */
  onDefaultModelChanged(callback: () => void): void {
    this.modelManager.setOnDefaultModelChanged(callback);
  }

  async setServerEnabled(folderKey: string, serverName: string, enabled: boolean): Promise<void> {
    return this.mcpManager.setServerEnabled(folderKey, serverName, enabled);
  }

  getEnabledMcpServers(folderKey: string): McpScope {
    return this.mcpManager.getEnabledServers(folderKey);
  }

  getMcpServersForUI(folderKey: string): McpServerStatusInfo[] {
    return this.mcpManager.getServersForUI(folderKey);
  }

  getMcpConfigLoaded(): boolean {
    return this.mcpManager.getConfigLoaded();
  }

  async loadMcpConfig(): Promise<void> {
    return this.mcpManager.loadConfig();
  }

  /**
   * Add / edit / remove a server in `~/.damocles/mcp.json`, the only MCP file Damocles writes.
   * `folderKey` is the acting panel's folder: a name that folder's own files win is refused there,
   * while a name defined only in another folder is accepted. The shadowing-name map comes from the
   * manager here rather than from the message handler, so the policy's inputs stay inside the settings
   * layer. Each throws a human-readable `Error` on a rejected definition or name collision, having
   * written nothing.
   */
  async addMcpServer(folderKey: string, serverName: string, config: McpServerConfig): Promise<void> {
    return addDamoclesMcpServer(serverName, config, this.mcpManager.getShadowingServerNames(folderKey));
  }

  /**
   * A rename also moves the two stores keyed by server name, which the config file knows nothing
   * about. Without this, renaming a server the user had switched OFF brings it back on — for stdio,
   * spawning a process they deliberately stopped — and every tool they turned off individually silently
   * comes back, because `damocles.mcp.toolExposure` is keyed by server name.
   *
   * Both run after the write, so a rejected write moves nothing, and before the caller reloads the
   * config, so the reload sees the updated state. The per-tool setting moves at every scope it is set
   * at, project included, where the panel itself writes it, so an Off chosen there stays Off. The
   * rename has landed by then, so a failure in either step is logged and the save still succeeds.
   */
  async updateMcpServer(folderKey: string, serverName: string, newServerName: string | undefined, config: McpServerConfig): Promise<void> {
    await updateDamoclesMcpServer(serverName, newServerName, config, this.mcpManager.getShadowingServerNames(folderKey));

    if (newServerName === undefined || newServerName === serverName) return;
    try {
      await this.mcpManager.carryDisabledServerThroughRename(serverName, newServerName);
    } catch (err) {
      log("[SettingsManager] the enabled state of MCP server %s did not follow its rename: %s", serverName, err instanceof Error ? err.message : String(err));
    }

    await this.serializeSettingWrite(async () => {
      const inspection = this.platform.settings.inspect<unknown>(MCP_TOOL_EXPOSURE_SETTING);
      const scopes = [["user", inspection.userValue], ["project", inspection.projectValue], ["local", inspection.localValue]] as const;
      for (const [scope, value] of scopes) {
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, serverName)) continue;
        const { [serverName]: tools, ...rest } = value as Record<string, unknown>;
        try {
          await this.platform.settings.update(MCP_TOOL_EXPOSURE_SETTING, { ...rest, [newServerName]: tools }, scope);
        } catch (err) {
          log("[SettingsManager] the %s-scope tool exposure of MCP server %s did not follow its rename: %s", scope, serverName, err instanceof Error ? err.message : String(err));
        }
      }
    });
  }

  async deleteMcpServer(serverName: string): Promise<void> {
    await deleteDamoclesMcpServer(serverName);
    // Pruned so re-adding the same name later is not silently switched off by a decision about a
    // server that no longer exists.
    await this.mcpManager.pruneDisabledServer(serverName);
  }

  async sendMcpStatus(session: ChatSession, host: PanelHost, folderKey: string): Promise<void> {
    const sdkStatuses = await session.getMcpServerStatus();
    const mcpEntries = this.mcpManager.buildRuntimeStatus(folderKey, sdkStatuses);
    const mcpEnabled = this.platform.settings.get<boolean>("damocles.mcp.enabled", true);
    this.postMessage(host, {
      type: "mcpServerStatus",
      servers: mcpEntries,
      mcpEnabled,
      configErrors: this.mcpManager.getConfigErrors(folderKey),
      toolExposureScopes: this.mcpManager.toolExposureScopes(folderKey),
      localMcpUnignored: this.mcpManager.getLocalMcpUnignored(folderKey),
    });
  }

  getMcpToolExposureScopes(folderKey: string): McpToolExposureScope[] {
    return this.mcpManager.toolExposureScopes(folderKey);
  }

  /**
   * The config-update message for a panel in `folderKey`. Built in one place because it is both posted
   * to a single host and sent to every panel, and a field added to only one of those paths would leave
   * some panels showing stale state.
   */
  buildMcpConfigUpdate(folderKey: string): Extract<ExtensionToWebviewMessage, { type: "mcpConfigUpdate" }> {
    return {
      type: "mcpConfigUpdate",
      servers: this.getMcpServersForUI(folderKey),
      configErrors: this.mcpManager.getConfigErrors(folderKey),
      localMcpUnignored: this.mcpManager.getLocalMcpUnignored(folderKey),
    };
  }

  sendMcpConfig(host: PanelHost, folderKey: string): void {
    this.postMessage(host, this.buildMcpConfigUpdate(folderKey));
  }

  loadBrowserState(): void {
    this.browserManager.loadState();
  }

  async setBrowserEnabled(enabled: boolean): Promise<SettingWrite> {
    return this.browserManager.setEnabled(enabled);
  }

  getBrowserEnabled(): boolean {
    return this.browserManager.isEnabled();
  }

  /**
   * Runs a setter that reads a list or object setting and writes it back after the setters queued before it, so each
   * reads what the previous one wrote: the stores change what they read only once a write has landed.
   */
  serializeSettingWrite<T>(write: () => Promise<T>): Promise<T> {
    const run = this.settingWrites.then(write);
    // The chain only orders writes; each caller handles its own failure.
    this.settingWrites = run.catch(() => undefined);
    return run;
  }

  /** Add/remove a tool's active-set name in `damocles.tools.disabled` (per-tool Tools-panel toggle). */
  async setToolDisabled(toolName: string, disabled: boolean): Promise<void> {
    await this.serializeSettingWrite(async () => {
      const current = this.platform.settings.get<string[]>("damocles.tools.disabled", []) ?? [];
      const set = new Set(current);
      if (disabled) set.add(toolName);
      else set.delete(toolName);
      await updateConfigAtEffectiveScope(this.platform, "damocles.tools.disabled", [...set]);
    });
  }

  /** Flip a subsystem's master enable config (the Tools-panel group switch). */
  async setToolGroupEnabled(group: SwitchableToolGroup, enabled: boolean): Promise<SettingWrite> {
    if (group === "browser") return this.browserManager.setEnabled(enabled);
    if (group === "image") return this.setImageGenerationEnabled(enabled);
    return updateConfigAtEffectiveScope(this.platform, TOOL_GROUP_SETTINGS[group], enabled);
  }

  /** Always the user scope: a repository must never turn on generation billed to the user's key. */
  async setImageGenerationEnabled(enabled: boolean): Promise<SettingWrite> {
    await this.platform.settings.update(IMAGE_ENABLED_SETTING, enabled, "user");
    return { key: IMAGE_ENABLED_SETTING, home: "user" };
  }

  /** Always the user scope: the model decides what each image costs on the user's key. */
  async setImageGenerationModel(model: string): Promise<SettingWrite> {
    await this.platform.settings.update(IMAGE_MODEL_SETTING, model, "user");
    return { key: IMAGE_MODEL_SETTING, home: "user" };
  }

  /** Posts nothing until pi's runtime is up: the model list and the OpenRouter check both come from it. */
  sendImageGenerationSettings(host: PanelHost): void {
    const runtime = PiRuntime.exists ? PiRuntime.get().modelRuntime : null;
    if (!runtime) return;
    this.postMessage(host, {
      type: "imageGenerationSettings",
      settings: {
        enabled: this.platform.settings.get<boolean>(IMAGE_ENABLED_SETTING, false),
        model: this.platform.settings.get<string>(IMAGE_MODEL_SETTING, ""),
        imageModels: runtime.getModelsOfType("image", IMAGE_PROVIDER).filter(isOfferedImageModel).map((model) => ({ id: model.id, name: model.name })),
        openRouterConfigured: runtime.hasConfiguredAuth(IMAGE_PROVIDER),
      },
    });
  }

  async sendCurrentSettings(host: PanelHost, permissionHandler: PermissionHandler, folder: FolderTarget): Promise<void> {
    return this.configManager.sendCurrentSettings(host, permissionHandler, settingsFolderOf(folder));
  }

  async sendAvailableModels(session: ChatSession, host: PanelHost): Promise<void> {
    return this.configManager.sendAvailableModels(session, host);
  }

  async sendSupportedCommands(session: ChatSession, host: PanelHost): Promise<void> {
    return this.configManager.sendSupportedCommands(session, host);
  }

  initPanelModel(panelId: string): void {
    this.modelManager.initPanelModel(panelId);
  }

  cleanupPanelModel(panelId: string): void {
    this.modelManager.cleanupPanelModel(panelId);
  }

  getActiveModelForPanel(panelId: string): string {
    return this.modelManager.getActiveModelForPanel(panelId);
  }

  getDefaultModel(): string {
    return this.modelManager.getDefaultModel();
  }

  setActiveModelForPanel(panelId: string, model: string): boolean {
    return this.modelManager.setActiveModelForPanel(panelId, model);
  }

  async setDefaultModel(model: string): Promise<SettingWrite> {
    return this.modelManager.setDefaultModel(model);
  }

  sendModelForPanel(host: PanelHost, panelId: string): void {
    this.modelManager.sendModelForPanel(host, panelId);
  }

  async handleSetDefaultMaxThinkingTokens(tokens: number | null, folder: FolderTarget): Promise<SettingWrite> {
    return this.configManager.handleSetDefaultMaxThinkingTokens(tokens, settingsFolderOf(folder));
  }

  async handleSetDefaultThinkingDisabled(disabled: boolean, folder: FolderTarget): Promise<SettingWrite> {
    return this.configManager.handleSetDefaultThinkingDisabled(disabled, settingsFolderOf(folder));
  }

  async handleSetPinnedHeaderHidden(hidden: boolean): Promise<void> {
    return this.configManager.handleSetPinnedHeaderHidden(hidden);
  }

  async handleSetDefaultEffort(effort: EffortLevel | null, model: string, folder: FolderTarget): Promise<SettingWrite> {
    return this.serializeSettingWrite(() => this.configManager.handleSetDefaultEffort(effort, model, settingsFolderOf(folder)));
  }

  async handleSetTeamRoleModel(role: TeamRole, model: string, folder: FolderTarget): Promise<SettingWrite> {
    return this.configManager.handleSetTeamRoleModel(role, model, settingsFolderOf(folder));
  }

  async handleSetTeamRoleEffort(role: TeamRole, effort: EffortLevel | null, folder: FolderTarget): Promise<SettingWrite> {
    return this.configManager.handleSetTeamRoleEffort(role, effort, settingsFolderOf(folder));
  }

  cleanupPanelThinking(panelId: string): void {
    this.thinkingManager.cleanupPanelThinking(panelId);
  }

  copyPanelThinkingStateTo(sourcePanelId: string, targetPanelId: string): void {
    this.thinkingManager.copyPanelStateTo(sourcePanelId, targetPanelId);
  }

  resolveThinkingDisabled(panelId: string, model: string, settings: SettingsStore, folder: SettingsFolder | undefined): boolean {
    return this.thinkingManager.resolveDisabled(panelId, model, settings, folder);
  }

  resolveThinkingEffort(panelId: string, model: string, settings: SettingsStore, folder: SettingsFolder | undefined): EffortLevel | null {
    return this.thinkingManager.resolveEffort(panelId, model, settings, folder);
  }

  resolveMaxThinkingTokens(panelId: string, model: string, settings: SettingsStore, folder: SettingsFolder | undefined): number | null {
    return this.thinkingManager.resolveMaxTokens(panelId, model, settings, folder);
  }

  handleSetPanelThinkingDisabled(panelId: string, disabled: boolean): void {
    this.thinkingManager.setPanelDisabled(panelId, disabled);
  }

  handleSetPanelEffort(panelId: string, model: string, effort: EffortLevel | null): void {
    this.thinkingManager.setPanelEffort(panelId, model, effort);
  }

  handleSetPanelMaxThinkingTokens(panelId: string, model: string, tokens: number | null): void {
    this.thinkingManager.setPanelMaxTokens(panelId, model, tokens);
  }

  sendThinkingForPanel(host: PanelHost, panelId: string, folder: FolderTarget): void {
    const activeModel = this.modelManager.getActiveModelForPanel(panelId);
    const defaultModel = this.modelManager.getDefaultModel();
    this.thinkingManager.sendThinkingForPanel(host, panelId, activeModel, defaultModel, this.platform.settings, settingsFolderOf(folder));
  }

  async handleSetBudgetLimit(budgetUsd: number | null, folder: FolderTarget): Promise<SettingWrite> {
    return this.configManager.handleSetBudgetLimit(budgetUsd, settingsFolderOf(folder));
  }

  async handleSetTaskBudget(budget: number | null, folder: FolderTarget): Promise<SettingWrite> {
    return this.configManager.handleSetTaskBudget(budget, settingsFolderOf(folder));
  }

  async handleSetAutoCompact(config: AutoCompactConfig, folder: FolderTarget): Promise<SettingWrite> {
    return this.configManager.handleSetAutoCompact(config, settingsFolderOf(folder));
  }

  async handleSetCheckpointRetentionDays(days: number): Promise<SettingWrite> {
    return this.configManager.handleSetCheckpointRetentionDays(days);
  }

  async handleSetCacheWarming(mode: CacheWarmingMode): Promise<SettingWrite> {
    return this.configManager.handleSetCacheWarming(mode);
  }

  async handleSetPermissionMode(
    session: ChatSession,
    permissionHandler: PermissionHandler,
    mode: PermissionMode
  ): Promise<void> {
    return this.configManager.handleSetPermissionMode(session, permissionHandler, mode);
  }

  async handleSetDefaultPermissionMode(mode: PermissionMode, folder: FolderTarget): Promise<SettingWrite> {
    return this.configManager.handleSetDefaultPermissionMode(mode, settingsFolderOf(folder));
  }

  async handleSetDefaultDangerouslySkipPermissions(enabled: boolean, folder: FolderTarget): Promise<SettingWrite> {
    return this.configManager.handleSetDefaultDangerouslySkipPermissions(enabled, settingsFolderOf(folder));
  }

  async handleSetIdeContextEnabled(enabled: boolean): Promise<SettingWrite> {
    return this.configManager.handleSetIdeContextEnabled(enabled);
  }

  handleSetDangerouslySkipPermissions(permissionHandler: PermissionHandler, enabled: boolean): void {
    this.configManager.handleSetDangerouslySkipPermissions(permissionHandler, enabled);
  }

  async setVoiceProvider(provider: VoiceProvider): Promise<SettingWrite> {
    return this.voiceManager.setProvider(provider);
  }

  async setVoiceLanguage(language: string): Promise<SettingWrite> {
    return this.voiceManager.setLanguage(language);
  }

  async storeVoiceApiKey(provider: VoiceProvider, apiKey: string): Promise<void> {
    return this.voiceManager.storeApiKey(provider, apiKey);
  }

  async deleteVoiceApiKey(provider: VoiceProvider): Promise<void> {
    return this.voiceManager.deleteApiKey(provider);
  }

  async getVoiceApiKey(provider: VoiceProvider): Promise<string | undefined> {
    return this.voiceManager.getApiKey(provider);
  }

  getVoiceConfig(): VoiceConfig {
    return this.voiceManager.getConfig();
  }

  async sendVoiceConfig(host: PanelHost): Promise<void> {
    return this.voiceManager.sendVoiceConfig(host);
  }

  async setVoiceMode(mode: VoiceMode): Promise<SettingWrite> {
    return this.voiceManager.setMode(mode);
  }

  async setVoiceWakeWord(wakeWord: string): Promise<SettingWrite> {
    return this.voiceManager.setWakeWord(wakeWord);
  }

  async setVoiceWakeWordSensitivity(sensitivity: number): Promise<SettingWrite> {
    return this.voiceManager.setWakeWordSensitivity(sensitivity);
  }

  async setVoiceTtsEnabled(enabled: boolean): Promise<SettingWrite> {
    return this.voiceManager.setTtsEnabled(enabled);
  }

  async setVoiceTtsVoice(voice: TtsVoiceId): Promise<SettingWrite> {
    return this.voiceManager.setTtsVoice(voice);
  }

  async setVoiceLocalGpu(pref: GpuPreference): Promise<SettingWrite> {
    return this.voiceManager.setGpuPreference(pref);
  }

  async setVoiceEndOfTurnSilenceMs(ms: number): Promise<SettingWrite> {
    return this.voiceManager.setEndOfTurnSilenceMs(ms);
  }

  async setVoiceMaxUtteranceMs(ms: number): Promise<SettingWrite> {
    return this.voiceManager.setMaxUtteranceMs(ms);
  }

  async setVoiceAutoSubmit(autoSubmit: boolean): Promise<SettingWrite> {
    return this.voiceManager.setAutoSubmit(autoSubmit);
  }

  async setVoiceDiagnostics(diagnostics: boolean): Promise<SettingWrite> {
    return this.voiceManager.setDiagnostics(diagnostics);
  }

  async storeExploreApiKey(apiKey: string): Promise<void> {
    return this.exploreManager.storeApiKey(apiKey);
  }

  async deleteExploreApiKey(): Promise<void> {
    return this.exploreManager.deleteApiKey();
  }

  async sendExploreKeyStatus(host: PanelHost): Promise<void> {
    return this.exploreManager.sendExploreKeyStatus(host);
  }

  async setExploreProvider(provider: string): Promise<SettingWrite> {
    return this.exploreManager.setProvider(provider);
  }

  async setExploreModel(model: string): Promise<SettingWrite> {
    return this.serializeSettingWrite(() => this.exploreManager.setModel(model));
  }

  async setExploreEffort(effort: string): Promise<SettingWrite> {
    return this.exploreManager.setEffort(effort);
  }

  sendExploreConfig(host: PanelHost): void {
    this.exploreManager.sendExploreConfig(host);
  }

  selectedExploreProvider(): string {
    return this.exploreManager.selectedExploreProvider();
  }

  async storeStepfunApiKey(key: string): Promise<void> {
    return this.exploreManager.storeStepfunApiKey(key);
  }

  async deleteStepfunApiKey(): Promise<void> {
    return this.exploreManager.deleteStepfunApiKey();
  }

  async sendStepfunAuthStatus(host: PanelHost): Promise<void> {
    return this.exploreManager.sendStepfunAuthStatus(host);
  }

  async storeDeepseekApiKey(key: string): Promise<void> {
    return this.exploreManager.storeDeepseekApiKey(key);
  }

  async deleteDeepseekApiKey(): Promise<void> {
    return this.exploreManager.deleteDeepseekApiKey();
  }

  async sendDeepseekAuthStatus(host: PanelHost): Promise<void> {
    return this.exploreManager.sendDeepseekAuthStatus(host);
  }
}
