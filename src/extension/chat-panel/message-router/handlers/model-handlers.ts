import type { HandlerDependencies, HandlerRegistry } from "../types";

export function createModelHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { getPanels, settingsManager } = deps;

  return {
    setActiveModel: (msg, ctx) => {
      if (msg.type !== "setActiveModel") return;
      const changed = settingsManager.setActiveModelForPanel(ctx.panelId, msg.model);
      settingsManager.sendModelForPanel(ctx.host, ctx.panelId);
      if (changed) {
        ctx.session.setModel(msg.model);
        settingsManager.handleModelBetaCleanupForPanel(ctx.panelId);
        settingsManager.sendBetasForPanel(ctx.host, ctx.panelId);
        ctx.session.setBetas(settingsManager.getActiveBetasForPanel(ctx.panelId));
      }
    },

    toggleBeta: (msg, ctx) => {
      if (msg.type !== "toggleBeta") return;
      settingsManager.toggleBetaForPanel(ctx.panelId, msg.beta, msg.enabled);
      settingsManager.sendBetasForPanel(ctx.host, ctx.panelId);
      ctx.session.setBetas(settingsManager.getActiveBetasForPanel(ctx.panelId));
    },

    setDefaultModel: async (msg) => {
      if (msg.type !== "setDefaultModel") return;
      await settingsManager.setDefaultModel(msg.model);
      for (const [panelId, instance] of getPanels()) {
        settingsManager.sendModelForPanel(instance.host, panelId);
      }
    },
  };
}
