import type { HandlerDependencies, HandlerRegistry } from "../types";
import { log } from "../../../logger";

export function createWorkspaceFolderHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { folderRegistry, switchPanelFolder, postWorkspaceFolderState } = deps;

  return {
    setPanelWorkspaceFolder: async (msg, ctx) => {
      if (msg.type !== "setPanelWorkspaceFolder") return;
      try {
        await switchPanelFolder(ctx.panelId, msg.folderKey, "user");
      } catch (err) {
        // The webview holds its input until a workspaceFolderUpdate answers this message, thrown or not.
        postWorkspaceFolderState(ctx.panelId);
        throw err;
      }
    },

    setDefaultWorkspaceFolder: async (msg, ctx) => {
      if (msg.type !== "setDefaultWorkspaceFolder") return;
      // Every panel hears of an accepted default through the registry's change event.
      if (await folderRegistry.setDefault(msg.folderKey)) return;
      log("[WorkspaceFolderHandlers] Ignoring a default folder key that is not open: %s", msg.folderKey);
      postWorkspaceFolderState(ctx.panelId);
    },
  };
}
