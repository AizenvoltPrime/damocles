import type { Model, Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelInfo, EffortLevel } from '../../shared/types/settings';
import { DEFAULT_MODELS, DEFAULT_CONTEXT_WINDOW } from '../../shared/types/constants';
import {
  TOOL_ASK_USER_QUESTION,
  TOOL_TASK_CREATE,
  TOOL_TASK_UPDATE,
  TOOL_TASK_LIST,
  TOOL_TASK_GET,
  TOOL_EXIT_PLAN_MODE,
  TOOL_AGENT,
  TOOL_GET_SUBAGENT_RESULT,
  TOOL_STEER_SUBAGENT,
  TOOL_EDIT,
} from '../../shared/tool-names';
import { OPENAI_API_PROVIDER, OPENAI_CODEX_PROVIDER, type OpenAIAuthStatus } from './openai-auth';

export { mapPiToolName, PI_TOOL_NAME_MAP, normalizeToolInput, toolCategory } from './tool-normalization';

/**
 * The small/fast model values (Damocles `DEFAULT_MODELS` entries) for internal LLM sub-calls — a
 * Haiku-class model on Anthropic, a mini-class model on OpenAI (US-006b). Both resolve through
 * `resolvePiModel` to their canonical provider.
 */
export const PI_SMALL_FAST_ANTHROPIC = 'claude-haiku-4-5-20251001';
export const PI_SMALL_FAST_OPENAI = 'gpt-5.4-mini';

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

/**
 * pi built-in tools active on the Phase-2 surface. `edit` is deliberately ABSENT — it is replaced by
 * the Damocles custom `Edit` (CC `file_path/old_string/new_string` shape) and excluded via
 * `PI_EXCLUDED_TOOLS`. `grep`/`find`/`ls` MUST be listed explicitly because pi's default active set is
 * only `read/bash/edit/write`.
 */
export const PI_NATIVE_ACTIVE_TOOLS: readonly string[] = ['read', 'bash', 'write', 'grep', 'find', 'ls'];

/** pi built-ins to exclude from the active set (its native `edit` is replaced by the custom `Edit`). */
export const PI_EXCLUDED_TOOLS: readonly string[] = ['edit'];

/**
 * The native web tool names (Phase 7). Re-exported from the web-access module (single source of truth)
 * and added to the active set when `damocles.pi.webSearch.enabled` is on — built per-session like the
 * other module tools, so the live toggle is a next-turn active-set change with no install/reload.
 */
export { WEB_PI_TOOL_NAMES as WEB_TOOLS } from './web-access';

/**
 * The read-only pi tools allowed while plan mode is active (US-017). The always-allowed interactive
 * tools (AskUserQuestion / Task* list management) and `ExitPlanMode` are appended by the caller from the
 * custom tool set so the model can still plan, track tasks, answer questions, and exit. The web tools
 * are read-only, so they stay usable in plan mode too.
 */
export const PLAN_MODE_READONLY_PI_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls', 'WebSearch', 'WebFetch', 'CodeSearch'];

/**
 * The interactive custom tools that stay active in plan mode (task-list management + question) + Exit,
 * plus the subagent tools so the planner can still spawn read-only Explore/Plan agents while planning
 * (their own nested write/shell calls are blocked by the gate's plan-mode defense).
 */
export const PLAN_MODE_INTERACTIVE_TOOLS: readonly string[] = [
  TOOL_ASK_USER_QUESTION,
  TOOL_TASK_CREATE,
  TOOL_TASK_UPDATE,
  TOOL_TASK_LIST,
  TOOL_TASK_GET,
  TOOL_EXIT_PLAN_MODE,
  TOOL_AGENT,
  TOOL_GET_SUBAGENT_RESULT,
  TOOL_STEER_SUBAGENT,
];

/**
 * Write tools kept ACTIVE in plan mode so the model can maintain its plan file (US-002). They are
 * available, but the permission gate allows them ONLY when the target is the plan file
 * (`isPlanFilePath`) — every other Edit/Write is blocked by the gate's plan-mode defense. These are
 * ACTIVE-SET names: the custom `Edit` (`TOOL_EDIT`) and pi-native `write` (from `PI_NATIVE_ACTIVE_TOOLS`,
 * which the gate normalizes to `TOOL_WRITE` when deciding) — not the normalized `TOOL_WRITE`.
 */
export const PLAN_MODE_PLAN_FILE_TOOLS: readonly string[] = [TOOL_EDIT, 'write'];

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
  return DEFAULT_MODELS.filter((m) => m.backend !== 'openai' && !m.piProvider);
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

  if (info?.piProvider) {
    const model = registry.find(info.piProvider, info.value);
    if (!model) return {};                                   // StepFun pre-key: not registered yet
    return { model, authed: registry.hasConfiguredAuth(model) }; // DeepSeek pre-key: authed=false
  }

  const model = registry.find(ANTHROPIC_PROVIDER, value);
  if (!model) return {};
  return { model, authed: registry.hasConfiguredAuth(model) };
}

/** The human-readable provider name for an unauthed sign-in toast. */
export function providerDisplayName(info?: ModelInfo): string {
  if (info?.backend === 'openai') return 'OpenAI';
  if (info?.piProvider === 'stepfun') return 'StepFun';
  if (info?.piProvider === 'deepseek') return 'DeepSeek';
  return 'Anthropic';
}

/**
 * Whether the active model's credential is dollar-metered (so `maxBudgetUsd` enforcement applies), as
 * opposed to a flat subscription with no per-call dollar cost. piProvider models (StepFun/DeepSeek)
 * report their provider id as `apiKeySource`, not a first-party label, so they're classified from the
 * catalog: metered unless `flatFee` (StepFun). First-party models fall back to the credential label.
 */
export function isDollarBilled(info: ModelInfo | undefined, apiKeySource: string): boolean {
  if (info?.piProvider) return !info.flatFee;
  return apiKeySource === 'apikey' || apiKeySource === 'extra' || apiKeySource === 'openai-api-key';
}
