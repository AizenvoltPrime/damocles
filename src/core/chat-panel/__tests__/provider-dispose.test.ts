import * as fs from "fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-provider-dispose-"));
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
import type { StorageManager } from "../storage-manager";

type Internals = {
  storageManager: StorageManager;
  relocations: { engine: { runs: Map<string, Promise<void>> } };
};

let subscriptions: Disposable[];

beforeEach(() => {
  fs.mkdirSync(fakeWorkspace, { recursive: true });
  subscriptions = [];
});

afterEach(async () => {
  for (const subscription of subscriptions) subscription.dispose();
  await PiRuntime.disposeInstance();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ChatPanelProvider.dispose", () => {
  // A relocation's sessions step reads and moves rows of the session index, which stays open until the run in flight ends.
  it("closes the session index only once the relocation run in flight has ended", async () => {
    const platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }] });
    const provider = new ChatPanelProvider(platform, {
      subscriptions,
      createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
    });
    const internals = provider as unknown as Internals;
    let endRun!: () => void;
    internals.relocations.engine.runs.set("r1", new Promise<void>((resolve) => { endRun = resolve; }));
    const close = vi.spyOn(internals.storageManager.metaIndex, "close");

    const disposed = provider.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(close).not.toHaveBeenCalled();

    internals.relocations.engine.runs.delete("r1");
    endRun();
    await disposed;
    expect(close).toHaveBeenCalledTimes(1);
  });
});
