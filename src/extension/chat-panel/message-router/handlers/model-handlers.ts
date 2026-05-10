import type { HandlerDependencies, HandlerRegistry } from "../types";

export function createModelHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { getPanels, settingsManager } = deps;

  return {
    setActiveModel: async (msg, ctx) => {
      if (msg.type !== "setActiveModel") return;
      const changed = settingsManager.setActiveModelForPanel(ctx.panelId, msg.model);
      if (changed) {
        ctx.session.setModel(msg.model);
        settingsManager.sendBetasForPanel(ctx.host, ctx.panelId);
        ctx.session.setBetas(settingsManager.getActiveBetasForPanel(ctx.panelId));
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
      settingsManager.sendModelForPanel(ctx.host, ctx.panelId);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
    },

    toggleBeta: (msg, ctx) => {
      if (msg.type !== "toggleBeta") return;
      settingsManager.toggleBetaForPanel(ctx.panelId, msg.beta, msg.enabled);
      settingsManager.sendBetasForPanel(ctx.host, ctx.panelId);
      settingsManager.sendModelForPanel(ctx.host, ctx.panelId);
      ctx.session.setBetas(settingsManager.getActiveBetasForPanel(ctx.panelId));
    },

    setDefaultModel: async (msg) => {
      if (msg.type !== "setDefaultModel") return;
      await settingsManager.setDefaultModel(msg.model);
      for (const [panelId, instance] of getPanels()) {
        settingsManager.sendModelForPanel(instance.host, panelId);
        settingsManager.sendThinkingForPanel(instance.host, panelId);
      }
    },
  };
}
