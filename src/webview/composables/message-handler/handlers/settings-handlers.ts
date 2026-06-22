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
      ctx.stores.settingsStore.updateSettings(msg.settings);
      ctx.stores.uiStore.setIdeContextDefault(msg.settings.ideContextEnabled);
    },

    mcpServerStatus: (msg, ctx) => {
      ctx.stores.settingsStore.setMcpServers(msg.servers);
      ctx.stores.settingsStore.setMcpEnabled(msg.mcpEnabled);
    },

    mcpConfigUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setMcpServers(msg.servers);
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
        toast.error(`Authentication error: ${msg.error}`);
      }
    },

    openaiAuthStatusChanged: (msg, ctx) => {
      ctx.stores.settingsStore.setOpenAIAuthStatus(msg.status, msg.preferApiKey);
    },

    openaiCodexAuthStarted: (_msg, ctx) => {
      ctx.stores.settingsStore.setCodexAuthInFlight(true);
    },

    openaiCodexAuthCompleted: (msg, ctx) => {
      ctx.stores.settingsStore.setCodexAuthInFlight(false);
      ctx.stores.settingsStore.setCodexAuthError(null);
      if (msg.accountId) {
        toast.success(t('openai.toast.signedInAs', { account: msg.accountId }));
      } else {
        toast.success(t('openai.toast.signedIn'));
      }
    },

    openaiCodexAuthFailed: (msg, ctx) => {
      ctx.stores.settingsStore.setCodexAuthInFlight(false);
      ctx.stores.settingsStore.setCodexAuthError(msg.error);
      toast.error(t('openai.toast.signInFailed', { error: msg.error }));
    },

    openaiAuthRequired: (msg, ctx) => {
      ctx.stores.settingsStore.setPendingOpenAIModel(msg.modelValue);
      ctx.stores.uiStore.openSettingsPanel();
      toast.warning(t('openai.authRequiredToast'));
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

    openaiModelPricingUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setOpenAIModelPricing(msg.pricing);
    },

    configChange: (msg) => {
      const labels: Record<string, string> = {
        user_settings: 'User settings',
        project_settings: 'Project settings',
        local_settings: 'Local settings',
        policy_settings: 'Policy settings',
        skills: 'Skills',
      };
      toast.info(`${labels[msg.source] ?? 'Settings'} updated`);
    },
  };
}
