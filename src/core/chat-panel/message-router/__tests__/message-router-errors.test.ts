import { describe, expect, it, vi } from "vitest";
import { MessageRouter, type MessageRouterConfig } from "../index";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../shared/types/messages";
import type { HostInstance } from "../../types";
import { createFakePlatform } from "../../../../__mocks__/fake-platform";
import { LocalizedError } from "../../../../shared/localized-text";
import { l } from "../../../l10n";

describe("a handler's failure shown in the chat", () => {
  it("shows the error's control and bidi characters as escapes, keeping its lines", async () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const chatMove = vi.fn(async () => {
      throw new Error("C:\\repo\\.damocles\\worktree.json is not valid JSON: a\u202Eb\u0007\nnext line");
    });
    const instance = { host: { id: "h1" }, session: {}, permissionHandler: {}, ideContextManager: {}, terminalAttachments: {}, folder: { key: "k" } } as unknown as HostInstance;
    const router = new MessageRouter({
      postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { posted.push(message); },
      getPanels: () => new Map([["p1", instance]]),
      platform: createFakePlatform({ capabilities: { worktrees: true } }),
      subscriptions: [],
      worktrees: () => ({ chatMove }),
    } as unknown as MessageRouterConfig);
    await router.handleWebviewMessage({ type: "chatMove", to: "worktree" } as WebviewToExtensionMessage, "p1");
    expect(chatMove).toHaveBeenCalledOnce();
    expect(posted).toEqual([{
      type: "error",
      message: { message: "Failed to handle {0}: {1}", args: ["chatMove", { message: "{0}", args: ["C:\\repo\\.damocles\\worktree.json is not valid JSON: a\\u{202E}b\\u{7}\nnext line"] }] },
    }]);
  });

  it("shows those characters as escapes in every string argument of a LocalizedError, nested ones included, and leaves its keys and numbers", async () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const chatMove = vi.fn(async () => {
      throw new LocalizedError(l("{0} could not be moved: {1}", "a\u2066b.ts", l("{0} is larger than {1} bytes.", "C:\\repo\\evil\u202Etxt.exe\u0007\nnext", { number: 65536 })));
    });
    const instance = { host: { id: "h1" }, session: {}, permissionHandler: {}, ideContextManager: {}, terminalAttachments: {}, folder: { key: "k" } } as unknown as HostInstance;
    const router = new MessageRouter({
      postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { posted.push(message); },
      getPanels: () => new Map([["p1", instance]]),
      platform: createFakePlatform({ capabilities: { worktrees: true } }),
      subscriptions: [],
      worktrees: () => ({ chatMove }),
    } as unknown as MessageRouterConfig);
    await router.handleWebviewMessage({ type: "chatMove", to: "worktree" } as WebviewToExtensionMessage, "p1");
    expect(posted).toEqual([{
      type: "error",
      message: {
        message: "Failed to handle {0}: {1}",
        args: ["chatMove", {
          message: "{0} could not be moved: {1}",
          args: ["a\\u{2066}b.ts", { message: "{0} is larger than {1} bytes.", args: ["C:\\repo\\evil\\u{202E}txt.exe\\u{7}\nnext", { number: 65536 }] }],
        }],
      },
    }]);
  });
});
