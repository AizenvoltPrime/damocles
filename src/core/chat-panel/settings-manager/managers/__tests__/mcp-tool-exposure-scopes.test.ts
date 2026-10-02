import { describe, it, expect } from "vitest";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";
import type { Platform } from "../../../../../platform/platform";
import { folderKey } from "../../../../workspace-folders/folder-key";
import { DEFAULT_WORKSPACE_FOLDER_STATE_KEY } from "../../../../workspace-folders/folder-registry";
import { McpManager } from "../mcp-manager";
import { folderTarget } from "./mcp-folder-fixtures";

/** The "Save to" scopes the MCP panel offers for a per-tool exposure, per folder. */
describe("McpManager.toolExposureScopes", () => {
  const trustedFolder = folderTarget("/ws/a");
  const openFolders = [{ fsPath: "/ws/a", name: "a" }, { fsPath: "/ws/b", name: "b" }];

  it("offers User and Project where the host keeps no local settings file, as on VS Code", () => {
    const manager = new McpManager(createFakePlatform({ folders: openFolders }), () => [trustedFolder]);
    expect(manager.toolExposureScopes(trustedFolder.key)).toEqual(["user", "project"]);
  });

  it("adds Local where the host keeps a local settings file, as on desktop", () => {
    const platform = createFakePlatform({ folders: openFolders, settings: { scopeFiles: { local: "/ws/a/.damocles/settings.local.json" } } });
    const manager = new McpManager(platform, () => [trustedFolder]);
    expect(manager.toolExposureScopes(trustedFolder.key)).toEqual(["user", "project", "local"]);
  });

  it("offers only User in an untrusted folder, where project and local values do not apply", () => {
    const platform = createFakePlatform({ trusted: false, folders: openFolders, settings: { scopeFiles: { local: "/ws/a/.damocles/settings.local.json" } } });
    const manager = new McpManager(platform, () => [trustedFolder]);
    expect(manager.toolExposureScopes(trustedFolder.key)).toEqual(["user"]);
  });

  // The settings store writes project and local values to the default project, and refuses an untrusted one.
  it("offers only User when the default project the write goes to is untrusted, though the panel's folder is trusted", () => {
    const base = createFakePlatform({
      folders: openFolders,
      workspaceState: { [DEFAULT_WORKSPACE_FOLDER_STATE_KEY]: folderKey("/ws/b") },
      settings: { scopeFiles: { local: "/ws/b/.damocles/settings.local.json" } },
    });
    const platform: Platform = { ...base, trust: { ...base.trust, isTrusted: (folder) => folderKey(folder) === folderKey("/ws/a") } };
    const manager = new McpManager(platform, () => [trustedFolder, folderTarget("/ws/b")]);
    expect(manager.toolExposureScopes(trustedFolder.key)).toEqual(["user"]);
  });

  it("offers only User for a target with no project layer, or an unknown folder", () => {
    const home = folderTarget("/home/me", false);
    const manager = new McpManager(createFakePlatform(), () => [home]);
    expect(manager.toolExposureScopes(home.key)).toEqual(["user"]);
    expect(manager.toolExposureScopes("missing")).toEqual(["user"]);
  });
});
