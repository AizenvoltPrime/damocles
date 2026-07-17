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
    signInSubscription: vi.fn(async (_useAllowance: boolean, _i: AuthInteractionLike): Promise<ClaudeAuthStatus> => ({ mode: "allowance" })),
    setSubscriptionBilling: vi.fn(async (): Promise<ClaudeAuthStatus> => ({ mode: "extra" })),
    setAnthropicApiKey: vi.fn(async (): Promise<ClaudeAuthStatus> => ({ mode: "apikey" })),
    signOutAnthropic: vi.fn(async (): Promise<ClaudeAuthStatus> => ({ mode: "none" })),
  };
  return { runtime };
});
type AuthInteractionLike = Parameters<typeof H.runtime.signInSubscription>[1];

vi.mock("../../../../pi-session/pi-runtime", () => ({
  PiRuntime: { get: () => H.runtime, exists: true },
}));

vi.mock("../../../../pi-session/agent-dir", () => ({
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: "/fake/agent",
}));

vi.mock("../../../../pi-session/subscription", async (importActual) => {
  const actual = await importActual<typeof import("../../../../pi-session/subscription")>();
  return { ...actual, readClaudeAuthFromDisk: vi.fn((): ClaudeAuthStatus => ({ mode: "none" })) };
});

vi.mock("vscode", () => ({
  env: { openExternal: vi.fn(() => Promise.resolve(true)) },
  Uri: { parse: (str: string) => ({ toString: () => str }) },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    showInputBox: vi.fn(() => Promise.resolve(undefined)),
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
  },
  CancellationTokenSource: class {
    private listeners: (() => void)[] = [];
    token = {
      isCancellationRequested: false,
      onCancellationRequested: (cb: () => void) => {
        this.listeners.push(cb);
        return { dispose: () => {} };
      },
    };
    cancel(): void {
      this.token.isCancellationRequested = true;
      for (const cb of this.listeners) cb();
    }
    dispose(): void {}
  },
}));

import { createClaudeAuthHandlers } from "../claude-auth-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";

function makeDeps(sent: ExtensionToWebviewMessage[]): { deps: HandlerDependencies; ctx: HandlerContext } {
  const host = { id: "panel-1" } as unknown as HandlerContext["host"];
  const deps = {
    workspacePath: "/cwd",
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
    getPanels: () => new Map([["panel-1", { host }]]) as unknown as Map<string, never>,
  } as unknown as HandlerDependencies;
  return { deps, ctx: { host } as HandlerContext };
}

describe("createClaudeAuthHandlers", () => {
  let sent: ExtensionToWebviewMessage[];
  let handlers: ReturnType<typeof createClaudeAuthHandlers>;
  let ctx: HandlerContext;

  beforeEach(() => {
    vi.clearAllMocks();
    H.runtime.signInSubscription.mockResolvedValue({ mode: "allowance" });
    sent = [];
    const built = makeDeps(sent);
    handlers = createClaudeAuthHandlers(built.deps);
    ctx = built.ctx;
  });

  it("claudeSignIn drives busy → status → not-busy on success", async () => {
    await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);

    expect(H.runtime.signInSubscription).toHaveBeenCalledTimes(1);
    expect(H.runtime.signInSubscription.mock.calls[0][0]).toBe(true);
    expect(sent).toEqual([
      { type: "claudeAuthBusy", busy: true },
      { type: "claudeAuthStatusChanged", mode: "allowance" },
      { type: "claudeAuthBusy", busy: false },
    ]);
  });

  it("claudeSignIn broadcasts a benign cancel when the interaction prompt is dismissed", async () => {
    // pi drives the paste-the-redirect-URL fallback: it invokes interaction.prompt, which hits
    // showInputBox → undefined (Escape) → the SIGN_IN_CANCELLED sentinel → claudeAuthCancelled.
    H.runtime.signInSubscription.mockImplementationOnce(async (_useAllowance, interaction: AuthInteractionLike) => {
      await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
      return { mode: "allowance" };
    });

    await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: true }, ctx);

    expect(sent.some((m) => m.type === "claudeAuthCancelled")).toBe(true);
    expect(sent.some((m) => m.type === "claudeAuthError")).toBe(false);
  });

  it("claudeSignIn opens the browser on an auth_url notification", async () => {
    const vscode = await import("vscode");
    H.runtime.signInSubscription.mockImplementationOnce(async (_useAllowance, interaction: AuthInteractionLike) => {
      interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize" });
      return { mode: "extra" };
    });

    await handlers.claudeSignIn!({ type: "claudeSignIn", useAllowance: false }, ctx);

    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    const arg = (vscode.env.openExternal as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(String(arg)).toBe("https://claude.ai/oauth/authorize");
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
    const vscode = await import("vscode");
    let promptOpened!: () => void;
    const promptOpen = new Promise<void>((resolve) => { promptOpened = resolve; });
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_opts: unknown, token: { onCancellationRequested: (cb: () => void) => void }) =>
        new Promise((resolve) => {
          token.onCancellationRequested(() => resolve(undefined));
          promptOpened();
        }),
    );
    H.runtime.signInSubscription.mockImplementationOnce(async (_useAllowance, interaction: AuthInteractionLike) => {
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
});
