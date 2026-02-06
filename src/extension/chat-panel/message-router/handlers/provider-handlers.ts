import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { log } from "../../../logger";

export function createProviderHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, getPanels, settingsManager } = deps;

  function broadcastProviderProfilesToAllPanels(): void {
    for (const [panelId, instance] of getPanels()) {
      settingsManager.sendProviderProfilesForPanel(instance.host, panelId);
    }
  }

  return {
    requestProviderProfiles: (_msg, ctx) => {
      settingsManager.sendProviderProfilesForPanel(ctx.host, ctx.panelId);
    },

    createProviderProfile: async (msg, ctx) => {
      if (msg.type !== "createProviderProfile") return;
      try {
        await settingsManager.createProviderProfile(msg.profile);
        broadcastProviderProfilesToAllPanels();
      } catch (err) {
        log("[MessageRouter] Error creating provider profile:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to create provider profile: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },

    updateProviderProfile: async (msg, ctx) => {
      if (msg.type !== "updateProviderProfile") return;
      try {
        const needsRestart = await settingsManager.updateProviderProfile(msg.originalName, msg.profile);
        broadcastProviderProfilesToAllPanels();

        if (needsRestart) {
          ctx.session.setProviderEnv(settingsManager.getActiveProviderEnvForPanel(ctx.panelId));
          ctx.session.restartForProviderChange();
        }
      } catch (err) {
        log("[MessageRouter] Error updating provider profile:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to update provider profile: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },

    deleteProviderProfile: async (msg, ctx) => {
      if (msg.type !== "deleteProviderProfile") return;
      try {
        const currentProfile = settingsManager.getActiveProviderProfileForPanel(ctx.panelId);
        const needsRestart = currentProfile === msg.profileName;
        await settingsManager.deleteProviderProfile(msg.profileName);
        broadcastProviderProfilesToAllPanels();

        if (needsRestart) {
          ctx.session.setProviderEnv(undefined);
          ctx.session.restartForProviderChange();
        }
      } catch (err) {
        log("[MessageRouter] Error deleting provider profile:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to delete provider profile: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },

    setActiveProviderProfile: async (msg, ctx) => {
      if (msg.type !== "setActiveProviderProfile") return;
      try {
        const needsRestart = settingsManager.setActiveProviderProfileForPanel(ctx.panelId, msg.profileName);
        settingsManager.sendProviderProfilesForPanel(ctx.host, ctx.panelId);

        if (needsRestart) {
          ctx.session.setProviderEnv(settingsManager.getActiveProviderEnvForPanel(ctx.panelId));
          ctx.session.restartForProviderChange();
        }
      } catch (err) {
        log("[MessageRouter] Error setting active provider profile:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to set active provider profile: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },

    setDefaultProviderProfile: async (msg, ctx) => {
      if (msg.type !== "setDefaultProviderProfile") return;
      try {
        await settingsManager.setDefaultProviderProfile(msg.profileName);
        broadcastProviderProfilesToAllPanels();
      } catch (err) {
        log("[MessageRouter] Error setting default provider profile:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to set default provider profile: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },
  };
}
