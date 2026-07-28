import type { Model, Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelInfo, EffortLevel } from '../../shared/types/settings';
import { DEFAULT_MODELS, DEFAULT_CONTEXT_WINDOW } from '../../shared/types/constants';
import { TOOL_ENTER_PLAN_MODE } from '../../shared/tool-names';
import { TEAM_MAIN_PI_TOOL_NAMES } from './tools/team-tools';
import { OPENAI_API_PROVIDER, OPENAI_CODEX_PROVIDER, type OpenAIAuthStatus } from './openai-auth';

export { mapPiToolName, PI_TOOL_NAME_MAP, normalizeToolInput, toolCategory } from './tool-normalization';

/**
 * The small/fast model values (Damocles `DEFAULT_MODELS` entries) for internal LLM sub-calls — a
 * Haiku-class model on Anthropic, GPT-5.6 Luna on OpenAI. Both resolve through
 * `resolvePiModel` to their canonical provider.
 */
export const PI_SMALL_FAST_ANTHROPIC = 'claude-haiku-4-5-20251001';
export const PI_SMALL_FAST_OPENAI = 'gpt-5.6-luna';

/**
 * Damocles effort levels → pi thinking levels. pi gained a native `max` level in 0.80.6 (above
 * `xhigh`), so `max` now passes through directly. `ultracode` is Damocles' own top tier with no pi
 * analogue, so it maps to pi's highest (`max`). pi clamps per-model (`clampThinkingLevel`), so a model
 * without native `max` support (e.g. Haiku) degrades gracefully to its top level — never an error.
 */
const EFFORT_TO_PI_THINKING: Record<EffortLevel, ThinkingLevel> = {
  none: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultracode: 'max',
};

/** Map a Damocles effort level directly to its pi thinking level (clamped per-model by pi at runtime).
 *  Thin accessor over the module-private `EFFORT_TO_PI_THINKING` for the team role resolver. */
export function effortToPiThinking(effort: EffortLevel): ThinkingLevel {
  return EFFORT_TO_PI_THINKING[effort];
}

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
 * Tools REMOVED from the active set while plan mode is active.
 *
 * This list is deliberately an EXCLUSION list, not an inclusion allowlist. An inclusion list makes every
 * new tool subsystem silently invisible while planning until someone remembers to add it — that bug has
 * shipped three times (MCP, memory, browser; see CHANGELOG). Stating what plan mode BLOCKS means a new
 * subsystem is available by default and only a deliberate decision removes it.
 *
 * HOW MUCH THE GATE BACKS THIS UP DEPENDS ON THE TOOL — do not read "defense in depth" as universal:
 *
 *  - Damocles-native write/shell (`Edit`, `write`, `bash`, `PowerShell`) ARE independently enforced.
 *    `runPermissionGate` blocks a non-plan-file Edit/Write and classifies every shell command whenever
 *    `isPlanMode()` is true, whatever this list contains. For these, the active set is genuinely a
 *    second layer and the bar for exclusion is "calling this while planning is always wrong".
 *
 *  - Gateable MODULE tools (memory, compass, browser, team — `GATEABLE_MODULE_NAMES`) are NOT. Their
 *    branch in `runPermissionGate` returns BEFORE the plan-mode branch, so it auto-allows them in every
 *    mode; only a settings deny rule stops one. For these THIS LIST IS THE ONLY PLAN-MODE CONTROL, so an
 *    entry added here is a security decision, not a UX one. Anything added to `GATEABLE_MODULE_NAMES` in
 *    future must be evaluated against that fact rather than assumed to be gate-checked.
 *
 * The browser tools are deliberately left ACTIVE. That is an accepted risk, not an oversight: plan mode
 * already permits side effects outside the workspace (every enabled MCP tool stays available, including
 * mutating ones), so its guarantee is "no unapproved workspace writes and no unapproved shell", not "no
 * side effects anywhere". `BrowserEvaluate`, `BrowserUpload` and `BrowserIntercept` are the sharp edges
 * — arbitrary main-world JS against a live logged-in profile, an arbitrary local path to a remote
 * origin, and context-wide interception that reaches the human's own tabs. They are governed by the
 * browser master switch (`damocles.browser.enabled`, off by default) and by settings deny rules, not by
 * plan mode.
 */
export const PLAN_MODE_EXCLUDED_TOOLS: readonly string[] = [
  // Already in plan mode — calling it again is a no-op that wastes a turn.
  TOOL_ENTER_PLAN_MODE,
  // `create_team` starts a multi-agent run that writes code; the plan-mode directive tells the model to
  // spawn teams per slice AFTER the plan is approved. `get_team_status`/`cancel_team` are harmless on
  // their own, but the whole subsystem is already absent from plan mode and this keeps that behavior —
  // relaxing it is a separate decision, made on its own merits.
  ...TEAM_MAIN_PI_TOOL_NAMES,
];

/** pi's canonical first-party Anthropic provider (api.anthropic.com), as opposed to gateway/reseller
 * providers (cloudflare-ai-gateway, opencode, bedrock, vertex, openrouter) that carry the same ids. */
const ANTHROPIC_PROVIDER = 'anthropic';

/** Minimal structural view of pi's ModelRuntime used for resolution (keeps this module test-friendly).
 *  `ModelRuntime` satisfies this interface structurally — no adapter. */
export interface ModelLookup {
  getModel(provider: string, modelId: string): Model<Api> | undefined;
  hasConfiguredAuth(providerId: string): boolean;
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
    const codexModel = openai.codex ? registry.getModel(OPENAI_CODEX_PROVIDER, id) : undefined;
    const apiModel = registry.getModel(OPENAI_API_PROVIDER, id);

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
    const model = registry.getModel(info.piProvider, info.value);
    if (!model) return {};                                            // StepFun pre-key: not registered yet
    return { model, authed: registry.hasConfiguredAuth(model.provider) }; // DeepSeek pre-key: authed=false
  }

  const model = registry.getModel(ANTHROPIC_PROVIDER, value);
  if (!model) return {};
  return { model, authed: registry.hasConfiguredAuth(model.provider) };
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
