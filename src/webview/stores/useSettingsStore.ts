import { ref } from 'vue';
import { defineStore } from 'pinia';
import { DEFAULT_THINKING_TOKENS } from '@shared/types/constants';
import type { ExtensionSettings, ModelInfo, AccountInfo, PermissionMode, ContextStrategy, ProviderProfile, AutoCompactConfig, ContextWarningLevel, ReasoningEffort } from '@shared/types/settings';
import type { McpServerStatusInfo } from '@shared/types/mcp';
import type { PluginStatusInfo } from '@shared/types/plugins';
import type { VoiceConfig } from '@shared/types/voice';

const DEFAULT_AUTO_COMPACT: AutoCompactConfig = {
  enabled: false,
  warningThreshold: 60,
  softThreshold: 70,
  hardThreshold: 75,
};

const DEFAULT_SETTINGS: ExtensionSettings = {
  maxTurns: 50,
  maxBudgetUsd: null,
  maxThinkingTokens: DEFAULT_THINKING_TOKENS,
  thinkingDisabled: false,
  effort: null,
  permissionMode: 'default',
  defaultPermissionMode: 'default',
  enableFileCheckpointing: true,
  sandbox: { enabled: false },
  autoCompact: DEFAULT_AUTO_COMPACT,
  dangerouslySkipPermissions: false,
};

export interface BudgetWarningState {
  currentSpend: number;
  limit: number;
  exceeded: boolean;
}

export interface ContextWarningState {
  level: ContextWarningLevel;
  autoCompactTriggered: boolean;
}

export const useSettingsStore = defineStore('settings', () => {
  const currentSettings = ref<ExtensionSettings>({ ...DEFAULT_SETTINGS });
  const availableModels = ref<ModelInfo[]>([]);
  const accountInfo = ref<AccountInfo | null>(null);
  const mcpServers = ref<McpServerStatusInfo[]>([]);
  const plugins = ref<PluginStatusInfo[]>([]);
  const budgetWarning = ref<BudgetWarningState | null>(null);
  const contextWarning = ref<ContextWarningState | null>(null);
  const providerProfiles = ref<ProviderProfile[]>([]);
  const activeProviderProfile = ref<string | null>(null);
  const defaultProviderProfile = ref<string | null>(null);
  const activeModel = ref<string>("");
  const defaultModel = ref<string>("");
  const activeBetas = ref<string[]>([]);
  const activeContextStrategy = ref<ContextStrategy>("default");
  const defaultContextStrategy = ref<ContextStrategy>("default");
  const distillTokenBudget = ref<number>(4000);
  const voiceConfig = ref<VoiceConfig>({ provider: "openai-whisper", language: "en" });
  const voiceHasApiKey = ref(false);

  function updateSettings(settings: ExtensionSettings) {
    currentSettings.value = settings;
  }

  function setPermissionMode(mode: PermissionMode) {
    currentSettings.value.permissionMode = mode;
  }

  function setMaxThinkingTokens(tokens: number | null) {
    currentSettings.value.maxThinkingTokens = tokens;
  }

  function setThinkingDisabled(disabled: boolean) {
    currentSettings.value.thinkingDisabled = disabled;
  }

  function setEffort(effort: ReasoningEffort | null) {
    currentSettings.value.effort = effort;
  }

  function setBudgetLimit(budgetUsd: number | null) {
    currentSettings.value.maxBudgetUsd = budgetUsd;
  }

  function setBetaState(active: string[]) {
    activeBetas.value = active;
  }

  function setDefaultPermissionMode(mode: PermissionMode) {
    currentSettings.value.defaultPermissionMode = mode;
  }

  function setDangerouslySkipPermissions(enabled: boolean) {
    currentSettings.value.dangerouslySkipPermissions = enabled;
  }

  function setContextStrategyState(active: ContextStrategy, newDefault: ContextStrategy, tokenBudget: number) {
    activeContextStrategy.value = active;
    defaultContextStrategy.value = newDefault;
    distillTokenBudget.value = tokenBudget;
  }

  function setAvailableModels(models: ModelInfo[]) {
    availableModels.value = models;
  }

  function setAccountInfo(info: AccountInfo | null) {
    if (info === null) {
      accountInfo.value = null;
    } else {
      accountInfo.value = { ...accountInfo.value, ...info };
    }
  }

  function setMcpServers(servers: McpServerStatusInfo[]) {
    mcpServers.value = servers;
  }

  function updateMcpServerStatuses(sdkStatuses: { name: string; status: string }[]) {
    const statusMap = new Map(sdkStatuses.map(s => [s.name, s.status]));
    mcpServers.value = mcpServers.value.map(server => ({
      ...server,
      status: server.enabled
        ? (statusMap.get(server.name) as McpServerStatusInfo["status"]) || server.status
        : "disabled",
    }));
  }

  function setPlugins(newPlugins: PluginStatusInfo[]) {
    plugins.value = newPlugins;
  }

  function updatePluginStatuses(sdkPlugins: { name: string; path: string; version?: string; description?: string }[]) {
    const statusMap = new Map(sdkPlugins.map(p => [p.name, p]));
    plugins.value = plugins.value.map(plugin => {
      const sdkPlugin = statusMap.get(plugin.name);
      return {
        ...plugin,
        status: plugin.enabled
          ? (sdkPlugin ? "loaded" : plugin.status)
          : "disabled",
        version: sdkPlugin?.version ?? plugin.version,
        description: sdkPlugin?.description ?? plugin.description,
      } as PluginStatusInfo;
    });
  }

  function setBudgetWarning(currentSpend: number, limit: number, exceeded: boolean) {
    budgetWarning.value = { currentSpend, limit, exceeded };
  }

  function dismissBudgetWarning() {
    budgetWarning.value = null;
  }

  function setContextWarning(level: ContextWarningLevel) {
    if (level === 'none') {
      contextWarning.value = null;
    } else {
      contextWarning.value = {
        level,
        autoCompactTriggered: contextWarning.value?.autoCompactTriggered ?? false,
      };
    }
  }

  function setAutoCompactTriggered() {
    if (contextWarning.value) {
      contextWarning.value = { ...contextWarning.value, autoCompactTriggered: true };
    }
  }

  function clearAutoCompactTriggered() {
    if (contextWarning.value) {
      contextWarning.value = { ...contextWarning.value, autoCompactTriggered: false };
    }
  }

  function dismissContextWarning() {
    contextWarning.value = null;
  }

  function updateAutoCompactConfig(config: AutoCompactConfig) {
    currentSettings.value.autoCompact = config;
  }

  function setProviderProfiles(profiles: ProviderProfile[], active: string | null, defaultProfile: string | null) {
    providerProfiles.value = profiles;
    activeProviderProfile.value = active;
    defaultProviderProfile.value = defaultProfile;
  }

  function setModelState(active: string, newDefault: string) {
    activeModel.value = active;
    defaultModel.value = newDefault;
  }

  function setVoiceConfig(config: VoiceConfig, hasApiKey: boolean) {
    voiceConfig.value = config;
    voiceHasApiKey.value = hasApiKey;
  }

  function $reset() {
    currentSettings.value = { ...DEFAULT_SETTINGS };
    availableModels.value = [];
    accountInfo.value = null;
    mcpServers.value = [];
    plugins.value = [];
    budgetWarning.value = null;
    contextWarning.value = null;
    providerProfiles.value = [];
    activeProviderProfile.value = null;
    defaultProviderProfile.value = null;
    activeModel.value = "";
    defaultModel.value = "";
    activeBetas.value = [];
    activeContextStrategy.value = "default";
    defaultContextStrategy.value = "default";
    distillTokenBudget.value = 4000;
    voiceConfig.value = { provider: "openai-whisper", language: "en" };
    voiceHasApiKey.value = false;
  }

  return {
    currentSettings,
    availableModels,
    accountInfo,
    mcpServers,
    plugins,
    budgetWarning,
    contextWarning,
    providerProfiles,
    activeProviderProfile,
    defaultProviderProfile,
    activeModel,
    defaultModel,
    activeBetas,
    activeContextStrategy,
    defaultContextStrategy,
    distillTokenBudget,
    updateSettings,
    setPermissionMode,
    setMaxThinkingTokens,
    setThinkingDisabled,
    setEffort,
    setBudgetLimit,
    setBetaState,
    setDefaultPermissionMode,
    setDangerouslySkipPermissions,
    setContextStrategyState,
    setAvailableModels,
    setAccountInfo,
    setMcpServers,
    updateMcpServerStatuses,
    setPlugins,
    updatePluginStatuses,
    setBudgetWarning,
    dismissBudgetWarning,
    setContextWarning,
    setAutoCompactTriggered,
    clearAutoCompactTriggered,
    dismissContextWarning,
    updateAutoCompactConfig,
    setProviderProfiles,
    setModelState,
    voiceConfig,
    voiceHasApiKey,
    setVoiceConfig,
    $reset,
  };
});
