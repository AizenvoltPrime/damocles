import type { HandlerDependencies, HandlerRegistry } from "../types";
import { writeSetting } from "../setting-write";
import { t } from "../../../l10n";

export function createModelHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { getPanels, settingsManager } = deps;

  return {
    // A request only: the session publishes the model it committed, which the panel then shows.
    setActiveModel: (msg, ctx) => {
      if (msg.type !== "setActiveModel") return;
      void ctx.session.setModel(msg.model);
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
