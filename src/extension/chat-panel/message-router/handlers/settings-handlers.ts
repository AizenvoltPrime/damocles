import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import { updateConfigAtEffectiveScope } from "../../settings-manager/utils";
import { log } from "../../../logger";

export function createSettingsHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, settingsManager, getPanels } = deps;

  /** Broadcast to every open panel — auth-status changes must propagate cross-panel (and, for the
   *  shared StepFun key, between the Explore field and the dedicated StepFun panel). */
  function broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, message);
    }
  }

  /** Re-broadcast StepFun + Explore status to all panels so both indicators stay in sync (they share
   *  one SecretStorage entry). */
  async function broadcastStepfunStatus(): Promise<void> {
    for (const [, instance] of getPanels()) {
      await settingsManager.sendStepfunAuthStatus(instance.host);
      await settingsManager.sendExploreKeyStatus(instance.host);
    }
  }

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

    setTeamRoleModel: async (msg, ctx) => {
      if (msg.type !== "setTeamRoleModel") return;
      try {
        await settingsManager.handleSetTeamRoleModel(msg.role, msg.model);
      } catch (err) {
        log("[MessageRouter] Error setting team role model:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save team role model: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
    },

    setTeamRoleEffort: async (msg, ctx) => {
      if (msg.type !== "setTeamRoleEffort") return;
      try {
        await settingsManager.handleSetTeamRoleEffort(msg.role, msg.effort);
      } catch (err) {
        log("[MessageRouter] Error setting team role effort:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save team role effort: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
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

    setAutoCompact: async (msg, ctx) => {
      if (msg.type !== "setAutoCompact") return;
      try {
        await settingsManager.handleSetAutoCompact(msg.config);
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      } catch (err) {
        log("[MessageRouter] Error setting auto-compact:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save auto-compact settings: {0}", err instanceof Error ? err.message : "Unknown error"),
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


    setDangerouslySkipPermissions: async (msg, ctx) => {
      if (msg.type !== "setDangerouslySkipPermissions") return;
      settingsManager.handleSetDangerouslySkipPermissions(ctx.permissionHandler, msg.enabled);
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
    },

    setDefaultDangerouslySkipPermissions: async (msg, ctx) => {
      if (msg.type !== "setDefaultDangerouslySkipPermissions") return;
      try {
        await settingsManager.handleSetDefaultDangerouslySkipPermissions(msg.enabled);
      } catch (err) {
        log("[MessageRouter] Error setting default YOLO mode:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save default YOLO mode: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setIdeContextEnabled: async (msg, ctx) => {
      if (msg.type !== "setIdeContextEnabled") return;
      try {
        await settingsManager.handleSetIdeContextEnabled(msg.enabled);
      } catch (err) {
        log("[MessageRouter] Error setting IDE context default:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save IDE context setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    toggleMcpServer: async (msg, ctx) => {
      if (msg.type !== "toggleMcpServer") return;
      try {
        await settingsManager.setServerEnabled(msg.serverName, msg.enabled);
        ctx.session.setMcpServers(settingsManager.getEnabledMcpServers());
        ctx.session.restartForMcpChanges();
        // Push live status now (shows "connecting"); the MCP status listener auto-pushes "connected"
        // once the background connect settles.
        await settingsManager.sendMcpStatus(ctx.session, ctx.host);
      } catch (err) {
        log("[MessageRouter] Error toggling MCP server:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save MCP server setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendMcpStatus(ctx.session, ctx.host);
      }
    },

    reconnectMcpServer: async (msg, ctx) => {
      if (msg.type !== "reconnectMcpServer") return;
      const success = await ctx.session.reconnectMcpServerLive(msg.serverName);
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
      const success = await ctx.session.reconnectMcpServerLive(msg.serverName);
      await settingsManager.sendMcpStatus(ctx.session, ctx.host);
      if (!success) {
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to authenticate MCP server"),
          notificationType: "error",
        });
      }
    },

    reauthenticateMcpServer: async (msg, ctx) => {
      if (msg.type !== "reauthenticateMcpServer") return;
      try {
        const success = await ctx.session.reauthenticateMcpServerLive(msg.serverName);
        if (!success) {
          postMessage(ctx.host, {
            type: "notification",
            message: vscode.l10n.t("Failed to re-authenticate MCP server"),
            notificationType: "error",
          });
        }
      } catch (err) {
        log("[MessageRouter] Error re-authenticating MCP server:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to re-authenticate MCP server: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      } finally {
        await settingsManager.sendMcpStatus(ctx.session, ctx.host);
      }
    },

    signOutMcpServer: async (msg, ctx) => {
      if (msg.type !== "signOutMcpServer") return;
      try {
        await ctx.session.signOutMcpServerLive(msg.serverName);
      } catch (err) {
        log("[MessageRouter] Error signing out of MCP server:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to sign out of MCP server: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      } finally {
        await settingsManager.sendMcpStatus(ctx.session, ctx.host);
      }
    },

    requestMcpStatus: async (_msg, ctx) => {
      await settingsManager.sendMcpStatus(ctx.session, ctx.host);
    },

    setMcpEnabled: async (msg, ctx) => {
      if (msg.type !== "setMcpEnabled") return;
      try {
        await updateConfigAtEffectiveScope("damocles", "mcp.enabled", msg.enabled);
        // Feed the master-gated set: disabling returns {} so live connections are torn down, not just
        // hidden; re-enabling re-feeds the enabled servers so they reconnect (M6).
        ctx.session.setMcpServers(settingsManager.getEnabledMcpServers());
        ctx.session.restartForMcpChanges();
        await settingsManager.sendMcpStatus(ctx.session, ctx.host);
      } catch (err) {
        log("[MessageRouter] Error setting MCP enabled:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to save MCP setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendMcpStatus(ctx.session, ctx.host);
      }
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

    setProjectTrusted: async (_msg, _ctx) => {
      // VS Code intentionally has no API to grant trust programmatically (it's a user decision); open the
      // Workspace Trust editor so the user can grant it. On grant, PiSession's onDidGrantWorkspaceTrust
      // reloads project agents and re-emits `projectTrust` (US-022).
      try {
        await vscode.commands.executeCommand("workbench.trust.manage");
      } catch (err) {
        log("[MessageRouter] Failed to open workspace-trust editor:", err);
      }
    },

    setExploreApiKey: async (msg, ctx) => {
      if (msg.type !== "setExploreApiKey") return;
      await settingsManager.storeExploreApiKey(msg.apiKey);
      await settingsManager.sendExploreKeyStatus(ctx.host);
      // The Explore StepFun field and the dedicated StepFun panel share one key — keep the panel's dot
      // in sync when stepfun is the selected explore provider. Mirror the storage boundary's trim so
      // a whitespace-only key reports the same "configured" state through both entry points.
      if (settingsManager.selectedExploreProvider() === "stepfun") {
        broadcast({ type: "stepfunAuthStatusChanged", configured: msg.apiKey.trim().length > 0 });
      }
    },

    deleteExploreApiKey: async (_msg, ctx) => {
      const wasStepfun = settingsManager.selectedExploreProvider() === "stepfun";
      await settingsManager.deleteExploreApiKey();
      await settingsManager.sendExploreKeyStatus(ctx.host);
      if (wasStepfun) {
        broadcast({ type: "stepfunAuthStatusChanged", configured: false });
      }
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

    setExploreEffort: async (msg, ctx) => {
      if (msg.type !== "setExploreEffort") return;
      await settingsManager.setExploreEffort(msg.effort);
      settingsManager.sendExploreConfig(ctx.host);
    },

    requestExploreConfig: (_msg, ctx) => {
      settingsManager.sendExploreConfig(ctx.host);
    },

    setStepfunApiKey: async (msg, ctx) => {
      if (msg.type !== "setStepfunApiKey") return;
      const key = msg.key.trim();
      if (!key) {
        postMessage(ctx.host, { type: "setStepfunApiKeyAck", requestId: msg.requestId, ok: false, error: "API key cannot be empty" });
        return;
      }
      try {
        await settingsManager.storeStepfunApiKey(key);
        postMessage(ctx.host, { type: "setStepfunApiKeyAck", requestId: msg.requestId, ok: true });
        await broadcastStepfunStatus();
      } catch (err) {
        log("[SettingsHandlers] Failed to store StepFun key:", err);
        postMessage(ctx.host, { type: "setStepfunApiKeyAck", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : "Failed to store API key" });
      }
    },

    clearStepfunApiKey: async (msg, ctx) => {
      if (msg.type !== "clearStepfunApiKey") return;
      try {
        await settingsManager.deleteStepfunApiKey();
        postMessage(ctx.host, { type: "clearStepfunApiKeyAck", requestId: msg.requestId, ok: true });
        await broadcastStepfunStatus();
      } catch (err) {
        log("[SettingsHandlers] Failed to clear StepFun key:", err);
        postMessage(ctx.host, { type: "clearStepfunApiKeyAck", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : "Failed to clear API key" });
      }
    },

    getStepfunAuthStatus: async (_msg, ctx) => {
      await settingsManager.sendStepfunAuthStatus(ctx.host);
    },

    setDeepseekApiKey: async (msg, ctx) => {
      if (msg.type !== "setDeepseekApiKey") return;
      const key = msg.key.trim();
      if (!key) {
        postMessage(ctx.host, { type: "setDeepseekApiKeyAck", requestId: msg.requestId, ok: false, error: "API key cannot be empty" });
        return;
      }
      try {
        await settingsManager.storeDeepseekApiKey(key);
        postMessage(ctx.host, { type: "setDeepseekApiKeyAck", requestId: msg.requestId, ok: true });
        broadcast({ type: "deepseekAuthStatusChanged", configured: true });
      } catch (err) {
        log("[SettingsHandlers] Failed to store DeepSeek key:", err);
        postMessage(ctx.host, { type: "setDeepseekApiKeyAck", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : "Failed to store API key" });
      }
    },

    clearDeepseekApiKey: async (msg, ctx) => {
      if (msg.type !== "clearDeepseekApiKey") return;
      try {
        await settingsManager.deleteDeepseekApiKey();
        postMessage(ctx.host, { type: "clearDeepseekApiKeyAck", requestId: msg.requestId, ok: true });
        broadcast({ type: "deepseekAuthStatusChanged", configured: false });
      } catch (err) {
        log("[SettingsHandlers] Failed to clear DeepSeek key:", err);
        postMessage(ctx.host, { type: "clearDeepseekApiKeyAck", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : "Failed to clear API key" });
      }
    },

    getDeepseekAuthStatus: async (_msg, ctx) => {
      await settingsManager.sendDeepseekAuthStatus(ctx.host);
    },

  };
}
