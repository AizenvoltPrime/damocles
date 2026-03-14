import { toast } from "vue-sonner";
import type { HandlerRegistry } from "../types";

export function createSettingsHandlers(): Partial<HandlerRegistry> {
  return {
    accountInfo: (msg, ctx) => {
      ctx.stores.settingsStore.setAccountInfo(msg.data);
    },

    availableModels: (msg, ctx) => {
      ctx.stores.settingsStore.setAvailableModels(msg.models);
    },

    settingsUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.updateSettings(msg.settings);
    },

    mcpServerStatus: (msg, ctx) => {
      ctx.stores.settingsStore.setMcpServers(msg.servers);
    },

    mcpConfigUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setMcpServers(msg.servers);
    },

    pluginStatus: (msg, ctx) => {
      ctx.stores.settingsStore.setPlugins(msg.plugins);
    },

    pluginConfigUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setPlugins(msg.plugins);
    },

    providerProfilesUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setProviderProfiles(msg.profiles, msg.activeProfile, msg.defaultProfile);
    },

    systemInit: (msg, ctx) => {
      const { settingsStore } = ctx.stores;
      if (msg.data.mcpServers) {
        settingsStore.updateMcpServerStatuses(msg.data.mcpServers);
      }
      if (msg.data.plugins) {
        settingsStore.updatePluginStatuses(msg.data.plugins);
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

    betaUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setBetaState(msg.activeBetas);
    },

    contextStrategyUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setContextStrategyState(msg.activeStrategy, msg.defaultStrategy);
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
