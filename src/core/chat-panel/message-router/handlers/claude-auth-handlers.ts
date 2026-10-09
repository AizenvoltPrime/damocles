import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import type { PanelHost } from "../../../../platform/window-service";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { PI_AGENT_DIR } from "../../../pi-session/agent-dir";
import { readClaudeAuthFromDisk, type ClaudeAuthStatus } from "../../../pi-session/subscription";
import { buildAuthInteraction } from "./auth-interaction";
import { republishAccountInfo } from "./account-info";
import { log } from "../../../logger";

/** Sentinel thrown when the user dismisses a sign-in dialog — a benign cancel, not a failure. */
const SIGN_IN_CANCELLED = "__claude_signin_cancelled__";
const BUSY_ERROR = "A Claude auth operation is already in progress.";
// The longest pasted redirect URL forwarded to pi.
const MAX_PASTE_CHARS = 8 * 1024;

type ManualCodePrompt = Extract<AuthPrompt, { type: "manual_code" }>;

export interface ClaudeAuthHandlers {
  handlers: Partial<HandlerRegistry>;
  /** Posts the auth mode and any sign-in in progress, for a settings view that (re)mounted and missed the broadcasts. */
  postState: (host: PanelHost) => void;
}

/**
 * Webview-driven Claude auth across all three modes: API key, subscription · allowance (plugin),
 * and subscription · extra usage (built-in). The same OAuth token serves both subscription modes;
 * installing/removing the subscription plugin flips the billing bucket without re-login. pi
 * owns and refreshes the grant — Damocles never copies or refreshes the token.
 */
export function createClaudeAuthHandlers(deps: HandlerDependencies): ClaudeAuthHandlers {
  const { postMessage, getPanels } = deps;
  let busy = false;
  let signInAbort: AbortController | null = null;
  let signInInFlight: Promise<void> | null = null;
  // Set while pi's paste-the-redirect-URL prompt is open; a pasted answer settles it.
  let pendingPaste: ((input: string) => void) | null = null;

  function broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, message);
    }
  }

  function statusChanged(status: ClaudeAuthStatus): ExtensionToWebviewMessage {
    return { type: "claudeAuthStatusChanged", mode: status.mode };
  }

  /**
   * pi races its `manual_code` prompt against the loopback callback for the whole browser wait; the settings panel shows
   * it inline as "Paste link instead". Rejections follow `buildAuthInteraction`: the sentinel on a flow abort, the prompt
   * signal's reason when pi withdraws the prompt because the callback won.
   */
  function waitForPaste(prompt: ManualCodePrompt, flow: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (flow.aborted) return reject(new Error(SIGN_IN_CANCELLED));
      if (prompt.signal?.aborted) return reject(prompt.signal.reason ?? new Error("Auth prompt aborted"));
      const settle = (finish: () => void): void => {
        prompt.signal?.removeEventListener("abort", onAbort);
        flow.removeEventListener("abort", onAbort);
        pendingPaste = null;
        broadcast({ type: "claudeSignInWaiting", waiting: false });
        finish();
      };
      const onAbort = (): void =>
        settle(() => reject(flow.aborted ? new Error(SIGN_IN_CANCELLED) : (prompt.signal?.reason ?? new Error("Auth prompt aborted"))));
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      flow.addEventListener("abort", onAbort, { once: true });
      pendingPaste = (input) => settle(() => resolve(input));
      broadcast({ type: "claudeSignInWaiting", waiting: true });
    });
  }

  function buildLoginInteraction(signal: AbortSignal): AuthInteraction {
    return buildAuthInteraction({
      signal,
      cancelSentinel: SIGN_IN_CANCELLED,
      logPrefix: "[ClaudeAuth]",
      platform: deps.platform,
      manualCode: (prompt) => waitForPaste(prompt, signal),
    });
  }

  /**
   * Run a Claude-auth operation with busy/cancel/error broadcasting and a single-flight guard. `cancel` is the
   * operation's own abort signal: pi rethrows a flow abort as its own "Login cancelled", so an aborted operation is a
   * cancel whatever it threw.
   */
  async function runOp(op: () => Promise<ClaudeAuthStatus>, cancel?: AbortSignal): Promise<void> {
    if (busy) {
      broadcast({ type: "claudeAuthError", error: BUSY_ERROR });
      return;
    }
    busy = true;
    broadcast({ type: "claudeAuthBusy", busy: true });
    try {
      broadcast(statusChanged(await op()));
      // Every op here changes the credential the account state is derived from.
      republishAccountInfo(getPanels);
    } catch (err) {
      if (cancel?.aborted || (err instanceof Error && err.message === SIGN_IN_CANCELLED)) {
        broadcast({ type: "claudeAuthCancelled" });
      } else {
        const error = err instanceof Error ? err.message : String(err);
        log("[ClaudeAuth] operation failed: %O", err);
        broadcast({ type: "claudeAuthError", error });
      }
    } finally {
      busy = false;
      broadcast({ type: "claudeAuthBusy", busy: false });
    }
  }

  /** Abort an in-flight sign-in and wait until it has settled as a cancel and released the busy guard. */
  async function abortSignIn(): Promise<void> {
    if (!signInAbort) return;
    signInAbort.abort();
    await signInInFlight;
  }

  const runtime = (): PiRuntime => PiRuntime.get();

  const handlers: Partial<HandlerRegistry> = {
    claudeSignIn: async (msg, ctx) => {
      if (msg.type !== "claudeSignIn") return;
      // Refused before it touches the running sign-in's abort controller, which Cancel and Sign out reach it through.
      if (busy || signInAbort !== null) {
        broadcast({ type: "claudeAuthError", error: BUSY_ERROR });
        return;
      }
      const useAllowance = msg.useAllowance;
      const abort = new AbortController();
      signInAbort = abort;
      const run = runOp(
        () => runtime().signInSubscription(ctx.folder.fsPath, useAllowance, buildLoginInteraction(abort.signal)),
        abort.signal,
      );
      signInInFlight = run;
      try {
        await run;
      } finally {
        if (signInAbort === abort) signInAbort = null;
        if (signInInFlight === run) signInInFlight = null;
      }
    },

    claudeSignInPaste: (msg) => {
      if (msg.type !== "claudeSignInPaste" || typeof msg.input !== "string" || msg.input.length > MAX_PASTE_CHARS) return;
      pendingPaste?.(msg.input);
    },

    claudeSignInCancel: async (msg) => {
      if (msg.type !== "claudeSignInCancel") return;
      await abortSignIn();
    },

    claudeSetBilling: async (msg, ctx) => {
      if (msg.type !== "claudeSetBilling") return;
      const useAllowance = msg.useAllowance;
      await runOp(() => runtime().setSubscriptionBilling(ctx.folder.fsPath, useAllowance));
    },

    claudeSetApiKey: async (msg) => {
      if (msg.type !== "claudeSetApiKey") return;
      const key = msg.key;
      await runOp(() => runtime().setAnthropicApiKey(key));
    },

    claudeSignOut: async (msg) => {
      if (msg.type !== "claudeSignOut") return;
      // A stalled sign-in is aborted first, so the sign-out runs instead of bouncing off "already in progress".
      await abortSignIn();
      await runOp(() => runtime().signOutAnthropic());
    },
  };

  return {
    handlers,
    postState: (host) => {
      postMessage(host, { type: "claudeAuthStatusChanged", mode: readClaudeAuthFromDisk(PI_AGENT_DIR).mode });
      postMessage(host, { type: "claudeAuthBusy", busy });
      postMessage(host, { type: "claudeSignInWaiting", waiting: pendingPaste !== null });
    },
  };
}
