import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { Platform } from "../../../../platform/platform";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import { PiRuntime, remoteSignInRefusal } from "../../../pi-session/pi-runtime";
import { PI_AGENT_DIR } from "../../../pi-session/agent-dir";
import type { ProviderCredentialActive } from "../../../../shared/settings-sections";
import {
  OPENAI_API_KEY_SECRET,
  OPENAI_API_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  openaiAuthStatus,
  openaiRuntimeKeyWanted,
  readOpenAIAuthFromDisk,
  readPreferOpenAIApiKey,
  type OpenAIAuthStatus,
} from "../../../pi-session/openai-auth";
import { describeAuthError } from "../../../pi-session/describe-error";
import { clientHasKey, clientPrefersApiKey } from "../../../client-snapshots";
import { buildAuthInteraction } from "./auth-interaction";
import { deviceHost } from "../../device-hosts";
import type { PanelHost } from "../../../../platform/window-service";
import { republishAccountInfo } from "./account-info";
import { log } from "../../../logger";
import { l } from "../../../l10n";
import { signInFailure, signInFailureLog } from "./sign-in-failure";
import { LocalizedError, type LocalizedText } from "../../../../shared/localized-text";

/** Sentinel thrown when the user dismisses the OAuth prompt — a benign cancel, not a failure. */
const CHATGPT_SIGN_IN_CANCELLED = "__chatgpt_signin_cancelled__";
// pi's own text when its loopback callback port is taken, read before any provider text (openai-chatgpt.js:202 in pi-ai 1.4.0)
const PI_PORT_IN_USE = /^Port (\d+) is in use\b/;

const OPENAI_MODELS_PROBE_URL = "https://api.openai.com/v1/models";
const OPENAI_PROBE_TIMEOUT_MS = 8_000;

type OpenAIAuthSnapshot = Extract<ExtensionToWebviewMessage, { type: "openaiAuthStatusChanged" }>["status"];

interface ProbeResult {
  status: "ok" | "rejected" | "forbidden" | "network-error";
  modelCount?: number;
  httpStatus?: number;
}

/**
 * Validate an OpenAI API key against the models endpoint. The key rides only in the outbound
 * `Authorization` header to OpenAI — never logged, never sent to any OutputChannel (FR-7).
 */
async function probeOpenAIKey(key: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_PROBE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });

    if (response.status === 200) {
      const body = (await response.json().catch(() => null)) as { data?: unknown[] } | null;
      const modelCount = Array.isArray(body?.data) ? body!.data.length : 0;
      return { status: "ok", modelCount };
    }
    if (response.status === 401) {
      return { status: "rejected" };
    }
    if (response.status === 403) {
      return { status: "forbidden", httpStatus: 403 };
    }
    return { status: "network-error", httpStatus: response.status };
  } catch {
    return { status: "network-error" };
  } finally {
    clearTimeout(timeout);
  }
}

/** A failed ChatGPT sign-in as Damocles' own text, pi's busy loopback port, or a fixed message per class, never pi's other text. */
function chatGPTSignInFailure(err: unknown): { text: LocalizedText; log: string } {
  if (err instanceof LocalizedError) return { text: err.text, log: err.message };
  const port = err instanceof Error ? PI_PORT_IN_USE.exec(err.message) : null;
  if (port) return { text: l("Port {0} is in use, probably by an unfinished sign-in in another app or by the Codex CLI. Cancel that sign-in and try again.", Number(port[1])), log: "port in use" };
  const failure = signInFailure(err);
  return { text: failure.message, log: signInFailureLog(err, failure) };
}

/** The settings panel's view of OpenAI auth: presence and expiry only, never a key or token. */
function toSnapshot(status: OpenAIAuthStatus): OpenAIAuthSnapshot {
  return {
    chatgpt: {
      signedIn: status.chatgpt,
      ...(typeof status.chatgptExpires === "number" ? { expiresAt: status.chatgptExpires } : {}),
    },
    codex: {
      signedIn: status.codex,
      ...(typeof status.codexExpires === "number" ? { expiresAt: status.codexExpires } : {}),
    },
    apikey: { configured: status.apiKey },
  };
}

/** Live status once init's first key sync has run. Before that, the disk part plus a direct secret read. */
async function readStatus(platform: Platform): Promise<OpenAIAuthStatus> {
  if (PiRuntime.exists && PiRuntime.get().openaiStatusReady) return PiRuntime.get().getOpenAIAuthStatus();
  // a daemon's core: the key is the client's, known from its clientAuth, never read
  if (platform.remote) return openaiAuthStatus(readOpenAIAuthFromDisk(PI_AGENT_DIR), clientHasKey(platform.remote, "openai"));
  const secret = await platform.secrets.get(OPENAI_API_KEY_SECRET);
  return openaiAuthStatus(readOpenAIAuthFromDisk(PI_AGENT_DIR), secret !== undefined && secret !== "");
}

/**
 * The credential pi sends for GPT models, in `resolvePiModel`'s order: the preferred key, ChatGPT, Codex, the key, an
 * environment or models.json key.
 */
function activeOpenAICredential(status: OpenAIAuthStatus, preferApiKey: boolean): ProviderCredentialActive {
  if (openaiRuntimeKeyWanted(status, preferApiKey) && (preferApiKey || !status.codex)) return "apiKey";
  if (status.chatgpt || status.codex) return "signIn";
  const external = PiRuntime.exists ? PiRuntime.get().externalKeySource(OPENAI_API_PROVIDER) : null;
  return external !== null ? "external" : "none";
}

export async function openaiAuthStatusMessage(platform: Platform): Promise<Extract<ExtensionToWebviewMessage, { type: "openaiAuthStatusChanged" }>> {
  const status = await readStatus(platform);
  const preferApiKey = platform.remote ? clientPrefersApiKey(platform.remote, OPENAI_API_PROVIDER) : readPreferOpenAIApiKey(platform.state);
  return {
    type: "openaiAuthStatusChanged",
    status: toSnapshot(status),
    preferApiKey,
    // a daemon's core: which credential is active is the client's to say
    ...(platform.remote ? {} : { active: activeOpenAICredential(status, preferApiKey) }),
  };
}

/**
 * Webview-driven OpenAI auth (API key secret, Sign in with ChatGPT, legacy Codex sign-out) backed by
 * `PiRuntime`. pi owns the grants in auth.json, the loopback OAuth callback server, PKCE and token
 * refresh; the key lives in the host secret store. The prefer-api-key precedence is a global-state flag.
 */
export function createOpenAIHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, getPanels, platform } = deps;
  let signInBusy = false;
  let signInAbort: AbortController | null = null;

  const runtime = (): PiRuntime => PiRuntime.get();

  function broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, message);
    }
  }

  /** Every panel, on a daemon's core only the views of the device `asker` replies to: its sign-in's progress and refusal are its own. */
  function toAsker(asker: PanelHost, message: ExtensionToWebviewMessage): void {
    for (const [, instance] of getPanels()) {
      postMessage(asker.clientId === undefined ? instance.host : deviceHost(instance.host, asker.clientId), message);
    }
  }

  /**
   * Called on the mutation paths only, once the runtime's own sync set the state they read; the secret or auth.json change
   * of the write publishes nothing more (`ownAuthFileChange`, and the runtime's key secret check). The read-only status
   * queries post `openaiAuthStatusMessage()` direct, because a read changes nothing the account state is derived from.
   */
  async function broadcastAuthStatus(): Promise<void> {
    await deps.broadcastAccountState("the OpenAI auth status", "openai", () => openaiAuthStatusMessage(platform));
    republishAccountInfo(getPanels);
  }

  /** Runs a change of the `openai` or `openai-codex` entries in auth.json, which this handler publishes after it settled, failed or not. */
  function ownChange<T>(providers: readonly string[], op: () => Promise<T>): Promise<T> {
    return runtime().ownAuthFileChange(providers, true, op);
  }

  /** The OpenAI account's credential changed, so its rejected-credential card goes. */
  function credentialChanged(): void {
    broadcast({ type: "authFailureCleared", account: "openai" });
  }

  /** Each chat applies or drops a model pick that asked for this sign-in; only a ChatGPT sign-in or a key save ends one. */
  function endSignIn(signedIn: boolean): void {
    for (const [, instance] of getPanels()) void instance.session.openaiSignInEnded(signedIn);
  }

  /**
   * pi races the `manual_code` paste-the-redirect-URL prompt against its local OAuth callback server;
   * when the callback wins, the prompt is dismissed through its abort signal (see `buildAuthInteraction`).
   */
  function buildChatGPTInteraction(signal: AbortSignal): AuthInteraction {
    return buildAuthInteraction({ signal, cancelSentinel: CHATGPT_SIGN_IN_CANCELLED, logPrefix: "[OpenAIHandlers]", platform });
  }

  return {
    setOpenAIApiKey: async (msg, ctx) => {
      if (msg.type !== "setOpenAIApiKey") return;
      // before the probe, so the key never reaches OpenAI from a daemon's core
      if (platform.remote) {
        postMessage(ctx.reply, { type: "setOpenAIApiKeyAck", requestId: msg.requestId, ok: false, error: remoteSignInRefusal() });
        return;
      }
      const key = msg.key.trim();
      if (!key) {
        postMessage(ctx.reply, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: l("API key cannot be empty"),
        });
        return;
      }

      const probe = await probeOpenAIKey(key);

      if (probe.status === "rejected") {
        postMessage(ctx.reply, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: l("Key rejected. Verify it on platform.openai.com."),
        });
        return;
      }

      if (probe.status === "forbidden") {
        postMessage(ctx.reply, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: l("Key returned 403. It is likely rate-limited, IP-restricted or region-blocked. Verify it on platform.openai.com."),
        });
        return;
      }

      // A pending sign-in holds the credential chain, so this save would wait for it to end.
      signInAbort?.abort();
      try {
        await ownChange([OPENAI_API_PROVIDER], () => runtime().setOpenAIApiKey(key));
      } catch (err) {
        log("[OpenAIHandlers] Failed to persist API key: %s", describeAuthError(err));
        await broadcastAuthStatus();
        endSignIn(false);
        postMessage(ctx.reply, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: l("Failed to persist API key"),
        });
        return;
      }

      await broadcastAuthStatus();
      credentialChanged();
      endSignIn(true);

      if (probe.status === "ok") {
        postMessage(ctx.reply, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: true,
          validated: true,
          modelCount: probe.modelCount ?? 0,
        });
      } else {
        postMessage(ctx.reply, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: true,
          validated: false,
          warning: l("Couldn't validate the key because of a network error."),
        });
      }
    },

    clearOpenAIApiKey: async (msg, ctx) => {
      if (msg.type !== "clearOpenAIApiKey") return;
      if (platform.remote) {
        postMessage(ctx.reply, { type: "clearOpenAIApiKeyAck", requestId: msg.requestId, ok: false, error: remoteSignInRefusal() });
        return;
      }
      signInAbort?.abort();
      try {
        await ownChange([OPENAI_API_PROVIDER], () => runtime().clearOpenAIApiKey());
        await broadcastAuthStatus();
        credentialChanged();
        postMessage(ctx.reply, { type: "clearOpenAIApiKeyAck", requestId: msg.requestId, ok: true });
      } catch (err) {
        log("[OpenAIHandlers] Failed to clear API key: %s", describeAuthError(err));
        await broadcastAuthStatus();
        postMessage(ctx.reply, {
          type: "clearOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: l("Failed to clear API key"),
        });
      }
    },

    getOpenAIAuthStatus: async (_msg, ctx) => {
      postMessage(ctx.reply, await openaiAuthStatusMessage(platform));
    },

    setOpenAIPreferApiKey: async (msg, ctx) => {
      if (msg.type !== "setOpenAIPreferApiKey") return;
      // each device's flag is its own, which its clientAuth carries
      if (platform.remote) {
        postMessage(ctx.reply, { type: "setOpenAIPreferApiKeyAck", requestId: msg.requestId, ok: false, error: remoteSignInRefusal() });
        return;
      }
      signInAbort?.abort();
      try {
        await runtime().setOpenAIPreferApiKey(msg.preferApiKey);
      } catch (err) {
        log("[OpenAIHandlers] Failed to apply the API key preference: %s", describeAuthError(err));
        await broadcastAuthStatus();
        postMessage(ctx.reply, {
          type: "setOpenAIPreferApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: l("Failed to apply the preference"),
        });
        return;
      }
      await broadcastAuthStatus();
      // the toggle switches the credential pi sends, so the refusal the card names no longer applies
      credentialChanged();
      postMessage(ctx.reply, {
        type: "setOpenAIPreferApiKeyAck",
        requestId: msg.requestId,
        ok: true,
      });
    },

    startChatGPTOAuth: async (msg, ctx) => {
      if (msg.type !== "startChatGPTOAuth") return;

      // The flow in progress is still running, so the requester is told so rather than every panel told it failed.
      if (signInBusy) {
        postMessage(ctx.reply, { type: "openaiChatGPTAuthStarted" });
        return;
      }

      signInBusy = true;
      const abort = new AbortController();
      signInAbort = abort;
      toAsker(ctx.reply, { type: "openaiChatGPTAuthStarted" });

      let signedIn = false;
      try {
        await ownChange([OPENAI_API_PROVIDER, OPENAI_CODEX_PROVIDER], () => runtime().signInChatGPT(buildChatGPTInteraction(abort.signal)));
        signedIn = true;
        toAsker(ctx.reply, { type: "openaiChatGPTAuthCompleted" });
        credentialChanged();
      } catch (err) {
        // pi rethrows a flow abort as its own "Login cancelled", so the signal is checked as well as the sentinel.
        if (abort.signal.aborted || (err instanceof Error && err.message === CHATGPT_SIGN_IN_CANCELLED)) {
          toAsker(ctx.reply, { type: "openaiChatGPTAuthFailed", error: l("Sign-in cancelled.") });
        } else {
          const failure = chatGPTSignInFailure(err);
          log("[OpenAIHandlers] ChatGPT sign-in failed: %s", failure.log);
          toAsker(ctx.reply, { type: "openaiChatGPTAuthFailed", error: failure.text });
        }
      } finally {
        signInBusy = false;
        signInAbort = null;
        // A failed sign-in may still have changed auth.json, so the status is restated either way.
        await broadcastAuthStatus();
        endSignIn(signedIn);
      }
    },

    signOutChatGPT: async (msg) => {
      if (msg.type !== "signOutChatGPT") return;
      // Abort an in-flight sign-in so a stalled OAuth flow cannot land after the sign-out.
      signInAbort?.abort();
      try {
        await ownChange([OPENAI_API_PROVIDER], () => runtime().signOutChatGPT());
        credentialChanged();
      } catch (err) {
        log("[OpenAIHandlers] ChatGPT sign-out failed: %s", describeAuthError(err));
      }
      await broadcastAuthStatus();
    },

    signOutCodex: async (msg) => {
      if (msg.type !== "signOutCodex") return;
      // The panel disables this sign-out during a ChatGPT sign-in; one arriving anyway must not queue behind the flow.
      signInAbort?.abort();
      try {
        await ownChange([OPENAI_CODEX_PROVIDER], () => runtime().signOutCodex());
        credentialChanged();
      } catch (err) {
        log("[OpenAIHandlers] Codex sign-out failed: %s", describeAuthError(err));
      }
      await broadcastAuthStatus();
    },
  };
}
