import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { ExtensionSettings, ModelInfo, AccountInfo, PermissionMode, AutoCompactConfig, ContextWarningLevel, PanelThinkingState } from '@shared/types/settings';
import type { McpConfigError, McpServerStatusInfo, McpWriteErrorInfo } from '@shared/types/mcp';
import type { ToolsSnapshot } from '@shared/types/tools';
import type { VoiceConfig } from '@shared/types/voice';
import { DEFAULT_MODELS } from '@shared/types/constants';

const DEFAULT_AUTO_COMPACT: AutoCompactConfig = {
  enabled: false,
  triggerPercent: 80,
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
  defaultDangerouslySkipPermissions: false,
  ideContextEnabled: true,
  pinnedHeaderHidden: false,
  worktreeBaseRef: 'head',
  team: { leadModel: '', leadEffort: null, implementorModel: '', implementorEffort: null, reviewerModel: '', reviewerEffort: null },
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

/**
 * Statuses that can only come from the live MCP client. Anything else is derived from config alone
 * and must not survive a config reload.
 */
const LIVE_MCP_STATUSES = new Set<McpServerStatusInfo["status"]>([
  "connected",
  "failed",
  "needs-auth",
  "pending",
]);

export const useSettingsStore = defineStore('settings', () => {
  const currentSettings = ref<ExtensionSettings>({ ...DEFAULT_SETTINGS });
  const baseAvailableModels = ref<ModelInfo[]>([]);

  const availableModels = computed<ModelInfo[]>(() => {
    return baseAvailableModels.value.length > 0 ? baseAvailableModels.value : DEFAULT_MODELS;
  });
  const accountInfo = ref<AccountInfo | null>(null);
  const mcpServers = ref<McpServerStatusInfo[]>([]);
  /** Live `damocles.mcp.enabled` — the MCP-panel master switch. */
  const mcpEnabled = ref<boolean>(true);
  /** MCP config files that exist but do not parse, so their servers are missing from the list. */
  const mcpConfigErrors = ref<McpConfigError[]>([]);
  /** The requestId of the MCP write awaiting acknowledgement, or null. */
  const mcpWriteRequestId = ref<string | null>(null);
  const mcpWriteError = ref<McpWriteErrorInfo | null>(null);
  const toolsSnapshot = ref<ToolsSnapshot>({ groups: [], tools: [] });
  /** Whether the workspace is trusted — when false, project-scope subagents/skills are disabled (US-022). */
  const projectTrusted = ref<boolean>(true);
  const budgetWarning = ref<BudgetWarningState | null>(null);
  const contextWarning = ref<ContextWarningState | null>(null);
  const activeModel = ref<string>("");
  const defaultModel = ref<string>("");
  const panelThinking = ref<PanelThinkingState | null>(null);
  const panelThinkingModel = ref<string>("");
  const defaultThinking = ref<PanelThinkingState | null>(null);
  const defaultThinkingModel = ref<string>("");
  const voiceConfig = ref<VoiceConfig>({ provider: "openai-whisper", language: "en" });
  const voiceHasApiKey = ref(false);
  const exploreHasApiKey = ref(false);
  const exploreProvider = ref('openrouter');
  const exploreModel = ref('');
  const exploreEffort = ref('');
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
  const claudeAuthMode = ref<"none" | "apikey" | "allowance" | "extra">("none");
  const claudeAuthBusy = ref(false);
  const claudeAuthError = ref<string | null>(null);
  const stepfunConfigured = ref(false);
  const deepseekConfigured = ref(false);

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

  function setDefaultPermissionMode(mode: PermissionMode) {
    currentSettings.value.defaultPermissionMode = mode;
  }

  function setWorktreeBaseRef(baseRef: 'fresh' | 'head') {
    currentSettings.value.worktreeBaseRef = baseRef;
  }

  function setDangerouslySkipPermissions(enabled: boolean) {
    currentSettings.value.dangerouslySkipPermissions = enabled;
  }

  function setDefaultDangerouslySkipPermissions(enabled: boolean) {
    currentSettings.value.defaultDangerouslySkipPermissions = enabled;
  }

  function setIdeContextEnabledDefault(enabled: boolean) {
    currentSettings.value.ideContextEnabled = enabled;
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

  /**
   * Apply a config-only server list (`mcpConfigUpdate`), which describes every enabled server as
   * `idle` because it is built without consulting the live client. Observed runtime state is carried
   * over so a config reload does not blank every server's connection until the next `mcpServerStatus`.
   *
   * The new payload is the base and only the RUNTIME fields below are carried over. Spreading the old
   * entry underneath cannot express "this field is now gone" — every config field is optional — which
   * matters most for `editableConfig`: the extension withholds it precisely so Edit stops being
   * offered, and a resurrected copy reopens the "Edit destroys what it cannot show" hole.
   */
  function reconcileMcpServers(servers: McpServerStatusInfo[]) {
    const previous = new Map(mcpServers.value.map(s => [s.name, s]));
    mcpServers.value = servers.map(server => {
      const prior = previous.get(server.name);
      if (!prior || server.status !== "idle" || !LIVE_MCP_STATUSES.has(prior.status)) return server;
      const merged: McpServerStatusInfo = { ...server, status: prior.status };
      if (prior.tools !== undefined) merged.tools = prior.tools;
      if (prior.serverInfo !== undefined) merged.serverInfo = prior.serverInfo;
      if (prior.error !== undefined) merged.error = prior.error;
      // `supportsOAuth` is deliberately NOT carried. It is runtime-derived, and a server just edited
      // from remote to stdio would keep offering Re-authenticate — an action that cannot work. Losing
      // the affordance for the moment before the next status message costs nothing by comparison.
      return merged;
    });
  }

  function setMcpConfigErrors(errors: McpConfigError[]) {
    mcpConfigErrors.value = errors;
  }

  /** A write has been sent; the form stays open and disabled until `settleMcpWrite` matches it. */
  function beginMcpWrite(requestId: string) {
    mcpWriteRequestId.value = requestId;
    mcpWriteError.value = null;
  }

  /**
   * Apply an acknowledgement. A stale one is ignored: only the request currently in flight may
   * settle it, or a late reply to an abandoned attempt would close a form the user has reopened.
   */
  function settleMcpWrite(requestId: string, error: McpWriteErrorInfo | null) {
    if (mcpWriteRequestId.value !== requestId) return;
    mcpWriteRequestId.value = null;
    mcpWriteError.value = error;
  }

  function setMcpEnabled(enabled: boolean) {
    mcpEnabled.value = enabled;
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

  function setToolsSnapshot(snapshot: ToolsSnapshot) {
    toolsSnapshot.value = snapshot;
  }

  function setProjectTrusted(trusted: boolean) {
    projectTrusted.value = trusted;
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

  function setExploreConfig(provider: string, model: string, effort: string) {
    exploreProvider.value = provider;
    exploreModel.value = model;
    exploreEffort.value = effort;
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

  function setClaudeAuthMode(mode: "none" | "apikey" | "allowance" | "extra") {
    claudeAuthMode.value = mode;
  }

  function setClaudeAuthBusy(value: boolean) {
    claudeAuthBusy.value = value;
    if (value) claudeAuthError.value = null;
  }

  function setClaudeAuthError(error: string | null) {
    claudeAuthError.value = error;
  }

  function setStepfunConfigured(configured: boolean) {
    stepfunConfigured.value = configured;
  }

  function setDeepseekConfigured(configured: boolean) {
    deepseekConfigured.value = configured;
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
    mcpEnabled.value = true;
    toolsSnapshot.value = { groups: [], tools: [] };
    budgetWarning.value = null;
    contextWarning.value = null;
    activeModel.value = "";
    defaultModel.value = "";
    panelThinking.value = null;
    panelThinkingModel.value = "";
    defaultThinking.value = null;
    defaultThinkingModel.value = "";
    voiceConfig.value = { provider: "openai-whisper", language: "en" };
    voiceHasApiKey.value = false;
    exploreHasApiKey.value = false;
    exploreProvider.value = 'openrouter';
    exploreModel.value = '';
    exploreEffort.value = '';
    authStatus.value = null;
    openaiAuthStatus.value = { codex: { signedIn: false }, apikey: { configured: false } };
    openaiPreferApiKey.value = false;
    openaiCodexAuthInFlight.value = false;
    openaiCodexAuthError.value = null;
    claudeAuthMode.value = "none";
    claudeAuthBusy.value = false;
    claudeAuthError.value = null;
    stepfunConfigured.value = false;
    deepseekConfigured.value = false;
    pendingOpenAIModel.value = null;
    openaiModelPricing.value = {};
  }

  return {
    currentSettings,
    availableModels,
    accountInfo,
    mcpServers,
    mcpConfigErrors,
    mcpWriteRequestId,
    mcpWriteError,
    mcpEnabled,
    toolsSnapshot,
    projectTrusted,
    budgetWarning,
    contextWarning,
    activeModel,
    defaultModel,
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
    setDefaultPermissionMode,
    setWorktreeBaseRef,
    setDangerouslySkipPermissions,
    setDefaultDangerouslySkipPermissions,
    setIdeContextEnabledDefault,
    setAvailableModels,
    setAccountInfo,
    setMcpServers,
    reconcileMcpServers,
    setMcpConfigErrors,
    beginMcpWrite,
    settleMcpWrite,
    setMcpEnabled,
    updateMcpServerStatuses,
    setToolsSnapshot,
    setProjectTrusted,
    setBudgetWarning,
    dismissBudgetWarning,
    setContextWarning,
    setAutoCompactTriggered,
    clearAutoCompactTriggered,
    dismissContextWarning,
    updateAutoCompactConfig,
    setModelState,
    voiceConfig,
    voiceHasApiKey,
    setVoiceConfig,
    exploreHasApiKey,
    exploreProvider,
    exploreModel,
    exploreEffort,
    setExploreHasApiKey,
    setExploreConfig,
    authStatus,
    setAuthStatus,
    openaiAuthStatus,
    openaiPreferApiKey,
    openaiCodexAuthInFlight,
    openaiCodexAuthError,
    claudeAuthMode,
    claudeAuthBusy,
    claudeAuthError,
    stepfunConfigured,
    deepseekConfigured,
    setStepfunConfigured,
    setDeepseekConfigured,
    pendingOpenAIModel,
    setOpenAIAuthStatus,
    setCodexAuthInFlight,
    setCodexAuthError,
    setClaudeAuthMode,
    setClaudeAuthBusy,
    setClaudeAuthError,
    setPendingOpenAIModel,
    openaiModelPricing,
    setOpenAIModelPricing,
    $reset,
  };
});
