import type * as vscode from "vscode";
import { DEFAULT_MODELS } from "../../shared/types/constants";
import type { AccountInfo, ModelInfo } from "../../shared/types/settings";
import { log } from "../logger";
import { resolveAuth } from "./openai-auth";
import { extractCodexJwtClaims } from "./codex-oauth";

const FETCH_TIMEOUT_MS = 8_000;

export interface OpenAIAccountQuery {
  context: vscode.ExtensionContext;
  modelInfo: ModelInfo | undefined;
  preferApiKey: boolean;
}

/**
 * Resolve real account metadata for an OpenAI-backed session.
 *
 *   - Codex OAuth: derives plan + email from the JWT claims (`chatgpt_plan_type`,
 *     `email`). Returns a `subscriptionType` mapped from the plan tier.
 *   - API key: tries `api.openai.com/v1/organizations`, falls back to `/v1/me`
 *     on 404. Returns `{ apiKeySource: "openai-platform" }` either way.
 *
 * The selection order honors the panel-level model auth-mode restriction and the
 * `preferApiKey` toggle. Network failures degrade to a minimal stub so the UI
 * still renders a sign-in indicator.
 */
export async function resolveOpenAIAccountInfo(args: OpenAIAccountQuery): Promise<AccountInfo> {
  const { context, modelInfo, preferApiKey } = args;
  const modelAuthMode = modelInfo?.openaiAuthMode ?? "any";
  const apikeyEligible = modelAuthMode !== "codex";
  const codexEligible = modelAuthMode !== "apikey";

  if (preferApiKey && apikeyEligible) {
    const apikey = await resolveAuth("apikey", context);
    if (apikey) return await fetchOpenAIApiKeyAccount(apikey.token);
  }
  if (codexEligible) {
    const codex = await resolveAuth("codex", context);
    if (codex) return fetchCodexAccount(codex.token);
  }
  if (apikeyEligible) {
    const apikey = await resolveAuth("apikey", context);
    if (apikey) return await fetchOpenAIApiKeyAccount(apikey.token);
  }
  return { subscriptionType: "unknown" };
}

export function fetchCodexAccount(accessToken: string): AccountInfo {
  const claims = extractCodexJwtClaims(accessToken);
  const planType = claims?.chatgpt_plan_type?.toLowerCase() ?? "";
  const subscriptionType = planType.includes("pro") ? "chatgpt-pro"
    : planType.includes("plus") ? "chatgpt-plus"
    : planType.includes("team") ? "chatgpt-team"
    : planType.includes("enterprise") ? "chatgpt-enterprise"
    : "unknown";
  const result: AccountInfo = { subscriptionType, tokenSource: "codex-oauth" };
  if (claims?.email) result.email = claims.email;
  log(
    "[OpenAIAccount] fetchCodexAccount: JWT claims email=%s plan=%s",
    claims?.email ? "<present>" : "<absent>",
    claims?.chatgpt_plan_type ?? "<absent>",
  );
  return result;
}

export async function fetchOpenAIApiKeyAccount(apiKey: string): Promise<AccountInfo> {
  const headers = { "Authorization": `Bearer ${apiKey}` };
  const fallback: AccountInfo = {
    subscriptionType: "openai-apikey",
    apiKeySource: "openai-platform",
  };
  const tryEndpoint = async (url: string): Promise<Response | null> => {
    try {
      return await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      log("[OpenAIAccount] fetchOpenAIApiKeyAccount: network error against %s: %O", url, err);
      return null;
    }
  };

  let res = await tryEndpoint("https://api.openai.com/v1/organizations");
  if (res && res.status === 404) {
    log("[OpenAIAccount] fetchOpenAIApiKeyAccount: /organizations returned 404, falling back to /me");
    res = await tryEndpoint("https://api.openai.com/v1/me");
  }
  if (!res || !res.ok) {
    log("[OpenAIAccount] fetchOpenAIApiKeyAccount: falling back to apikey stub (status=%s)", res?.status ?? "no-response");
    return fallback;
  }
  try {
    const json = (await res.json()) as Record<string, unknown>;
    const data = Array.isArray(json["data"]) ? (json["data"] as Array<Record<string, unknown>>)[0] : null;
    const orgName = data && typeof data["title"] === "string" ? (data["title"] as string)
      : data && typeof data["name"] === "string" ? (data["name"] as string)
      : typeof json["organization"] === "string" ? (json["organization"] as string)
      : undefined;
    const email = typeof json["email"] === "string" ? (json["email"] as string) : undefined;
    const result: AccountInfo = {
      subscriptionType: "openai-apikey",
      apiKeySource: "openai-platform",
    };
    if (orgName) result.organization = orgName;
    if (email) result.email = email;
    return result;
  } catch (err) {
    log("[OpenAIAccount] fetchOpenAIApiKeyAccount: JSON parse failed: %O", err);
    return fallback;
  }
}

/**
 * Build the supported-models list when an OpenAI bridge is active. The SDK's
 * `result.supportedModels()` is Anthropic-only — calling it on a Codex-bound
 * subprocess returns Claude IDs that the bridge would reject.
 *
 *   - API-key path: queries `api.openai.com/v1/models`, filters to GPT-* and
 *     o-series, merges with the static GPT subset of DEFAULT_MODELS (dedup by
 *     `value`) so locally-known capability flags survive even when the API
 *     omits a model.
 *   - Codex path: returns the static GPT subset of DEFAULT_MODELS — Codex
 *     exposes no `/models` endpoint, so reading from the catalog avoids a
 *     misleading empty dropdown.
 */
export async function resolveOpenAISupportedModels(args: OpenAIAccountQuery): Promise<ModelInfo[]> {
  const gptCatalog = DEFAULT_MODELS.filter(m => m.backend === "openai");
  const { context, modelInfo, preferApiKey } = args;

  const modelAuthMode = modelInfo?.openaiAuthMode ?? "any";
  const apikeyEligible = modelAuthMode !== "codex";
  let apikey: Awaited<ReturnType<typeof resolveAuth>> = null;
  if (apikeyEligible && (preferApiKey || modelAuthMode === "apikey")) {
    apikey = await resolveAuth("apikey", context);
  }
  if (!apikey) {
    return gptCatalog;
  }

  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apikey.token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log("[OpenAIAccount] /v1/models returned status=%s — using catalog only", res.status);
      return gptCatalog;
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const remoteIds = (json.data ?? [])
      .map(m => m.id)
      .filter((id): id is string => typeof id === "string" && (id.startsWith("gpt-") || /^o\d/.test(id)));

    const remoteModels: ModelInfo[] = remoteIds.map(id => ({
      value: id,
      displayName: id,
      description: "OpenAI model (live catalog)",
      backend: "openai" as const,
      openaiModelId: id,
      openaiAuthMode: "any" as const,
    }));
    const merged = new Map<string, ModelInfo>();
    for (const m of remoteModels) merged.set(m.value, m);
    for (const m of gptCatalog) merged.set(m.value, { ...merged.get(m.value), ...m });
    return [...merged.values()];
  } catch (err) {
    log("[OpenAIAccount] /v1/models fetch failed: %O", err);
    return gptCatalog;
  }
}
