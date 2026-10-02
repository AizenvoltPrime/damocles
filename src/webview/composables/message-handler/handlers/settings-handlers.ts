import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";
import type { HandlerRegistry } from "../types";

export function createSettingsHandlers(): Partial<HandlerRegistry> {
  const { t } = useI18n();

  return {
    accountInfo: (msg, ctx) => {
      ctx.stores.settingsStore.setAccountInfo(msg.data);
    },

    availableModels: (msg, ctx) => {
      ctx.stores.settingsStore.setAvailableModels(msg.models);
    },

    settingsUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.updateSettings(msg.settings, msg.settingSources);
      ctx.stores.uiStore.setIdeContextDefault(msg.settings.ideContextEnabled);
    },

    hostCapabilities: (msg, ctx) => {
      ctx.stores.settingsStore.setHostCapabilities(msg.capabilities);
    },

    mcpServerStatus: (msg, ctx) => {
      ctx.stores.settingsStore.setMcpServers(msg.servers);
      ctx.stores.settingsStore.setMcpEnabled(msg.mcpEnabled);
      ctx.stores.settingsStore.setMcpConfigErrors(msg.configErrors);
      ctx.stores.settingsStore.setMcpLocalUnignored(msg.localMcpUnignored);
      ctx.stores.settingsStore.setMcpToolExposureScopes(msg.toolExposureScopes);
    },

    mcpConfigUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.reconcileMcpServers(msg.servers);
      ctx.stores.settingsStore.setMcpConfigErrors(msg.configErrors);
      ctx.stores.settingsStore.setMcpLocalUnignored(msg.localMcpUnignored);
    },

    mcpRenamedToolRules: (msg, ctx) => {
      ctx.stores.settingsStore.addMcpRenamedToolRules(msg.notices);
    },

    mcpWriteResult: (msg, ctx) => {
      ctx.stores.settingsStore.settleMcpWrite(msg.requestId, msg.ok ? null : msg.error);
    },

    toolStatus: (msg, ctx) => {
      ctx.stores.settingsStore.setToolsSnapshot(msg.data);
    },

    projectTrust: (msg, ctx) => {
      ctx.stores.settingsStore.setProjectTrusted(msg.trusted);
    },

    systemInit: (msg, ctx) => {
      const { settingsStore } = ctx.stores;
      if (msg.data.mcpServers) {
        settingsStore.updateMcpServerStatuses(msg.data.mcpServers);
      }
    },

    budgetWarning: (msg, ctx) => {
      ctx.stores.settingsStore.setBudgetWarning(msg.currentSpend, msg.limit, false);
    },

    budgetExceeded: (msg, ctx) => {
      ctx.stores.settingsStore.setBudgetWarning(msg.finalSpend, msg.limit, true);
    },

    contextWarning: (msg, ctx) => {
      ctx.stores.settingsStore.setContextWarning(msg.level);
    },

    autoCompactTriggering: (_msg, ctx) => {
      ctx.stores.settingsStore.setAutoCompactTriggered();
    },

    autoCompactComplete: (_msg, ctx) => {
      ctx.stores.settingsStore.clearAutoCompactTriggered();
    },

    autoCompactConfigUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.updateAutoCompactConfig(msg.config);
    },

    modelUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setModelState(msg.activeModel, msg.defaultModel);
      ctx.stores.sessionStore.updateStats({ contextWindowSize: msg.contextWindowSize });
    },

    panelThinkingUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setPanelThinking(msg.panel, msg.panelModel);
      ctx.stores.settingsStore.setDefaultThinking(msg.defaults, msg.defaultsModel);
    },

    authStatusUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setAuthStatus({
        isAuthenticating: msg.isAuthenticating,
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      });
      if (msg.error) {
        toast.error(t("toast.authError", { error: msg.error }));
      }
    },

    openaiAuthStatusChanged: (msg, ctx) => {
      ctx.stores.settingsStore.setOpenAIAuthStatus(msg.status, msg.preferApiKey);
    },

    openaiChatGPTAuthStarted: (_msg, ctx) => {
      ctx.stores.settingsStore.setChatGPTAuthInFlight(true);
    },

    openaiChatGPTAuthCompleted: (_msg, ctx) => {
      ctx.stores.settingsStore.setChatGPTAuthInFlight(false);
      ctx.stores.settingsStore.setChatGPTAuthError(null);
      toast.success(t('openai.toast.signedIn'));
    },

    openaiChatGPTAuthFailed: (msg, ctx) => {
      ctx.stores.settingsStore.setChatGPTAuthInFlight(false);
      ctx.stores.settingsStore.setChatGPTAuthError(msg.error);
      toast.error(t('openai.toast.signInFailed', { error: msg.error }));
    },

    openaiAuthRequired: (msg, ctx) => {
      ctx.stores.settingsStore.setPendingOpenAIModel(msg.modelValue);
      ctx.stores.uiStore.openSettingsPanel();
      toast.warning(t('openai.authRequiredToast'));
    },

    openOpenAIAuthPanel: (_msg, ctx) => {
      ctx.stores.settingsStore.setOpenAIAuthPanelRequested(true);
      ctx.stores.uiStore.openSettingsPanel();
    },

    openSettingsPanel: (_msg, ctx) => {
      ctx.stores.uiStore.openSettingsPanel();
    },

    claudeAuthStatusChanged: (msg, ctx) => {
      ctx.stores.settingsStore.setClaudeAuthMode(msg.mode);
    },

    claudeAuthBusy: (msg, ctx) => {
      ctx.stores.settingsStore.setClaudeAuthBusy(msg.busy);
    },

    claudeAuthCancelled: (_msg, ctx) => {
      ctx.stores.settingsStore.setClaudeAuthBusy(false);
      ctx.stores.settingsStore.setClaudeAuthError(null);
    },

    claudeAuthError: (msg, ctx) => {
      ctx.stores.settingsStore.setClaudeAuthBusy(false);
      ctx.stores.settingsStore.setClaudeAuthError(msg.error);
      toast.error(t('claudeAuth.toast.error', { error: msg.error }));
    },

    stepfunAuthStatusChanged: (msg, ctx) => {
      ctx.stores.settingsStore.setStepfunConfigured(msg.configured);
    },

    deepseekAuthStatusChanged: (msg, ctx) => {
      ctx.stores.settingsStore.setDeepseekConfigured(msg.configured);
    },

    typesafeAuthStatusChanged: (msg, ctx) => {
      ctx.stores.settingsStore.setTypesafeStatus(msg.configured, msg.memoryJudge);
    },

    openrouterAuthStatusChanged: (msg, ctx) => {
      ctx.stores.settingsStore.setOpenrouterConfigured(msg.configured);
    },

    imageGenerationSettings: (msg, ctx) => {
      ctx.stores.settingsStore.setImageGeneration(msg.settings);
    },

    configChange: (msg) => {
      const keys: Record<string, string> = {
        user_settings: "toast.configChange.user",
        project_settings: "toast.configChange.project",
        local_settings: "toast.configChange.local",
        policy_settings: "toast.configChange.policy",
        skills: "toast.configChange.skills",
      };
      toast.info(t(keys[msg.source] ?? "toast.configChange.other"));
    },
  };
}
