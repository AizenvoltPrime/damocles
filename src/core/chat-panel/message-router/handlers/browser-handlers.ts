import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { BrowserService } from "../../../browser";
import { log } from "../../../logger";

export function createBrowserHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, platform } = deps;

  function getBrowserService(): BrowserService | null {
    return deps.browserService ?? null;
  }

  return {
    pickBrowserElement: async (_msg, ctx) => {
      const browserService = getBrowserService();
      if (!browserService?.isConnected()) {
        postMessage(ctx.host, {
          type: "notification",
          message: "No browser session active. Open a browser first.",
          notificationType: "warning",
        });
        return;
      }

      try {
        const element = await browserService.pickElement(ctx.host);
        postMessage(ctx.host, { type: "browserElementPicked", element });
      } catch (err) {
        log("[BrowserHandlers] Element pick failed:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: `Element pick failed: ${err instanceof Error ? err.message : String(err)}`,
          notificationType: "error",
        });
      }
    },

    openElementContext: async (msg, ctx) => {
      if (msg.type !== "openElementContext") return;
      try {
        await platform.editor.openUntitled(msg.content, "html", { panelId: ctx.panelId });
      } catch (err) {
        log("[BrowserHandlers] Failed to open element context:", err);
      }
    },

    openBrowser: async (msg, ctx) => {
      if (msg.type !== "openBrowser") return;
      const browserService = getBrowserService();
      if (!browserService) {
        postMessage(ctx.host, {
          type: "notification",
          message: "Browser service not available.",
          notificationType: "error",
        });
        return;
      }

      try {
        // The human's toolbar open targets the chat's human scope, the same tab the main agent drives, so
        // "I open a page, then the agent continues on it" keeps working.
        await browserService.openForChat(ctx.host, msg.url);
      } catch (err) {
        log("[BrowserHandlers] Open browser failed:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: `Failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
          notificationType: "error",
        });
      }
    },
  };
}
