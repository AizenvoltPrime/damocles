import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { ExtensionSettings, ModelInfo, AccountInfo, PermissionMode, ContextStrategy, ProviderProfile, AutoCompactConfig, ContextWarningLevel, FastModeState, PanelThinkingState } from '@shared/types/settings';
import type { McpServerStatusInfo } from '@shared/types/mcp';
import type { PluginStatusInfo } from '@shared/types/plugins';
import type { VoiceConfig } from '@shared/types/voice';
import { DEFAULT_MODELS } from '@shared/types/constants';

const DEFAULT_AUTO_COMPACT: AutoCompactConfig = {
  enabled: false,
  warningThreshold: 60,
  softThreshold: 70,
  hardThreshold: 75,
};

const DEFAULT_SETTINGS: ExtensionSettings = {
  maxTurns: 50,
  maxBudgetUsd: null,
  taskBudget: null,
  permissionMode: 'default',
  defaultPermissionMode: 'default',
  enableFileCheckpointing: true,
  sandbox: { enabled: false },
  autoCompact: DEFAULT_AUTO_COMPACT,
  dangerouslySkipPermissions: false,
  fastMode: false,
  pinnedHeaderHidden: false,
  worktreeBaseRef: 'head',
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
  const baseAvailableModels = ref<ModelInfo[]>([]);

  const availableModels = computed<ModelInfo[]>(() => {
    return baseAvailableModels.value.length > 0 ? baseAvailableModels.value : DEFAULT_MODELS;
  });
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
  const panelThinking = ref<PanelThinkingState | null>(null);
  const panelThinkingModel = ref<string>("");
  const defaultThinking = ref<PanelThinkingState | null>(null);
  const defaultThinkingModel = ref<string>("");
  const voiceConfig = ref<VoiceConfig>({ provider: "openai-whisper", language: "en" });
  const voiceHasApiKey = ref(false);
  const exploreHasApiKey = ref(false);
  const exploreProvider = ref('openrouter');
  const exploreModel = ref('');
  const fastModeState = ref<FastModeState>('off');
  const authStatus = ref<{ isAuthenticating: boolean; error?: string } | null>(null);
  const openaiAuthStatus = ref<{
    codex: { signedIn: boolean; accountId?: string; expiresAt?: number };
    apikey: { configured: boolean };
  }>({ codex: { signedIn: false }, apikey: { configured: false } });
  const openaiPreferApiKey = ref(false);
  const openaiCodexAuthInFlight = ref(false);
  const openaiCodexAuthError = ref<string | null>(null);
  const pendingOpenAIModel = ref<string | null>(null);
  const openaiModelPricing = ref<Record<string, { input: number; cachedInput: number; output: number; reasoning: number }>>({});

  function updateSettings(settings: ExtensionSettings) {
    currentSettings.value = settings;
  }

  function setPermissionMode(mode: PermissionMode) {
    currentSettings.value.permissionMode = mode;
  }

  function setPinnedHeaderHidden(hidden: boolean) {
    currentSettings.value.pinnedHeaderHidden = hidden;
  }

  function setPanelThinking(state: PanelThinkingState, model: string) {
    panelThinking.value = state;
    panelThinkingModel.value = model;
  }

  function setDefaultThinking(state: PanelThinkingState, model: string) {
    defaultThinking.value = state;
    defaultThinkingModel.value = model;
  }

  function setBudgetLimit(budgetUsd: number | null) {
    currentSettings.value.maxBudgetUsd = budgetUsd;
  }

  function setTaskBudget(budget: number | null) {
    currentSettings.value.taskBudget = budget;
  }

  function setBetaState(active: string[]) {
    activeBetas.value = active;
  }

  function setDefaultPermissionMode(mode: PermissionMode) {
    currentSettings.value.defaultPermissionMode = mode;
  }

  function setWorktreeBaseRef(baseRef: 'fresh' | 'head') {
    currentSettings.value.worktreeBaseRef = baseRef;
  }

  function setDangerouslySkipPermissions(enabled: boolean) {
    currentSettings.value.dangerouslySkipPermissions = enabled;
  }

  function setContextStrategyState(active: ContextStrategy, newDefault: ContextStrategy) {
    activeContextStrategy.value = active;
    defaultContextStrategy.value = newDefault;
  }

  function setAvailableModels(models: ModelInfo[]) {
    baseAvailableModels.value = models;
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

  function setExploreHasApiKey(hasKey: boolean) {
    exploreHasApiKey.value = hasKey;
  }

  function setExploreConfig(provider: string, model: string) {
    exploreProvider.value = provider;
    exploreModel.value = model;
  }

  function setFastModeState(state: FastModeState) {
    fastModeState.value = state;
  }

  function setAuthStatus(status: { isAuthenticating: boolean; error?: string } | null) {
    authStatus.value = status;
  }

  function setOpenAIAuthStatus(
    status: { codex: { signedIn: boolean; accountId?: string; expiresAt?: number }; apikey: { configured: boolean } },
    preferApiKey: boolean
  ) {
    openaiAuthStatus.value = status;
    openaiPreferApiKey.value = preferApiKey;
  }

  function setCodexAuthInFlight(value: boolean) {
    openaiCodexAuthInFlight.value = value;
    if (value) openaiCodexAuthError.value = null;
  }

  function setCodexAuthError(error: string | null) {
    openaiCodexAuthError.value = error;
  }

  function setPendingOpenAIModel(model: string | null) {
    pendingOpenAIModel.value = model;
  }

  function setOpenAIModelPricing(pricing: Record<string, { input: number; cachedInput: number; output: number; reasoning: number }>) {
    openaiModelPricing.value = pricing ?? {};
  }

  function $reset() {
    currentSettings.value = { ...DEFAULT_SETTINGS };
    baseAvailableModels.value = [];
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
    panelThinking.value = null;
    panelThinkingModel.value = "";
    defaultThinking.value = null;
    defaultThinkingModel.value = "";
    voiceConfig.value = { provider: "openai-whisper", language: "en" };
    voiceHasApiKey.value = false;
    exploreHasApiKey.value = false;
    exploreProvider.value = 'openrouter';
    exploreModel.value = '';
    fastModeState.value = 'off';
    authStatus.value = null;
    openaiAuthStatus.value = { codex: { signedIn: false }, apikey: { configured: false } };
    openaiPreferApiKey.value = false;
    openaiCodexAuthInFlight.value = false;
    openaiCodexAuthError.value = null;
    pendingOpenAIModel.value = null;
    openaiModelPricing.value = {};
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
    panelThinking,
    panelThinkingModel,
    defaultThinking,
    defaultThinkingModel,
    updateSettings,
    setPermissionMode,
    setPinnedHeaderHidden,
    setPanelThinking,
    setDefaultThinking,
    setBudgetLimit,
    setTaskBudget,
    setBetaState,
    setDefaultPermissionMode,
    setWorktreeBaseRef,
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
    exploreHasApiKey,
    exploreProvider,
    exploreModel,
    setExploreHasApiKey,
    setExploreConfig,
    fastModeState,
    setFastModeState,
    authStatus,
    setAuthStatus,
    openaiAuthStatus,
    openaiPreferApiKey,
    openaiCodexAuthInFlight,
    openaiCodexAuthError,
    pendingOpenAIModel,
    setOpenAIAuthStatus,
    setCodexAuthInFlight,
    setCodexAuthError,
    setPendingOpenAIModel,
    openaiModelPricing,
    setOpenAIModelPricing,
    $reset,
  };
});
