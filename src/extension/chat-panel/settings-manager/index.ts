import type { ClaudeSession } from "../../claude-session";
import type { PermissionHandler } from "../../permission-handler";
import type { PluginService } from "../../PluginService";
import type { WebviewHost } from "../types";
import type { McpServerConfig, McpServerStatusInfo } from "../../../shared/types/mcp";
import type { PluginConfig, PluginStatusInfo } from "../../../shared/types/plugins";
import type { PermissionMode, ContextStrategy, ProviderProfile } from "../../../shared/types/settings";
import { McpManager } from "./managers/mcp-manager";
import { PluginManager } from "./managers/plugin-manager";
import { ProviderManager } from "./managers/provider-manager";
import { ConfigManager } from "./managers/config-manager";
import { ModelManager } from "./managers/model-manager";
import { BetaManager } from "./managers/beta-manager";
import type { SettingsManagerConfig } from "./types";

export type { SettingsManagerConfig };

export class SettingsManager {
  private readonly mcpManager: McpManager;
  private readonly pluginManager: PluginManager;
  private readonly providerManager: ProviderManager;
  private readonly configManager: ConfigManager;
  private readonly modelManager: ModelManager;
  private readonly betaManager: BetaManager;

  constructor(config: SettingsManagerConfig) {
    this.mcpManager = new McpManager(config.postMessage);
    this.pluginManager = new PluginManager(config.postMessage);
    this.providerManager = new ProviderManager(config.postMessage, config.secrets);
    this.configManager = new ConfigManager(config.postMessage);
    this.modelManager = new ModelManager(config.postMessage);
    this.betaManager = new BetaManager(
      config.postMessage,
      (panelId) => this.modelManager.getActiveModelForPanel(panelId),
    );
  }

  setOnMcpConfigChange(callback: () => void): void {
    this.mcpManager.setOnConfigChange(callback);
  }

  setupMcpWatcher(workspacePath: string): void {
    this.mcpManager.setupWatcher(workspacePath);
  }

  dispose(): void {
    this.mcpManager.dispose();
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

  async sendMcpStatus(session: ClaudeSession, host: WebviewHost): Promise<void> {
    return this.mcpManager.sendStatus(session, host);
  }

  sendMcpConfig(host: WebviewHost): void {
    this.mcpManager.sendConfig(host);
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

  toggleBetaForPanel(panelId: string, beta: string, enabled: boolean): void {
    this.betaManager.toggleBetaForPanel(panelId, beta, enabled);
  }

  sendBetasForPanel(host: WebviewHost, panelId: string): void {
    this.betaManager.sendBetasForPanel(host, panelId);
  }

  handleModelBetaCleanupForPanel(panelId: string): void {
    this.betaManager.handleModelBetaCleanupForPanel(panelId);
  }

  async handleSetMaxThinkingTokens(session: ClaudeSession, tokens: number | null): Promise<void> {
    return this.configManager.handleSetMaxThinkingTokens(session, tokens);
  }

  async handleSetBudgetLimit(budgetUsd: number | null): Promise<void> {
    return this.configManager.handleSetBudgetLimit(budgetUsd);
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

  async handleSetContextStrategy(strategy: ContextStrategy): Promise<void> {
    return this.configManager.handleSetContextStrategy(strategy);
  }

  handleSetDangerouslySkipPermissions(permissionHandler: PermissionHandler, enabled: boolean): void {
    this.configManager.handleSetDangerouslySkipPermissions(permissionHandler, enabled);
  }
}
