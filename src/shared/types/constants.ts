import type { EffortLevel, ModelInfo } from './settings';

export const FEEDBACK_MARKER = "The user provided the following reason for the rejection:";
export const DEFAULT_THINKING_TOKENS = 63999;

/**
 * Prompt-cache TTL (ms): idle gaps at or beyond this are worth mentioning as the likely cause of a
 * cache miss. Mirrors pi's `core/cache-stats.ts` CACHE_TTL_MS (Anthropic default 5-min prompt-cache
 * TTL). Single source of truth shared by the extension detector (`cache-stats.ts`) and the webview
 * notice (`CacheMissNotice.vue`) so the emit threshold and the display idle-hint can never diverge.
 */
export const CACHE_TTL_MS: number = 5 * 60 * 1000;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_FALLBACK_MODEL = "claude-opus-4-8";

export const DEFAULT_MODELS: ModelInfo[] = [
  {
    value: "claude-fable-5",
    displayName: "Fable 5",
    description: "Anthropic's most capable model for the most demanding work",
    contextWindow: 1_000_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    alwaysUses1mContext: true,
  },
  {
    value: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "Most capable model for agentic work",
    contextWindow: 1_000_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    alwaysUses1mContext: true,
  },
  {
    value: "claude-sonnet-5",
    displayName: "Sonnet 5",
    description: "Best balance of speed and capability",
    contextWindow: 1_000_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    alwaysUses1mContext: true,
  },
  {
    value: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    description: "Fastest model",
    contextWindow: 200_000,
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
 * Maps retired GPT model ids to their GPT-5.6 successors. Used to transparently migrate stored
 * `damocles.model` values (write-back at activation + read-mapping defense-in-depth).
 */
export const LEGACY_MODEL_MAP: Record<string, string> = {
  'gpt-5.5': 'gpt-5.6-sol',
  'gpt-5.3-codex': 'gpt-5.6-sol',
  'gpt-5.4': 'gpt-5.6-terra',
  'gpt-5.4-mini': 'gpt-5.6-luna',
  'gpt-5.2': 'gpt-5.6-luna',
};

/** Returns the GPT-5.6 successor for a legacy model id, or the value unchanged if not legacy. */
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
