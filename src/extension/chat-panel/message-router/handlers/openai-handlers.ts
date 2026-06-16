import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import { PiRuntime, type CodexLoginCallbacks } from "../../../pi-session/pi-runtime";
import { PI_AGENT_DIR } from "../../../pi-session/agent-dir";
import { readOpenAIAuthFromDisk, OPENAI_PREFER_API_KEY_STATE, type OpenAIAuthStatus } from "../../../pi-session/openai-auth";
import { log } from "../../../logger";

/** Sentinel thrown when the user dismisses the OAuth prompt — a benign cancel, not a failure. */
const CODEX_SIGN_IN_CANCELLED = "__codex_signin_cancelled__";

const OPENAI_MODELS_PROBE_URL = "https://api.openai.com/v1/models";
const OPENAI_PROBE_TIMEOUT_MS = 8_000;

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

/**
 * Map pi's flat OpenAI auth state to the nested snapshot the settings panel renders. pi does not
 * surface a Codex account id, so `accountId` is always omitted.
 */
function toSnapshot(status: OpenAIAuthStatus): {
  codex: { signedIn: boolean; expiresAt?: number };
  apikey: { configured: boolean };
} {
  return {
    codex: {
      signedIn: status.codex,
      ...(typeof status.codexExpires === "number" ? { expiresAt: status.codexExpires } : {}),
    },
    apikey: { configured: status.apiKey },
  };
}

/**
 * Webview-driven OpenAI auth (API key + Codex OAuth) backed by `PiRuntime`. pi owns the OpenAI/Codex
 * credential storage, the loopback OAuth callback server, PKCE, and token refresh; Damocles only
 * relays UI intent and broadcasts state. The prefer-api-key precedence stays a workspaceState flag.
 */
export function createOpenAIHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, getPanels, context, workspacePath } = deps;
  let codexBusy = false;
  let codexAbort: AbortController | null = null;

  const runtime = (): PiRuntime => PiRuntime.get(workspacePath, PI_AGENT_DIR);

  function broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, message);
    }
  }

  /**
   * Live status once pi's services are populated, otherwise the disk mirror. `PiRuntime.exists` flips
   * true as soon as the singleton is constructed — before `init()` resolves — so we additionally gate
   * on `services` being live to avoid reporting a spurious "not configured" during the init window.
   */
  function readStatus(): OpenAIAuthStatus {
    return PiRuntime.exists && runtime().services
      ? runtime().getOpenAIAuthStatus()
      : readOpenAIAuthFromDisk(PI_AGENT_DIR);
  }

  function authStatusMessage(): ExtensionToWebviewMessage {
    return {
      type: "openaiAuthStatusChanged",
      status: toSnapshot(readStatus()),
      preferApiKey: context.workspaceState.get<boolean>(OPENAI_PREFER_API_KEY_STATE, false),
    };
  }

  function broadcastAuthStatus(): void {
    broadcast(authStatusMessage());
  }

  function buildCodexCallbacks(signal: AbortSignal): CodexLoginCallbacks {
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
        if (value === undefined) throw new Error(CODEX_SIGN_IN_CANCELLED);
        return value;
      },
      signal,
    };
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
          error: "API key cannot be empty",
        });
        return;
      }

      const probe = await probeOpenAIKey(key);

      if (probe.status === "rejected") {
        postMessage(ctx.host, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: "Key rejected — verify it on platform.openai.com",
        });
        return;
      }

      if (probe.status === "forbidden") {
        postMessage(ctx.host, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: "Key returned 403 — likely rate-limited, IP-restricted, or region-blocked. Verify on platform.openai.com.",
        });
        return;
      }

      try {
        await runtime().setOpenAIApiKey(key);
      } catch (err) {
        log("[OpenAIHandlers] Failed to persist API key:", err);
        postMessage(ctx.host, {
          type: "setOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: err instanceof Error ? err.message : "Failed to persist API key",
        });
        return;
      }

      broadcastAuthStatus();

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
          warning: "Couldn't validate key — network error",
        });
      }
    },

    clearOpenAIApiKey: async (msg, ctx) => {
      if (msg.type !== "clearOpenAIApiKey") return;
      try {
        runtime().clearOpenAIApiKey();
        broadcastAuthStatus();
        postMessage(ctx.host, { type: "clearOpenAIApiKeyAck", requestId: msg.requestId, ok: true });
      } catch (err) {
        log("[OpenAIHandlers] Failed to clear API key:", err);
        postMessage(ctx.host, {
          type: "clearOpenAIApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: err instanceof Error ? err.message : "Failed to clear API key",
        });
      }
    },

    getOpenAIAuthStatus: (_msg, ctx) => {
      postMessage(ctx.host, authStatusMessage());
    },

    setOpenAIPreferApiKey: async (msg, ctx) => {
      if (msg.type !== "setOpenAIPreferApiKey") return;
      try {
        await context.workspaceState.update(OPENAI_PREFER_API_KEY_STATE, msg.preferApiKey);
      } catch (err) {
        log("[OpenAIHandlers] Failed to persist preference:", err);
        postMessage(ctx.host, {
          type: "setOpenAIPreferApiKeyAck",
          requestId: msg.requestId,
          ok: false,
          error: err instanceof Error ? err.message : "Failed to persist preference",
        });
        return;
      }
      broadcastAuthStatus();
      postMessage(ctx.host, {
        type: "setOpenAIPreferApiKeyAck",
        requestId: msg.requestId,
        ok: true,
      });
    },

    startCodexOAuth: async (msg) => {
      if (msg.type !== "startCodexOAuth") return;

      if (codexBusy) {
        broadcast({ type: "openaiCodexAuthFailed", error: "A sign-in flow is already in progress." });
        return;
      }

      codexBusy = true;
      codexAbort = new AbortController();
      broadcast({ type: "openaiCodexAuthStarted" });

      try {
        await runtime().signInCodex(buildCodexCallbacks(codexAbort.signal));
        broadcast({ type: "openaiCodexAuthCompleted", accountId: null });
        broadcastAuthStatus();
      } catch (err) {
        if (err instanceof Error && err.message === CODEX_SIGN_IN_CANCELLED) {
          broadcast({ type: "openaiCodexAuthFailed", error: "Sign-in cancelled." });
        } else {
          const error = err instanceof Error ? err.message : String(err);
          log("[OpenAIHandlers] Codex sign-in failed: %O", err);
          broadcast({ type: "openaiCodexAuthFailed", error });
        }
      } finally {
        codexBusy = false;
        codexAbort = null;
      }
    },

    signOutCodex: async (msg) => {
      if (msg.type !== "signOutCodex") return;
      try {
        // Abort an in-flight sign-in (if any) so a stalled OAuth flow can't leave codexBusy latched.
        codexAbort?.abort();
        runtime().signOutCodex();
        broadcastAuthStatus();
      } catch (err) {
        log("[OpenAIHandlers] Codex sign-out failed:", err);
      }
    },
  };
}
