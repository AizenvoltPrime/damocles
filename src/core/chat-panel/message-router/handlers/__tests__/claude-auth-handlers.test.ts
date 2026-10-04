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
  let handlers: ReturnType<typeof createClaudeAuthHandlers>;
  let ctx: HandlerContext;
  let publishAccountInfo: ReturnType<typeof vi.fn>;
  let platform: FakePlatform;

  beforeEach(() => {
    vi.clearAllMocks();
    H.runtime.signInSubscription.mockResolvedValue({ mode: "allowance" });
    sent = [];
    platform = createFakePlatform();
    const built = makeDeps(sent, platform);
    handlers = createClaudeAuthHandlers(built.deps);
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

  it("claudeSignIn broadcasts a benign cancel when the interaction prompt is dismissed", async () => {
    // pi drives the paste-the-redirect-URL fallback: it invokes interaction.prompt, which hits
    // the input box → undefined (Escape) → the SIGN_IN_CANCELLED sentinel → claudeAuthCancelled.
    H.runtime.signInSubscription.mockImplementationOnce(async (_cwd, _useAllowance, interaction: AuthInteractionLike) => {
      await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
      return { mode: "allowance" };
    });

    await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);

    expect(sent.some((m) => m.type === "claudeAuthCancelled")).toBe(true);
    expect(sent.some((m) => m.type === "claudeAuthError")).toBe(false);
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

  it("claudeSignOut during a stalled sign-in aborts the flow, then signs out", async () => {
    // Stalled browser login: pi is parked awaiting the manual_code prompt. claudeSignOut fires the
    // flow-level abort; the interaction bridge dismisses the input box, the sign-in settles as a
    // benign cancel releasing the busy guard, and the sign-out proceeds instead of bouncing.
    let promptOpened!: () => void;
    const promptOpen = new Promise<void>((resolve) => { promptOpened = resolve; });
    // Never answers: only the abort the sign-out fires can dismiss the box.
    platform.dialogs.answerInputBox(() => {
      promptOpened();
      return new Promise<undefined>(() => {});
    });
    H.runtime.signInSubscription.mockImplementationOnce(async (_cwd, _useAllowance, interaction: AuthInteractionLike) => {
      await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
      return { mode: "allowance" };
    });

    const signInPromise = handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);
    await promptOpen; // sign-in has reached the parked prompt
    await handlers.claudeSignOut!({ type: "claudeSignOut" }, ctx);
    await signInPromise;

    expect(sent.some((m) => m.type === "claudeAuthCancelled")).toBe(true);
    expect(H.runtime.signOutAnthropic).toHaveBeenCalledTimes(1);
    expect(sent.filter((m) => m.type === "claudeAuthError")).toEqual([]);
  });

  /**
   * The account chip is derived from the Claude auth mode. Nothing republishes it on its own, so each
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
