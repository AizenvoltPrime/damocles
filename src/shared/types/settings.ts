import type { CACHE_WARMING_MODES } from "./constants";

export type PermissionMode = "default" | "acceptEdits" | "plan";

export type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

/** Selects which role slot a spawned specialist runs under (set by the lead on spawn): `implementor` or
 *  `reviewer` role settings (model + reasoning effort). */
export type SpecialistKind = "implementor" | "reviewer";

/** A team role whose model/effort the user configures: the lead plus the two specialist kinds. The
 *  single source of truth for this union — re-exported by the extension resolver and the webview so the
 *  role identifiers never drift across the message boundary. */
export type TeamRole = "lead" | SpecialistKind;

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
  /** Per-model budgets keyed by `DEFAULT_MODELS[].value`, the same key `damocles.model` uses. */
  modelOverrides?: Record<string, { triggerPercent?: number; keepRecentPercent?: number }>;
}

/** Derived from the runtime tuple so a mode added to one is a compile error in the other. */
export type CacheWarmingMode = (typeof CACHE_WARMING_MODES)[number];

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
  cacheWarming: CacheWarmingMode;
  /** `damocles.checkpoints.retentionDays`; 0 keeps checkpoints forever. */
  checkpointRetentionDays: number;
  dangerouslySkipPermissions: boolean;
  /** Workspace default seeded into each new panel's YOLO state; per-panel toggle overrides it. */
  defaultDangerouslySkipPermissions: boolean;
  /** When false, the IDE opened-file/selection context chip starts disabled in new panels. */
  ideContextEnabled: boolean;
  pinnedHeaderHidden: boolean;
  team: TeamRoleSettings;
}

/** One OpenRouter image model from pi's image catalog. */
export interface ImageModelOption {
  id: string;
  name: string;
}

/** The image generation section: `damocles.imageGeneration.enabled` and `.model`, the catalog, and OpenRouter auth. */
export interface ImageGenerationSettings {
  enabled: boolean;
  /** "" when none is chosen. */
  model: string;
  imageModels: ImageModelOption[];
  /** pi's `hasConfiguredAuth('openrouter')`, the same check the tool's eligibility uses. */
  openRouterConfigured: boolean;
}

/**
 * Per-role model + reasoning-effort overrides for agent teams.
 * An empty-string model means "use the active panel model"; a null effort
 * means "use the model default". Persisted to the six `damocles.team.*` keys.
 */
export interface TeamRoleSettings {
  leadModel: string;
  leadEffort: EffortLevel | null;
  implementorModel: string;
  implementorEffort: EffortLevel | null;
  reviewerModel: string;
  reviewerEffort: EffortLevel | null;
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
  /** Effort applied when the user has set none for this model. Unset models fall through to pi's own
   *  default. Must be a member of `supportedEffortLevels`. */
  defaultEffort?: EffortLevel;
  /** pi thinks on this model whatever level is requested, so the disable-thinking control is a no-op.
   *  True exactly when pi's metadata has `compat.supportsMidConvoEffort` or `thinkingLevelMap.off: null`
   *  in every catalog serving the model (drift-guarded by pi-models.test.ts). */
  thinkingAlwaysOn?: boolean;
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
  organization?: string;
  model?: string;
  /** False on a flat subscription, where a rendered dollar cost is an estimate rather than a charge. */
  dollarBilled: boolean;
}

/** A provider that serves the Jev classifier. */
export type ClassifierProvider = "typesafe" | "openrouter";

/** Why a classifier provider's credential was refused: HTTP 401, 402 or 403. */
export type ClassifierRejection = "unauthorized" | "payment-required" | "forbidden";

/**
 * The model the memory contradiction judge and reranks run on. `model` is `<provider>/<id>`. `unknown`: no
 * classifier key, and the sub-call model is resolved only once a chat has started pi.
 */
export type MemoryJudge = (
  | { kind: "jev"; via: ClassifierProvider }
  | { kind: "model"; model: string }
  | { kind: "none" }
  | { kind: "unknown" }
) & {
  /** Configured classifier providers the judges skip because their credential was refused. */
  rejected?: { via: ClassifierProvider; reason: ClassifierRejection }[];
};

export interface BudgetWarningInfo {
  currentSpend: number;
  limit: number;
  percentUsed: number;
}
