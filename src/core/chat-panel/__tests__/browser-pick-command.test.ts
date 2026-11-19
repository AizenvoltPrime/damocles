import * as fs from "fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-browser-pick-"));
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
import { PickCancelledError, type BrowserService } from "../../browser";
import * as logger from "../../logger";
import type { ElementAttachment } from "../../../shared/types/browser";

// The VS Code command Damocles: Pick Browser Element (damocles.pickBrowserElement).
let platform: FakePlatform;
let subscriptions: Disposable[];

type Internals = {
  panelManager: { getPanels(): Map<string, unknown>; lastActivePanelId: string | null };
  browserService: BrowserService;
};

function provider(): ChatPanelProvider {
  platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }], capabilities: { settingsInPanel: true } });
  return new ChatPanelProvider(platform, {
    subscriptions,
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
}

function chatHost() {
  const posted: unknown[] = [];
  return { posted, visible: true, postMessage: async (message: unknown) => (posted.push(message), true) };
}

const attachment: ElementAttachment = { id: "e1", selector: "s", tagName: "div", attributes: {}, outerHTML: "<div></div>", computedStyles: {}, boundingBox: { x: 0, y: 0, width: 1, height: 1 }, elementScreenshot: "", consoleMessages: [], networkErrors: [] };

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

describe("the pick command", () => {
  it("picks on the active chat's page and posts the element to that chat alone", async () => {
    const created = provider();
    const internals = created as unknown as Internals;
    const [a, b] = [chatHost(), chatHost()];
    internals.panelManager.getPanels().set("pa", { host: a });
    internals.panelManager.getPanels().set("pb", { host: b });
    internals.panelManager.lastActivePanelId = "pb";
    vi.spyOn(internals.browserService, "isConnected").mockReturnValue(true);
    vi.spyOn(internals.browserService, "holdsPages").mockReturnValue(true);
    const pick = vi.spyOn(internals.browserService, "pickElement").mockResolvedValue(attachment);

    await created.pickBrowserElementForActiveChat();

    expect(pick).toHaveBeenCalledWith(b);
    expect(b.posted).toContainEqual({ type: "browserElementPicked", element: attachment });
    expect(a.posted).toEqual([]);
  });

  it("warns and picks nothing when no chat is open", async () => {
    const created = provider();
    const internals = created as unknown as Internals;
    vi.spyOn(internals.browserService, "isConnected").mockReturnValue(true);
    const pick = vi.spyOn(internals.browserService, "pickElement");
    const warn = vi.spyOn(platform.notifications, "warn");

    await created.pickBrowserElementForActiveChat();

    expect(pick).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ message: "Damocles: No chat panel is open. Open one to receive picked elements." });
  });

  it("warns and picks nothing when no browser runs", async () => {
    const created = provider();
    const internals = created as unknown as Internals;
    internals.panelManager.getPanels().set("pa", { host: chatHost() });
    const pick = vi.spyOn(internals.browserService, "pickElement");
    const warn = vi.spyOn(platform.notifications, "warn");

    await created.pickBrowserElementForActiveChat();

    expect(pick).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ message: "Damocles: No browser session active. Open a browser first." });
  });

  it("says the active chat has no page, and picks nothing, while only another chat's page is open", async () => {
    const created = provider();
    const internals = created as unknown as Internals;
    const [a, b] = [chatHost(), chatHost()];
    internals.panelManager.getPanels().set("pa", { host: a });
    internals.panelManager.getPanels().set("pb", { host: b });
    internals.panelManager.lastActivePanelId = "pb";
    vi.spyOn(internals.browserService, "isConnected").mockReturnValue(true);
    vi.spyOn(internals.browserService, "holdsPages").mockImplementation((chat) => chat === (a as unknown));
    const pick = vi.spyOn(internals.browserService, "pickElement");
    const warn = vi.spyOn(platform.notifications, "warn");
    const error = vi.spyOn(platform.notifications, "error");

    await created.pickBrowserElementForActiveChat();

    expect(pick).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ message: "Damocles: The active chat has no browser page." });
    expect(error).not.toHaveBeenCalled();
  });

  describe("once the pick is armed", () => {
    function armed(): { created: ChatPanelProvider; internals: Internals; chat: ReturnType<typeof chatHost>; pick: ReturnType<typeof vi.spyOn> } {
      const created = provider();
      const internals = created as unknown as Internals;
      const chat = chatHost();
      internals.panelManager.getPanels().set("pa", { host: chat });
      internals.panelManager.lastActivePanelId = "pa";
      vi.spyOn(internals.browserService, "isConnected").mockReturnValue(true);
      vi.spyOn(internals.browserService, "holdsPages").mockReturnValue(true);
      return { created, internals, chat, pick: vi.spyOn(internals.browserService, "pickElement") };
    }

    it("stays silent when the pick is cancelled", async () => {
      const { created, pick } = armed();
      pick.mockRejectedValue(new PickCancelledError());
      const warn = vi.spyOn(platform.notifications, "warn");
      const error = vi.spyOn(platform.notifications, "error");

      await created.pickBrowserElementForActiveChat();

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it("shows a failure whose text only mentions a cancel", async () => {
      const { created, pick } = armed();
      pick.mockRejectedValue(new Error("net::ERR_ABORTED: request cancelled"));
      const error = vi.spyOn(platform.notifications, "error");

      await created.pickBrowserElementForActiveChat();

      expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "Damocles: Element pick failed: {0}" }));
    });

    it("logs a notice the host could not show instead of leaving its rejection unhandled", async () => {
      const { created, pick } = armed();
      pick.mockRejectedValue(new Error("Element picking timed out after 60s with no selection"));
      vi.spyOn(platform.notifications, "error").mockRejectedValue(new Error("no window"));
      const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});

      await created.pickBrowserElementForActiveChat();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(logSpy.mock.calls.map((call) => call.map(String).join(" "))).toContain("[ChatPanelProvider] Could not show the pick failure: Error: no window");
      logSpy.mockRestore();
    });

    it("logs, and tells no one that no chat is open, when the pick's chat closed before the element arrived", async () => {
      const { created, internals, chat, pick } = armed();
      const other = chatHost();
      internals.panelManager.getPanels().set("pb", { host: other });
      let deliver!: (element: ElementAttachment) => void;
      pick.mockReturnValue(new Promise((resolve) => { deliver = resolve; }));
      const warn = vi.spyOn(platform.notifications, "warn");
      const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});

      const picking = created.pickBrowserElementForActiveChat();
      internals.panelManager.getPanels().delete("pa");
      deliver(attachment);
      await picking;

      expect(warn).not.toHaveBeenCalled();
      expect(chat.posted).toEqual([]);
      expect(other.posted).toEqual([]);
      expect(logSpy.mock.calls.map((call) => call.map(String).join(" "))).toContain("[ChatPanelProvider] A picked element's chat closed during the pick");
      logSpy.mockRestore();
    });
  });
});
