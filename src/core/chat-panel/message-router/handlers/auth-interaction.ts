import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { Platform } from "../../../../platform/platform";
import { log } from "../../../logger";

export interface AuthInteractionOptions {
  /** Flow-level abort signal — pi aborts the whole login when it fires. */
  signal: AbortSignal;
  /** Error message thrown when the USER dismisses a prompt — the handler's benign-cancel sentinel. */
  cancelSentinel: string;
  /** Log prefix for info/progress events, e.g. "[ClaudeAuth]". */
  logPrefix: string;
  platform: Pick<Platform, "shell" | "notifications" | "dialogs">;
  /**
   * Answers `manual_code` prompts in the caller's own UI instead of the input box. It must honour the same rejection
   * semantics as the input box below: `cancelSentinel` on a flow abort, the prompt signal's reason on a prompt abort.
   */
  manualCode?: (prompt: Extract<AuthPrompt, { type: "manual_code" }>) => Promise<string>;
}

// pi-ai's Anthropic login method ids (`ANTHROPIC_BROWSER_LOGIN_METHOD`, `ANTHROPIC_COPY_CODE_LOGIN_METHOD`), not exported.
const ANTHROPIC_LOGIN_METHODS: ReadonlySet<string> = new Set(["browser", "copy_code"]);

/**
 * Answers only the select prompts this host knows. pi's Anthropic login asks browser or copy code, and its browser
 * method still accepts a pasted redirect URL, so that choice never reaches the user; any other select would need the
 * user, and picking for them could sign in to the wrong account.
 */
function answerSelect(p: Extract<AuthPrompt, { type: "select" }>): string {
  const ids = new Set(p.options.map((option) => option.id));
  if (ids.size === p.options.length && ids.size === ANTHROPIC_LOGIN_METHODS.size && [...ids].every((id) => ANTHROPIC_LOGIN_METHODS.has(id))) {
    return "browser";
  }
  throw new Error(`Sign-in asked a question Damocles cannot answer: ${JSON.stringify(p.message)}`);
}

/**
 * Build the pi `AuthInteraction` that drives OAuth/api-key logins through the host UI.
 *
 * pi races interactive prompts against out-of-band resolution — e.g. the `manual_code`
 * paste-the-redirect-URL prompt runs concurrently with the 127.0.0.1 loopback callback server, and
 * whichever resolves first wins. When the out-of-band path wins, pi aborts the losing prompt via
 * `AuthPrompt.signal`; that signal is bridged to the input box's abort signal here so the box
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
          void opts.platform.shell.openExternal(event.url);
          return;
        case "device_code":
          void opts.platform.notifications.info(
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
      if (p.type === "select") return answerSelect(p);
      if (p.type === "manual_code" && opts.manualCode) return opts.manualCode(p);
      const dismiss = new AbortController();
      const onAbort = (): void => dismiss.abort();
      p.signal?.addEventListener("abort", onAbort, { once: true });
      opts.signal.addEventListener("abort", onAbort, { once: true });
      if (p.signal?.aborted || opts.signal.aborted) dismiss.abort();
      try {
        const value = await opts.platform.dialogs.inputBox(
          {
            prompt: p.message,
            password: p.type === "secret",
            ...(p.placeholder ? { placeholder: p.placeholder } : {}),
            ignoreFocusOut: true,
          },
          dismiss.signal,
        );
        if (value === undefined) {
          if (p.signal?.aborted && !opts.signal.aborted) throw p.signal.reason ?? new Error("Auth prompt aborted");
          throw new Error(opts.cancelSentinel);
        }
        return value;
      } finally {
        p.signal?.removeEventListener("abort", onAbort);
        opts.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
