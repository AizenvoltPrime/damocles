import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { ExtensionSettings, ModelInfo, AccountInfo, PermissionMode, AutoCompactConfig, CacheWarmingMode, ContextWarningLevel, PanelThinkingState, MemoryJudge, ImageGenerationSettings } from '@shared/types/settings';
import type { McpConfigError, McpRenamedToolRuleNotice, McpServerStatusInfo, McpToolExposureScope, McpWriteErrorInfo } from '@shared/types/mcp';
import type { ToolsSnapshot } from '@shared/types/tools';
import type { VoiceConfig } from '@shared/types/voice';
import type { WorkspaceFolderInfo } from '@shared/types/workspace-folders';
import { VSCODE_HOST_CAPABILITIES, type ExtensionToWebviewMessage, type HostCapabilities, type SettingSource } from '@shared/types/messages';
import {
  DEFAULT_TTS_VOICE,
  DEFAULT_WAKE_SENSITIVITY,
  DEFAULT_END_OF_TURN_MS,
  DEFAULT_MAX_UTTERANCE_MS,
} from '@shared/types/voice';
import { DEFAULT_MODELS, DEFAULT_CACHE_WARMING } from '@shared/types/constants';
import { usePlatformBridge } from '@/composables/usePlatformBridge';

/**
 * Placeholder held until the host's first `voiceConfigUpdate`. Mirrors the `damocles.voice.*`
 * defaults declared in package.json, so a read that lands before that message sees the setting the
 * user actually has rather than `undefined`.
 */
const INITIAL_VOICE_CONFIG: VoiceConfig = {
  provider: 'openai-whisper',
  language: 'en',
  mode: 'off',
  wakeWord: 'hey_jarvis',
  wakeWordSensitivity: DEFAULT_WAKE_SENSITIVITY,
  ttsEnabled: false,
  ttsVoice: DEFAULT_TTS_VOICE,
  localGpu: 'auto',
  endOfTurnSilenceMs: DEFAULT_END_OF_TURN_MS,
  maxUtteranceMs: DEFAULT_MAX_UTTERANCE_MS,
  autoSubmit: true,
  diagnostics: false,
};

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
  cacheWarming: DEFAULT_CACHE_WARMING,
  dangerouslySkipPermissions: false,
  defaultDangerouslySkipPermissions: false,
  ideContextEnabled: true,
  pinnedHeaderHidden: false,
  checkpointRetentionDays: 30,
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

type OpenAIAuthStatusView = Extract<ExtensionToWebviewMessage, { type: "openaiAuthStatusChanged" }>["status"];

function signedOutOpenAIStatus(): OpenAIAuthStatusView {
  return { chatgpt: { signedIn: false }, codex: { signedIn: false }, apikey: { configured: false } };
}

export const useSettingsStore = defineStore('settings', () => {
  const { postMessage } = usePlatformBridge();
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
  /** True when `<ws>/.damocles/mcp.local.json` exists and git does not ignore it. */
  const mcpLocalUnignored = ref<boolean>(false);
  /** The settings scopes a per-tool MCP exposure can be saved to in this panel's folder, lowest first. */
  const mcpToolExposureScopes = ref<McpToolExposureScope[]>(["user"]);
  /** Rules in files Damocles must not rewrite that still name renamed MCP tools. The host sends each once. */
  const mcpRenamedToolRules = ref<McpRenamedToolRuleNotice[]>([]);
  /**
   * Counts applied `mcpConfigUpdate` payloads. `mcpReloadConfig` carries no requestId and the reply
   * usually renders identically to what is on screen, so this counter is what tells the panel a
   * reload it asked for came back.
   */
  const mcpConfigRevision = ref<number>(0);
  /** The requestId of the MCP write awaiting acknowledgement, or null. */
  const mcpWriteRequestId = ref<string | null>(null);
  const mcpWriteError = ref<McpWriteErrorInfo | null>(null);
  const toolsSnapshot = ref<ToolsSnapshot>({ groups: [], tools: [] });
  /** Whether the workspace is trusted — when false, project-scope subagents/skills are disabled (US-022). */
  const projectTrusted = ref<boolean>(true);
  const hostCapabilities = ref<HostCapabilities>({ ...VSCODE_HOST_CAPABILITIES });
  // damocles.* key -> the .damocles file supplying its effective value; empty unless hostCapabilities.settingsSources.
  const settingSources = ref<Record<string, SettingSource>>({});
  // False in an untrusted folder, whose Workspace section core refuses to write.
  const workspaceWritable = ref<boolean>(true);
  const voiceControlsAvailable = computed(() => hostCapabilities.value.voice || hostCapabilities.value.hostSpeechExtensions);
  const budgetWarning = ref<BudgetWarningState | null>(null);
  const contextWarning = ref<ContextWarningState | null>(null);
  const activeModel = ref<string>("");
  const defaultModel = ref<string>("");
  const panelThinking = ref<PanelThinkingState | null>(null);
  const panelThinkingModel = ref<string>("");
  const defaultThinking = ref<PanelThinkingState | null>(null);
  const defaultThinkingModel = ref<string>("");
  const voiceConfig = ref<VoiceConfig>({ ...INITIAL_VOICE_CONFIG });
  const voiceHasApiKey = ref(false);
  const exploreHasApiKey = ref(false);
  const exploreProvider = ref('openrouter');
  const exploreModel = ref('');
  const exploreEffort = ref('');
  const authStatus = ref<{ isAuthenticating: boolean; error?: string } | null>(null);
  const openaiAuthStatus = ref<OpenAIAuthStatusView>(signedOutOpenAIStatus());
  const openaiPreferApiKey = ref(false);
  const openaiChatGPTAuthInFlight = ref(false);
  const openaiChatGPTAuthError = ref<string | null>(null);
  const pendingOpenAIModel = ref<string | null>(null);
  const claudeAuthMode = ref<"none" | "apikey" | "allowance" | "extra">("none");
  const claudeAuthBusy = ref(false);
  const claudeAuthError = ref<string | null>(null);
  const claudeSignInWaiting = ref(false);
  const stepfunConfigured = ref(false);
  const deepseekConfigured = ref(false);
  const typesafeConfigured = ref(false);
  const openrouterConfigured = ref(false);
  const memoryJudge = ref<MemoryJudge | null>(null);
  // Null until the host's first `imageGenerationSettings`, which waits for the pi runtime.
  const imageGeneration = ref<ImageGenerationSettings | null>(null);
  const workspaceFolders = ref<WorkspaceFolderInfo[]>([]);
  const panelWorkspaceFolderKey = ref<string>("");
  const defaultWorkspaceFolderKey = ref<string>("");
  const isMultiRoot = computed(() => workspaceFolders.value.length >= 2);
  // The extension answers every setPanelWorkspaceFolder with a workspaceFolderUpdate, which clears this.
  const workspaceFolderSwitchPending = ref(false);

  function updateSettings(settings: ExtensionSettings, sources?: Record<string, SettingSource>) {
    currentSettings.value = settings;
    settingSources.value = sources ?? {};
  }

  function setWorkspaceWritable(writable: boolean) {
    workspaceWritable.value = writable;
  }

  function setHostCapabilities(capabilities: HostCapabilities) {
    hostCapabilities.value = capabilities;
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

  // buildAccountInfo returns a whole snapshot, so it replaces the previous one rather than merging into it.
  function setAccountInfo(info: AccountInfo | null) {
    accountInfo.value = info;
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
    mcpConfigRevision.value += 1;
  }

  function setMcpConfigErrors(errors: McpConfigError[]) {
    mcpConfigErrors.value = errors;
  }

  function setMcpLocalUnignored(unignored: boolean) {
    mcpLocalUnignored.value = unignored;
  }

  function setMcpToolExposureScopes(scopes: McpToolExposureScope[]) {
    mcpToolExposureScopes.value = scopes;
  }

  /** Later notices for a file already on screen join its list, so one file never shows twice. */
  function addMcpRenamedToolRules(notices: McpRenamedToolRuleNotice[]) {
    const merged = mcpRenamedToolRules.value.map((notice) => ({ ...notice, rules: [...notice.rules] }));
    for (const notice of notices) {
      const existing = merged.find((entry) => entry.path === notice.path);
      if (!existing) {
        merged.push({ ...notice, rules: [...notice.rules] });
        continue;
      }
      for (const rule of notice.rules) {
        if (!existing.rules.some((known) => known.old === rule.old)) existing.rules.push(rule);
      }
    }
    mcpRenamedToolRules.value = merged;
  }

  function dismissMcpRenamedToolRules() {
    mcpRenamedToolRules.value = [];
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

  function setCacheWarmingMode(mode: CacheWarmingMode) {
    currentSettings.value.cacheWarming = mode;
  }

  function setTeamSettings(team: ExtensionSettings['team']) {
    currentSettings.value.team = team;
  }

  function setCheckpointRetentionDays(days: number) {
    currentSettings.value.checkpointRetentionDays = days;
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

  function setOpenAIAuthStatus(status: OpenAIAuthStatusView, preferApiKey: boolean) {
    openaiAuthStatus.value = status;
    openaiPreferApiKey.value = preferApiKey;
  }

  function setChatGPTAuthInFlight(value: boolean) {
    openaiChatGPTAuthInFlight.value = value;
    if (value) openaiChatGPTAuthError.value = null;
  }

  function setChatGPTAuthError(error: string | null) {
    openaiChatGPTAuthError.value = error;
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

  function setClaudeSignInWaiting(value: boolean) {
    claudeSignInWaiting.value = value;
  }

  function setStepfunConfigured(configured: boolean) {
    stepfunConfigured.value = configured;
  }

  function setDeepseekConfigured(configured: boolean) {
    deepseekConfigured.value = configured;
  }

  function setTypesafeStatus(configured: boolean, judge: MemoryJudge) {
    typesafeConfigured.value = configured;
    memoryJudge.value = judge;
  }

  function setOpenrouterConfigured(configured: boolean) {
    openrouterConfigured.value = configured;
  }

  function setImageGeneration(settings: ImageGenerationSettings) {
    imageGeneration.value = settings;
  }

  function setWorkspaceFolders(folders: WorkspaceFolderInfo[], panelFolderKey: string, defaultFolderKey: string) {
    workspaceFolders.value = folders;
    panelWorkspaceFolderKey.value = panelFolderKey;
    defaultWorkspaceFolderKey.value = defaultFolderKey;
    workspaceFolderSwitchPending.value = false;
  }

  function requestPanelWorkspaceFolder(folderKey: string) {
    if (workspaceFolderSwitchPending.value || folderKey === panelWorkspaceFolderKey.value) return;
    workspaceFolderSwitchPending.value = true;
    postMessage({ type: 'setPanelWorkspaceFolder', folderKey });
  }

  function setPendingOpenAIModel(model: string | null) {
    pendingOpenAIModel.value = model;
  }

  function $reset() {
    currentSettings.value = { ...DEFAULT_SETTINGS };
    settingSources.value = {};
    workspaceWritable.value = true;
    baseAvailableModels.value = [];
    accountInfo.value = null;
    mcpServers.value = [];
    mcpEnabled.value = true;
    mcpConfigErrors.value = [];
    mcpLocalUnignored.value = false;
    mcpToolExposureScopes.value = ["user"];
    mcpRenamedToolRules.value = [];
    mcpConfigRevision.value = 0;
    mcpWriteRequestId.value = null;
    mcpWriteError.value = null;
    toolsSnapshot.value = { groups: [], tools: [] };
    budgetWarning.value = null;
    contextWarning.value = null;
    activeModel.value = "";
    defaultModel.value = "";
    panelThinking.value = null;
    panelThinkingModel.value = "";
    defaultThinking.value = null;
    defaultThinkingModel.value = "";
    voiceConfig.value = { ...INITIAL_VOICE_CONFIG };
    voiceHasApiKey.value = false;
    exploreHasApiKey.value = false;
    exploreProvider.value = 'openrouter';
    exploreModel.value = '';
    exploreEffort.value = '';
    authStatus.value = null;
    openaiAuthStatus.value = signedOutOpenAIStatus();
    openaiPreferApiKey.value = false;
    openaiChatGPTAuthInFlight.value = false;
    openaiChatGPTAuthError.value = null;
    claudeAuthMode.value = "none";
    claudeAuthBusy.value = false;
    claudeAuthError.value = null;
    claudeSignInWaiting.value = false;
    stepfunConfigured.value = false;
    deepseekConfigured.value = false;
    typesafeConfigured.value = false;
    openrouterConfigured.value = false;
    memoryJudge.value = null;
    imageGeneration.value = null;
    pendingOpenAIModel.value = null;
    workspaceFolders.value = [];
    panelWorkspaceFolderKey.value = "";
    defaultWorkspaceFolderKey.value = "";
    workspaceFolderSwitchPending.value = false;
  }

  return {
    currentSettings,
    availableModels,
    accountInfo,
    mcpServers,
    mcpConfigErrors,
    mcpLocalUnignored,
    mcpToolExposureScopes,
    mcpRenamedToolRules,
    mcpConfigRevision,
    mcpWriteRequestId,
    mcpWriteError,
    mcpEnabled,
    toolsSnapshot,
    projectTrusted,
    hostCapabilities,
    settingSources,
    workspaceWritable,
    setWorkspaceWritable,
    voiceControlsAvailable,
    setHostCapabilities,
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
    setDangerouslySkipPermissions,
    setDefaultDangerouslySkipPermissions,
    setIdeContextEnabledDefault,
    setAvailableModels,
    setAccountInfo,
    setMcpServers,
    reconcileMcpServers,
    setMcpConfigErrors,
    setMcpLocalUnignored,
    setMcpToolExposureScopes,
    addMcpRenamedToolRules,
    dismissMcpRenamedToolRules,
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
    setCacheWarmingMode,
    setCheckpointRetentionDays,
    setTeamSettings,
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
    openaiChatGPTAuthInFlight,
    openaiChatGPTAuthError,
    claudeAuthMode,
    claudeAuthBusy,
    claudeAuthError,
    claudeSignInWaiting,
    stepfunConfigured,
    deepseekConfigured,
    setStepfunConfigured,
    setDeepseekConfigured,
    typesafeConfigured,
    memoryJudge,
    setTypesafeStatus,
    openrouterConfigured,
    setOpenrouterConfigured,
    imageGeneration,
    setImageGeneration,
    pendingOpenAIModel,
    setOpenAIAuthStatus,
    setChatGPTAuthInFlight,
    setChatGPTAuthError,
    setClaudeAuthMode,
    setClaudeAuthBusy,
    setClaudeAuthError,
    setClaudeSignInWaiting,
    setPendingOpenAIModel,
    workspaceFolders,
    panelWorkspaceFolderKey,
    defaultWorkspaceFolderKey,
    isMultiRoot,
    workspaceFolderSwitchPending,
    setWorkspaceFolders,
    requestPanelWorkspaceFolder,
    $reset,
  };
});
