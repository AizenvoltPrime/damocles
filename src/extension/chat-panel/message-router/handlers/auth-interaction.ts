import * as vscode from "vscode";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { log } from "../../../logger";

export interface AuthInteractionOptions {
  /** Flow-level abort signal — pi aborts the whole login when it fires. */
  signal: AbortSignal;
  /** Error message thrown when the USER dismisses a prompt — the handler's benign-cancel sentinel. */
  cancelSentinel: string;
  /** Log prefix for info/progress events, e.g. "[ClaudeAuth]". */
  logPrefix: string;
}

/**
 * Build the pi `AuthInteraction` that drives OAuth/api-key logins through VS Code UI.
 *
 * pi races interactive prompts against out-of-band resolution — e.g. the `manual_code`
 * paste-the-redirect-URL prompt runs concurrently with the 127.0.0.1 loopback callback server, and
 * whichever resolves first wins. When the out-of-band path wins, pi aborts the losing prompt via
 * `AuthPrompt.signal`; that signal is bridged to a `CancellationTokenSource` here so the input box
 * dismisses itself instead of lingering until the user presses Escape.
 *
 * The FLOW-level `opts.signal` (the handler's AbortController, fired by e.g. sign-out-during-sign-in)
 * is bridged as well: pi only forwards it to its network calls, not to the open prompt, so without the
 * bridge an aborted flow would leave the input box up and the login promise pending until Escape.
 * Dismissing the prompt is what triggers pi's `cancelWait`, unsticking the whole login.
 *
 * Rejection semantics matter: a USER dismissal (Escape) and a FLOW abort both reject with
 * `cancelSentinel` (benign cancel — the caller chose to stop), while a PER-PROMPT signal dismissal
 * rejects with the abort reason — pi fires that signal when the race was already won, and the sentinel
 * there would misreport a successful sign-in as user-cancelled.
 */
export function buildAuthInteraction(opts: AuthInteractionOptions): AuthInteraction {
  return {
    signal: opts.signal,
    notify: (event) => {
      switch (event.type) {
        case "auth_url":
          void vscode.env.openExternal(vscode.Uri.parse(event.url));
          return;
        case "device_code":
          void vscode.window.showInformationMessage(
            `Enter code ${event.userCode} at ${event.verificationUri} to finish signing in.`,
          );
          return;
        case "info":
        case "progress":
          log("%s %s", opts.logPrefix, event.message);
          return;
      }
    },
    prompt: async (p) => {
      if (p.type === "select") {
        // The Damocles flows are not expected to reach here with a select prompt (Codex's
        // login-method select is answered inside PiRuntime). Throwing would abort an otherwise-
        // answerable flow, so defensively return the first option id — pi orders options
        // default-first. Documented defensive default, not an error swallow.
        const first = p.options[0];
        if (first === undefined) throw new Error("Auth select prompt had no options");
        return first.id;
      }
      const cts = new vscode.CancellationTokenSource();
      const onAbort = (): void => cts.cancel();
      p.signal?.addEventListener("abort", onAbort, { once: true });
      opts.signal.addEventListener("abort", onAbort, { once: true });
      if (p.signal?.aborted || opts.signal.aborted) cts.cancel();
      try {
        const value = await vscode.window.showInputBox(
          {
            prompt: p.message,
            password: p.type === "secret",
            ...(p.placeholder ? { placeHolder: p.placeholder } : {}),
            ignoreFocusOut: true,
          },
          cts.token,
        );
        if (value === undefined) {
          if (p.signal?.aborted && !opts.signal.aborted) throw p.signal.reason ?? new Error("Auth prompt aborted");
          throw new Error(opts.cancelSentinel);
        }
        return value;
      } finally {
        p.signal?.removeEventListener("abort", onAbort);
        opts.signal.removeEventListener("abort", onAbort);
        cts.dispose();
      }
    },
  };
}
