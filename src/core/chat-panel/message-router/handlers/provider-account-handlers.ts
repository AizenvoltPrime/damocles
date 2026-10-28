import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { PanelHost } from "../../../../platform/window-service";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import type { ProviderSignInError, ProviderSignInState } from "../../../../shared/types/settings";
import { isKeyProviderId, isSignInProviderId, SIGN_IN_PROVIDER_IDS, type AccountProviderId, type SignInProviderId } from "../../../../shared/settings-sections";
import { PiRuntime, remoteSignInRefusal } from "../../../pi-session/pi-runtime";
import { providerSignInDef } from "../../../pi-session/custom-providers";
import { httpStatusOf } from "../../../pi-session/http-status";
import { deleteProviderKey, storeProviderKey } from "../../settings-manager/managers/provider-keys";
import { buildAuthInteraction } from "./auth-interaction";
import { republishAccountInfo } from "./account-info";
import { log } from "../../../logger";
import { t } from "../../../l10n";

/** Thrown when a flow is aborted while a prompt waits; a cancel, not a failure. */
const SIGN_IN_CANCELLED = "__provider_signin_cancelled__";
const MAX_ANSWER_BYTES = 8 * 1024;
const MAX_HOSTNAME_CHARS = 253;
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;
const NETWORK_ERROR_CODES: ReadonlySet<unknown> = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"]);

type AnswerKind = "enterpriseDomain" | "code";

interface SignInFlow {
  readonly abort: AbortController;
  state: ProviderSignInState;
  /** The page pi named for this flow; opened only when it is https. */
  pageUrl?: string;
  /** A code or a page was shown, so pi's progress means the flow is finishing. */
  shown: boolean;
  answer?: { kind: AnswerKind; resolve: (input: string) => void };
  run?: Promise<void>;
}

export interface ProviderAccountHandlers {
  handlers: Partial<HandlerRegistry>;
  /** Posts each sign-in provider's flow state, for a settings view that (re)mounted and missed the broadcasts. */
  postState: (host: PanelHost) => void;
}

// pi's own phrases, matched only at the start of its text before any punctuation, so a provider body quoted after
// pi's ": " or "(" never classifies (device-code.js:2-3, xai.js:149,152, kimi-coding.js:160,163, meta.js:119,121 in pi-ai 1.4.0).
const PI_EXPIRED = /^(?:Device flow timed out\b|[\w ]*\bdevice (?:code|authorization) expired\b)/;
const PI_DENIED = /^[\w ]*\b(?:authorization|login) was denied\b/;
// "(HTTP 400)" (xai.js:81, openrouter.js:91), "(status 400)" (kimi-coding.js:167, meta.js:147), "with status 400" (kimi-coding.js:62, meta.js:73).
const PI_STATUS = /^[\w ]*?(?:\((?:HTTP|status) (\d{3})\)|\bwith status (\d{3})\b)/;

/** The HTTP status pi's text names before any provider body: Copilot's leading "404 Not Found: …" (github-copilot.js:150) or one of pi's own forms. */
function signInHttpStatus(message: string): number | undefined {
  // only the leading form: httpStatusOf's "(404):" form could find a status inside a body
  if (/^\d{3} /.test(message)) return httpStatusOf(message);
  const own = PI_STATUS.exec(message);
  return own ? Number(own[1] ?? own[2]) : undefined;
}

/** A fixed message per failure class: pi's error text for these flows can carry an OAuth response, so it is never shown or logged. */
function signInError(err: unknown, cancelled: boolean): ProviderSignInError {
  if (cancelled || (err instanceof Error && err.message === SIGN_IN_CANCELLED)) return { kind: "cancelled", message: t("Sign-in cancelled.") };
  if (!(err instanceof Error)) return { kind: "provider", message: t("The provider could not complete the sign-in.") };
  if (PI_EXPIRED.test(err.message)) return { kind: "expired", message: t("Code expired. Start the sign-in again.") };
  if (PI_DENIED.test(err.message)) return { kind: "denied", message: t("The sign-in was denied.") };
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  if (err.name === "TimeoutError" || (err.name === "TypeError" && err.message === "fetch failed") || NETWORK_ERROR_CODES.has(code)) {
    return { kind: "network", message: t("Could not reach the sign-in service. Check the connection and try again.") };
  }
  const httpStatus = signInHttpStatus(err.message);
  return httpStatus === undefined
    ? { kind: "provider", message: t("The provider could not complete the sign-in.") }
    : { kind: "provider", message: t("The provider could not complete the sign-in (HTTP {0}).", httpStatus), status: httpStatus };
}

function isHttpsUrl(url: string | undefined): url is string {
  if (url === undefined || !URL.canParse(url)) return false;
  return new URL(url).protocol === "https:";
}

/**
 * The pi OAuth sign-ins of the account providers (`SIGN_IN_PROVIDER_IDS`) and the key providers' saved keys. One flow per provider;
 * flows of different providers run side by side. The webview never opens a URL: core opens the https page pi named for
 * the flow it runs.
 */
export function createProviderAccountHandlers(deps: HandlerDependencies): ProviderAccountHandlers {
  const { postMessage, getPanels, platform } = deps;
  const flows = new Map<SignInProviderId, SignInFlow>();
  const settled = new Map<SignInProviderId, ProviderSignInState>();

  function broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of getPanels()) postMessage(instance.host, message);
  }

  function setState(provider: SignInProviderId, flow: SignInFlow, state: ProviderSignInState): void {
    if (flows.get(provider) !== flow) return;
    flow.state = state;
    broadcast({ type: "providerSignInState", provider, state });
  }

  function settle(provider: SignInProviderId, flow: SignInFlow, state: ProviderSignInState): void {
    if (flows.get(provider) !== flow) return;
    flows.delete(provider);
    settled.set(provider, state);
    broadcast({ type: "providerSignInState", provider, state });
  }

  /** A credential change succeeded, so an error an earlier flow or sign-out left no longer describes the provider. */
  function credentialChanged(account: AccountProviderId): void {
    if (isSignInProviderId(account)) {
      const previous = settled.get(account);
      settled.delete(account);
      if (previous?.phase === "idle" && previous.error) broadcast({ type: "providerSignInState", provider: account, state: { phase: "idle" } });
    }
    broadcast({ type: "authFailureCleared", account });
    republishAccountInfo(getPanels);
  }

  /** Waits for the user's answer to a prompt; rejects as `buildAuthInteraction` does: the sentinel on a flow abort, the prompt signal's reason when pi withdraws it. */
  function waitForAnswer(flow: SignInFlow, kind: AnswerKind, prompt: AuthPrompt): Promise<string> {
    const signal = flow.abort.signal;
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(new Error(SIGN_IN_CANCELLED));
      if (prompt.signal?.aborted) return reject(prompt.signal.reason ?? new Error("Auth prompt aborted"));
      const done = (finish: () => void): void => {
        prompt.signal?.removeEventListener("abort", onAbort);
        signal.removeEventListener("abort", onAbort);
        if (flow.answer?.resolve === answer) delete flow.answer;
        finish();
      };
      const onAbort = (): void => done(() => reject(signal.aborted ? new Error(SIGN_IN_CANCELLED) : (prompt.signal?.reason ?? new Error("Auth prompt aborted"))));
      const answer = (input: string): void => done(() => resolve(input));
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
      flow.answer = { kind, resolve: answer };
    });
  }

  function buildInteraction(provider: SignInProviderId, flow: SignInFlow): AuthInteraction {
    return buildAuthInteraction({
      signal: flow.abort.signal,
      cancelSentinel: SIGN_IN_CANCELLED,
      logPrefix: `[ProviderSignIn:${provider}]`,
      platform,
      deviceCode: (event) => {
        flow.pageUrl = event.verificationUri;
        flow.shown = true;
        const expiresAt = event.expiresInSeconds !== undefined ? { expiresAt: Date.now() + event.expiresInSeconds * 1000 } : {};
        setState(provider, flow, { phase: "deviceCode", userCode: event.userCode, verificationUri: event.verificationUri, ...expiresAt });
      },
      authUrl: (event) => {
        flow.pageUrl = event.url;
        flow.shown = true;
        setState(provider, flow, { phase: "browser", paste: false });
        if (isHttpsUrl(event.url)) void platform.shell.openExternal(event.url);
        else log("[ProviderSignIn:%s] the sign-in page is not https, so it is not opened", provider);
      },
      progress: () => {
        if (flow.shown) setState(provider, flow, { phase: "finishing" });
      },
      manualCode: async (prompt) => {
        flow.shown = true;
        setState(provider, flow, { phase: "browser", paste: true });
        const code = await waitForAnswer(flow, "code", prompt);
        setState(provider, flow, { phase: "finishing" });
        return code;
      },
      text: async (prompt) => {
        if (providerSignInDef(provider).textPrompt !== "enterpriseDomain") throw new Error(`The ${provider} sign-in asked a question Damocles cannot answer`);
        setState(provider, flow, { phase: "prompt", prompt: "enterpriseDomain" });
        const domain = await waitForAnswer(flow, "enterpriseDomain", prompt);
        setState(provider, flow, { phase: "starting" });
        return domain;
      },
    });
  }

  async function runSignIn(provider: SignInProviderId, flow: SignInFlow): Promise<void> {
    try {
      await PiRuntime.get().signInProvider(provider, buildInteraction(provider, flow));
      settle(provider, flow, { phase: "idle" });
      credentialChanged(provider);
    } catch (err) {
      const error = signInError(err, flow.abort.signal.aborted);
      const name = err instanceof Error ? err.name : typeof err;
      log("[ProviderSignIn:%s] sign-in ended: %s (%s)%s", provider, error.kind, name, error.status !== undefined ? ` (HTTP ${error.status})` : "");
      settle(provider, flow, { phase: "idle", error });
    }
  }

  /** Abort the provider's flow, if any, and wait until it has settled. */
  async function abortFlow(provider: AccountProviderId): Promise<void> {
    if (!isSignInProviderId(provider)) return;
    const flow = flows.get(provider);
    if (!flow) return;
    flow.abort.abort();
    await flow.run;
  }

  /** Answers only the view that asked and is not kept: the provider's state is unchanged, and other clients of a daemon asked nothing. */
  function refuse(host: PanelHost, provider: SignInProviderId): void {
    postMessage(host, { type: "providerSignInState", provider, state: { phase: "idle", error: { kind: "remote", message: remoteSignInRefusal() } } });
  }

  deps.subscriptions.push({
    dispose: () => {
      for (const flow of flows.values()) flow.abort.abort();
    },
  });

  const handlers: Partial<HandlerRegistry> = {
    providerSignIn: async (msg, ctx) => {
      if (msg.type !== "providerSignIn") return;
      const { provider } = msg;
      if (!isSignInProviderId(provider)) throw new Error("Unknown sign-in provider");
      if (flows.has(provider)) return;
      if (platform.remote) {
        refuse(ctx.reply, provider);
        return;
      }
      const flow: SignInFlow = { abort: new AbortController(), state: { phase: "starting" }, shown: false };
      flows.set(provider, flow);
      settled.delete(provider);
      broadcast({ type: "providerSignInState", provider, state: flow.state });
      flow.run = runSignIn(provider, flow);
      await flow.run;
    },

    // carries a code or a domain the user typed; never log it
    providerSignInAnswer: (msg) => {
      if (msg.type !== "providerSignInAnswer" || !isSignInProviderId(msg.provider) || typeof msg.input !== "string") return;
      const flow = flows.get(msg.provider);
      const answer = flow?.answer;
      if (!flow || !answer) return;
      const refuseAnswer = (): void => {
        if (flow.state.phase === "prompt" || flow.state.phase === "browser") setState(msg.provider as SignInProviderId, flow, { ...flow.state, invalid: true });
      };
      if (Buffer.byteLength(msg.input, "utf8") > MAX_ANSWER_BYTES) return refuseAnswer();
      if (answer.kind === "code") {
        answer.resolve(msg.input);
        return;
      }
      // blank means github.com
      const domain = msg.input.trim();
      if (domain.length > MAX_HOSTNAME_CHARS || (domain !== "" && !HOSTNAME.test(domain))) return refuseAnswer();
      answer.resolve(domain);
    },

    providerSignInOpenPage: async (msg) => {
      if (msg.type !== "providerSignInOpenPage" || !isSignInProviderId(msg.provider)) return;
      const url = flows.get(msg.provider)?.pageUrl;
      if (!isHttpsUrl(url)) {
        log("[ProviderSignIn:%s] no https sign-in page to open", msg.provider);
        return;
      }
      await platform.shell.openExternal(url);
    },

    // A desktop settings overlay has no clipboard permission, so core writes the code; it is never logged.
    providerSignInCopyCode: async (msg, ctx) => {
      if (msg.type !== "providerSignInCopyCode" || !isSignInProviderId(msg.provider)) return;
      const { provider } = msg;
      // a daemon's core would write the target's clipboard
      if (platform.remote) {
        refuse(ctx.reply, provider);
        return;
      }
      const state = flows.get(provider)?.state;
      let ok = false;
      if (state?.phase === "deviceCode") {
        try {
          await platform.clipboard.writeText(state.userCode);
          ok = true;
        } catch (err) {
          log("[ProviderSignIn:%s] could not copy the code: %s", provider, err instanceof Error ? err.name : typeof err);
        }
      }
      postMessage(ctx.reply, { type: "providerSignInCopyCodeAck", provider, ok });
    },

    providerSignInCancel: async (msg) => {
      if (msg.type !== "providerSignInCancel" || !isSignInProviderId(msg.provider)) return;
      await abortFlow(msg.provider);
    },

    providerSignOut: async (msg, ctx) => {
      if (msg.type !== "providerSignOut") return;
      const { provider } = msg;
      if (!isSignInProviderId(provider)) throw new Error("Unknown sign-in provider");
      if (platform.remote) {
        refuse(ctx.reply, provider);
        return;
      }
      await abortFlow(provider);
      try {
        await PiRuntime.get().signOutProvider(provider);
        credentialChanged(provider);
      } catch (err) {
        log("[ProviderSignIn:%s] sign-out failed: %s", provider, err instanceof Error ? err.name : typeof err);
        const state: ProviderSignInState = { phase: "idle", error: { kind: "provider", message: t("Could not sign out. Try again.") } };
        settled.set(provider, state);
        broadcast({ type: "providerSignInState", provider, state });
      }
    },

    setProviderApiKey: async (msg, ctx) => {
      if (msg.type !== "setProviderApiKey") return;
      const { provider, requestId } = msg;
      if (!isKeyProviderId(provider)) throw new Error("Unknown key provider");
      if (typeof msg.key !== "string") throw new Error("Malformed API key");
      // the secrets proxy would refuse too, but with a store failure instead of the reason
      if (platform.remote) {
        postMessage(ctx.reply, { type: "setProviderApiKeyAck", provider, requestId, ok: false, error: remoteSignInRefusal() });
        return;
      }
      const key = msg.key.trim();
      if (!key) {
        postMessage(ctx.reply, { type: "setProviderApiKeyAck", provider, requestId, ok: false, error: t("API key cannot be empty") });
        return;
      }
      await abortFlow(provider);
      try {
        await storeProviderKey(platform, provider, key);
        postMessage(ctx.reply, { type: "setProviderApiKeyAck", provider, requestId, ok: true });
      } catch (err) {
        log("[ProviderAccounts] Failed to store the %s key:", provider, err);
        // The store's error text is not localized and can name a keyring path, so only the log carries it.
        postMessage(ctx.reply, { type: "setProviderApiKeyAck", provider, requestId, ok: false, error: t("Failed to store API key") });
        return;
      }
      credentialChanged(provider);
    },

    clearProviderApiKey: async (msg, ctx) => {
      if (msg.type !== "clearProviderApiKey") return;
      const { provider, requestId } = msg;
      if (!isKeyProviderId(provider)) throw new Error("Unknown key provider");
      if (platform.remote) {
        postMessage(ctx.reply, { type: "clearProviderApiKeyAck", provider, requestId, ok: false, error: remoteSignInRefusal() });
        return;
      }
      await abortFlow(provider);
      try {
        await deleteProviderKey(platform, provider);
        postMessage(ctx.reply, { type: "clearProviderApiKeyAck", provider, requestId, ok: true });
      } catch (err) {
        log("[ProviderAccounts] Failed to clear the %s key:", provider, err);
        postMessage(ctx.reply, { type: "clearProviderApiKeyAck", provider, requestId, ok: false, error: t("Failed to clear API key") });
        return;
      }
      credentialChanged(provider);
    },
  };

  return {
    handlers,
    postState: (host) => {
      for (const provider of SIGN_IN_PROVIDER_IDS) {
        const state = flows.get(provider)?.state ?? settled.get(provider) ?? { phase: "idle" };
        postMessage(host, { type: "providerSignInState", provider, state });
      }
    },
  };
}
