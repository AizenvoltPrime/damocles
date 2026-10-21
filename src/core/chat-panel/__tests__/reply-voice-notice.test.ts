import * as fs from "fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-reply-voice-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), fakeWorkspace: nodePath.join(root, "home", "workspace") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { ChatPanelProvider } from "../index";
import { installFakePlatform, type FakePlatform } from "../../../__mocks__/fake-platform";
import { PiRuntime } from "../../pi-session/pi-runtime";
import type { Disposable } from "../../../platform/disposable";
import type { HostCapabilities } from "../../../shared/types/messages";

let platform: FakePlatform;
let subscriptions: Disposable[];

type Internals = {
  panelManager: { getPanels(): Map<string, unknown> };
  voiceService: { speakReply(text: string, origin: string): Promise<void>; emit(event: "replyNotSpoken", notice: { reason: string; origin: string }): boolean };
  dispatchTtsForReply(text: string, panelId: string): void;
};

function provider(capabilities: Partial<HostCapabilities> = {}): Internals {
  platform = installFakePlatform({
    folders: [{ fsPath: fakeWorkspace, name: "workspace" }],
    capabilities: { settingsInPanel: true, ...capabilities },
    settings: { user: { "damocles.voice.tts.enabled": true } },
  });
  const created = new ChatPanelProvider(platform, {
    subscriptions,
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
  return created as unknown as Internals;
}

function chatHost() {
  const posted: unknown[] = [];
  return { posted, reveal: vi.fn(), visible: true, postMessage: async (message: unknown) => (posted.push(message), true) };
}

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

describe("speaking a reply", () => {
  it("never starts voice on a host that hides it, whatever tts.enabled holds", () => {
    const internals = provider({ voice: false });
    const speak = vi.spyOn(internals.voiceService, "speakReply").mockResolvedValue();
    internals.dispatchTtsForReply("hello", "p1");
    expect(speak).not.toHaveBeenCalled();
  });

  it("speaks on a host with voice", () => {
    const internals = provider({ voice: true });
    const speak = vi.spyOn(internals.voiceService, "speakReply").mockResolvedValue();
    internals.dispatchTtsForReply("hello", "p1");
    expect(speak).toHaveBeenCalledWith("hello", "p1");
  });
});

describe("a reply that could not be spoken", () => {
  it("names only the first line of the reason, and its action opens Voice settings in front, in another panel once the chat closed", async () => {
    const internals = provider();
    const other = chatHost();
    internals.panelManager.getPanels().set("p2", { host: other });
    platform.notifications.answerWith((call) => call.actions[0]);

    internals.voiceService.emit("replyNotSpoken", { reason: "pip install failed (exit 1):\nline 1\nline 2", origin: "p1" });

    await vi.waitFor(() => expect(other.posted).toEqual([{ type: "openSettingsPanel", section: "voice" }]));
    expect(platform.notifications.calls.at(-1)?.message).toBe("A reply could not be spoken: pip install failed (exit 1):");
    expect(other.reveal).toHaveBeenCalledOnce();
  });
});
