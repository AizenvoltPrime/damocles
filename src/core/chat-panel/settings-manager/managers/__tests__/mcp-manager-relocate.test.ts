import * as path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { installFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";
import type { Memento } from "../../../../../platform/key-value-state";
import { folderKey } from "../../../../workspace-folders/folder-key";
import {
  McpManager,
  MCP_DISABLED_PROJECT_SERVERS_KEY,
  MCP_DISABLED_SPLIT_PENDING_KEY,
  MCP_ENABLED_PROJECT_SERVERS_KEY,
} from "../mcp-manager";

const root = path.resolve("/mcp-relocate");
const oldKey = folderKey(path.join(root, "old"));
const newKey = folderKey(path.join(root, "new"));
const targetKey = folderKey(path.join(root, "target"));

let platform: FakePlatform;

function memento(initial: Record<string, unknown>): Memento & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? store.get(key) : defaultValue) as T,
    update: async (key: string, value: unknown): Promise<void> => { store.set(key, value); },
  } as Memento & { store: Map<string, unknown> };
}

const managerOn = (state: Memento): McpManager => new McpManager({ ...platform, state: { global: platform.state.global, workspace: state } }, () => []);

beforeEach(() => {
  platform = installFakePlatform();
});

describe("McpManager.relocateFolders", () => {
  it("re-keys a located folder's disabled and enabled lists and the split's progress", async () => {
    const state = memento({
      [MCP_DISABLED_PROJECT_SERVERS_KEY]: { [oldKey]: ["db"], other: ["x"] },
      [MCP_ENABLED_PROJECT_SERVERS_KEY]: { [oldKey]: ["search"] },
      [MCP_DISABLED_SPLIT_PENDING_KEY]: { names: ["db"], migratedFolders: [oldKey], decided: { [oldKey]: ["db"] } },
    });
    await managerOn(state).relocateFolders([{ from: path.join(root, "old"), to: path.join(root, "new") }]);
    expect(state.store.get(MCP_DISABLED_PROJECT_SERVERS_KEY)).toEqual({ other: ["x"], [newKey]: ["db"] });
    expect(state.store.get(MCP_ENABLED_PROJECT_SERVERS_KEY)).toEqual({ [newKey]: ["search"] });
    expect(state.store.get(MCP_DISABLED_SPLIT_PENDING_KEY)).toEqual({ names: ["db"], migratedFolders: [newKey], decided: { [newKey]: ["db"] } });
  });

  it("keeps a merge target's own lists and drops the old folder's where the target has one", async () => {
    const state = memento({
      [MCP_DISABLED_PROJECT_SERVERS_KEY]: { [oldKey]: ["db"], [targetKey]: ["web"] },
      [MCP_ENABLED_PROJECT_SERVERS_KEY]: { [oldKey]: ["search"] },
    });
    await managerOn(state).relocateFolders([{ from: path.join(root, "old"), to: path.join(root, "target") }]);
    expect(state.store.get(MCP_DISABLED_PROJECT_SERVERS_KEY)).toEqual({ [targetKey]: ["web"] });
    expect(state.store.get(MCP_ENABLED_PROJECT_SERVERS_KEY)).toEqual({ [targetKey]: ["search"] });
  });

  it("writes nothing once nothing is left under the old key", async () => {
    const state = memento({ [MCP_DISABLED_PROJECT_SERVERS_KEY]: { [newKey]: ["db"] } });
    const before = new Map(state.store);
    await managerOn(state).relocateFolders([{ from: path.join(root, "old"), to: path.join(root, "new") }]);
    expect(state.store).toEqual(before);
  });
});
