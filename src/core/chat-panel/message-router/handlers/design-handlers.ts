import * as path from "path";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { isSafeAgentPathId } from "../../../../shared/agent-path-id";
import { hasUnsafeWindowsSegment, isRelativeFilePath } from "../../../../shared/relative-path";
import { isFileBelow } from "../../../paths";
import { listDesignFiles } from "../../../design/design-files";
import { errorTextOf, l } from "../../../l10n";
import { LocalizedError } from "../../../../shared/localized-text";
import { log } from "../../../logger";

const MAX_REQUEST_ID_CHARS = 128;

/** A design-folder-relative path the webview names: a '/' separated relative path with no segment Windows resolves elsewhere. */
function isDesignRelativePath(value: unknown): value is string {
  return typeof value === "string" && isRelativeFilePath(value) && !hasUnsafeWindowsSegment(value);
}

/** The design chat's buttons: its parent, its own design chat, and the files of its own design folder only, in an editor or the browser. */
export function createDesignHandlers(deps: HandlerDependencies): HandlerRegistry {
  const { postMessage, workspaceManager, platform } = deps;
  return {
    openDesignChat: async (msg, ctx) => {
      if (msg.type !== "openDesignChat" || !isSafeAgentPathId(msg.designId)) return;
      await ctx.session.design.openDesignChat(msg.designId);
    },

    openParentChat: async (msg, ctx) => {
      if (msg.type !== "openParentChat") return;
      await ctx.session.design.openParentChat();
    },

    openDesignFile: async (msg, ctx) => {
      if (msg.type !== "openDesignFile" || !isSafeAgentPathId(msg.designId)) return;
      const folder = ctx.session.design.folderOf(msg.designId);
      const target = folder !== undefined && isDesignRelativePath(msg.file) ? path.resolve(folder, ...msg.file.split("/")) : undefined;
      // The file the button names must be in this chat's own design folder, through links too.
      if (folder === undefined || target === undefined || !isFileBelow(folder, target)) {
        log("[DesignHandlers] refused to open %s of design %s", msg.file, msg.designId);
        // A malformed message may carry any JSON value, and an object argument would render as localized text.
        void platform.notifications.error(l("Could not open file: {0}", String(msg.file)));
        return;
      }
      await workspaceManager.handleOpenFile(ctx.panelId, target, undefined, ctx.folder);
    },

    openDesignInBrowser: async (msg, ctx) => {
      if (msg.type !== "openDesignInBrowser" || !isSafeAgentPathId(msg.designId)) return;
      const host = platform.design;
      // A remote core never asks this computer to open a URL; desktop opens designs from main's own UI (PD-35).
      if (!host || !ctx.session.design.hostRuleSet().openInBrowserFromChat) {
        log("[DesignHandlers] refused to open design %s in the browser: this host opens designs only from its own UI", msg.designId);
        postMessage(ctx.reply, { type: "notification", message: l("This window does not open designs in the browser."), notificationType: "warning" });
        return;
      }
      const folder = ctx.session.design.servedFolderOf(msg.designId);
      if (folder === undefined || !isDesignRelativePath(msg.relPath)) {
        log("[DesignHandlers] refused to open %s of design %s in the browser", msg.relPath, msg.designId);
        postMessage(ctx.reply, { type: "notification", message: l("Could not open {0} in the browser.", String(msg.relPath)), notificationType: "error" });
        return;
      }
      try {
        const url = await host.openInBrowser(msg.designId, folder, msg.relPath);
        postMessage(ctx.reply, url === undefined
          ? { type: "notification", message: l("Could not open {0} in the browser.", msg.relPath), notificationType: "error" }
          : { type: "notification", message: l("Opened {0} in the browser.", url), notificationType: "info" });
      } catch (err) {
        log("[DesignHandlers] opening %s of design %s in the browser failed: %O", msg.relPath, msg.designId, err);
        postMessage(ctx.reply, { type: "notification", message: l("Could not open {0} in the browser: {1}", msg.relPath, errorTextOf(err)), notificationType: "error" });
      }
    },

    openDesignPreview: async (msg, ctx) => {
      if (msg.type !== "openDesignPreview" || !isSafeAgentPathId(msg.designId)) return;
      // The design must be this chat's own (its role or own link); the tab opens in its design chat (PD-33).
      if (!isDesignRelativePath(msg.relPath) || ctx.session.design.folderOf(msg.designId) === undefined) {
        log("[DesignHandlers] refused to preview %s of design %s", msg.relPath, msg.designId);
        postMessage(ctx.reply, { type: "notification", message: l("Could not preview {0}.", String(msg.relPath)), notificationType: "error" });
        return;
      }
      try {
        if (await ctx.session.design.openPreview(msg.designId, msg.relPath)) return;
        postMessage(ctx.reply, { type: "notification", message: l("Open the design chat to preview {0}.", msg.relPath), notificationType: "warning" });
      } catch (err) {
        log("[DesignHandlers] previewing %s of design %s failed: %O", msg.relPath, msg.designId, err);
        postMessage(ctx.reply, { type: "notification", message: l("Could not preview {0}: {1}", msg.relPath, errorTextOf(err)), notificationType: "error" });
      }
    },

    // The thumbnail reaches the asking webview only, as toolResultImages does; nothing of it is stored.
    requestDesignPreviewImage: async (msg, ctx) => {
      if (msg.type !== "requestDesignPreviewImage") return;
      const { requestId, toolUseId, questionIndex, optionIndex } = msg as { requestId: unknown; toolUseId: unknown; questionIndex: unknown; optionIndex: unknown };
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_CHARS) {
        log("[DesignHandlers] requestDesignPreviewImage dropped: invalid requestId");
        return;
      }
      const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 16;
      if (typeof toolUseId !== "string" || toolUseId.length === 0 || toolUseId.length > MAX_REQUEST_ID_CHARS || !isIndex(questionIndex) || !isIndex(optionIndex)) {
        postMessage(ctx.reply, { type: "designPreviewImage", requestId, error: l("This option has no design preview.") });
        return;
      }
      try {
        const image = await ctx.session.design.questionPreviewImage(toolUseId, questionIndex, optionIndex, ctx.permissionHandler.openQuestions(toolUseId));
        postMessage(ctx.reply, { type: "designPreviewImage", requestId, image });
      } catch (err) {
        log("[DesignHandlers] the preview of option %d of question %d of %s failed: %O", optionIndex, questionIndex, toolUseId, err);
        postMessage(ctx.reply, { type: "designPreviewImage", requestId, error: errorTextOf(err) });
      }
    },

    // The journey comes from this chat's branch, never the webview; the reply reaches the asking view once the replay ended.
    replayDesignJourney: async (msg, ctx) => {
      if (msg.type !== "replayDesignJourney") return;
      const { toolCallId, reducedMotion } = msg as { toolCallId: unknown; reducedMotion: unknown };
      if (typeof toolCallId !== "string" || toolCallId.length === 0 || toolCallId.length > MAX_REQUEST_ID_CHARS) {
        log("[DesignHandlers] replayDesignJourney dropped: invalid toolCallId");
        return;
      }
      try {
        await ctx.session.design.replayJourney(toolCallId, reducedMotion === true);
        postMessage(ctx.reply, { type: "designJourneyReplayed", toolCallId, ok: true });
      } catch (err) {
        log("[DesignHandlers] replaying journey %s failed: %O", toolCallId, err);
        postMessage(ctx.reply, { type: "designJourneyReplayed", toolCallId, ok: false, error: err instanceof LocalizedError ? err.text : l("Could not replay the journey: {0}", errorTextOf(err)) });
      }
    },

    requestDesignFiles: async (msg, ctx) => {
      if (msg.type !== "requestDesignFiles" || !isSafeAgentPathId(msg.designId)) return;
      const folder = ctx.session.design.folderOf(msg.designId);
      if (folder === undefined) {
        log("[DesignHandlers] refused to list design %s, which is not this chat's", msg.designId);
        postMessage(ctx.reply, { type: "designFiles", designId: msg.designId, files: [], failed: true });
        return;
      }
      try {
        postMessage(ctx.reply, { type: "designFiles", designId: msg.designId, files: await listDesignFiles(folder) });
      } catch (err) {
        log("[DesignHandlers] listing design %s failed: %O", msg.designId, err);
        void platform.notifications.error(l("Could not list the design's files: {0}", errorTextOf(err)));
        postMessage(ctx.reply, { type: "designFiles", designId: msg.designId, files: [], failed: true });
      }
    },
  };
}
