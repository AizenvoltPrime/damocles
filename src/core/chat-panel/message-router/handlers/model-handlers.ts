import type { HandlerDependencies, HandlerRegistry } from "../types";
import { writeSetting } from "../setting-write";
import { t } from "../../../l10n";

export function createModelHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { getPanels, settingsManager } = deps;

  return {
    setActiveModel: async (msg, ctx) => {
      if (msg.type !== "setActiveModel") return;
      const changed = settingsManager.setActiveModelForPanel(ctx.panelId, msg.model);
      if (changed) {
        ctx.session.setModel(msg.model);
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
      }
      settingsManager.sendModelForPanel(ctx.host, ctx.panelId);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId, ctx.folder);
    },

    setDefaultModel: async (msg, ctx) => {
      if (msg.type !== "setDefaultModel") return;
      await writeSetting(deps, ctx, "damocles.model", (detail) => t("Failed to save the default model: {0}", detail), () =>
        settingsManager.setDefaultModel(msg.model));
      for (const [panelId, instance] of getPanels()) {
        settingsManager.sendModelForPanel(instance.host, panelId);
        settingsManager.sendThinkingForPanel(instance.host, panelId, instance.folder);
      }
    },
  };
}
