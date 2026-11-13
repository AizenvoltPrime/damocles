import * as fs from "fs";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-tool-status-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), fakeWorkspace: nodePath.join(root, "home", "workspace") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { ChatPanelProvider } from "../index";
import { SettingsManager } from "../settings-manager";
import { installFakePlatform, type FakePlatform } from "../../../__mocks__/fake-platform";
import { createFakeRemoteHost } from "../../../__mocks__/fake-remote-host";
import { PiRuntime } from "../../pi-session/pi-runtime";
import { folderKey } from "../../workspace-folders/folder-key";
import { runPin } from "../../client-snapshots";
import { forgeGroupUnavailable } from "../../user-scope";
import { TOOL_GROUP_SETTINGS, TOOLS_DISABLED_SETTING } from "../../../shared/types/tools";
import { IMAGE_ENABLED_SETTING, IMAGE_MODEL_SETTING } from "../../pi-session/tools/image-tool-specs";
import type { Disposable } from "../../../platform/disposable";
import type { SettingsChange } from "../../../platform/settings-store";
import type { PanelHost } from "../../../platform/window-service";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";

type Posted = ExtensionToWebviewMessage;

interface Panel {
  readonly posted: Posted[];
  readonly refreshActiveTools: ReturnType<typeof vi.fn>;
  readonly entry: { host: Record<string, unknown> };
}

let platform: FakePlatform;
let subscriptions: Disposable[];

function addPanel(panels: Map<string, unknown>, id: string): Panel {
  const posted: Posted[] = [];
  const refreshActiveTools = vi.fn();
  const entry = {
    host: { postMessage: async (m: Posted) => { posted.push(m); return true; } } as Record<string, unknown>,
    // read as the client whose snapshots the status is built from, as the real one reads its settings
    session: { refreshActiveTools, getToolStatus: () => ({ groups: [], tools: [], panel: id, client: runPin()?.clientId }), publishAccountInfo: vi.fn() },
    folder: { key: folderKey(fakeWorkspace), fsPath: fakeWorkspace, name: "workspace", label: "workspace", projectScope: true },
    permissionHandler: {},
    ideContextManager: {},
    disposables: [],
  };
  panels.set(id, entry);
  return { posted, refreshActiveTools, entry };
}

function harness(): { provider: ChatPanelProvider; panels: Map<string, unknown>; p1: Panel; p2: Panel } {
  const provider = new ChatPanelProvider(platform, {
    subscriptions,
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
  const panels = (provider as unknown as { panelManager: { getPanels: () => Map<string, unknown> } }).panelManager.getPanels();
  return { provider, panels, p1: addPanel(panels, "p1"), p2: addPanel(panels, "p2") };
}

const toolStatuses = (posted: Posted[]) => posted.filter((m) => m.type === "toolStatus");

type Router = { handleWebviewMessage: (message: unknown, panelId: string, view: undefined) => Promise<void> };
const routerOf = (provider: ChatPanelProvider): Router => (provider as unknown as { messageRouter: Router }).messageRouter;

beforeEach(() => {
  fs.mkdirSync(fakeWorkspace, { recursive: true });
  platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }] });
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

describe("the Tools status publisher", () => {
  const nonImageKeys = [...Object.values(TOOL_GROUP_SETTINGS).filter((key) => key !== IMAGE_ENABLED_SETTING), TOOLS_DISABLED_SETTING];

  it.each(nonImageKeys)("re-applies the tools and posts one toolStatus in every panel when %s changes", async (key) => {
    const { p1, p2 } = harness();
    await platform.settings.update(key, key === TOOLS_DISABLED_SETTING ? ["web_search"] : false, "user");
    for (const panel of [p1, p2]) {
      expect(panel.refreshActiveTools).toHaveBeenCalledTimes(1);
      expect(toolStatuses(panel.posted)).toHaveLength(1);
    }
  });

  it("posts nothing for a key no tool switch reads", async () => {
    const { p1 } = harness();
    await platform.settings.update("damocles.memory.autoExtract.enabled", false, "user");
    await platform.settings.update("damocles.pinnedHeaderHidden", true, "user");
    expect(p1.refreshActiveTools).not.toHaveBeenCalled();
    expect(toolStatuses(p1.posted)).toHaveLength(0);
  });

  it.each([IMAGE_ENABLED_SETTING, IMAGE_MODEL_SETTING])("posts the image settings with the toolStatus when %s changes, and leaves the tools to the runtime's image listener", async (key) => {
    const sendImage = vi.spyOn(SettingsManager.prototype, "sendImageGenerationSettings");
    const { p1, p2 } = harness();
    await platform.settings.update(key, key === IMAGE_ENABLED_SETTING ? true : "some/model", "user");
    expect(sendImage).toHaveBeenCalledTimes(2);
    for (const panel of [p1, p2]) {
      expect(panel.refreshActiveTools).not.toHaveBeenCalled();
      expect(toolStatuses(panel.posted)).toHaveLength(1);
    }
  });

  it("follows a hand edit or another window, which no handler sees", async () => {
    const { p1 } = harness();
    await platform.settings.update("damocles.compass.enabled", true, "user");
    await platform.settings.update("damocles.compass.enabled", false, "user");
    expect(p1.refreshActiveTools).toHaveBeenCalledTimes(2);
    expect(toolStatuses(p1.posted)).toHaveLength(2);
  });

  it("posts one toolStatus per panel for a chat's own switch, and the chat's result only to that chat", async () => {
    const { provider, p1, p2 } = harness();
    const router = routerOf(provider);
    await router.handleWebviewMessage({ type: "toggleToolGroup", group: "compass", enabled: false }, "p1", undefined);
    await router.handleWebviewMessage({ type: "toggleTool", toolName: "web_search", enabled: false }, "p1", undefined);
    expect(toolStatuses(p1.posted)).toHaveLength(2);
    expect(toolStatuses(p2.posted)).toHaveLength(2);
    expect(p1.refreshActiveTools).toHaveBeenCalledTimes(2);
    expect(p2.refreshActiveTools).toHaveBeenCalledTimes(2);
    expect(p1.posted.filter((m) => m.type === "settingWriteResult").map((m) => m.key)).toEqual(["damocles.compass.enabled", TOOLS_DISABLED_SETTING]);
    expect(p2.posted.some((m) => m.type === "settingWriteResult")).toBe(false);
  });

  it("posts no toolStatus for a chat's switch whose write failed", async () => {
    const { provider, p1 } = harness();
    vi.spyOn(platform.settings, "update").mockRejectedValue(new Error("EACCES: permission denied"));
    await routerOf(provider).handleWebviewMessage({ type: "toggleToolGroup", group: "compass", enabled: false }, "p1", undefined);
    expect(toolStatuses(p1.posted)).toHaveLength(0);
    expect(p1.refreshActiveTools).not.toHaveBeenCalled();
    expect(p1.posted).toContainEqual(expect.objectContaining({ type: "settingWriteResult", key: "damocles.compass.enabled", ok: false }));
  });

  it("on a daemon's core, posts a change of one device's user layer to that device's views alone, built as that client", async () => {
    const remote = createFakeRemoteHost();
    Object.assign(platform, { remote: remote.remote });
    const listeners: Array<{ section: string; cb: (change: SettingsChange) => void }> = [];
    const subscribe = platform.settings.onDidChange.bind(platform.settings);
    vi.spyOn(platform.settings, "onDidChange").mockImplementation((section, cb) => {
      listeners.push({ section, cb });
      return subscribe(section, cb);
    });
    const { p1 } = harness();
    const views = new Map<string, Posted[]>([["view-laptop", []], ["view-desktop", []]]);
    p1.entry.host["views"] = () => [{ viewKey: "view-laptop", clientId: "laptop" }, { viewKey: "view-desktop", clientId: "desktop" }];
    p1.entry.host["viewHost"] = (viewKey: string): Partial<PanelHost> => ({ postMessage: async (m: unknown) => { views.get(viewKey)!.push(m as Posted); return true; } });

    const change: SettingsChange = { affects: (key) => key === "damocles" || key === "damocles.compass.enabled", clientId: "laptop" };
    for (const { section, cb } of listeners) if (change.affects(section)) cb(change);

    expect(toolStatuses(views.get("view-laptop")!).map((m) => (m as { data: { client?: string } }).data.client)).toEqual(["laptop"]);
    expect(toolStatuses(views.get("view-desktop")!)).toHaveLength(0);
    expect(toolStatuses(p1.posted)).toHaveLength(0);
    expect(p1.refreshActiveTools).toHaveBeenCalledTimes(1);
  });
});

describe("the GitHub and GitLab group follows the accounts", () => {
  it("re-applies every chat's tools, which republishes the ToolSearch menu, only when the group becomes loadable or stops being so", () => {
    let hasAccount = false;
    const changed = new Set<() => void>();
    const forge = {
      hasAccount: () => hasAccount,
      onChange: (listener: () => void) => {
        changed.add(listener);
        return { dispose: () => changed.delete(listener) };
      },
      onMessage: () => ({ dispose: () => undefined }),
      onShellRefused: () => ({ dispose: () => undefined }),
    };
    const provider = new ChatPanelProvider(platform, {
      subscriptions,
      createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
      forge: forge as unknown as NonNullable<ConstructorParameters<typeof ChatPanelProvider>[1]["forge"]>,
    });
    const panels = (provider as unknown as { panelManager: { getPanels: () => Map<string, unknown> } }).panelManager.getPanels();
    const p1 = addPanel(panels, "p1");
    const publish = (): void => {
      for (const listener of changed) listener();
    };
    publish();
    expect(p1.refreshActiveTools).not.toHaveBeenCalled();
    expect(toolStatuses(p1.posted)).toHaveLength(1);
    hasAccount = true;
    publish();
    expect(p1.refreshActiveTools).toHaveBeenCalledTimes(1);
    publish();
    expect(p1.refreshActiveTools).toHaveBeenCalledTimes(1);
    hasAccount = false;
    publish();
    expect(p1.refreshActiveTools).toHaveBeenCalledTimes(2);
    expect(toolStatuses(p1.posted)).toHaveLength(4);
  });

  it("on a daemon's core, posts every chat's toolStatus again once the device's servers land, which said not read yet until then", () => {
    const remote = createFakeRemoteHost();
    Object.assign(platform, { remote: remote.remote });
    const { p1, p2 } = harness();
    for (const panel of [p1, p2]) Object.assign((panel.entry as unknown as { session: object }).session, { getToolStatus: () => ({ forge: forgeGroupUnavailable() }) });

    remote.set("clientForges", "client-a", { servers: [], pending: true });
    remote.set("clientForges", "client-a", { servers: [{ id: "gitlab.com", webUrl: "https://gitlab.com", gitHosts: ["gitlab.com"], hasAccount: true }] });

    for (const panel of [p1, p2]) {
      expect(toolStatuses(panel.posted).map((m) => (m as { data: unknown }).data)).toEqual([{ forge: "forgeServersUnread" }, { forge: undefined }]);
      expect(panel.refreshActiveTools).toHaveBeenCalledTimes(2);
    }
  });
});

describe("an agent shell's refused notice", () => {
  it('lands under the tool call its shell ran in, whichever of two running shells git refused first', () => {
    let refused: ((refusal: unknown) => void) | undefined;
    const recorded: string[] = [];
    const forge = {
      hasAccount: () => true,
      onChange: () => ({ dispose: () => undefined }),
      onMessage: () => ({ dispose: () => undefined }),
      onShellRefused: (listener: (refusal: unknown) => void) => {
        refused = listener;
        return { dispose: () => undefined };
      },
      state: () => ({ accounts: [], showAvatars: false }),
      recordRefusal: (_panelId: string, toolCallId: string) => void recorded.push(toolCallId),
      publish: () => undefined,
    };
    const provider = new ChatPanelProvider(platform, {
      subscriptions,
      createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
      forge: forge as unknown as NonNullable<ConstructorParameters<typeof ChatPanelProvider>[1]["forge"]>,
    });
    const panels = (provider as unknown as { panelManager: { getPanels: () => Map<string, unknown> } }).panelManager.getPanels();
    const p1 = addPanel(panels, "p1");
    const refusal = (toolCallId: string) => ({
      origin: { kind: "agentShell", panelId: "p1", sessionId: "s1", toolCallId },
      server: { id: "gitlab.com" },
      projectKey: fakeWorkspace,
      projectLabel: "workspace",
      reason: "noAccount",
    });
    // the second shell started last, and the first one's git asks after it
    refused!(refusal("call-first"));
    refused!(refusal("call-second"));
    const notices = p1.posted.filter((m): m is Extract<Posted, { type: "forgeShellRefused" }> => m.type === "forgeShellRefused");
    expect(notices.map((notice) => notice.toolCallId)).toEqual(["call-first", "call-second"]);
    expect(recorded).toEqual(["call-first", "call-second"]);
  });
});
