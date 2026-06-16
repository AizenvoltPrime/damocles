import type { Model, Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelInfo, EffortLevel } from '../../shared/types/settings';
import { DEFAULT_MODELS, DEFAULT_CONTEXT_WINDOW } from '../../shared/types/constants';
import { TOOL_READ, TOOL_GREP, TOOL_GLOB, TOOL_LS } from '../../shared/tool-names';
import { OPENAI_API_PROVIDER, OPENAI_CODEX_PROVIDER, type OpenAIAuthStatus } from './openai-auth';

/** Damocles effort levels → pi thinking levels. pi has no `max`/`ultracode`; both map to its top `xhigh`. */
const EFFORT_TO_PI_THINKING: Record<EffortLevel, ThinkingLevel> = {
  none: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
  ultracode: 'xhigh',
};

/** Resolve a Damocles thinking config to the pi thinking level to apply (clamped per-model by pi). */
export function effortToThinkingLevel(thinking: { thinkingDisabled: boolean; effort: EffortLevel | null }): ThinkingLevel {
  if (thinking.thinkingDisabled) return 'off';
  if (thinking.effort === null) return 'medium';
  return EFFORT_TO_PI_THINKING[thinking.effort];
}

/** pi built-in read-only tools enabled in Phase 1 (write/edit/bash wait for the US-004 gate). */
export const READ_ONLY_PI_TOOLS: string[] = ['read', 'grep', 'find', 'ls'];

/**
 * pi built-in tool name → Damocles tool display name. `find→Glob` is load-bearing: the webview's
 * tool card renderer keys off the Damocles names, not pi's.
 */
export const PI_TOOL_NAME_MAP: Record<string, string> = {
  read: TOOL_READ,
  grep: TOOL_GREP,
  find: TOOL_GLOB,
  ls: TOOL_LS,
};

/** Map a pi built-in tool name to its Damocles display name (identity for unknown names). */
export function mapPiToolName(name: string): string {
  return PI_TOOL_NAME_MAP[name] ?? name;
}

/** pi's canonical first-party Anthropic provider (api.anthropic.com), as opposed to gateway/reseller
 * providers (cloudflare-ai-gateway, opencode, bedrock, vertex, openrouter) that carry the same ids. */
const ANTHROPIC_PROVIDER = 'anthropic';

/** Minimal structural view of pi's ModelRegistry used for resolution (keeps this module test-friendly). */
export interface ModelLookup {
  find(provider: string, modelId: string): Model<Api> | undefined;
  hasConfiguredAuth(model: Model<Api>): boolean;
}

function isOpenAIProvider(provider: string): boolean {
  return provider === OPENAI_API_PROVIDER || provider === OPENAI_CODEX_PROVIDER;
}

/** The Damocles `DEFAULT_MODELS` entry whose display/pricing a given pi model should inherit. */
function defaultInfoForPiModel(model: Model<Api>): ModelInfo | undefined {
  if (isOpenAIProvider(model.provider)) {
    return DEFAULT_MODELS.find((m) => m.backend === 'openai' && (m.openaiModelId === model.id || m.value === model.id));
  }
  return DEFAULT_MODELS.find((m) => m.backend !== 'openai' && m.value === model.id);
}

/** Map a pi `Model` to a Damocles `ModelInfo`, reconciling display + pricing from `DEFAULT_MODELS`. */
export function piModelToModelInfo(model: Model<Api>): ModelInfo {
  const info = defaultInfoForPiModel(model);
  if (info) return info;
  return {
    value: model.id,
    displayName: model.name || model.id,
    description: '',
    contextWindow: model.contextWindow || DEFAULT_CONTEXT_WINDOW,
    ...(isOpenAIProvider(model.provider) ? { backend: 'openai' as const, openaiModelId: model.id } : {}),
  };
}

/** The model list the `sdk` harness serves: Anthropic-only (GPT runs only on pi). */
export function sdkAnthropicModels(): ModelInfo[] {
  return DEFAULT_MODELS.filter((m) => m.backend !== 'openai');
}

/**
 * The model list the `pi` harness serves: the curated Damocles catalog (`DEFAULT_MODELS`), same set
 * the SDK path showed. We deliberately do NOT surface pi's raw `getAvailable()` — that leaks every
 * gateway/reseller provider's duplicate of each model (and even unauthed ones, since pi's auth check
 * is loose), producing a junk dropdown. Resolution maps each curated value to its canonical provider.
 */
export function piSupportedModels(): ModelInfo[] {
  return DEFAULT_MODELS;
}

export interface ModelResolution {
  /** Resolved pi model under a supported canonical provider, when the catalog carries it. */
  model?: Model<Api>;
  /** Whether the resolved model's provider has configured auth (ready to use). */
  authed?: boolean;
  /** Set when the value is a GPT model and no configured OpenAI auth path serves it. */
  authRequired?: boolean;
}

/**
 * Resolve a Damocles model `value` to a pi `Model` under a SUPPORTED CANONICAL provider — never the
 * gateway/reseller duplicates (cloudflare-ai-gateway, opencode, bedrock, vertex, openrouter) that
 * carry the same ids without the user's auth. GPT values split across pi's two OpenAI providers:
 * Codex OAuth (`openai-codex`) wins by default when configured, unless `preferApiKey` is set AND an
 * API key is configured, in which case the `openai` (API-key) provider wins. Claude values resolve
 * against the first-party `anthropic` provider.
 */
export function resolvePiModel(
  value: string,
  registry: ModelLookup,
  openai: OpenAIAuthStatus,
  preferApiKey = false,
): ModelResolution {
  const info = DEFAULT_MODELS.find((m) => m.value === value);

  if (info?.backend === 'openai') {
    const id = info.openaiModelId ?? value;
    const codexModel = openai.codex ? registry.find(OPENAI_CODEX_PROVIDER, id) : undefined;
    const apiModel = registry.find(OPENAI_API_PROVIDER, id);

    const codexRes: ModelResolution | undefined = codexModel ? { model: codexModel, authed: true } : undefined;
    const apiRes: ModelResolution | undefined = apiModel
      ? (openai.apiKey ? { model: apiModel, authed: true } : { model: apiModel, authRequired: true })
      : undefined;

    // The toggle only takes effect when an API key actually exists; otherwise Codex OAuth keeps its
    // default precedence so the user is never routed to a credential they don't have.
    const ordered = preferApiKey && openai.apiKey ? [apiRes, codexRes] : [codexRes, apiRes];
    const authed = ordered.find((r) => r?.authed);
    if (authed) return authed;
    return apiRes ?? { authRequired: true };
  }

  const model = registry.find(ANTHROPIC_PROVIDER, value);
  if (!model) return {};
  return { model, authed: registry.hasConfiguredAuth(model) };
}
