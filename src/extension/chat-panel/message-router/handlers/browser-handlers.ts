import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { BrowserService } from "../../../browser";
import { log } from "../../../logger";

export function createBrowserHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage } = deps;

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
        const element = await browserService.pickElement();
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

    openElementContext: async (msg) => {
      if (msg.type !== "openElementContext") return;
      try {
        const doc = await vscode.workspace.openTextDocument({ content: msg.content, language: "html" });
        await vscode.window.showTextDocument(doc, { preview: true });
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
        // The human's toolbar open targets the PRIMARY scope — the same tab the main agent drives, so
        // "I open a page, then the agent continues on it" keeps working.
        await browserService.openPrimary(msg.url);
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
