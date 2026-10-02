import * as fs from "fs";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-replay-reasons-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), fakeWorkspace: nodePath.join(root, "home", "workspace") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { ChatPanelProvider } from "../index";
import { installFakePlatform } from "../../../__mocks__/fake-platform";
import { PiRuntime } from "../../pi-session/pi-runtime";
import type { Disposable } from "../../../platform/disposable";
import type { ModelReasonsLookup } from "../../pi-session/session-store/history-loader";

let subscriptions: Disposable[];

/** The registry lookup the history manager hands each replay. */
function replayModelReasons(): () => Promise<ModelReasonsLookup | undefined> {
  const provider = new ChatPanelProvider(installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }] }), {
    subscriptions,
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
  return (provider as unknown as { historyManager: { modelReasons: () => Promise<ModelReasonsLookup | undefined> } }).historyManager.modelReasons;
}

beforeEach(() => {
  fs.mkdirSync(fakeWorkspace, { recursive: true });
  subscriptions = [];
});

afterEach(async () => {
  for (const subscription of subscriptions) subscription.dispose();
  vi.restoreAllMocks();
  await PiRuntime.disposeInstance();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("replayed reply effort lookup", () => {
  // A replay that lands after `disposeInstance` at shutdown would otherwise build a runtime whose watchers nothing disposes.
  it("creates no pi runtime after shutdown retired it, and answers without a lookup", async () => {
    const modelReasons = replayModelReasons();
    PiRuntime.get();
    await PiRuntime.disposeInstance();

    await expect(modelReasons()).resolves.toBeUndefined();
    expect(PiRuntime.exists).toBe(false);
  });

  it("creates the runtime for a panel restored at startup, so its replies keep their effort badges", async () => {
    const models = { getModel: (provider: string, id: string) => (provider === "anthropic" && id === "opus" ? { reasoning: true } : undefined) };
    vi.spyOn(PiRuntime.prototype, "modelRuntimeReady").mockResolvedValue(models as never);
    // Each test starts after the previous one's disposeInstance; a fresh process has retired nothing.
    (PiRuntime as unknown as { _retired: boolean })._retired = false;
    const modelReasons = replayModelReasons();

    const lookup = await modelReasons();

    expect(PiRuntime.exists).toBe(true);
    expect(lookup?.("anthropic", "opus")).toBe(true);
  });

  it("reads the existing runtime's model registry without waiting for the rest of its init", async () => {
    const modelReasons = replayModelReasons();
    const runtime = PiRuntime.get();
    const models = { getModel: (provider: string, id: string) => (provider === "anthropic" && id === "opus" ? { reasoning: true } : undefined) };
    vi.spyOn(runtime, "modelRuntimeReady").mockResolvedValue(models as never);
    const init = vi.spyOn(runtime, "init");

    const lookup = await modelReasons();

    expect(lookup?.("anthropic", "opus")).toBe(true);
    expect(lookup?.("anthropic", "other")).toBeUndefined();
    expect(init).not.toHaveBeenCalled();
  });
});
