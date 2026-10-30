// @vitest-environment happy-dom
// A daemon's core whose chat two devices show, each in its own language: core sends its text as LocalizedText, and each
// device's chat page renders it in the language core gave that device's views (docs/invariants.md "Localized text").
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("vue-sonner", () => {
  const show = (text: string): void => void toasts.push(text);
  return { toast: Object.assign(show, { info: show, success: show, warning: show, error: show }) };
});

import { ChatPanelProvider } from "../index";
import { installFakePlatform } from "../../../__mocks__/fake-platform";
import { createFakeRemoteHost } from "../../../__mocks__/fake-remote-host";
import { inGreek } from "../../../__mocks__/greek-locale";
import { PiRuntime } from "../../pi-session/pi-runtime";
import { postUserPromptVerdict } from "../../pi-session/hooks";
import { folderKey } from "../../workspace-folders/folder-key";
import { englishText } from "../../../shared/localized-text";
import type { Disposable } from "../../../platform/disposable";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";
import type { PanelHost } from "../../../platform/window-service";
import type { HostInstance } from "../types";
import { chatPage } from "../../pi-session/__tests__/live-chat-page";

type Posted = ExtensionToWebviewMessage;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dam-device-language-"));
const workspace = path.join(tmpRoot, "workspace");
const BLOCKED = { message: "Your prompt was blocked by a hook." };

let subscriptions: Disposable[];

beforeEach(() => {
  fs.mkdirSync(workspace, { recursive: true });
  subscriptions = [];
  toasts.length = 0;
});

afterEach(async () => {
  for (const subscription of subscriptions) subscription.dispose();
  await PiRuntime.disposeInstance();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A chat on a daemon's core that device-a (English) and device-b (Greek) show, a view each. */
function chatTwoDevicesShow() {
  const platform = installFakePlatform({ folders: [{ fsPath: workspace, name: "workspace" }] });
  const host = createFakeRemoteHost();
  Object.assign(platform, { remote: host.remote });
  const provider = new ChatPanelProvider(platform, {
    subscriptions,
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
  const panelManager = provider.getPanelManager();
  const views = new Map<string, Posted[]>([["view-a", []], ["view-b", []]]);
  const panelHost = {
    // a post to the panel reaches every view
    postMessage: async (m: Posted) => {
      for (const shown of views.values()) shown.push(m);
      return true;
    },
    views: () => [{ viewKey: "view-a", clientId: "device-a" }, { viewKey: "view-b", clientId: "device-b" }],
    viewHost: (viewKey: string) => ({ postMessage: async (m: Posted) => { views.get(viewKey)!.push(m); return true; } }),
  } as unknown as PanelHost;
  panelManager.getPanels().set("p1", {
    host: panelHost,
    session: { publishAccountInfo: vi.fn(), publishAvailableModels: vi.fn(), getToolStatus: () => ({}) },
    folder: { key: folderKey(workspace), fsPath: workspace, name: "workspace", label: "workspace", projectScope: true },
    permissionHandler: {},
    ideContextManager: {},
    disposables: [],
  } as unknown as HostInstance);
  // what the chat's session posts reaches the panel's host, as PiSession's emit does
  const sessionPost = (message: Posted): void => panelManager.postMessage(panelHost, message);
  return { host, sessionPost, view: (key: string) => views.get(key)! };
}

const languageChanges = (posted: readonly Posted[]) => posted.filter((m) => m.type === "languageChange");

describe("a daemon's core whose chat two devices show", () => {
  it("languageChange is per device: a device's language reaches that device's views alone", () => {
    const { host, view } = chatTwoDevicesShow();

    host.set("clientLanguage", "device-b", { language: "el" });

    expect(languageChanges(view("view-b"))).toEqual([{ type: "languageChange", locale: "el" }]);
    expect(languageChanges(view("view-a"))).toEqual([]);

    host.set("clientLanguage", "device-a", { language: "en" });

    expect(languageChanges(view("view-a"))).toEqual([{ type: "languageChange", locale: "en" }]);
    expect(languageChanges(view("view-b"))).toEqual([{ type: "languageChange", locale: "el" }]);
  });

  it("a notification broadcast to a chat both devices show renders in en on one and el on the other", async () => {
    const { host, sessionPost, view } = chatTwoDevicesShow();
    host.set("clientLanguage", "device-a", { language: "en" });
    host.set("clientLanguage", "device-b", { language: "el" });

    postUserPromptVerdict(sessionPost, { block: true, systemMessages: [] });

    // each device's page takes what its views were sent, through the real dispatcher; the two pages share this test's one
    // vue-i18n, so device-b's page handles all it was sent before device-a's page starts
    const deviceB = chatPage();
    deviceB.deliver(view("view-b"));
    await deviceB.settled();
    chatPage().deliver(view("view-a"));

    expect(toasts).toEqual(["Το μήνυμά σας μπλοκαρίστηκε από ένα hook.", "Your prompt was blocked by a hook."]);
    expect(toasts).toEqual([inGreek(BLOCKED), englishText(BLOCKED)]);
    // core sends both devices the same text, which neither device's language shaped
    const notices = (key: string) => view(key).filter((m) => m.type === "notification");
    expect(notices("view-a")).toEqual([{ type: "notification", notificationType: "warning", message: BLOCKED }]);
    expect(notices("view-b")).toEqual(notices("view-a"));
  });
});
