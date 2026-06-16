import { log } from "../logger";
import { DEFAULT_MODELS } from "../../shared/types/constants";
import type { ModelInfo } from "../../shared/types/settings";
import { buildSdkEnv, SMALL_FAST_ANTHROPIC_MODEL } from "./sdk-env";

/** Small/fast model for OpenAI-backed sub-calls (used only when a GPT backend is wired). */
const SMALL_FAST_OPENAI_MODEL = "gpt-5.4-mini";

/**
 * Context placeholder for sub-call routing (btw, recall, memory expansion). The SDK sub-call
 * path is Anthropic-only — GPT runs exclusively on the pi harness — so this is always `null`
 * in practice. Retained as a typed seam so sub-call sites compile unchanged.
 */
export type SubCallBridgeCtx = Record<string, never>;

export interface SubCallEnvResolution {
  env: Record<string, string>;
  /** Upstream model id the SDK should send. */
  resolvedModel: string;
}

function lookupModelInfo(modelValue: string): ModelInfo | undefined {
  const stripped = modelValue.replace(/\[1m\]$/, "");
  return DEFAULT_MODELS.find(m => m.value === stripped);
}

/**
 * Resolve env + model id for a sub-call SDK invocation. The SDK path is Anthropic-only, so this
 * returns the sanitized Anthropic env for every Anthropic-backed model. OpenAI-backed models are
 * not routable through the SDK path and resolve to `null` so callers (memory / recall / btw)
 * degrade gracefully.
 */
export async function buildSubCallEnv(
  modelValue: string,
  _ctx: SubCallBridgeCtx | null,
): Promise<SubCallEnvResolution | null> {
  const modelInfo = lookupModelInfo(modelValue);
  if (modelInfo?.backend === "openai") {
    log("[buildSubCallEnv] OpenAI sub-call models are not supported on the SDK path: %s", modelValue);
    return null;
  }
  return { env: buildSdkEnv(), resolvedModel: modelValue };
}

/**
 * Return the appropriate small-fast model identifier for a given backend.
 *
 * `gpt-5.4-mini` on OpenAI is hardcoded to satisfy the CLAUDE.md contract that
 * background sub-calls (Memory expansion, Recall sub-calls, btw) hit the same
 * tier as primary requests.
 */
export function getSmallFastModelForBackend(backend: "anthropic" | "openai"): string {
  return backend === "openai" ? SMALL_FAST_OPENAI_MODEL : SMALL_FAST_ANTHROPIC_MODEL;
}

/**
 * Resolve the backend of a sub-call context. The SDK sub-call path is Anthropic-only, so this
 * always reports `anthropic`.
 */
export function inferSubCallBackendForCtx(_ctx: SubCallBridgeCtx | null): "anthropic" | "openai" {
  return "anthropic";
}
