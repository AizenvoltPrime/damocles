export type PermissionMode = "default" | "acceptEdits" | "plan";

export type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

export interface SandboxConfig {
  enabled: boolean;
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: boolean;
  networkAllowedDomains?: string[];
  networkAllowLocalBinding?: boolean;
}

export interface AutoCompactConfig {
  enabled: boolean;
  /** Compact when context usage crosses this percentage of the window (maps to pi's reserveTokens). */
  triggerPercent: number;
}

export type ContextWarningLevel = 'none' | 'warning' | 'soft' | 'critical';

export interface SessionSettings {
  model?: string;
  permissionMode: PermissionMode;
  maxThinkingTokens?: number | null;
}

export interface ExtensionSettings {
  maxTurns: number;
  maxBudgetUsd: number | null;
  taskBudget: number | null;
  permissionMode: PermissionMode;
  defaultPermissionMode: PermissionMode;
  enableFileCheckpointing: boolean;
  sandbox: SandboxConfig;
  autoCompact: AutoCompactConfig;
  dangerouslySkipPermissions: boolean;
  /** Workspace default seeded into each new panel's YOLO state; per-panel toggle overrides it. */
  defaultDangerouslySkipPermissions: boolean;
  /** When false, the IDE opened-file/selection context chip starts disabled in new panels. */
  ideContextEnabled: boolean;
  pinnedHeaderHidden: boolean;
  worktreeBaseRef: 'fresh' | 'head';
}

/**
 * Resolved thinking-control values. Carries one snapshot for the panel's
 * active model and a separate snapshot for the workspace defaults' model —
 * the two are broadcast together via `panelThinkingUpdate` and labeled with
 * `panelModel` / `defaultsModel`.
 *
 * Field scoping:
 * - `effort` is **model-scoped** — the value belongs to a specific model and
 *   is only meaningful when read alongside the matching model identifier.
 * - `maxThinkingTokens` is **model-scoped** in the per-panel matrix but the
 *   workspace default `damocles.maxThinkingTokens` is a single value shared
 *   across models; both expressions surface through this field.
 * - `thinkingDisabled` is **model-agnostic** — a single boolean per panel /
 *   per workspace, never keyed by model.
 */
export interface PanelThinkingState {
  thinkingDisabled: boolean;
  effort: EffortLevel | null;
  maxThinkingTokens: number | null;
}

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  contextWindow?: number;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
  alwaysUses1mContext?: boolean;
  /** Backend dispatcher. Omitted defaults to "anthropic" for backwards compatibility. */
  backend?: "anthropic" | "openai";
  /** Literal model ID sent in the Codex request body; may differ from `value`. */
  openaiModelId?: string;
  /** Gates which auth path supports this model. */
  openaiAuthMode?: "codex" | "apikey" | "any";
  /** Maps to Codex `reasoning.effort`. */
  openaiReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  /** Canonical pi provider for catalog models that are neither first-party Anthropic nor OpenAI.
   *  When set, resolution routes via registry.find(piProvider, value); `backend` stays unset so the
   *  non-OpenAI reasoning UI path is used. A closed union so a typo can't silently fall through to the
   *  Anthropic resolution branch. */
  piProvider?: "stepfun" | "deepseek";
  /** True when the provider bills a flat subscription (no per-token dollar cost), so dollar-budget
   *  enforcement does not apply. Set for StepFun; unset (metered) for DeepSeek. */
  flatFee?: boolean;
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  apiKeySource?: string;
  /** OpenAI auth path source label, e.g. "codex-oauth". Unset for Anthropic. */
  tokenSource?: string;
  model?: string;
}

export interface BudgetWarningInfo {
  currentSpend: number;
  limit: number;
  percentUsed: number;
}
