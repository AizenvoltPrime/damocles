import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, afterAll, vi } from "vitest";

/**
 * Renaming a `~/.damocles/mcp.json` server moves the per-tool disabled names with it, driven through
 * the real `SettingsManager` over a real file in a redirected home.
 */
const { tmpRoot, fakeHome, folder } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-mcp-rename-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), folder: nodePath.join(root, "ws") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

const execMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => { throw new Error("fatal: not a git repository"); }));
vi.mock("../../../pi-session/checkpoints/exec", () => ({ exec: execMock }));

import * as vscode from "vscode";
import { SettingsManager } from "..";
import { MCP_DISABLED_SERVERS_KEY, MCP_DISABLED_SPLIT_MIGRATED_KEY } from "../managers/mcp-manager";
import { folderTarget } from "../managers/__tests__/mcp-folder-fixtures";

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function memento(initial: Record<string, unknown>): vscode.Memento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? store.get(key) : defaultValue) as T,
    update: async (key: string, value: unknown): Promise<void> => { store.set(key, value); },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

describe("SettingsManager.updateMcpServer rename", () => {
  it("remaps a disabled server's switched-off tools to its new name", async () => {
    fs.mkdirSync(path.join(fakeHome, ".damocles"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".damocles", "mcp.json"), JSON.stringify({ mcpServers: { "my.docs": { command: "docs" } } }), "utf-8");
    fs.mkdirSync(folder, { recursive: true });
    const target = folderTarget(folder);

    let disabledTools = ["mcp__my_docs__search", "mcp__other__run"];
    const original = vscode.workspace.getConfiguration;
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = (section?: string) => ({
      get: (key: string, defaultValue?: unknown) =>
        section === "damocles" && key === "tools.disabled" ? disabledTools : defaultValue,
      inspect: () => ({ globalValue: disabledTools }),
      update: async (key: string, value: unknown) => {
        if (section === "damocles" && key === "tools.disabled") disabledTools = value as string[];
      },
    });
    try {
      const settings = new SettingsManager({
        postMessage: () => {},
        secrets: {} as vscode.SecretStorage,
        workspaceState: memento({ [MCP_DISABLED_SPLIT_MIGRATED_KEY]: true, [MCP_DISABLED_SERVERS_KEY]: ["my.docs"] }),
        folders: () => [target],
      });
      await settings.loadMcpConfig();

      await settings.updateMcpServer(target.key, "my.docs", "handbook", { command: "docs" });

      expect(disabledTools).toEqual(["mcp__handbook__search", "mcp__other__run"]);
      settings.dispose();
    } finally {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = original;
    }
  });
});
