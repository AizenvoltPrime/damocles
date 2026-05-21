import * as vscode from "vscode";
import type { ModelInfo } from "../../shared/types/settings";
import type { OpenAIBridge, OpenAIBridgeAuthMode } from "./index";
import type { OpenAIAuthStatusSnapshot } from "./openai-auth";
import { log } from "../logger";

/**
 * Raised by bridge provisioning helpers when an OpenAI-backed model is selected
 * but neither auth path is configured. Callers surface this via the
 * `openaiAuthRequired` webview message; the SettingsPanel highlights the auth
 * section. The held model is re-applied after the user signs in.
 */
export class OpenAIAuthRequiredError extends Error {
  readonly modelValue: string;
  constructor(modelValue: string) {
    super(`OpenAI auth required for model ${modelValue}`);
    this.name = "OpenAIAuthRequiredError";
    this.modelValue = modelValue;
  }
}

/**
 * Shape of the bridge endpoint + chosen auth-mode + resolved upstream model ID,
 * returned to env construction sites (main-chat QueryManager and Team AgentRunner).
 */
export interface OpenAIBridgeProvisioning {
  url: string;
  bearer: string;
  authMode: OpenAIBridgeAuthMode;
  openaiModelId: string;
  smallFastModel: string;
}

/**
 * Deps shared by every provisioning site. `getBridge` is a factory: callers invoke it the
 * moment they actually need the proxy instance. Lazy by design — Anthropic-only sessions
 * never trigger bridge construction, so no idle loopback server, no OutputChannel, no
 * proxy state allocated until a GPT model is selected.
 */
export interface OpenAIBridgeProvisionDeps {
  getBridge: () => OpenAIBridge;
  panelId: string;
  getOpenAIAuthStatus: () => Promise<OpenAIAuthStatusSnapshot>;
  getPreferApiKey: () => boolean;
}

/** Hardcoded small/fast model for OpenAI-backed sessions. */
export const SMALL_FAST_OPENAI_MODEL = "gpt-5.4-mini";

/**
 * Pre-flight async helper that provisions a bridge endpoint when the active model is
 * OpenAI-backed. Returns `null` for Anthropic-backed models (the SDK talks to Anthropic
 * directly). Throws `OpenAIAuthRequiredError` when neither auth path is configured for
 * the selected GPT model — callers surface this as the `openaiAuthRequired` webview
 * message and pause the spawn until the user signs in.
 *
 * Auth-mode resolution mirrors US-006:
 *   - both modes eligible → `preferApiKey` toggle picks; default = codex
 *   - only one eligible → use that one
 *   - neither eligible → throw `OpenAIAuthRequiredError`
 */
export async function provisionOpenAIBridge(
  modelInfo: ModelInfo | undefined,
  deps: OpenAIBridgeProvisionDeps | null,
): Promise<OpenAIBridgeProvisioning | null> {
  if (!modelInfo || modelInfo.backend !== "openai") return null;
  if (!vscode.workspace.isTrusted) {
    throw new Error("OpenAI bridge requires a trusted workspace. Trust this workspace or switch to the Anthropic backend.");
  }
  if (!deps) {
    throw new OpenAIAuthRequiredError(modelInfo.value);
  }

  const authStatus = await deps.getOpenAIAuthStatus();
  const preferApiKey = deps.getPreferApiKey();
  const codexConfigured = authStatus.codex.signedIn;
  const apikeyConfigured = authStatus.apikey.configured;

  if (!codexConfigured && !apikeyConfigured) {
    throw new OpenAIAuthRequiredError(modelInfo.value);
  }

  const modelAuthMode = modelInfo.openaiAuthMode ?? "any";
  const codexEligible = codexConfigured && modelAuthMode !== "apikey";
  const apikeyEligible = apikeyConfigured && modelAuthMode !== "codex";
  if (!codexEligible && !apikeyEligible) {
    throw new OpenAIAuthRequiredError(modelInfo.value);
  }

  let authMode: OpenAIBridgeAuthMode;
  if (preferApiKey && apikeyEligible) authMode = "apikey";
  else if (codexEligible) authMode = "codex";
  else authMode = "apikey";

  const endpoint = await deps.getBridge().ensureRunning(deps.panelId, authMode);
  const smallFastModel = SMALL_FAST_OPENAI_MODEL;
  log(
    '[OpenAIBridge] provisioned panelId=%s authMode=%s url=%s model=%s smallFast=%s',
    deps.panelId,
    authMode,
    endpoint.url,
    modelInfo.openaiModelId ?? modelInfo.value,
    smallFastModel,
  );
  return {
    url: endpoint.url,
    bearer: endpoint.bearer,
    authMode,
    openaiModelId: modelInfo.openaiModelId ?? modelInfo.value,
    smallFastModel,
  };
}

/** Family-alias targets for the SDK's tier-routed requests on OpenAI sessions. Haiku uses smallFastModel; subagent inherits active model. */
const OPUS_TIER_OPENAI_MODEL = "gpt-5.5";
const SONNET_TIER_OPENAI_MODEL = "gpt-5.4";

/**
 * Build the env-var record the SDK subprocess needs to route through the bridge.
 * Returns an empty object for Anthropic-backed models so the caller can spread
 * unconditionally without special-casing.
 */
export function buildOpenAIBridgeEnv(
  provisioning: OpenAIBridgeProvisioning | null,
  clientAppVersion: string,
): Record<string, string> {
  if (!provisioning) return {};
  return {
    ANTHROPIC_BASE_URL: provisioning.url,
    ANTHROPIC_AUTH_TOKEN: provisioning.bearer,
    ANTHROPIC_MODEL: provisioning.openaiModelId,
    ANTHROPIC_SMALL_FAST_MODEL: provisioning.smallFastModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: OPUS_TIER_OPENAI_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: SONNET_TIER_OPENAI_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: provisioning.smallFastModel,
    CLAUDE_CODE_SUBAGENT_MODEL: provisioning.openaiModelId,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: `damocles/${clientAppVersion}`,
  };
}

/**
 * Resolve the model identifier the SDK should send. For OpenAI-backed models, this
 * is the upstream `openaiModelId` (e.g. `gpt-5.5`) so the bridge can forward the
 * right model to Codex. The `[1m]` suffix is Anthropic-only — never appended for
 * OpenAI-backed models because GPT entries do not declare `alwaysUses1mContext`.
 */
export function resolveSdkModel(
  configuredModel: string,
  modelInfo: ModelInfo | undefined,
  has1mBeta: boolean,
): string {
  if (modelInfo?.backend === "openai") {
    return modelInfo.openaiModelId ?? configuredModel;
  }
  const alwaysOneM = !!modelInfo?.alwaysUses1mContext;
  return (has1mBeta || alwaysOneM) ? `${configuredModel}[1m]` : configuredModel;
}
