import * as fs from "fs";
import * as path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/** What a panel's @ list receives when trust or the walk settings change after it was listed. */
const { tmpRoot, fakeHome, workspace, outside } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-relist-")));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), workspace: nodePath.join(root, "home", "workspace"), outside: nodePath.join(root, "outside") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

// MCP's gitignore check of a trusted folder runs git; nothing here reads its answer.
vi.mock("../../pi-session/checkpoints/exec", () => ({ exec: vi.fn(async () => ({ stdout: "", stderr: "" })) }));

import { ChatPanelProvider } from "../index";
import { installFakePlatform, type FakePlatform } from "../../../__mocks__/fake-platform";
import { folderKey } from "../../workspace-folders/folder-key";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";

let platform: FakePlatform;

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(workspace, "a.txt"), "");
  fs.writeFileSync(path.join(outside, "c.txt"), "");
  fs.symlinkSync(outside, path.join(workspace, "j"), "junction");
  platform = installFakePlatform({ trusted: true, folders: [{ fsPath: workspace, name: "workspace" }] });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function attachedPanel(): { provider: ChatPanelProvider; lists: () => string[][] } {
  const provider = new ChatPanelProvider(platform, {
    subscriptions: [],
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
  const posted: ExtensionToWebviewMessage[] = [];
  const panels = (provider as unknown as { panelManager: { getPanels: () => Map<string, unknown> } }).panelManager.getPanels();
  panels.set("p1", {
    host: { postMessage: async (message: ExtensionToWebviewMessage) => { posted.push(message); return true; } },
    session: { setMcpServers: () => undefined, getMcpServerStatus: async () => [] },
    folder: { key: folderKey(workspace), fsPath: workspace, name: "workspace", label: "workspace", projectScope: true },
    permissionHandler: {},
    ideContextManager: {},
    disposables: [],
  });
  const lists = (): string[][] => posted.flatMap((message) => (message.type === "workspaceFiles" ? [message.files.filter((file) => !file.isDirectory).map((file) => file.relativePath).sort()] : []));
  return { provider, lists };
}

describe("a panel's @ list after it was listed", () => {
  it("is posted again without links once trust is taken back, with them once it is granted, and without them once the follow switch is off", async () => {
    const { provider, lists } = attachedPanel();
    try {
      platform.trust.revokeTrust();
      await vi.waitFor(() => expect(lists()).toHaveLength(1));
      expect(lists()[0]).toEqual(["a.txt"]);
      platform.trust.grantTrust();
      await vi.waitFor(() => expect(lists()).toHaveLength(2));
      expect(lists()[1]).toEqual(["a.txt", "j/c.txt"]);
      await platform.settings.update("search.followSymlinks", false, "user");
      await vi.waitFor(() => expect(lists()).toHaveLength(3));
      expect(lists()[2]).toEqual(["a.txt"]);
      // with the follow switch off, trust decides nothing the list holds
      platform.trust.revokeTrust();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(lists()).toHaveLength(3);
    } finally {
      // the stand-in panel has no session to release
      (provider as unknown as { panelManager: { getPanels: () => Map<string, unknown> } }).panelManager.getPanels().clear();
      await provider.dispose();
    }
  });
});
