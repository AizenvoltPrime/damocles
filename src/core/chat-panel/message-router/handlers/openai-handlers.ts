import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { Platform } from "../../../../platform/platform";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { PI_AGENT_DIR } from "../../../pi-session/agent-dir";
import {
  OPENAI_API_KEY_SECRET,
  OPENAI_PREFER_API_KEY_STATE,
  openaiAuthStatus,
  readOpenAIAuthFromDisk,
  type OpenAIAuthStatus,
} from "../../../pi-session/openai-auth";
import { describeAuthError } from "../../../pi-session/describe-error";
import { buildAuthInteraction } from "./auth-interaction";
import { republishAccountInfo } from "./account-info";
import { log } from "../../../logger";
import { t } from "../../../l10n";

/** Sentinel thrown when the user dismisses the OAuth prompt — a benign cancel, not a failure. */
const CHATGPT_SIGN_IN_CANCELLED = "__chatgpt_signin_cancelled__";

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
  const secret = await platform.secrets.get(OPENAI_API_KEY_SECRET);
  return openaiAuthStatus(readOpenAIAuthFromDisk(PI_AGENT_DIR), secret !== undefined && secret !== "");
}

export async function openaiAuthStatusMessage(platform: Platform): Promise<Extract<ExtensionToWebviewMessage, { type: "openaiAuthStatusChanged" }>> {
  return {
    type: "openaiAuthStatusChanged",
    status: toSnapshot(await readStatus(platform)),
    preferApiKey: platform.state.workspace.get<boolean>(OPENAI_PREFER_API_KEY_STATE, false),
  };
}

/**
 * Webview-driven OpenAI auth (API key secret, Sign in with ChatGPT, legacy Codex sign-out) backed by
 * `PiRuntime`. pi owns the grants in auth.json, the loopback OAuth callback server, PKCE and token
 * refresh; the key lives in the host secret store. The prefer-api-key precedence is a workspaceState flag.
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

  /** Called on the mutation paths only. The read-only status queries post `openaiAuthStatusMessage()` direct,
   *  because a read changes nothing the account state is derived from. */
  async function broadcastAuthStatus(): Promise<void> {
    broadcast(await openaiAuthStatusMessage(platform));
    republishAccountInfo(getPanels);
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
      const key = msg.key.trim();
      if (!key) {
        postMessage(ctx.host, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: t("API key cannot be empty"),
        });
        return;
      }

      const probe = await probeOpenAIKey(key);

      if (probe.status === "rejected") {
        postMessage(ctx.host, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: t("Key rejected. Verify it on platform.openai.com."),
        });
        return;
      }

      if (probe.status === "forbidden") {
        postMessage(ctx.host, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: t("Key returned 403. It is likely rate-limited, IP-restricted or region-blocked. Verify it on platform.openai.com."),
        });
        return;
      }

      // A pending sign-in holds the credential chain, so this save would wait for it to end.
      signInAbort?.abort();
      try {
        await runtime().setOpenAIApiKey(key);
      } catch (err) {
        log("[OpenAIHandlers] Failed to persist API key: %s", describeAuthError(err));
        await broadcastAuthStatus();
        postMessage(ctx.host, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: t("Failed to persist API key"),
        });
        return;
      }

      await broadcastAuthStatus();

      if (probe.status === "ok") {
        postMessage(ctx.host, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: true,
          validated: true,
          modelCount: probe.modelCount ?? 0,
        });
      } else {
        postMessage(ctx.host, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: true,
          validated: false,
          warning: t("Couldn't validate the key because of a network error."),
        });
      }
    },

    clearOpenAIApiKey: async (msg, ctx) => {
      if (msg.type !== "clearOpenAIApiKey") return;
      signInAbort?.abort();
      try {
        await runtime().clearOpenAIApiKey();
        await broadcastAuthStatus();
        postMessage(ctx.host, { type: "clearOpenAIApiKeyAck", requestId: msg.requestId, ok: true });
      } catch (err) {
        log("[OpenAIHandlers] Failed to clear API key: %s", describeAuthError(err));
        await broadcastAuthStatus();
        postMessage(ctx.host, {
          type: "clearOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: t("Failed to clear API key"),
        });
      }
    },

    getOpenAIAuthStatus: async (_msg, ctx) => {
      postMessage(ctx.host, await openaiAuthStatusMessage(platform));
    },

    setOpenAIPreferApiKey: async (msg, ctx) => {
      if (msg.type !== "setOpenAIPreferApiKey") return;
      signInAbort?.abort();
      try {
        await platform.state.workspace.update(OPENAI_PREFER_API_KEY_STATE, msg.preferApiKey);
        await runtime().syncOpenAIRuntimeKey();
      } catch (err) {
        log("[OpenAIHandlers] Failed to apply the API key preference: %s", describeAuthError(err));
        await broadcastAuthStatus();
        postMessage(ctx.host, {
          type: "setOpenAIPreferApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: t("Failed to apply the preference"),
        });
        return;
      }
      await broadcastAuthStatus();
      postMessage(ctx.host, {
        type: "setOpenAIPreferApiKeyAck",
        requestId: msg.requestId,
        ok: true,
      });
    },

    startChatGPTOAuth: async (msg, ctx) => {
      if (msg.type !== "startChatGPTOAuth") return;

      // The flow in progress is still running, so the requester is told so rather than every panel told it failed.
      if (signInBusy) {
        postMessage(ctx.host, { type: "openaiChatGPTAuthStarted" });
        return;
      }

      signInBusy = true;
      const abort = new AbortController();
      signInAbort = abort;
      broadcast({ type: "openaiChatGPTAuthStarted" });

      try {
        await runtime().signInChatGPT(buildChatGPTInteraction(abort.signal));
        broadcast({ type: "openaiChatGPTAuthCompleted" });
      } catch (err) {
        // pi rethrows a flow abort as its own "Login cancelled", so the signal is checked as well as the sentinel.
        if (abort.signal.aborted || (err instanceof Error && err.message === CHATGPT_SIGN_IN_CANCELLED)) {
          broadcast({ type: "openaiChatGPTAuthFailed", error: t("Sign-in cancelled.") });
        } else {
          log("[OpenAIHandlers] ChatGPT sign-in failed: %s", describeAuthError(err));
          broadcast({ type: "openaiChatGPTAuthFailed", error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        signInBusy = false;
        signInAbort = null;
        // A failed sign-in may still have changed auth.json, so the status is restated either way.
        await broadcastAuthStatus();
      }
    },

    signOutChatGPT: async (msg) => {
      if (msg.type !== "signOutChatGPT") return;
      // Abort an in-flight sign-in so a stalled OAuth flow cannot land after the sign-out.
      signInAbort?.abort();
      try {
        await runtime().signOutChatGPT();
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
        await runtime().signOutCodex();
      } catch (err) {
        log("[OpenAIHandlers] Codex sign-out failed: %s", describeAuthError(err));
      }
      await broadcastAuthStatus();
    },
  };
}
