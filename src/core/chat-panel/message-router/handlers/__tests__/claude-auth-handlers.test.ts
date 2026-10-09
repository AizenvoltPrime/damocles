import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ClaudeAuthStatus } from "../../../../pi-session/subscription";

/**
 * Handler-level tests: busy single-flight guard, benign-cancel vs error broadcasting, and the
 * abort-stalled-sign-in-on-sign-out path. `PiRuntime` is stubbed at the module boundary — the runtime's
 * own login/logout behavior is covered by the pi-session tests; here only the handler contract matters.
 */
const H = vi.hoisted(() => {
  interface AuthPrompt {
    type: "text" | "secret" | "manual_code" | "select";
    message: string;
    placeholder?: string;
    options?: readonly { id: string; label: string }[];
    signal?: AbortSignal;
  }
  interface AuthInteractionLike {
    signal?: AbortSignal;
    prompt(p: AuthPrompt): Promise<string>;
    notify(event: unknown): void;
  }
  const runtime = {
    signInSubscription: vi.fn(async (_cwd: string, _useAllowance: boolean, _i: AuthInteractionLike): Promise<ClaudeAuthStatus> => ({ mode: "allowance" })),
    setSubscriptionBilling: vi.fn(async (_cwd: string, _useAllowance: boolean): Promise<ClaudeAuthStatus> => ({ mode: "extra" })),
    setAnthropicApiKey: vi.fn(async (): Promise<ClaudeAuthStatus> => ({ mode: "apikey" })),
    signOutAnthropic: vi.fn(async (): Promise<ClaudeAuthStatus> => ({ mode: "none" })),
  };
  return { runtime };
});
type AuthInteractionLike = Parameters<typeof H.runtime.signInSubscription>[2];

vi.mock("../../../../pi-session/pi-runtime", () => ({
  PiRuntime: { get: () => H.runtime, exists: true, notifyMemoryJudgeChange: () => {} },
}));

vi.mock("../../../../pi-session/agent-dir", () => ({
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: "/fake/agent",
}));

vi.mock("../../../../pi-session/subscription", async (importActual) => {
  const actual = await importActual<typeof import("../../../../pi-session/subscription")>();
  return { ...actual, readClaudeAuthFromDisk: vi.fn((): ClaudeAuthStatus => ({ mode: "none" })) };
});

import { createClaudeAuthHandlers } from "../claude-auth-handlers";
import { createFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";

/** A sign-in parked on pi's paste prompt, the way pi races it against the loopback callback for the whole browser wait. */
function parkOnPastePrompt(withdraw?: AbortSignal): { pasted: Promise<string> } {
  let pasted!: Promise<string>;
  H.runtime.signInSubscription.mockImplementationOnce(async (_cwd, _useAllowance, interaction: AuthInteractionLike) => {
    pasted = interaction.prompt({ type: "manual_code", message: "Paste the redirect URL", ...(withdraw ? { signal: withdraw } : {}) });
    await pasted.catch((err: unknown) => {
      if (!withdraw?.aborted) throw err;
    });
    return { mode: "allowance" };
  });
  return {
    get pasted() {
      return pasted;
    },
  };
}

const waitingFlags = (sent: ExtensionToWebviewMessage[]): boolean[] =>
  sent.flatMap((m) => (m.type === "claudeSignInWaiting" ? [m.waiting] : []));

async function untilWaiting(sent: ExtensionToWebviewMessage[]): Promise<void> {
  await vi.waitFor(() => expect(waitingFlags(sent)).toContain(true));
}

function makeDeps(sent: ExtensionToWebviewMessage[], platform: FakePlatform): {
  deps: HandlerDependencies;
  ctx: HandlerContext;
  publishAccountInfo: ReturnType<typeof vi.fn>;
} {
  const host = { id: "panel-1" } as unknown as HandlerContext["host"];
  const publishAccountInfo = vi.fn();
  const deps = {
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
    getPanels: () => new Map([["panel-1", { host, session: { publishAccountInfo } }]]) as unknown as Map<string, never>,
    platform,
  } as unknown as HandlerDependencies;
  const folder = { key: "/ws/b", fsPath: "/ws/B", name: "B", label: "B", projectScope: true };
  return { deps, ctx: { host, folder } as HandlerContext, publishAccountInfo };
}

describe("createClaudeAuthHandlers", () => {
  let sent: ExtensionToWebviewMessage[];
  let handlers: ReturnType<typeof createClaudeAuthHandlers>["handlers"];
  let postState: ReturnType<typeof createClaudeAuthHandlers>["postState"];
  let ctx: HandlerContext;
  let publishAccountInfo: ReturnType<typeof vi.fn>;
  let platform: FakePlatform;

  beforeEach(() => {
    vi.clearAllMocks();
    H.runtime.signInSubscription.mockResolvedValue({ mode: "allowance" });
    sent = [];
    platform = createFakePlatform();
    const built = makeDeps(sent, platform);
    ({ handlers, postState } = createClaudeAuthHandlers(built.deps));
    ctx = built.ctx;
    publishAccountInfo = built.publishAccountInfo;
  });

  it("claudeSignIn drives busy → status → not-busy on success", async () => {
    await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);

    expect(H.runtime.signInSubscription).toHaveBeenCalledTimes(1);
    // The plugin switch verifies against the requesting panel's folder runtime.
    expect(H.runtime.signInSubscription.mock.calls[0]!.slice(0, 2)).toEqual(["/ws/B", true]);
    expect(sent).toEqual([
      { type: "claudeAuthBusy", busy: true },
      { type: "claudeAuthStatusChanged", mode: "allowance" },
      { type: "claudeAuthBusy", busy: false },
    ]);
  });

  describe("the paste prompt is shown in the panel, never as a modal", () => {
    it("a pasted redirect URL answers pi's prompt and closes the waiting state", async () => {
      const parked = parkOnPastePrompt();
      const signIn = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
      await untilWaiting(sent);

      await handlers.claudeSignInPaste!({ type: "claudeSignInPaste", input: "http://localhost:1/callback?code=c&state=s" }, ctx);
      await signIn;

      await expect(parked.pasted).resolves.toBe("http://localhost:1/callback?code=c&state=s");
      expect(waitingFlags(sent)).toEqual([true, false]);
      expect(sent.some((m) => m.type === "claudeAuthStatusChanged")).toBe(true);
      expect(platform.dialogs.inputBoxCalls).toEqual([]);
    });

    it("pi withdrawing the prompt after the browser returned closes the waiting state with no error", async () => {
      const withdraw = new AbortController();
      parkOnPastePrompt(withdraw.signal);
      const signIn = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
      await untilWaiting(sent);

      withdraw.abort(new Error("callback won"));
      await signIn;

      expect(waitingFlags(sent)).toEqual([true, false]);
      expect(sent.some((m) => m.type === "claudeAuthError")).toBe(false);
      expect(sent.some((m) => m.type === "claudeAuthStatusChanged")).toBe(true);
    });

    it("a paste with no prompt open is dropped", async () => {
      await handlers.claudeSignInPaste!({ type: "claudeSignInPaste", input: "stray" }, ctx);

      expect(sent).toEqual([]);
    });

    it("a paste that is not a string, or is longer than 8 KB, leaves the prompt open", async () => {
      const parked = parkOnPastePrompt();
      const signIn = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
      await untilWaiting(sent);

      await handlers.claudeSignInPaste!({ type: "claudeSignInPaste", input: 7 as unknown as string }, ctx);
      await handlers.claudeSignInPaste!({ type: "claudeSignInPaste", input: "x".repeat(8 * 1024 + 1) }, ctx);
      expect(waitingFlags(sent)).toEqual([true]);

      const longest = `http://localhost:1/callback?code=${"c".repeat(8 * 1024 - 33)}`;
      await handlers.claudeSignInPaste!({ type: "claudeSignInPaste", input: longest }, ctx);
      await signIn;
      await expect(parked.pasted).resolves.toBe(longest);
    });
  });

  describe("claudeSignInCancel", () => {
    it("cancels a sign-in parked on the paste prompt as a benign cancel", async () => {
      parkOnPastePrompt();
      const signIn = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
      await untilWaiting(sent);

      await handlers.claudeSignInCancel!({ type: "claudeSignInCancel" }, ctx);
      await signIn;

      expect(sent.some((m) => m.type === "claudeAuthCancelled")).toBe(true);
      expect(sent.some((m) => m.type === "claudeAuthError")).toBe(false);
      expect(waitingFlags(sent)).toEqual([true, false]);
    });

    it("reports a cancel when pi rethrows the abort as its own error", async () => {
      // pi's callback server rejects a flow abort with "Login cancelled", not the bridge's sentinel.
      H.runtime.signInSubscription.mockImplementationOnce(
        (_cwd, _useAllowance, interaction: AuthInteractionLike) =>
          new Promise((_resolve, reject) => {
            interaction.signal!.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
          }),
      );
      const signIn = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
      await Promise.resolve();

      await handlers.claudeSignInCancel!({ type: "claudeSignInCancel" }, ctx);
      await signIn;

      expect(sent.some((m) => m.type === "claudeAuthCancelled")).toBe(true);
      expect(sent.some((m) => m.type === "claudeAuthError")).toBe(false);
    });
  });

  it("postState replays a sign-in in progress to a settings view that opened mid-way", async () => {
    parkOnPastePrompt();
    const signIn = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
    await untilWaiting(sent);

    sent.length = 0;
    postState(ctx.host);

    expect(sent).toEqual([
      { type: "claudeAuthStatusChanged", mode: "none" },
      { type: "claudeAuthBusy", busy: true },
      { type: "claudeSignInWaiting", waiting: true },
    ]);

    await handlers.claudeSignInCancel!({ type: "claudeSignInCancel" }, ctx);
    await signIn;
  });

  it("claudeSignIn opens the browser on an auth_url notification", async () => {
    H.runtime.signInSubscription.mockImplementationOnce(async (_cwd, _useAllowance, interaction: AuthInteractionLike) => {
      interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize" });
      return { mode: "extra" };
    });

    await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: false }, ctx);

    expect(platform.shell.openedExternal).toEqual(["https://claude.ai/oauth/authorize"]);
    expect(sent.some((m) => m.type === "claudeAuthStatusChanged")).toBe(true);
  });

  it("claudeSignIn surfaces a generic failure and releases the busy guard", async () => {
    H.runtime.signInSubscription.mockRejectedValueOnce(new Error("token exchange failed"));

    await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
    expect(sent.find((m) => m.type === "claudeAuthError")).toEqual({
      type: "claudeAuthError",
      error: "token exchange failed",
    });

    // busy released — the next operation runs instead of bouncing.
    sent.length = 0;
    await handlers.claudeSetApiKey!({ type: "claudeSetApiKey", key: "sk-ant" }, ctx);
    expect(H.runtime.setAnthropicApiKey).toHaveBeenCalledTimes(1);
    expect(sent.some((m) => m.type === "claudeAuthError")).toBe(false);
  });

  it("rejects a concurrent operation while one is in flight", async () => {
    let release!: () => void;
    H.runtime.signInSubscription.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ mode: "allowance" }); }),
    );

    const first = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
    await Promise.resolve();
    await handlers.claudeSetBilling!({ type: "claudeSetBilling", useAllowance: false }, ctx);

    expect(sent.find((m) => m.type === "claudeAuthError")).toEqual({
      type: "claudeAuthError",
      error: "A Claude auth operation is already in progress.",
    });
    expect(H.runtime.setSubscriptionBilling).not.toHaveBeenCalled();

    release();
    await first;
  });

  it("a second sign-in while one runs is refused, and Cancel and Sign out still reach the first", async () => {
    parkOnPastePrompt();
    const first = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
    await untilWaiting(sent);

    await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: false }, ctx);
    expect(H.runtime.signInSubscription).toHaveBeenCalledTimes(1);
    expect(sent.filter((m) => m.type === "claudeAuthError")).toEqual([
      { type: "claudeAuthError", error: "A Claude auth operation is already in progress." },
    ]);

    await handlers.claudeSignInCancel!({ type: "claudeSignInCancel" }, ctx);
    await first;
    expect(sent.some((m) => m.type === "claudeAuthCancelled")).toBe(true);

    parkOnPastePrompt();
    const again = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
    await vi.waitFor(() => expect(waitingFlags(sent).filter(Boolean)).toHaveLength(2));
    await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
    await handlers.claudeSignOut!({ type: "claudeSignOut" }, ctx);
    await again;
    expect(H.runtime.signOutAnthropic).toHaveBeenCalledTimes(1);
  });

  it("claudeSignOut during a stalled sign-in aborts the flow, then signs out", async () => {
    // Stalled browser login: pi is parked on the paste prompt. claudeSignOut fires the flow-level abort, the sign-in
    // settles as a benign cancel releasing the busy guard, and the sign-out proceeds instead of bouncing.
    parkOnPastePrompt();

    const signInPromise = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
    await untilWaiting(sent);
    await handlers.claudeSignOut!({ type: "claudeSignOut" }, ctx);
    await signInPromise;

    expect(sent.some((m) => m.type === "claudeAuthCancelled")).toBe(true);
    expect(H.runtime.signOutAnthropic).toHaveBeenCalledTimes(1);
    expect(sent.filter((m) => m.type === "claudeAuthError")).toEqual([]);
  });

  /**
   * The account state is derived from the Claude auth mode. Nothing republishes it on its own, so each
   * credential change here has to ask every panel's session to publish.
   */
  describe("account state republication", () => {
    it("claudeSignIn republishes to every panel", async () => {
      await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);

      expect(publishAccountInfo).toHaveBeenCalledTimes(1);
    });

    it("claudeSetBilling republishes to every panel", async () => {
      await handlers.claudeSetBilling!({ type: "claudeSetBilling", useAllowance: false }, ctx);

      expect(H.runtime.setSubscriptionBilling).toHaveBeenCalledWith("/ws/B", false);

      expect(publishAccountInfo).toHaveBeenCalledTimes(1);
    });

    it("claudeSignOut republishes to every panel", async () => {
      await handlers.claudeSignOut!({ type: "claudeSignOut" }, ctx);

      expect(publishAccountInfo).toHaveBeenCalledTimes(1);
    });

    it("a failed sign-in leaves the credential untouched, so it does not republish", async () => {
      H.runtime.signInSubscription.mockRejectedValueOnce(new Error("token exchange failed"));

      await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);

      expect(publishAccountInfo).not.toHaveBeenCalled();
    });
  });
});
