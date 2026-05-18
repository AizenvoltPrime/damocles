import * as vscode from "vscode";
import type { ClaudeSession } from "../../claude-session";
import type { PermissionHandler } from "../../permission-handler";
import type { PluginService } from "../../PluginService";
import type { WebviewHost } from "../types";
import type { McpServerConfig, McpServerStatusInfo } from "../../../shared/types/mcp";
import type { PluginConfig, PluginStatusInfo } from "../../../shared/types/plugins";
import type { PermissionMode, ContextStrategy, ProviderProfile, EffortLevel } from "../../../shared/types/settings";
import type { RecallConfig } from "../../recall/types";
import type { PostMessageFn, SettingsManagerConfig } from "./types";
import { ContextStrategyManager } from "./managers/context-strategy-manager";
import { McpManager } from "./managers/mcp-manager";
import { ChromeManager } from "./managers/chrome-manager";
import { BrowserManager } from "./managers/browser-manager";
import { PluginManager } from "./managers/plugin-manager";
import { ProviderManager } from "./managers/provider-manager";
import { ConfigManager } from "./managers/config-manager";
import { ModelManager } from "./managers/model-manager";
import { ThinkingManager } from "./managers/thinking-manager";
import { BetaManager } from "./managers/beta-manager";
import { VoiceManager } from "./managers/voice-manager";
import { ExploreManager } from "./managers/explore-manager";
import type { VoiceProvider, VoiceConfig, VoiceMode, GpuPreference, TtsVoiceId } from "../../../shared/types/voice";

export type { SettingsManagerConfig };

export class SettingsManager {
  private readonly postMessage: PostMessageFn;
  private readonly mcpManager: McpManager;
  private readonly chromeManager: ChromeManager;
  private readonly browserManager: BrowserManager;
  private readonly pluginManager: PluginManager;
  private readonly providerManager: ProviderManager;
  private readonly configManager: ConfigManager;
  private readonly modelManager: ModelManager;
  private readonly thinkingManager: ThinkingManager;
  private readonly betaManager: BetaManager;
  private readonly contextStrategyManager: ContextStrategyManager;
  private readonly voiceManager: VoiceManager;
  private readonly exploreManager: ExploreManager;

  constructor(config: SettingsManagerConfig) {
    this.postMessage = config.postMessage;
    this.mcpManager = new McpManager();
    this.chromeManager = new ChromeManager();
    this.browserManager = new BrowserManager();
    this.pluginManager = new PluginManager(config.postMessage);
    this.providerManager = new ProviderManager(config.postMessage, config.secrets);
    this.configManager = new ConfigManager(config.postMessage);
    this.modelManager = new ModelManager(config.postMessage);
    this.thinkingManager = new ThinkingManager(config.postMessage);
    this.betaManager = new BetaManager(
      config.postMessage,
      (panelId) => this.modelManager.getActiveModelForPanel(panelId),
    );
    this.modelManager.setBetasGetter(
      (panelId) => this.betaManager.getActiveBetasForPanel(panelId),
    );
    this.contextStrategyManager = new ContextStrategyManager(config.postMessage);
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
    this.chromeManager.dispose();
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
    return [...this.mcpManager.getServersForUI(), this.chromeManager.getServerForUI(), this.browserManager.getServerForUI()];
  }

  getMcpConfigLoaded(): boolean {
    return this.mcpManager.getConfigLoaded();
  }

  async loadMcpConfig(): Promise<void> {
    return this.mcpManager.loadConfig();
  }

  async sendMcpStatus(session: ClaudeSession, host: WebviewHost): Promise<void> {
    const sdkStatuses = await session.getMcpServerStatus();
    const mcpEntries = this.mcpManager.buildRuntimeStatus(sdkStatuses);
    const chromeEntry = this.chromeManager.mergeWithSdkStatus(sdkStatuses);
    const browserEntry = this.browserManager.mergeWithSdkStatus(sdkStatuses);
    this.postMessage(host, { type: "mcpServerStatus", servers: [...mcpEntries, chromeEntry, browserEntry] });
  }

  sendMcpConfig(host: WebviewHost): void {
    this.postMessage(host, { type: "mcpConfigUpdate", servers: this.getMcpServersForUI() });
  }

  loadChromeState(): void {
    this.chromeManager.loadState();
  }

  async setChromeEnabled(enabled: boolean): Promise<void> {
    return this.chromeManager.setEnabled(enabled);
  }

  getChromeEnabled(): boolean {
    return this.chromeManager.isEnabled();
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

  async setPluginEnabled(pluginFullId: string, enabled: boolean): Promise<void> {
    return this.pluginManager.setPluginEnabled(pluginFullId, enabled);
  }

  getEnabledPlugins(): PluginConfig[] {
    return this.pluginManager.getEnabledPlugins();
  }

  getEnabledPluginIds(): Set<string> {
    return this.pluginManager.getEnabledPluginIds();
  }

  getPluginsForUI(): PluginStatusInfo[] {
    return this.pluginManager.getPluginsForUI();
  }

  getPluginConfigLoaded(): boolean {
    return this.pluginManager.getConfigLoaded();
  }

  async loadPluginConfig(pluginService: PluginService): Promise<void> {
    return this.pluginManager.loadConfig(pluginService);
  }

  sendPluginConfig(host: WebviewHost): void {
    this.pluginManager.sendConfig(host);
  }

  async loadProviderProfiles(): Promise<void> {
    return this.providerManager.loadProfiles();
  }

  async createProviderProfile(profile: ProviderProfile): Promise<void> {
    return this.providerManager.createProfile(profile);
  }

  async updateProviderProfile(originalName: string, profile: ProviderProfile): Promise<boolean> {
    return this.providerManager.updateProfile(originalName, profile);
  }

  async deleteProviderProfile(profileName: string): Promise<boolean> {
    return this.providerManager.deleteProfile(profileName);
  }

  async setActiveProviderProfile(profileName: string | null): Promise<boolean> {
    return this.providerManager.setActiveProfile(profileName);
  }

  getActiveProviderEnv(): Record<string, string> | undefined {
    return this.providerManager.getActiveEnv();
  }

  initPanelProfile(panelId: string): void {
    this.providerManager.initPanelProfile(panelId);
  }

  cleanupPanelProfile(panelId: string): void {
    this.providerManager.cleanupPanelProfile(panelId);
  }

  getActiveProviderProfileForPanel(panelId: string): string | null {
    return this.providerManager.getActiveProfileForPanel(panelId);
  }

  setActiveProviderProfileForPanel(panelId: string, profileName: string | null): boolean {
    return this.providerManager.setActiveProfileForPanel(panelId, profileName);
  }

  getActiveProviderEnvForPanel(panelId: string): Record<string, string> | undefined {
    return this.providerManager.getActiveEnvForPanel(panelId);
  }

  sendProviderProfilesForPanel(host: WebviewHost, panelId: string): void {
    this.providerManager.sendProfilesForPanel(host, panelId);
  }

  async setDefaultProviderProfile(profileName: string | null): Promise<void> {
    return this.providerManager.setDefaultProfile(profileName);
  }

  async sendCurrentSettings(host: WebviewHost, permissionHandler: PermissionHandler): Promise<void> {
    return this.configManager.sendCurrentSettings(host, permissionHandler);
  }

  async sendAvailableModels(session: ClaudeSession, host: WebviewHost): Promise<void> {
    return this.configManager.sendAvailableModels(session, host);
  }

  async sendSupportedCommands(session: ClaudeSession, host: WebviewHost): Promise<void> {
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

  setActiveModelForPanel(panelId: string, model: string): boolean {
    return this.modelManager.setActiveModelForPanel(panelId, model);
  }

  async setDefaultModel(model: string): Promise<void> {
    return this.modelManager.setDefaultModel(model);
  }

  sendModelForPanel(host: WebviewHost, panelId: string): void {
    this.modelManager.sendModelForPanel(host, panelId);
  }

  initPanelBetas(panelId: string): void {
    this.betaManager.initPanelBetas(panelId);
  }

  cleanupPanelBetas(panelId: string): void {
    this.betaManager.cleanupPanelBetas(panelId);
  }

  getActiveBetasForPanel(panelId: string): string[] {
    return this.betaManager.getActiveBetasForPanel(panelId);
  }

  setActiveBetasForPanel(panelId: string, betas: string[]): void {
    this.betaManager.setActiveBetasForPanel(panelId, betas);
  }

  async toggleBetaForPanel(panelId: string, beta: string, enabled: boolean): Promise<void> {
    await this.betaManager.toggleBetaForPanel(panelId, beta, enabled);
  }

  sendBetasForPanel(host: WebviewHost, panelId: string): void {
    this.betaManager.sendBetasForPanel(host, panelId);
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

  async handleSetPermissionMode(
    session: ClaudeSession,
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

  initPanelStrategy(panelId: string): void {
    this.contextStrategyManager.initPanelStrategy(panelId);
  }

  cleanupPanelStrategy(panelId: string): void {
    this.contextStrategyManager.cleanupPanelStrategy(panelId);
  }

  getActiveStrategyForPanel(panelId: string): ContextStrategy {
    return this.contextStrategyManager.getActiveStrategyForPanel(panelId);
  }

  setActiveStrategyForPanel(panelId: string, strategy: ContextStrategy): boolean {
    return this.contextStrategyManager.setActiveStrategyForPanel(panelId, strategy);
  }

  async setDefaultStrategy(strategy: ContextStrategy): Promise<void> {
    return this.contextStrategyManager.setDefaultStrategy(strategy);
  }

  sendStrategyForPanel(host: WebviewHost, panelId: string): void {
    this.contextStrategyManager.sendStrategyForPanel(host, panelId);
  }

  buildRecallConfig(panelId: string): RecallConfig {
    return this.contextStrategyManager.buildRecallConfig(panelId);
  }

  handleSetDangerouslySkipPermissions(permissionHandler: PermissionHandler, enabled: boolean): void {
    this.configManager.handleSetDangerouslySkipPermissions(permissionHandler, enabled);
  }

  setFastModeGetter(getter: () => boolean): void {
    this.configManager.setFastModeGetter(getter);
  }

  handleSetFastMode(session: ClaudeSession, enabled: boolean): void {
    this.configManager.handleSetFastMode(session, enabled);
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

  sendExploreConfig(host: WebviewHost): void {
    this.exploreManager.sendExploreConfig(host);
  }
}
