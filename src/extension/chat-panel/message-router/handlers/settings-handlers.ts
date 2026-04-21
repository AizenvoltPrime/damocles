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

    setMaxThinkingTokens: async (msg, ctx) => {
      if (msg.type !== "setMaxThinkingTokens") return;
      try {
        await settingsManager.handleSetMaxThinkingTokens(msg.tokens);
      } catch (err) {
        log("[MessageRouter] Error setting thinking tokens:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save thinking tokens: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.panelId);
      }
    },

    setThinkingDisabled: async (msg, ctx) => {
      if (msg.type !== "setThinkingDisabled") return;
      try {
        await settingsManager.handleSetThinkingDisabled(msg.disabled);
      } catch (err) {
        log("[MessageRouter] Error setting thinking disabled:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save thinking setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.panelId);
      }
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
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.panelId);
      }
    },

    setEffort: async (msg, ctx) => {
      if (msg.type !== "setEffort") return;
      try {
        await settingsManager.handleSetEffort(msg.effort, ctx.panelId);
      } catch (err) {
        log("[MessageRouter] Error setting effort:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save effort setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.panelId);
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
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.panelId);
      }
    },

    setTaskBudget: async (msg, ctx) => {
      if (msg.type !== "setTaskBudget") return;
      try {
        await settingsManager.handleSetTaskBudget(msg.budget);
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.panelId);
      } catch (err) {
        log("[MessageRouter] Error setting task budget:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save task budget: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.panelId);
      }
    },

    setPermissionMode: async (msg, ctx) => {
      if (msg.type !== "setPermissionMode") return;
      await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, msg.mode);
    },

    setDefaultPermissionMode: async (msg) => {
      if (msg.type !== "setDefaultPermissionMode") return;
      await settingsManager.handleSetDefaultPermissionMode(msg.mode);
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
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.panelId);
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
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.panelId);
    },

    setFastMode: async (msg, ctx) => {
      if (msg.type !== "setFastMode") return;
      settingsManager.handleSetFastMode(ctx.session, msg.enabled);
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.panelId);
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

    reloadPlugins: async (_msg, ctx) => {
      const result = await ctx.session.reloadPlugins();
      if (result) {
        await settingsManager.sendMcpStatus(ctx.session, ctx.host);
        postMessage(ctx.host, { type: 'pluginsReloaded', errorCount: result.errorCount });
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

    togglePlugin: async (msg, ctx) => {
      if (msg.type !== "togglePlugin") return;
      try {
        await settingsManager.setPluginEnabled(msg.pluginFullId, msg.enabled);
        ctx.session.setPlugins(settingsManager.getEnabledPlugins());
        ctx.session.restartForPluginChanges();
        settingsManager.sendPluginConfig(ctx.host);
        const enabledPluginIds = settingsManager.getEnabledPluginIds();
        await deps.workspaceManager.sendCustomSlashCommands(ctx.host, enabledPluginIds);
        await deps.workspaceManager.sendCustomAgents(ctx.host, enabledPluginIds);
      } catch (err) {
        log("[MessageRouter] Error toggling plugin:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save plugin setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        settingsManager.sendPluginConfig(ctx.host);
      }
    },

    requestMcpStatus: async (_msg, ctx) => {
      await settingsManager.sendMcpStatus(ctx.session, ctx.host);
    },

    requestSupportedCommands: async (_msg, ctx) => {
      await settingsManager.sendSupportedCommands(ctx.session, ctx.host);
    },

    requestPluginStatus: (_msg, ctx) => {
      settingsManager.sendPluginConfig(ctx.host);
    },
  };
}
