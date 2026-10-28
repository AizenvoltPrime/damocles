import { describe, expect, it, vi } from "vitest";
import { MessageRouter, type MessageRouterConfig } from "../index";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../shared/types/messages";
import type { HostInstance } from "../../types";
import type { PanelHost } from "../../../../platform/window-service";
import { createFakePlatform } from "../../../../__mocks__/fake-platform";
import { makeMultiViewHost } from "../../__tests__/panel-manager-harness";

// A panel two devices show (a daemon's clients view-a and view-b): where each handler's posts land.
function setUp() {
  const panel = makeMultiViewHost();
  const landed: Array<[string, string]> = [];
  const where = (host: PanelHost): string => (host === panel ? "every view" : ["view-a", "view-b"].find((key) => panel.viewHost!(key) === host) ?? "another host");
  const post = (host: PanelHost, message: ExtensionToWebviewMessage): void => {
    landed.push([where(host), message.type]);
    void host.postMessage(message);
  };
  const settingsManager = {
    sendCurrentSettings: vi.fn(async (host: PanelHost) => post(host, { type: "currentSettings" } as unknown as ExtensionToWebviewMessage)),
    sendThinkingForPanel: vi.fn((host: PanelHost) => post(host, { type: "panelThinkingUpdate" } as unknown as ExtensionToWebviewMessage)),
    handleSetPermissionMode: vi.fn(async () => undefined),
    handleSetPanelEffort: vi.fn(),
  };
  const instance = {
    host: panel,
    session: { clear: vi.fn(), cancelToolCall: () => false },
    permissionHandler: { resetForNewConversation: vi.fn() },
    ideContextManager: {},
    terminalAttachments: {},
    folder: { key: "/w", fsPath: "/w", name: "w", label: "w", projectScope: true },
  } as unknown as HostInstance;
  const router = new MessageRouter({
    postMessage: post,
    getPanels: () => new Map([["p1", instance]]),
    platform: createFakePlatform(),
    subscriptions: [],
    settingsManager,
    worktrees: () => ({ chatMove: async () => { throw new Error("no worktree"); } }),
  } as unknown as MessageRouterConfig);
  const send = (message: Record<string, unknown>, viewKey: string): Promise<void> =>
    router.handleWebviewMessage(message as unknown as WebviewToExtensionMessage, "p1", undefined, viewKey);
  const fromSettingsView = (message: Record<string, unknown>, clientId: string): Promise<void> =>
    router.handleWebviewMessage(message as unknown as WebviewToExtensionMessage, "p1", { post: vi.fn(), detached: vi.fn(), clientId });
  return { landed, send, fromSettingsView, panel };
}

describe("a message from one view of a chat several devices show", () => {
  it("shows a new chat, a mode change and an effort change on every view", async () => {
    const { landed, send } = setUp();
    await send({ type: "clearSession" }, "view-a");
    await send({ type: "setPermissionMode", mode: "acceptEdits" }, "view-b");
    await send({ type: "setPanelEffort", model: "m", effort: "high" }, "view-a");
    expect(landed).toEqual([
      ["every view", "currentSettings"],
      ["every view", "conversationCleared"],
      ["every view", "currentSettings"],
      ["every view", "panelThinkingUpdate"],
    ]);
  });

  it("answers the sending view alone with a refusal, a rejected Stop and a handler's error", async () => {
    const { landed, send } = setUp();
    await send({ type: "setPermissionMode", mode: "nope" }, "view-b");
    await send({ type: "cancelToolCall", toolUseId: "t1" }, "view-a");
    await send({ type: "chatMove", to: "worktree" }, "view-b");
    expect(landed).toEqual([
      ["view-b", "permissionModeRefused"],
      ["view-a", "toolCancelRejected"],
      ["view-b", "error"],
    ]);
  });

  it("answers a request from a device's settings overlay on that device's views alone, and shows shared state on every view", async () => {
    const { send, fromSettingsView, panel } = setUp();
    Object.assign(panel, { views: () => [{ viewKey: "view-a", clientId: "laptop" }, { viewKey: "view-b", clientId: "desktop" }] });
    await fromSettingsView({ type: "setPermissionMode", mode: "nope" }, "laptop");
    await fromSettingsView({ type: "chatMove", to: "worktree" }, "desktop");
    expect([...panel.toView].map(([key, messages]) => [key, messages.map((message) => message.type)])).toEqual([["view-a", ["permissionModeRefused"]], ["view-b", ["error"]]]);
    expect(panel.posted).toEqual([]);
    await send({ type: "setPermissionMode", mode: "acceptEdits" }, "view-b");
    expect(panel.posted.map((message) => message.type)).toEqual(["currentSettings"]);
  });
});
