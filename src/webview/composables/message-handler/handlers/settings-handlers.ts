import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import { useEditorStore } from "@/stores/useEditorStore";
import { useSettingWritesStore } from "@/components/settings/settings-writes";
import { openSettings } from "@/composables/useOpenSettings";
import type { ExtensionToWebviewMessage } from "@shared/types/messages";
import type { SettingsViewMessageType, SettingsViewPromptType } from "@shared/settings-view-messages";
import type { SettingsTarget } from "@shared/settings-sections";
import type { HandlerRegistry, StoreContext } from "../types";

/** What the settings view's handlers reach; the desktop overlay builds it from its own stores. */
export interface SettingsHandlerContext {
  stores: Pick<StoreContext, "settingsStore" | "uiStore" | "extensionUiStore" | "voiceJarvisStore">;
}

/** One handler per type the host forwards to an attached settings view, so the forwarded set equals the handled set. */
export type SettingsViewHandlers = {
  [K in SettingsViewMessageType | SettingsViewPromptType]: (message: Extract<ExtensionToWebviewMessage, { type: K }>, ctx: SettingsHandlerContext) => void;
};

const t = i18n.global.t;

// The panel that sent the request listens for its own acknowledgement (OpenAIAuthPanel, CustomProviderAuthPanel).
const acknowledgedByPanel = (): void => {};

const OPENAI_SIGN_IN: SettingsTarget = { section: "accounts", account: "openai" };

export const settingsViewHandlers: SettingsViewHandlers = {
  settingsUpdate: (msg, ctx) => {
    ctx.stores.settingsStore.updateSettings(msg.settings, msg.settingSources);
    ctx.stores.settingsStore.setWorkspaceWritable(msg.workspaceWritable);
    ctx.stores.uiStore.setIdeContextDefault(msg.settings.ideContextEnabled);
  },
  accountInfo: (msg, ctx) => {
    ctx.stores.settingsStore.setAccountInfo(msg.data);
  },
  availableModels: (msg, ctx) => {
    ctx.stores.settingsStore.setAvailableModels(msg.models);
  },
  hostCapabilities: (msg, ctx) => {
    ctx.stores.settingsStore.setHostCapabilities(msg.capabilities);
  },
  modelUpdate: (msg, ctx) => {
    ctx.stores.settingsStore.setModelState(msg.activeModel, msg.defaultModel);
  },
  panelThinkingUpdate: (msg, ctx) => {
    ctx.stores.settingsStore.setPanelThinking(msg.panel, msg.panelModel);
    ctx.stores.settingsStore.setDefaultThinking(msg.defaults, msg.defaultsModel);
  },
  workspaceFolderUpdate: (msg, ctx) => {
    ctx.stores.settingsStore.setWorkspaceFolders(msg.folders, msg.panelFolderKey, msg.defaultFolderKey);
  },
  projectTrust: (msg, ctx) => {
    ctx.stores.settingsStore.setProjectTrusted(msg.trusted);
  },
  autoCompactConfigUpdate: (msg, ctx) => {
    ctx.stores.settingsStore.updateAutoCompactConfig(msg.config);
  },
  mcpServerStatus: (msg, ctx) => {
    ctx.stores.settingsStore.setMcpServers(msg.servers);
    ctx.stores.settingsStore.setMcpEnabled(msg.mcpEnabled);
    ctx.stores.settingsStore.setMcpConfigErrors(msg.configErrors);
    ctx.stores.settingsStore.setMcpLocalUnignored(msg.localMcpUnignored);
    ctx.stores.settingsStore.setMcpToolExposureScopes(msg.toolExposureScopes);
  },
  toolStatus: (msg, ctx) => {
    ctx.stores.settingsStore.setToolsSnapshot(msg.data);
  },
  imageGenerationSettings: (msg, ctx) => {
    ctx.stores.settingsStore.setImageGeneration(msg.settings);
  },
  voiceConfigUpdate: (msg, ctx) => {
    ctx.stores.settingsStore.setVoiceConfig(msg.config, msg.hasApiKey);
  },
  voiceFilesSizeUpdate: (msg, ctx) => {
    ctx.stores.voiceJarvisStore.setVoiceFilesBytes(msg.bytes);
  },
  exploreApiKeyUpdate: (msg, ctx) => {
    ctx.stores.settingsStore.setExploreHasApiKey(msg.hasApiKey);
  },
  exploreConfigUpdate: (msg, ctx) => {
    ctx.stores.settingsStore.setExploreConfig(msg.provider, msg.model, msg.effort);
  },
  openaiAuthStatusChanged: (msg, ctx) => {
    ctx.stores.settingsStore.setOpenAIAuthStatus(msg.status, msg.preferApiKey);
  },
  setOpenAIApiKeyAck: acknowledgedByPanel,
  clearOpenAIApiKeyAck: acknowledgedByPanel,
  setOpenAIPreferApiKeyAck: acknowledgedByPanel,
  openaiChatGPTAuthStarted: (_msg, ctx) => {
    ctx.stores.settingsStore.setChatGPTAuthInFlight(true);
  },
  openaiChatGPTAuthCompleted: (_msg, ctx) => {
    ctx.stores.settingsStore.setChatGPTAuthInFlight(false);
    ctx.stores.settingsStore.setChatGPTAuthError(null);
    toast.success(t("openai.toast.signedIn"));
  },
  openaiChatGPTAuthFailed: (msg, ctx) => {
    ctx.stores.settingsStore.setChatGPTAuthInFlight(false);
    ctx.stores.settingsStore.setChatGPTAuthError(msg.error);
    toast.error(t("openai.toast.signInFailed", { error: msg.error }));
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
    toast.error(t("claudeAuth.toast.error", { error: msg.error }));
  },
  stepfunAuthStatusChanged: (msg, ctx) => {
    ctx.stores.settingsStore.setStepfunConfigured(msg.configured);
  },
  setStepfunApiKeyAck: acknowledgedByPanel,
  clearStepfunApiKeyAck: acknowledgedByPanel,
  deepseekAuthStatusChanged: (msg, ctx) => {
    ctx.stores.settingsStore.setDeepseekConfigured(msg.configured);
  },
  setDeepseekApiKeyAck: acknowledgedByPanel,
  clearDeepseekApiKeyAck: acknowledgedByPanel,
  typesafeAuthStatusChanged: (msg, ctx) => {
    ctx.stores.settingsStore.setTypesafeStatus(msg.configured, msg.memoryJudge);
  },
  setTypesafeApiKeyAck: acknowledgedByPanel,
  clearTypesafeApiKeyAck: acknowledgedByPanel,
  openrouterAuthStatusChanged: (msg, ctx) => {
    ctx.stores.settingsStore.setOpenrouterConfigured(msg.configured);
  },
  setOpenrouterApiKeyAck: acknowledgedByPanel,
  clearOpenrouterApiKeyAck: acknowledgedByPanel,
  extensionUiRequest: (msg, ctx) => {
    ctx.stores.extensionUiStore.setRequest({
      requestId: msg.requestId,
      kind: msg.kind,
      title: msg.title,
      ...(msg.message !== undefined ? { message: msg.message } : {}),
      ...(msg.options !== undefined ? { options: msg.options } : {}),
      ...(msg.items !== undefined ? { items: msg.items } : {}),
      ...(msg.password !== undefined ? { password: msg.password } : {}),
      ...(msg.placeholder !== undefined ? { placeholder: msg.placeholder } : {}),
      ...(msg.prefill !== undefined ? { prefill: msg.prefill } : {}),
      ...(msg.agentId !== undefined ? { agentId: msg.agentId } : {}),
      ...(msg.agentName !== undefined ? { agentName: msg.agentName } : {}),
      ...(msg.teamId !== undefined ? { teamId: msg.teamId } : {}),
    });
  },
  // The extension withdrew a dialog that will never be answered; there is no response leg.
  extensionUiCancel: (msg, ctx) => {
    ctx.stores.extensionUiStore.cancel(msg.requestId);
  },
  settingsFileAvailability: (msg, ctx) => {
    // Nothing reaches the editor store while `monaco` is off, so the lazy Monaco chunk never loads on such a host.
    if (!ctx.stores.settingsStore.hostCapabilities.monaco) {
      console.warn(`[editor] ignored ${msg.type}: the host did not enable monaco`);
      return;
    }
    useEditorStore().setSettingsFileAvailability(msg.files);
  },
  settingWriteResult: (msg) => {
    useSettingWritesStore().settle(msg);
  },
};

export function createSettingsHandlers(): Partial<HandlerRegistry> {
  return {
    ...settingsViewHandlers,

    modelUpdate: (msg, ctx) => {
      settingsViewHandlers.modelUpdate(msg, ctx);
      ctx.stores.sessionStore.updateStats({ contextWindowSize: msg.contextWindowSize });
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

    systemInit: (msg, ctx) => {
      if (msg.data.mcpServers) ctx.stores.settingsStore.updateMcpServerStatuses(msg.data.mcpServers);
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

    authStatusUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setAuthStatus({
        isAuthenticating: msg.isAuthenticating,
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      });
      if (msg.error) toast.error(t("toast.authError", { error: msg.error }));
    },

    openaiAuthRequired: (msg, ctx) => {
      ctx.stores.settingsStore.setPendingOpenAIModel(msg.modelValue);
      openSettings(ctx.stores, ctx.bridge.postMessage, OPENAI_SIGN_IN);
      toast.warning(t("openai.authRequiredToast"));
    },

    openOpenAIAuthPanel: (_msg, ctx) => {
      openSettings(ctx.stores, ctx.bridge.postMessage, OPENAI_SIGN_IN);
    },

    openSettingsPanel: (msg, ctx) => {
      const { type: _type, ...target } = msg;
      openSettings(ctx.stores, ctx.bridge.postMessage, target);
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
