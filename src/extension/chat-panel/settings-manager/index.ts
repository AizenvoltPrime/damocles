import * as vscode from "vscode";
import type { ChatSession } from "../../chat-session";
import type { PermissionHandler } from "../../permission-handler";
import type { WebviewHost } from "../types";
import type { McpServerConfig, McpServerStatusInfo } from "../../../shared/types/mcp";
import type { PermissionMode, EffortLevel, AutoCompactConfig } from "../../../shared/types/settings";
import type { PostMessageFn, SettingsManagerConfig } from "./types";
import type { ToolGroup } from "../../../shared/types/tools";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";
import { updateConfigAtEffectiveScope } from "./utils";
import { remapMcpToolNamesForRename } from "../../pi-session/mcp/naming";
import { McpManager } from "./managers/mcp-manager";
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

export type { SettingsManagerConfig };

export class SettingsManager {
  private readonly postMessage: PostMessageFn;
  private readonly mcpManager: McpManager;
  private readonly browserManager: BrowserManager;
  private readonly configManager: ConfigManager;
  private readonly modelManager: ModelManager;
  private readonly thinkingManager: ThinkingManager;
  private readonly voiceManager: VoiceManager;
  private readonly exploreManager: ExploreManager;

  constructor(config: SettingsManagerConfig) {
    this.postMessage = config.postMessage;
    this.mcpManager = new McpManager(config.workspaceState);
    this.browserManager = new BrowserManager();
    this.configManager = new ConfigManager(config.postMessage);
    this.modelManager = new ModelManager(config.postMessage);
    this.thinkingManager = new ThinkingManager(config.postMessage);
    this.voiceManager = new VoiceManager(config.postMessage, config.secrets);
    this.exploreManager = new ExploreManager(config.postMessage, config.secrets);
  }

  setOnMcpConfigChange(callback: () => void): void {
    this.mcpManager.setOnConfigChange(callback);
  }

  setupMcpWatcher(workspacePath: string): void {
    this.mcpManager.setupWatcher(workspacePath);
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

  async setServerEnabled(serverName: string, enabled: boolean): Promise<void> {
    return this.mcpManager.setServerEnabled(serverName, enabled);
  }

  getEnabledMcpServers(): Record<string, McpServerConfig> {
    return this.mcpManager.getEnabledServers();
  }

  getMcpServersForUI(): McpServerStatusInfo[] {
    return this.mcpManager.getServersForUI();
  }

  getMcpConfigLoaded(): boolean {
    return this.mcpManager.getConfigLoaded();
  }

  async loadMcpConfig(): Promise<void> {
    return this.mcpManager.loadConfig();
  }

  /**
   * Add / edit / remove a server in `~/.damocles/mcp.json`, the only MCP file Damocles writes. The
   * shadowing-name map the collision policy needs comes from the manager here rather than from the
   * message handler, so the policy's inputs stay inside the settings layer. Each throws a
   * human-readable `Error` on a rejected definition or name collision, having written nothing.
   */
  async addMcpServer(serverName: string, config: McpServerConfig): Promise<void> {
    return addDamoclesMcpServer(serverName, config, this.mcpManager.getShadowingServerNames());
  }

  /**
   * A rename also moves the two stores keyed by server name, which the config file knows nothing
   * about. Without this, renaming a server the user had switched OFF brings it back on — for stdio,
   * spawning a process they deliberately stopped — and every tool they disabled individually silently
   * re-enables, because `damocles.tools.disabled` holds `mcp__<prefix>__<tool>` names.
   *
   * Both run after the write, so a rejected write moves nothing, and before the caller reloads the
   * config, so the reload sees the updated disabled set.
   */
  async updateMcpServer(serverName: string, newServerName: string | undefined, config: McpServerConfig): Promise<void> {
    const previousNames = this.mcpManager.getServerNames();
    await updateDamoclesMcpServer(serverName, newServerName, config, this.mcpManager.getShadowingServerNames());

    if (newServerName === undefined || newServerName === serverName) return;
    await this.mcpManager.carryDisabledServerThroughRename(serverName, newServerName);

    const disabledTools = vscode.workspace.getConfiguration("damocles").get<string[]>("tools.disabled", []) ?? [];
    const remapped = remapMcpToolNamesForRename(disabledTools, previousNames, serverName, newServerName);
    if (remapped.some((name, index) => name !== disabledTools[index])) {
      await updateConfigAtEffectiveScope("damocles", "tools.disabled", remapped);
    }
  }

  async deleteMcpServer(serverName: string): Promise<void> {
    await deleteDamoclesMcpServer(serverName);
    // Pruned so re-adding the same name later is not silently switched off by a decision about a
    // server that no longer exists.
    await this.mcpManager.pruneDisabledServer(serverName);
  }

  async sendMcpStatus(session: ChatSession, host: WebviewHost): Promise<void> {
    const sdkStatuses = await session.getMcpServerStatus();
    const mcpEntries = this.mcpManager.buildRuntimeStatus(sdkStatuses);
    const mcpEnabled = vscode.workspace.getConfiguration("damocles.mcp").get<boolean>("enabled", true);
    this.postMessage(host, {
      type: "mcpServerStatus",
      servers: mcpEntries,
      mcpEnabled,
      configErrors: this.mcpManager.getConfigErrors(),
      localMcpUnignored: this.mcpManager.getLocalMcpUnignored(),
    });
  }

  /**
   * The config-update message. Built in one place because it is both posted to a single host and
   * broadcast to every panel, and a field added to only one of those paths would leave some panels
   * showing stale state.
   */
  buildMcpConfigUpdate(): Extract<ExtensionToWebviewMessage, { type: "mcpConfigUpdate" }> {
    return {
      type: "mcpConfigUpdate",
      servers: this.getMcpServersForUI(),
      configErrors: this.mcpManager.getConfigErrors(),
      localMcpUnignored: this.mcpManager.getLocalMcpUnignored(),
    };
  }

  sendMcpConfig(host: WebviewHost): void {
    this.postMessage(host, this.buildMcpConfigUpdate());
  }

  loadBrowserState(): void {
    this.browserManager.loadState();
  }

  async setBrowserEnabled(enabled: boolean): Promise<void> {
    return this.browserManager.setEnabled(enabled);
  }

  getBrowserEnabled(): boolean {
    return this.browserManager.isEnabled();
  }

  /** Add/remove a tool's active-set name in `damocles.tools.disabled` (per-tool Tools-panel toggle). */
  async setToolDisabled(toolName: string, disabled: boolean): Promise<void> {
    const current = vscode.workspace.getConfiguration("damocles").get<string[]>("tools.disabled", []) ?? [];
    const set = new Set(current);
    if (disabled) set.add(toolName);
    else set.delete(toolName);
    await updateConfigAtEffectiveScope("damocles", "tools.disabled", [...set]);
  }

  /** Flip a subsystem's master enable config (the Tools-panel group switch). Core is not toggleable. */
  async setToolGroupEnabled(group: ToolGroup, enabled: boolean): Promise<void> {
    switch (group) {
      case "memory":
        await updateConfigAtEffectiveScope("damocles", "memory.enabled", enabled);
        break;
      case "compass":
        await updateConfigAtEffectiveScope("damocles", "compass.enabled", enabled);
        break;
      case "browser":
        await this.browserManager.setEnabled(enabled);
        break;
      case "web":
        await updateConfigAtEffectiveScope("damocles", "pi.webSearch.enabled", enabled);
        break;
      case "team":
        await updateConfigAtEffectiveScope("damocles", "team.enabled", enabled);
        break;
      case "core":
        break;
    }
  }

  async sendCurrentSettings(host: WebviewHost, permissionHandler: PermissionHandler): Promise<void> {
    return this.configManager.sendCurrentSettings(host, permissionHandler);
  }

  async sendAvailableModels(session: ChatSession, host: WebviewHost): Promise<void> {
    return this.configManager.sendAvailableModels(session, host);
  }

  async sendSupportedCommands(session: ChatSession, host: WebviewHost): Promise<void> {
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

  async setDefaultModel(model: string): Promise<void> {
    return this.modelManager.setDefaultModel(model);
  }

  sendModelForPanel(host: WebviewHost, panelId: string): void {
    this.modelManager.sendModelForPanel(host, panelId);
  }

  async handleSetDefaultMaxThinkingTokens(tokens: number | null): Promise<void> {
    return this.configManager.handleSetDefaultMaxThinkingTokens(tokens);
  }

  async handleSetDefaultThinkingDisabled(disabled: boolean): Promise<void> {
    return this.configManager.handleSetDefaultThinkingDisabled(disabled);
  }

  async handleSetPinnedHeaderHidden(hidden: boolean): Promise<void> {
    return this.configManager.handleSetPinnedHeaderHidden(hidden);
  }

  async handleSetDefaultEffort(effort: EffortLevel | null, model: string): Promise<void> {
    return this.configManager.handleSetDefaultEffort(effort, model);
  }

  async handleSetTeamRoleModel(role: TeamRole, model: string): Promise<void> {
    return this.configManager.handleSetTeamRoleModel(role, model);
  }

  async handleSetTeamRoleEffort(role: TeamRole, effort: EffortLevel | null): Promise<void> {
    return this.configManager.handleSetTeamRoleEffort(role, effort);
  }

  cleanupPanelThinking(panelId: string): void {
    this.thinkingManager.cleanupPanelThinking(panelId);
  }

  copyPanelThinkingStateTo(sourcePanelId: string, targetPanelId: string): void {
    this.thinkingManager.copyPanelStateTo(sourcePanelId, targetPanelId);
  }

  resolveThinkingDisabled(panelId: string, config: vscode.WorkspaceConfiguration): boolean {
    return this.thinkingManager.resolveDisabled(panelId, config);
  }

  resolveThinkingEffort(panelId: string, model: string, config: vscode.WorkspaceConfiguration): EffortLevel | null {
    return this.thinkingManager.resolveEffort(panelId, model, config);
  }

  resolveMaxThinkingTokens(panelId: string, model: string, config: vscode.WorkspaceConfiguration): number | null {
    return this.thinkingManager.resolveMaxTokens(panelId, model, config);
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

  sendThinkingForPanel(host: WebviewHost, panelId: string): void {
    const activeModel = this.modelManager.getActiveModelForPanel(panelId);
    const defaultModel = this.modelManager.getDefaultModel();
    const config = vscode.workspace.getConfiguration("damocles");
    this.thinkingManager.sendThinkingForPanel(host, panelId, activeModel, defaultModel, config);
  }

  async handleSetBudgetLimit(budgetUsd: number | null): Promise<void> {
    return this.configManager.handleSetBudgetLimit(budgetUsd);
  }

  async handleSetTaskBudget(budget: number | null): Promise<void> {
    return this.configManager.handleSetTaskBudget(budget);
  }

  async handleSetAutoCompact(config: AutoCompactConfig): Promise<void> {
    return this.configManager.handleSetAutoCompact(config);
  }

  async handleSetPermissionMode(
    session: ChatSession,
    permissionHandler: PermissionHandler,
    mode: PermissionMode
  ): Promise<void> {
    return this.configManager.handleSetPermissionMode(session, permissionHandler, mode);
  }

  async handleSetDefaultPermissionMode(mode: PermissionMode): Promise<void> {
    return this.configManager.handleSetDefaultPermissionMode(mode);
  }

  async handleSetWorktreeBaseRef(baseRef: 'fresh' | 'head'): Promise<void> {
    return this.configManager.handleSetWorktreeBaseRef(baseRef);
  }

  async handleSetDefaultDangerouslySkipPermissions(enabled: boolean): Promise<void> {
    return this.configManager.handleSetDefaultDangerouslySkipPermissions(enabled);
  }

  async handleSetIdeContextEnabled(enabled: boolean): Promise<void> {
    return this.configManager.handleSetIdeContextEnabled(enabled);
  }

  handleSetDangerouslySkipPermissions(permissionHandler: PermissionHandler, enabled: boolean): void {
    this.configManager.handleSetDangerouslySkipPermissions(permissionHandler, enabled);
  }

  async setVoiceProvider(provider: VoiceProvider): Promise<void> {
    return this.voiceManager.setProvider(provider);
  }

  async setVoiceLanguage(language: string): Promise<void> {
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

  async sendVoiceConfig(host: WebviewHost): Promise<void> {
    return this.voiceManager.sendVoiceConfig(host);
  }

  async setVoiceMode(mode: VoiceMode): Promise<void> {
    return this.voiceManager.setMode(mode);
  }

  async setVoiceWakeWord(wakeWord: string): Promise<void> {
    return this.voiceManager.setWakeWord(wakeWord);
  }

  async setVoiceWakeWordSensitivity(sensitivity: number): Promise<void> {
    return this.voiceManager.setWakeWordSensitivity(sensitivity);
  }

  async setVoiceTtsEnabled(enabled: boolean): Promise<void> {
    return this.voiceManager.setTtsEnabled(enabled);
  }

  async setVoiceTtsVoice(voice: TtsVoiceId): Promise<void> {
    return this.voiceManager.setTtsVoice(voice);
  }

  async setVoiceLocalGpu(pref: GpuPreference): Promise<void> {
    return this.voiceManager.setGpuPreference(pref);
  }

  async setVoiceEndOfTurnSilenceMs(ms: number): Promise<void> {
    return this.voiceManager.setEndOfTurnSilenceMs(ms);
  }

  async setVoiceMaxUtteranceMs(ms: number): Promise<void> {
    return this.voiceManager.setMaxUtteranceMs(ms);
  }

  async setVoiceAutoSubmit(autoSubmit: boolean): Promise<void> {
    return this.voiceManager.setAutoSubmit(autoSubmit);
  }

  async setVoiceDiagnostics(diagnostics: boolean): Promise<void> {
    return this.voiceManager.setDiagnostics(diagnostics);
  }

  async storeExploreApiKey(apiKey: string): Promise<void> {
    return this.exploreManager.storeApiKey(apiKey);
  }

  async deleteExploreApiKey(): Promise<void> {
    return this.exploreManager.deleteApiKey();
  }

  async sendExploreKeyStatus(host: WebviewHost): Promise<void> {
    return this.exploreManager.sendExploreKeyStatus(host);
  }

  async setExploreProvider(provider: string): Promise<void> {
    return this.exploreManager.setProvider(provider);
  }

  async setExploreModel(model: string): Promise<void> {
    return this.exploreManager.setModel(model);
  }

  async setExploreEffort(effort: string): Promise<void> {
    return this.exploreManager.setEffort(effort);
  }

  sendExploreConfig(host: WebviewHost): void {
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

  async sendStepfunAuthStatus(host: WebviewHost): Promise<void> {
    return this.exploreManager.sendStepfunAuthStatus(host);
  }

  async storeDeepseekApiKey(key: string): Promise<void> {
    return this.exploreManager.storeDeepseekApiKey(key);
  }

  async deleteDeepseekApiKey(): Promise<void> {
    return this.exploreManager.deleteDeepseekApiKey();
  }

  async sendDeepseekAuthStatus(host: WebviewHost): Promise<void> {
    return this.exploreManager.sendDeepseekAuthStatus(host);
  }

  getOpenAIModelPricing(): Record<string, { input: number; cachedInput: number; output: number; reasoning: number }> {
    const raw = vscode.workspace.getConfiguration("damocles.openai").get<Record<string, unknown>>("modelPricing", {}) ?? {};
    const out: Record<string, { input: number; cachedInput: number; output: number; reasoning: number }> = {};
    for (const [modelId, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const input = typeof e["input"] === "number" ? (e["input"] as number) : NaN;
      const cachedInput = typeof e["cachedInput"] === "number" ? (e["cachedInput"] as number) : NaN;
      const output = typeof e["output"] === "number" ? (e["output"] as number) : NaN;
      const reasoning = typeof e["reasoning"] === "number" ? (e["reasoning"] as number) : NaN;
      if ([input, cachedInput, output, reasoning].some(n => !Number.isFinite(n) || n < 0)) continue;
      out[modelId] = { input, cachedInput, output, reasoning };
    }
    return out;
  }

  sendOpenAIModelPricing(host: WebviewHost): void {
    this.postMessage(host, { type: "openaiModelPricingUpdate", pricing: this.getOpenAIModelPricing() });
  }

}
