import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import type { BrowserService } from "../../../browser";
import { log } from "../../../logger";
import { browserUnavailableReason, userScopeRemote } from "../../../user-scope";
import { errorTextOf, l } from "../../../l10n";

export function createBrowserHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, platform } = deps;

  function getBrowserService(): BrowserService | null {
    return deps.browserService ?? null;
  }

  /** The browser of a chat on a remote host is its client's, so a daemon's core refuses it. */
  function refusedOnRemoteHost(ctx: HandlerContext): boolean {
    if (!userScopeRemote()) return false;
    postMessage(ctx.reply, { type: "notification", message: browserUnavailableReason(), notificationType: "warning" });
    return true;
  }

  return {
    pickBrowserElement: async (_msg, ctx) => {
      if (refusedOnRemoteHost(ctx)) return;
      const browserService = getBrowserService();
      if (!browserService?.isConnected()) {
        postMessage(ctx.reply, {
          type: "notification",
          message: l("No browser session active. Open a browser first."),
          notificationType: "warning",
        });
        return;
      }

      try {
        const element = await browserService.pickElement(ctx.host);
        postMessage(ctx.reply, { type: "browserElementPicked", element });
      } catch (err) {
        log("[BrowserHandlers] Element pick failed:", err);
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Element pick failed: {0}", errorTextOf(err)),
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

    openBrowser: async (_msg, ctx) => {
      if (refusedOnRemoteHost(ctx)) return;
      const browserService = getBrowserService();
      if (!browserService) {
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Browser service not available."),
          notificationType: "error",
        });
        return;
      }

      try {
        await browserService.showForChat(ctx.host);
      } catch (err) {
        log("[BrowserHandlers] Open browser failed:", err);
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to open browser: {0}", errorTextOf(err)),
          notificationType: "error",
        });
      }
    },
  };
}
