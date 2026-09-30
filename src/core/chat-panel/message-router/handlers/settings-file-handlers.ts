import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import { SettingsFileEditor } from "../../settings-file-editor";

export function createSettingsFileHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const editor = new SettingsFileEditor(deps.platform, deps.postMessage);
  deps.subscriptions.push(editor);

  // A panel's first request ties the editor's hold on it to the panel's lifetime.
  const holdUntilPanelCloses = (ctx: HandlerContext): void => {
    const instance = deps.getPanels().get(ctx.panelId);
    // The panel closed while the request ran.
    if (!instance) {
      editor.releasePanel(ctx.panelId);
      return;
    }
    instance.disposables.push({ dispose: () => editor.releasePanel(ctx.panelId) });
  };

  return {
    settingsFileLoad: async (msg, ctx) => {
      if (msg.type !== "settingsFileLoad") return;
      if (await editor.load(ctx.panelId, ctx.host, msg.scope)) holdUntilPanelCloses(ctx);
    },

    settingsFileSave: async (msg, ctx) => {
      if (msg.type !== "settingsFileSave") return;
      await editor.save(ctx.panelId, ctx.host, msg.scope, msg.content, msg.baseVersion);
    },

    getSettingsFileAvailability: (msg, ctx) => {
      if (msg.type !== "getSettingsFileAvailability") return;
      if (editor.availability(ctx.panelId, ctx.host)) holdUntilPanelCloses(ctx);
    },

    revealSettingsFile: async (msg) => {
      if (msg.type !== "revealSettingsFile") return;
      await editor.reveal(msg.scope);
    },
  };
}
