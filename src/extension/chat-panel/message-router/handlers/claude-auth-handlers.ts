import * as vscode from "vscode";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { PI_AGENT_DIR } from "../../../pi-session/agent-dir";
import { readClaudeAuthFromDisk, type ClaudeAuthStatus } from "../../../pi-session/subscription";
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

  function broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, message);
    }
  }

  function statusChanged(status: ClaudeAuthStatus): ExtensionToWebviewMessage {
    return { type: "claudeAuthStatusChanged", mode: status.mode };
  }

  function buildLoginCallbacks(signal: AbortSignal): OAuthLoginCallbacks {
    // The anthropic login uses a 127.0.0.1 loopback callback server, so the normal flow only needs
    // onAuth (open the browser). onPrompt is the paste-the-redirect-URL fallback if the loopback
    // doesn't catch the redirect. onDeviceCode/onSelect are never invoked for this provider.
    return {
      onAuth: (info) => {
        void vscode.env.openExternal(vscode.Uri.parse(info.url));
      },
      onDeviceCode: () => {},
      onPrompt: async (prompt) => {
        const value = await vscode.window.showInputBox({
          prompt: prompt.message,
          ...(prompt.placeholder !== undefined ? { placeHolder: prompt.placeholder } : {}),
          ignoreFocusOut: true,
        });
        if (value === undefined) throw new Error(SIGN_IN_CANCELLED);
        return value;
      },
      onSelect: async () => undefined,
      signal,
    };
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
      await runOp(() => runtime().signInSubscription(useAllowance, buildLoginCallbacks(new AbortController().signal)));
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
      await runOp(async () => runtime().signOutAnthropic());
    },
  };
}
