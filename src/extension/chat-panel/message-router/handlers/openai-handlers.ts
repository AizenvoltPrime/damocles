import type { HandlerDependencies, HandlerRegistry } from "../types";
import { OPENAI_BRIDGE_SECRET_KEYS } from "../../../openai-bridge/types";
import { OPENAI_PREFER_API_KEY_STATE, getOpenAIAuthStatus } from "../../../openai-bridge/openai-auth";
import {
  cancelActiveOAuthFlow,
  isOAuthFlowInProgress,
  signOutCodex,
  startCodexOAuth,
} from "../../../openai-bridge/codex-oauth";
import { log } from "../../../logger";

const OPENAI_MODELS_PROBE_URL = "https://api.openai.com/v1/models";
const OPENAI_PROBE_TIMEOUT_MS = 8_000;

interface ProbeResult {
  status: "ok" | "rejected" | "forbidden" | "network-error";
  modelCount?: number;
  httpStatus?: number;
}

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

export function createOpenAIHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, getPanels, context, getOpenAIBridge } = deps;

  async function broadcastAuthStatus(): Promise<void> {
    const status = await getOpenAIAuthStatus(context);
    const preferApiKey = context.workspaceState.get<boolean>(OPENAI_PREFER_API_KEY_STATE, false);
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, {
        type: "openaiAuthStatusChanged",
        status,
        preferApiKey,
      });
    }
  }

  function broadcastCodex(message:
    | { type: "openaiCodexAuthStarted" }
    | { type: "openaiCodexAuthCompleted"; accountId: string | null }
    | { type: "openaiCodexAuthFailed"; error: string }
    | { type: "openaiCodexAuthExpired" }
  ): void {
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, message);
    }
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
        await context.secrets.store(OPENAI_BRIDGE_SECRET_KEYS.apikey, key);
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
          warning: "Couldn't validate key — network error",
        });
      }
    },

    clearOpenAIApiKey: async (msg, ctx) => {
      if (msg.type !== "clearOpenAIApiKey") return;
      try {
        await context.secrets.delete(OPENAI_BRIDGE_SECRET_KEYS.apikey);
        const bridge = getOpenAIBridge();
        if (bridge) {
          bridge.rotateBearersForAllPanels();
          log("[OpenAIHandlers] Rotated bearers after clearOpenAIApiKey");
        }
        await broadcastAuthStatus();
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

    getOpenAIAuthStatus: async (_msg, ctx) => {
      const status = await getOpenAIAuthStatus(context);
      const preferApiKey = context.workspaceState.get<boolean>(OPENAI_PREFER_API_KEY_STATE, false);
      postMessage(ctx.host, {
        type: "openaiAuthStatusChanged",
        status,
        preferApiKey,
      });
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
      const bridge = getOpenAIBridge();
      if (bridge) {
        bridge.rotateBearersForAllPanels();
        log("[OpenAIHandlers] Rotated bearers after preferApiKey=%s", msg.preferApiKey);
      } else {
        log("[OpenAIHandlers] preferApiKey=%s set with no bridge instance — nothing to rotate", msg.preferApiKey);
      }
      await broadcastAuthStatus();
      postMessage(ctx.host, {
        type: "setOpenAIPreferApiKeyAck",
        requestId: msg.requestId,
        ok: true,
      });
    },

    startCodexOAuth: async (msg) => {
      if (msg.type !== "startCodexOAuth") return;

      if (isOAuthFlowInProgress()) {
        broadcastCodex({ type: "openaiCodexAuthFailed", error: "A sign-in flow is already in progress." });
        return;
      }

      broadcastCodex({ type: "openaiCodexAuthStarted" });
      log("[OpenAIHandlers] Starting Codex OAuth flow");

      const result = await startCodexOAuth({
        context,
        onCompleted: (accountId) => {
          broadcastCodex({ type: "openaiCodexAuthCompleted", accountId });
        },
        onFailed: (error) => {
          broadcastCodex({ type: "openaiCodexAuthFailed", error });
        },
      });

      if (result.ok) {
        await broadcastAuthStatus();
      }
    },

    signOutCodex: async (msg) => {
      if (msg.type !== "signOutCodex") return;
      try {
        cancelActiveOAuthFlow("sign-out");
        await signOutCodex(context);
        const bridge = getOpenAIBridge();
        if (bridge) {
          bridge.rotateBearersForAllPanels();
          log("[OpenAIHandlers] Rotated bearers after signOutCodex");
        }
        await broadcastAuthStatus();
        log("[OpenAIHandlers] Codex sign-out completed");
      } catch (err) {
        log("[OpenAIHandlers] Codex sign-out failed:", err);
      }
    },
  };
}
