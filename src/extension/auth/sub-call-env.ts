import * as vscode from "vscode";
import { log } from "../logger";
import { DEFAULT_MODELS } from "../../shared/types/constants";
import type { ModelInfo } from "../../shared/types/settings";
import {
  buildOpenAIBridgeEnv,
  OpenAIAuthRequiredError,
  provisionOpenAIBridge,
  SMALL_FAST_OPENAI_MODEL,
  type OpenAIBridge,
} from "../openai-bridge";
import type { OpenAIAuthStatusSnapshot } from "../openai-bridge/openai-auth";
import { buildSdkEnv, SMALL_FAST_ANTHROPIC_MODEL } from "./sdk-env";

/**
 * Context required to route a sub-call (btw, recall, memory expansion) through the OpenAI
 * bridge when the panel's active model is GPT-backed. Every field is required — building a
 * partial context silently degrades to Anthropic-only, which the CLAUDE.md contract forbids.
 */
export interface SubCallBridgeCtx {
  panelId: string;
  ensureOpenAIBridge: () => OpenAIBridge;
  getOpenAIAuthStatus: () => Promise<OpenAIAuthStatusSnapshot>;
  getOpenAIPreferApiKey: () => boolean;
  clientAppVersion: string;
}

export interface SubCallEnvResolution {
  env: Record<string, string>;
  /** Upstream model id the SDK should send. For OpenAI models this is `openaiModelId`. */
  resolvedModel: string;
}

function lookupModelInfo(modelValue: string): ModelInfo | undefined {
  const stripped = modelValue.replace(/\[1m\]$/, "");
  return DEFAULT_MODELS.find(m => m.value === stripped);
}

/**
 * Resolve env + model id for a sub-call SDK invocation. Anthropic → sanitized env.
 * OpenAI without ctx / trust / auth → logs cause + returns null. Unexpected failures
 * are logged with name + message + stack then return null so callers (memory / recall /
 * btw) degrade gracefully instead of crashing the user's flow.
 */
export async function buildSubCallEnv(
  modelValue: string,
  ctx: SubCallBridgeCtx | null,
): Promise<SubCallEnvResolution | null> {
  const modelInfo = lookupModelInfo(modelValue);
  if (!modelInfo || modelInfo.backend !== "openai") {
    return { env: buildSdkEnv(), resolvedModel: modelValue };
  }
  if (!ctx) return null;
  if (!vscode.workspace.isTrusted) {
    log("[buildSubCallEnv] Skipping bridge provisioning: workspace is not trusted");
    return null;
  }
  try {
    const provisioning = await provisionOpenAIBridge(modelInfo, {
      getBridge: ctx.ensureOpenAIBridge,
      panelId: ctx.panelId,
      getOpenAIAuthStatus: ctx.getOpenAIAuthStatus,
      getPreferApiKey: ctx.getOpenAIPreferApiKey,
    });
    if (!provisioning) return null;
    return {
      env: { ...buildSdkEnv(), ...buildOpenAIBridgeEnv(provisioning, ctx.clientAppVersion) },
      resolvedModel: provisioning.openaiModelId,
    };
  } catch (err) {
    if (err instanceof OpenAIAuthRequiredError) {
      log("[buildSubCallEnv] OpenAI auth required for sub-call model=%s", modelValue);
      return null;
    }
    /** Log unexpected failures with full context, then degrade — caller (memory/recall/btw) must not crash on transient infra issues. */
    const errorMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log("[buildSubCallEnv] ERROR provisioning bridge for sub-call model=%s panelId=%s — %s", modelValue, ctx.panelId, errorMessage);
    if (err instanceof Error && err.stack) {
      log("[buildSubCallEnv] stack: %s", err.stack);
    }
    return null;
  }
}

/**
 * Return the appropriate small-fast model identifier for a given backend.
 *
 * `gpt-5.4-mini` on OpenAI is hardcoded to satisfy the CLAUDE.md contract that
 * background sub-calls (Memory expansion, Recall sub-calls, btw) hit the same
 * Codex tier as primary requests — cache-friendly and never rejected on auth-tier.
 */
export function getSmallFastModelForBackend(backend: "anthropic" | "openai"): string {
  return backend === "openai" ? SMALL_FAST_OPENAI_MODEL : SMALL_FAST_ANTHROPIC_MODEL;
}

/**
 * Resolve the backend of a context. Used by sub-call sites that pick between
 * Haiku (Anthropic) and gpt-5.4-mini (OpenAI) based on the panel's active model
 * — without knowing which model the user has selected they default to Anthropic.
 */
export function inferSubCallBackendForCtx(ctx: SubCallBridgeCtx | null): "anthropic" | "openai" {
  if (!ctx) return "anthropic";
  return "openai";
}
