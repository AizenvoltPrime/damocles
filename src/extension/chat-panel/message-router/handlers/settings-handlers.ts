import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
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
        await settingsManager.handleSetMaxThinkingTokens(ctx.session, msg.tokens);
      } catch (err) {
        log("[MessageRouter] Error setting thinking tokens:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save thinking tokens: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
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
      ctx.session.refreshContextStrategy(msg.strategy);
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

    toggleMcpServer: async (msg, ctx) => {
      if (msg.type !== "toggleMcpServer") return;
      try {
        await settingsManager.setServerEnabled(msg.serverName, msg.enabled);
        ctx.session.setMcpServers(settingsManager.getEnabledMcpServers());
        ctx.session.restartForMcpChanges();
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
