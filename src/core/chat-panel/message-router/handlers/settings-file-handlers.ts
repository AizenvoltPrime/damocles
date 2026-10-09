import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import { SETTINGS_FILE_SCOPES, SettingsFileAvailabilityFeed } from "../../settings-file-editor";

// A setting key the editor searches for; it never names a file.
function isSettingKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,199}$/.test(value);
}

export interface SettingsFileHandlers {
  handlers: Partial<HandlerRegistry>;
  /** Posts which settings files apply, and again on each change until the panel closes; nothing on a host that keeps none. */
  postAvailability: (ctx: HandlerContext) => void;
}

export function createSettingsFileHandlers(deps: HandlerDependencies): SettingsFileHandlers {
  const feed = new SettingsFileAvailabilityFeed(deps.platform, deps.postMessage);
  deps.subscriptions.push(feed);

  // A panel's first request ties the feed's hold on it to the panel's lifetime.
  const holdUntilPanelCloses = (ctx: HandlerContext): void => {
    const instance = deps.getPanels().get(ctx.panelId);
    // The panel closed while the request ran.
    if (!instance) {
      feed.releasePanel(ctx.panelId);
      return;
    }
    instance.disposables.push({ dispose: () => feed.releasePanel(ctx.panelId) });
  };

  const handlers: Partial<HandlerRegistry> = {
    // The settings modal's Edit settings.json: the host's editor opens the file (desktop: a pane tab).
    openSettingsFileInChat: async (msg) => {
      if (msg.type !== "openSettingsFileInChat") return;
      if (!deps.platform.capabilities.settingsSources) throw new Error("this host keeps no Damocles settings files to edit");
      if (!SETTINGS_FILE_SCOPES.includes(msg.scope)) throw new Error(`unknown settings file scope ${JSON.stringify(msg.scope)}`);
      if (msg.key !== undefined && !isSettingKey(msg.key)) throw new Error("malformed setting key");
      await deps.platform.editor.openSettingsFile(msg.scope, msg.key !== undefined ? { key: msg.key } : undefined);
    },
  };

  return {
    handlers,
    postAvailability: (ctx) => {
      if (!deps.platform.capabilities.settingsSources) return;
      if (feed.availability(ctx.panelId, ctx.host)) holdUntilPanelCloses(ctx);
    },
  };
}
