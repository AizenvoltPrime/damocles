import type { CacheWarmingMode, EffortLevel, ModelInfo } from './settings';

/** Sentinel marking a block the HUMAN made at an approval prompt. The text after it is their reason. */
export const FEEDBACK_MARKER = "The user provided the following reason for the rejection:";

/**
 * Sentinel marking a block the RUNTIME made without asking the human — a settings permission rule,
 * plan mode, a read-only agent's toolset, or a configured PreToolUse hook.
 *
 * Deliberately separate from {@link FEEDBACK_MARKER}, whose wording ("the user provided...") is a
 * claim about the human. Reusing it for an automatic block tells the model the user refused something
 * the user was never asked about, and a model that believes it was overruled by a person stops and
 * asks instead of adapting to the constraint it actually hit. Both markers render the call as
 * "denied"; only the attribution differs.
 */
export const POLICY_BLOCK_MARKER = "Blocked by Damocles policy:";
export const DEFAULT_THINKING_TOKENS = 63999;

/**
 * Prompt-cache TTL (ms): idle gaps at or beyond this are worth mentioning as the likely cause of a
 * cache miss. Mirrors pi's `core/cache-stats.ts` CACHE_TTL_MS (Anthropic default 5-min prompt-cache
 * TTL). Single source of truth shared by the extension detector (`cache-stats.ts`) and the webview
 * notice (`CacheMissNotice.vue`) so the emit threshold and the display idle-hint can never diverge.
 */
export const CACHE_TTL_MS: number = 5 * 60 * 1000;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_FALLBACK_MODEL = "claude-opus-5";

/**
 * Ordered substitutes tried when a requested model does not resolve against pi's model registry.
 *
 * pi ships a bundled catalog and refreshes it from the network; a model released after the pinned pi
 * version is absent from the bundle, so a fresh install that is offline or has not refreshed yet cannot
 * resolve it. Without this, resolution walks {@link DEFAULT_MODELS} from the top — which is ordered by
 * capability, not price — and silently seats the user on a costlier model than they asked for. These
 * keep such a session on the closest comparable model instead.
 */
export const MODEL_SUBSTITUTES: Readonly<Record<string, readonly string[]>> = {
  "claude-opus-5": ["claude-opus-4-8"],
};

export const DEFAULT_MODELS: ModelInfo[] = [
  {
    value: "claude-fable-5-1",
    displayName: "Fable 5.1",
    description: "Anthropic's most capable model for the most demanding work",
    contextWindow: 1_000_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  },
  {
    value: "claude-opus-5",
    displayName: "Opus 5",
    description: "Most capable model for agentic work",
    contextWindow: 1_000_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  },
  {
    value: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "Most capable model for agentic work",
    contextWindow: 1_000_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  },
  {
    value: "claude-sonnet-5",
    displayName: "Sonnet 5",
    description: "Best balance of speed and capability",
    contextWindow: 1_000_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  },
  {
    value: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    description: "Fastest model",
    contextWindow: 200_000,
  },
  {
    value: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    description: "Most capable OpenAI model, superseding the GPT-5.6 line",
    contextWindow: 272_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    backend: "openai",
    openaiModelId: "gpt-6-astra",
    openaiAuthMode: "any",
    openaiReasoningEffort: "medium",
  },
  {
    value: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "Smartest GPT-5.6 model for the most demanding work",
    contextWindow: 272_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    backend: "openai",
    openaiModelId: "gpt-5.6-sol",
    openaiAuthMode: "any",
    openaiReasoningEffort: "medium",
  },
  {
    value: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    description: "Balanced GPT-5.6 model for everyday coding",
    contextWindow: 272_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    backend: "openai",
    openaiModelId: "gpt-5.6-terra",
    openaiAuthMode: "any",
    openaiReasoningEffort: "medium",
  },
  {
    value: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    description: "Fast, cost-efficient GPT-5.6 model",
    contextWindow: 272_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    backend: "openai",
    openaiModelId: "gpt-5.6-luna",
    openaiAuthMode: "any",
    openaiReasoningEffort: "medium",
  },
  {
    value: "step-3.7-flash",
    displayName: "Step 3.7 Flash",
    description: "StepFun reasoning model (step-plan subscription)",
    contextWindow: 256_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
    piProvider: "stepfun",
    flatFee: true,
  },
  {
    value: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    description: "DeepSeek's most capable reasoning model",
    contextWindow: 1_000_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['high', 'max'],
    piProvider: "deepseek",
  },
  {
    value: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    description: "Fast, cost-efficient DeepSeek reasoning model",
    contextWindow: 1_000_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['high', 'max'],
    piProvider: "deepseek",
  },
];

/**
 * Maps retired model ids to their successors, across every provider. Used to transparently migrate
 * stored `damocles.model` values (write-back at activation + read-mapping defense-in-depth).
 */
export const LEGACY_MODEL_MAP: Record<string, string> = {
  'gpt-5.5': 'gpt-5.6-sol',
  'gpt-5.3-codex': 'gpt-5.6-sol',
  'gpt-5.4': 'gpt-5.6-terra',
  'gpt-5.4-mini': 'gpt-5.6-luna',
  'gpt-5.2': 'gpt-5.6-luna',
  'claude-fable-5': 'claude-fable-5-1',
};

/** Returns the successor for a retired model id, or the value unchanged if not retired. */
export function migrateLegacyModelValue(value: string): string {
  // Own-property lookup guards against inherited keys ("toString", "constructor") resolving to
  // prototype members instead of a real mapping.
  const mapped = Object.hasOwn(LEGACY_MODEL_MAP, value) ? LEGACY_MODEL_MAP[value] : undefined;
  return mapped ?? value;
}

/**
 * Per-model effort-value renames driven by pi metadata changes. pi 0.80.6 renamed DeepSeek's
 * `thinkingLevelMap` top level from `xhigh → max` (deepseek.models.ts: `{"high":"high","max":"max"}`,
 * previously `{"high":"high","xhigh":"max"}`), so `xhigh` no longer exists for DeepSeek. A stored
 * `effortByModel: { "deepseek-v4-pro": "xhigh" }` would otherwise be coerced to null and silently
 * downgraded to `medium`, so it must be value-migrated to `max` (an upward rename, matching pi's own
 * direction) at activation. Keyed by model id → { oldLevel: newLevel }. Extend this as future pi
 * metadata renames land.
 */
export const LEGACY_EFFORT_VALUE_MAP: Record<string, Partial<Record<EffortLevel, EffortLevel>>> = {
  'deepseek-v4-pro': { xhigh: 'max' },
  'deepseek-v4-flash': { xhigh: 'max' },
};

/** The full `EffortLevel` union as a runtime array — the single source of truth for validating stored
 *  effort strings. `satisfies` keeps it in lockstep with the type (a new level fails to compile here). */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

/** The reasoning-effort levels a user can pick for a team role: the `EffortLevel` union minus `none`.
 *  No catalog model advertises `none` in `supportedEffortLevels`, so it would always coerce away — it is
 *  excluded from the team effort enums (drift-guarded by team-settings-contributions.test.ts). */
export const TEAM_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

/** Validate an arbitrary settings string as an `EffortLevel`, returning `null` for `''`/unknown values.
 *  Replaces unchecked `as EffortLevel` casts on raw config reads. */
export function parseEffortLevel(value: string): EffortLevel | null {
  return (EFFORT_LEVELS as readonly string[]).includes(value) ? (value as EffortLevel) : null;
}

/** The prompt-cache warming modes, in the order the settings UI offers them. `CacheWarmingMode` is
 *  derived from this tuple, so the union and the runtime list cannot drift. */
export const CACHE_WARMING_MODES: readonly ['off', 'streaming', 'idle'] = ['off', 'streaming', 'idle'];

/** pi coerces any out-of-enum cache-warming mode to `"streaming"`, so every extension-side fallback must
 *  be this value or the seed file on disk disagrees with what pi does. The package.json contribution
 *  default is the one copy outside TypeScript, pinned by cache-warming.test.ts. */
export const DEFAULT_CACHE_WARMING: CacheWarmingMode = 'streaming';

/** Validate an arbitrary stored or posted value as a `CacheWarmingMode`, falling back to the default.
 *  Replaces unchecked `as CacheWarmingMode` casts on config reads and webview input. */
export function parseCacheWarmingMode(value: unknown): CacheWarmingMode {
  return (CACHE_WARMING_MODES as readonly unknown[]).includes(value) ? (value as CacheWarmingMode) : DEFAULT_CACHE_WARMING;
}

/** The reasoning-effort levels the Explore-section selection advertises, resolved by the same catalog
 *  double-match the subagent resolver (`exploreThinkingLevel`) and the settings UI use: a `DEFAULT_MODELS`
 *  entry whose `value` is the effective model id AND whose `piProvider` is the Explore provider. Empty for
 *  providers/models with no catalog effort levels (OpenRouter/Gemini free-text ids, effort-less models).
 *  Single source of truth so the settings write path, the config broadcast, and the webview Select can
 *  never advertise different levels. */
export function exploreSupportedEffortLevels(provider: string, modelValue: string): readonly EffortLevel[] {
  return DEFAULT_MODELS.find((m) => m.value === modelValue && m.piProvider === provider)?.supportedEffortLevels ?? [];
}

/** Apply a model's pi-metadata effort rename (e.g. DeepSeek `xhigh → max` in pi 0.80.6) to a stored
 *  effort. Returns the effort unchanged when the model has no rename or the value is not renamed. Mirrors
 *  the write-back migration in `migrateLegacyModelSetting` as read-side defense-in-depth for team slots. */
export function migrateLegacyEffortValue(model: string, effort: EffortLevel): EffortLevel {
  const renames = Object.hasOwn(LEGACY_EFFORT_VALUE_MAP, model) ? LEGACY_EFFORT_VALUE_MAP[model] : undefined;
  return renames?.[effort] ?? effort;
}
