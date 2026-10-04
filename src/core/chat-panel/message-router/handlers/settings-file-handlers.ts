import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import { SettingsFileEditor } from "../../settings-file-editor";

export interface SettingsFileHandlers {
  handlers: Partial<HandlerRegistry>;
  /** Posts which settings files apply, and again on each change until the panel closes; nothing on a host that keeps none. */
  postAvailability: (ctx: HandlerContext) => void;
}

export function createSettingsFileHandlers(deps: HandlerDependencies): SettingsFileHandlers {
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

  const handlers: Partial<HandlerRegistry> = {
    settingsFileLoad: async (msg, ctx) => {
      if (msg.type !== "settingsFileLoad") return;
      if (await editor.load(ctx.panelId, ctx.host, msg.scope)) holdUntilPanelCloses(ctx);
    },

    settingsFileSave: async (msg, ctx) => {
      if (msg.type !== "settingsFileSave") return;
      await editor.save(ctx.panelId, ctx.host, msg.scope, msg.content, msg.baseVersion);
    },

    openSettingsFileInChat: (msg, ctx) => {
      if (msg.type !== "openSettingsFileInChat") return;
      editor.openInChat(ctx.host, msg.scope);
    },

    revealSettingsFile: async (msg) => {
      if (msg.type !== "revealSettingsFile") return;
      await editor.reveal(msg.scope);
    },
  };

  return {
    handlers,
    postAvailability: (ctx) => {
      if (!deps.platform.capabilities.settingsSources) return;
      if (editor.availability(ctx.panelId, ctx.host)) holdUntilPanelCloses(ctx);
    },
  };
}
