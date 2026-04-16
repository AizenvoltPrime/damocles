import type { ModelInfo } from './settings';

export const FEEDBACK_MARKER = "The user provided the following reason for the rejection:";
export const DEFAULT_THINKING_TOKENS = 63999;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_FALLBACK_MODEL = "claude-opus-4-7";

export const DEFAULT_MODELS: ModelInfo[] = [
  {
    value: "claude-opus-4-7",
    displayName: "Opus 4.7",
    description: "Most capable model for agentic work",
    contextWindow: 1_000_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
    supportsAutoMode: true,
    alwaysUses1mContext: true,
  },
  {
    value: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "Most capable model with adaptive thinking",
    contextWindow: 200_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
    supportsFastMode: true,
    supports1MContext: true,
    supportsAutoMode: true,
  },
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Best balance of speed and capability",
    contextWindow: 200_000,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "claude-opus-4-5-20251101",
    displayName: "Opus 4.5",
    description: "Most capable model",
    contextWindow: 200_000,
  },
  {
    value: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    description: "Fastest model",
    contextWindow: 200_000,
  },
];
