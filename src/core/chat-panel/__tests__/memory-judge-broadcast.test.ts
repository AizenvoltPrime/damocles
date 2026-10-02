import * as fs from "fs";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-memory-judge-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), fakeWorkspace: nodePath.join(root, "home", "workspace") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { ChatPanelProvider } from "../index";
import { installLogSink } from "../../logger";
import { installFakePlatform, type FakePlatform } from "../../../__mocks__/fake-platform";
import { PiRuntime } from "../../pi-session/pi-runtime";
import { republishAccountInfo } from "../message-router/handlers/account-info";
import { folderKey } from "../../workspace-folders/folder-key";
import type { Disposable } from "../../../platform/disposable";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";

type Posted = ExtensionToWebviewMessage;

let platform: FakePlatform;
let subscriptions: Disposable[];

function harness(): { posted: Posted[]; panels: Map<string, unknown> } {
  const provider = new ChatPanelProvider(platform, {
    subscriptions,
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
  const panels = (provider as unknown as { panelManager: { getPanels: () => Map<string, unknown> } }).panelManager.getPanels();
  const posted: Posted[] = [];
  panels.set("p1", {
    host: { postMessage: async (m: Posted) => { posted.push(m); return true; } },
    session: { publishAccountInfo: () => {} },
    folder: { key: folderKey(fakeWorkspace), fsPath: fakeWorkspace, name: "workspace", label: "workspace", projectScope: true },
    permissionHandler: {},
    ideContextManager: {},
    disposables: [],
  });
  return { posted, panels };
}

const judgeUpdates = (posted: Posted[]) =>
  posted.filter((m): m is Extract<Posted, { type: "typesafeAuthStatusChanged" }> => m.type === "typesafeAuthStatusChanged");

beforeEach(() => {
  fs.mkdirSync(fakeWorkspace, { recursive: true });
  platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }] });
  subscriptions = [];
});

afterEach(async () => {
  for (const subscription of subscriptions) subscription.dispose();
  await PiRuntime.disposeInstance();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("memory judge status in open panels", () => {
  it("subscribes without creating the pi runtime", () => {
    harness();
    expect(PiRuntime.exists).toBe(false);
  });

  it("rebroadcasts when a judge input changes, before pi starts saying the sub-call model is not known yet", async () => {
    const { posted } = harness();
    PiRuntime.notifyMemoryJudgeChange();
    await vi.waitFor(() => expect(judgeUpdates(posted)).toHaveLength(1));
    expect(judgeUpdates(posted)[0]).toEqual({ type: "typesafeAuthStatusChanged", configured: false, memoryJudge: { kind: "unknown" } });
  });

  it("rebroadcasts when a classifier key is stored, here or in another window", async () => {
    const { posted } = harness();
    await platform.secrets.store("damocles.explore.apiKey.openrouter", "or-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)?.memoryJudge).toEqual({ kind: "jev", via: "openrouter" }));
    await platform.secrets.store("damocles.typesafe.apiKey", "ts-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)).toMatchObject({ configured: true, memoryJudge: { kind: "jev", via: "typesafe" } }));
  });

  it("rebroadcasts when a Claude or OpenAI credential change republishes the account", async () => {
    const { posted, panels } = harness();
    republishAccountInfo(() => panels as never);
    await vi.waitFor(() => expect(judgeUpdates(posted)).toHaveLength(1));
  });

  it("logs a status read that fails instead of leaving the rejection unhandled", async () => {
    const { posted } = harness();
    const logged: string[] = [];
    installLogSink({ appendLine: (line) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    vi.spyOn(platform.secrets, "get").mockRejectedValue(new Error("keyring locked"));

    PiRuntime.notifyMemoryJudgeChange();

    await vi.waitFor(() => expect(logged.join("\n")).toContain("reading the memory judge status failed: keyring locked"));
    expect(judgeUpdates(posted)).toHaveLength(0);
    vi.restoreAllMocks();
  });
});
