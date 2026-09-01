import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { PI_AGENT_DIR } from "../../../pi-session/agent-dir";
import { readClaudeAuthFromDisk, type ClaudeAuthStatus } from "../../../pi-session/subscription";
import { buildAuthInteraction } from "./auth-interaction";
import { republishAccountInfo } from "./account-info";
import { log } from "../../../logger";

/** Sentinel thrown when the user dismisses a sign-in dialog — a benign cancel, not a failure. */
const SIGN_IN_CANCELLED = "__claude_signin_cancelled__";

/**
 * Webview-driven Claude auth across all three modes: API key, subscription · allowance (plugin),
 * and subscription · extra usage (built-in). The same OAuth token serves both subscription modes;
 * installing/removing the pi-anthropic-oauth plugin flips the billing bucket without re-login. pi
 * owns and refreshes the grant — Damocles never copies or refreshes the token.
 */
export function createClaudeAuthHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, getPanels, workspacePath } = deps;
  let busy = false;
  let signInAbort: AbortController | null = null;
  let signInInFlight: Promise<void> | null = null;

  function broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, message);
    }
  }

  function statusChanged(status: ClaudeAuthStatus): ExtensionToWebviewMessage {
    return { type: "claudeAuthStatusChanged", mode: status.mode };
  }

  /**
   * The anthropic login uses a 127.0.0.1 loopback callback server, so the normal flow only needs the
   * `auth_url` notification (open the browser). pi races a `manual_code` paste-the-redirect-URL
   * prompt against the loopback; when the loopback wins, the prompt is auto-dismissed via its abort
   * signal (see `buildAuthInteraction`).
   */
  function buildLoginInteraction(signal: AbortSignal): AuthInteraction {
    return buildAuthInteraction({ signal, cancelSentinel: SIGN_IN_CANCELLED, logPrefix: "[ClaudeAuth]" });
  }

  /** Run a Claude-auth operation with busy/cancel/error broadcasting and a single-flight guard. */
  async function runOp(op: () => Promise<ClaudeAuthStatus>): Promise<void> {
    if (busy) {
      broadcast({ type: "claudeAuthError", error: "A Claude auth operation is already in progress." });
      return;
    }
    busy = true;
    broadcast({ type: "claudeAuthBusy", busy: true });
    try {
      broadcast(statusChanged(await op()));
      // Every op here changes the credential the account chip is derived from.
      republishAccountInfo(getPanels);
    } catch (err) {
      if (err instanceof Error && err.message === SIGN_IN_CANCELLED) {
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

  const runtime = (): PiRuntime => PiRuntime.get(workspacePath, PI_AGENT_DIR);

  return {
    getClaudeAuthStatus: (_msg, ctx) => {
      postMessage(ctx.host, statusChanged(readClaudeAuthFromDisk(PI_AGENT_DIR)));
    },

    claudeSignIn: async (msg) => {
      if (msg.type !== "claudeSignIn") return;
      const useAllowance = msg.useAllowance;
      const abort = new AbortController();
      signInAbort = abort;
      const run = runOp(() => runtime().signInSubscription(useAllowance, buildLoginInteraction(abort.signal)));
      signInInFlight = run;
      try {
        await run;
      } finally {
        if (signInAbort === abort) signInAbort = null;
        if (signInInFlight === run) signInInFlight = null;
      }
    },

    claudeSetBilling: async (msg) => {
      if (msg.type !== "claudeSetBilling") return;
      const useAllowance = msg.useAllowance;
      await runOp(() => runtime().setSubscriptionBilling(useAllowance));
    },

    claudeSetApiKey: async (msg) => {
      if (msg.type !== "claudeSetApiKey") return;
      const key = msg.key;
      await runOp(() => runtime().setAnthropicApiKey(key));
    },

    claudeSignOut: async (msg) => {
      if (msg.type !== "claudeSignOut") return;
      // Abort a stalled in-flight sign-in first (mirrors codex): the flow-level signal dismisses the
      // open prompt via the interaction bridge, the sign-in settles as a benign cancel and releases
      // the busy guard, and THEN the sign-out runs — instead of bouncing off "already in progress".
      if (signInAbort) {
        signInAbort.abort();
        await signInInFlight;
      }
      await runOp(() => runtime().signOutAnthropic());
    },
  };
}
