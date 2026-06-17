import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { CHROME_SERVER_NAME, CHROME_SDK_SERVER_NAME } from "../../../../shared/types/mcp";
import { BROWSER_SERVER_NAME } from "../../../../shared/types/browser";
import { log } from "../../../logger";

export function createSettingsHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, settingsManager } = deps;

  return {
    requestModels: async (_msg, ctx) => {
      await settingsManager.sendAvailableModels(ctx.session, ctx.host);
    },

    setPinnedHeaderHidden: async (msg, ctx) => {
      if (msg.type !== "setPinnedHeaderHidden") return;
      try {
        await settingsManager.handleSetPinnedHeaderHidden(msg.hidden);
      } catch (err) {
        log("[MessageRouter] Error setting pinned header visibility:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save pinned header setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setPanelThinkingDisabled: (msg, ctx) => {
      if (msg.type !== "setPanelThinkingDisabled") return;
      settingsManager.handleSetPanelThinkingDisabled(ctx.panelId, msg.disabled);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
    },

    setPanelEffort: (msg, ctx) => {
      if (msg.type !== "setPanelEffort") return;
      try {
        settingsManager.handleSetPanelEffort(ctx.panelId, msg.model, msg.effort);
      } catch (err) {
        log("[MessageRouter] Error setting panel effort:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save effort setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
    },

    setPanelMaxThinkingTokens: (msg, ctx) => {
      if (msg.type !== "setPanelMaxThinkingTokens") return;
      settingsManager.handleSetPanelMaxThinkingTokens(ctx.panelId, msg.model, msg.tokens);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
    },

    setDefaultThinkingDisabled: async (msg, ctx) => {
      if (msg.type !== "setDefaultThinkingDisabled") return;
      try {
        await settingsManager.handleSetDefaultThinkingDisabled(msg.disabled);
      } catch (err) {
        log("[MessageRouter] Error setting default thinking disabled:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save default thinking setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
      }
    },

    setDefaultEffort: async (msg, ctx) => {
      if (msg.type !== "setDefaultEffort") return;
      try {
        await settingsManager.handleSetDefaultEffort(msg.effort, msg.model);
      } catch (err) {
        log("[MessageRouter] Error setting default effort:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save default effort: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
      }
    },

    setDefaultMaxThinkingTokens: async (msg, ctx) => {
      if (msg.type !== "setDefaultMaxThinkingTokens") return;
      try {
        await settingsManager.handleSetDefaultMaxThinkingTokens(msg.tokens);
      } catch (err) {
        log("[MessageRouter] Error setting default max thinking tokens:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save default thinking tokens: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
      }
    },

    setBudgetLimit: async (msg, ctx) => {
      if (msg.type !== "setBudgetLimit") return;
      try {
        await settingsManager.handleSetBudgetLimit(msg.budgetUsd);
      } catch (err) {
        log("[MessageRouter] Error setting budget limit:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save budget limit: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setTaskBudget: async (msg, ctx) => {
      if (msg.type !== "setTaskBudget") return;
      try {
        await settingsManager.handleSetTaskBudget(msg.budget);
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      } catch (err) {
        log("[MessageRouter] Error setting task budget:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save task budget: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setPermissionMode: async (msg, ctx) => {
      if (msg.type !== "setPermissionMode") return;
      await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, msg.mode);
    },

    setDefaultPermissionMode: async (msg, ctx) => {
      if (msg.type !== "setDefaultPermissionMode") return;
      try {
        await settingsManager.handleSetDefaultPermissionMode(msg.mode);
      } catch (err) {
        log("[MessageRouter] Error setting default permission mode:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save default permission mode: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setWorktreeBaseRef: async (msg, ctx) => {
      if (msg.type !== "setWorktreeBaseRef") return;
      try {
        await settingsManager.handleSetWorktreeBaseRef(msg.baseRef);
      } catch (err) {
        log("[MessageRouter] Error setting worktree base ref:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save worktree base ref: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setActiveContextStrategy: async (msg, ctx) => {
      if (msg.type !== "setActiveContextStrategy") return;
      if (!settingsManager.setActiveStrategyForPanel(ctx.panelId, msg.strategy)) return;
      settingsManager.sendStrategyForPanel(ctx.host, ctx.panelId);
      ctx.session.clear();
      ctx.session.refreshRecallConfig(settingsManager.buildRecallConfig(ctx.panelId));
      ctx.permissionHandler.setDangerouslySkipPermissions(false);
      ctx.permissionHandler.clearSubagentAutoApprovals();
      postMessage(ctx.host, { type: "conversationCleared" });
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
    },

    setDefaultContextStrategy: async (msg) => {
      if (msg.type !== "setDefaultContextStrategy") return;
      await settingsManager.setDefaultStrategy(msg.strategy);
      for (const [panelId, instance] of deps.getPanels()) {
        settingsManager.sendStrategyForPanel(instance.host, panelId);
      }
    },

    setDangerouslySkipPermissions: async (msg, ctx) => {
      if (msg.type !== "setDangerouslySkipPermissions") return;
      settingsManager.handleSetDangerouslySkipPermissions(ctx.permissionHandler, msg.enabled);
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
    },

    setFastMode: async (msg, ctx) => {
      if (msg.type !== "setFastMode") return;
      settingsManager.handleSetFastMode(ctx.session, msg.enabled);
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
    },

    toggleMcpServer: async (msg, ctx) => {
      if (msg.type !== "toggleMcpServer") return;
      try {
        if (msg.serverName === CHROME_SERVER_NAME) {
          await settingsManager.setChromeEnabled(msg.enabled);
          ctx.session.setChromeEnabled(msg.enabled);
          ctx.session.restartForChromeChange();
        } else if (msg.serverName === BROWSER_SERVER_NAME) {
          await settingsManager.setBrowserEnabled(msg.enabled);
          ctx.session.setBrowserService(msg.enabled ? deps.browserService : undefined);
          ctx.session.restartForMcpChanges();
        } else {
          await settingsManager.setServerEnabled(msg.serverName, msg.enabled);
          ctx.session.setMcpServers(settingsManager.getEnabledMcpServers());
          ctx.session.restartForMcpChanges();
        }
        settingsManager.sendMcpConfig(ctx.host);
      } catch (err) {
        log("[MessageRouter] Error toggling MCP server:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save MCP server setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        settingsManager.sendMcpConfig(ctx.host);
      }
    },

    reconnectMcpServer: async (msg, ctx) => {
      if (msg.type !== "reconnectMcpServer") return;
      const sdkServerName = msg.serverName === CHROME_SERVER_NAME ? CHROME_SDK_SERVER_NAME : msg.serverName;
      const success = await ctx.session.reconnectMcpServerLive(sdkServerName);
      await settingsManager.sendMcpStatus(ctx.session, ctx.host);
      if (!success) {
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to reconnect MCP server"),
          notificationType: "error",
        });
      }
    },

    authenticateMcpServer: async (msg, ctx) => {
      if (msg.type !== "authenticateMcpServer") return;
      const sdkServerName = msg.serverName === CHROME_SERVER_NAME ? CHROME_SDK_SERVER_NAME : msg.serverName;
      const success = await ctx.session.reconnectMcpServerLive(sdkServerName);
      await settingsManager.sendMcpStatus(ctx.session, ctx.host);
      if (!success) {
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to authenticate MCP server"),
          notificationType: "error",
        });
      }
    },

    requestMcpStatus: async (_msg, ctx) => {
      await settingsManager.sendMcpStatus(ctx.session, ctx.host);
    },

    requestSupportedCommands: async (_msg, ctx) => {
      await settingsManager.sendSupportedCommands(ctx.session, ctx.host);
    },

    toggleTool: async (msg, ctx) => {
      if (msg.type !== "toggleTool") return;
      try {
        await settingsManager.setToolDisabled(msg.toolName, !msg.enabled);
        ctx.session.refreshActiveTools();
      } catch (err) {
        log("[MessageRouter] Error toggling tool:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save tool setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
    },

    toggleToolGroup: async (msg, ctx) => {
      if (msg.type !== "toggleToolGroup") return;
      try {
        await settingsManager.setToolGroupEnabled(msg.group, msg.enabled);
        ctx.session.refreshActiveTools();
      } catch (err) {
        log("[MessageRouter] Error toggling tool group:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save tool group setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
    },

    requestToolStatus: (_msg, ctx) => {
      postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
    },

    setExploreApiKey: async (msg, ctx) => {
      if (msg.type !== "setExploreApiKey") return;
      await settingsManager.storeExploreApiKey(msg.apiKey);
      await settingsManager.sendExploreKeyStatus(ctx.host);
    },

    deleteExploreApiKey: async (_msg, ctx) => {
      await settingsManager.deleteExploreApiKey();
      await settingsManager.sendExploreKeyStatus(ctx.host);
    },

    requestExploreKeyStatus: async (_msg, ctx) => {
      await settingsManager.sendExploreKeyStatus(ctx.host);
    },

    setExploreProvider: async (msg, ctx) => {
      if (msg.type !== "setExploreProvider") return;
      await settingsManager.setExploreProvider(msg.provider);
      settingsManager.sendExploreConfig(ctx.host);
      await settingsManager.sendExploreKeyStatus(ctx.host);
    },

    setExploreModel: async (msg, ctx) => {
      if (msg.type !== "setExploreModel") return;
      await settingsManager.setExploreModel(msg.model);
      settingsManager.sendExploreConfig(ctx.host);
    },

    requestExploreConfig: (_msg, ctx) => {
      settingsManager.sendExploreConfig(ctx.host);
    },

  };
}
