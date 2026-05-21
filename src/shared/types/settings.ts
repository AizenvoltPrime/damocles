export type PermissionMode = "default" | "acceptEdits" | "auto" | "plan";

export type ContextStrategy = "default" | "recall";

export type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SandboxConfig {
  enabled: boolean;
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: boolean;
  networkAllowedDomains?: string[];
  networkAllowLocalBinding?: boolean;
}

export interface AutoCompactConfig {
  enabled: boolean;
  warningThreshold: number;
  softThreshold: number;
  hardThreshold: number;
}

export type ContextWarningLevel = 'none' | 'warning' | 'soft' | 'critical';

export interface ProviderProfile {
  name: string;
  env: Record<string, string>;
}

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
  fastMode: boolean;
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

export type FastModeState = 'off' | 'cooldown' | 'on';

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  contextWindow?: number;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
  supports1MContext?: boolean;
  alwaysUses1mContext?: boolean;
  /** Backend dispatcher. Omitted defaults to "anthropic" for backwards compatibility. */
  backend?: "anthropic" | "openai";
  /** Literal model ID sent in the Codex request body; may differ from `value`. */
  openaiModelId?: string;
  /** Gates which auth path supports this model. */
  openaiAuthMode?: "codex" | "apikey" | "any";
  /** Maps to Codex `reasoning.effort`. */
  openaiReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
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
