import type { ASSET_SOURCE_PRECEDENCES, CACHE_WARMING_MODES } from "./constants";
import type { ModelVendor } from "../model-vendor";
import type { AccountProviderId } from "../settings-sections";

export const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

/** Selects which role slot a spawned specialist runs under (set by the lead on spawn): `implementor` or
 *  `reviewer` role settings (model + reasoning effort). */
export type SpecialistKind = "implementor" | "reviewer";

/** A team role whose model/effort the user configures: the lead plus the two specialist kinds. The
 *  single source of truth for this union — re-exported by the extension resolver and the webview so the
 *  role identifiers never drift across the message boundary. */
export type TeamRole = "lead" | SpecialistKind;

export interface AutoCompactConfig {
  enabled: boolean;
  /** Compact when context usage crosses this percentage of the window (maps to pi's reserveTokens). */
  triggerPercent: number;
  /** Per-model budgets keyed by `DEFAULT_MODELS[].value`, the same key `damocles.model` uses. */
  modelOverrides?: Record<string, { triggerPercent?: number; keepRecentPercent?: number }>;
}

/** Derived from the runtime tuple so a mode added to one is a compile error in the other. */
export type CacheWarmingMode = (typeof CACHE_WARMING_MODES)[number];

/** Which compat asset source wins on a name collision between equivalently-shaped Claude and Codex assets. */
export type AssetSourcePrecedence = (typeof ASSET_SOURCE_PRECEDENCES)[number];

export type ContextWarningLevel = 'none' | 'warning' | 'soft' | 'critical';

export interface SessionSettings {
  model?: string;
  permissionMode: PermissionMode;
}

export interface ExtensionSettings {
  maxBudgetUsd: number | null;
  taskBudget: number | null;
  permissionMode: PermissionMode;
  defaultPermissionMode: PermissionMode;
  autoCompact: AutoCompactConfig;
  /** `damocles.subagents.maxConcurrent`, read for the chat's folder. */
  subagentsMaxConcurrent: number;
  /** `damocles.showCacheMissNotices`, read for the chat's folder. */
  showCacheMissNotices: boolean;
  /** `damocles.showThinkingDroppedNotices`, read for the chat's folder. */
  showThinkingDroppedNotices: boolean;
  assetSourcePrecedence: AssetSourcePrecedence;
  /** `damocles.memory.autoExtract.enabled` */
  memoryAutoExtract: boolean;
  /** `damocles.memory.profile.enabled` */
  memoryProfile: boolean;
  /** `damocles.browser.headless` */
  browserHeadless: boolean;
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
  background: BackgroundSettings;
  judge: MemoryJudgeSettings;
  explore: ExploreSettings;
}

/** `damocles.background.*`: `model` '' is Automatic, `effort` null is Per job. */
export interface BackgroundSettings {
  model: string;
  effort: EffortLevel | null;
}

/** `damocles.memory.judge*`: `choice` '' is Automatic, else a classifier choice or a catalog model; `effort` null is Per job. */
export interface MemoryJudgeSettings {
  choice: string;
  effort: EffortLevel | null;
}

/** `damocles.explore.*`: `model` '' is Default (the chat's small model), `effort` null is medium. */
export interface ExploreSettings {
  model: string;
  effort: EffortLevel | null;
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
 * - `thinkingDisabled` is **model-agnostic** — a single boolean per panel /
 *   per workspace, never keyed by model.
 */
export interface PanelThinkingState {
  thinkingDisabled: boolean;
  effort: EffortLevel | null;
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
   *  in every catalog serving the model (drift-guarded by pi-models.test.ts); every StepFun, MiniMax, xAI, Kimi Code
   *  and Meta entry has it. GitHub Copilot's GPT-6 Luna and Gemini entries have it without either, because pi sends
   *  them no reasoning parameter for `off` and the model reasons at its own default. */
  thinkingAlwaysOn?: boolean;
  /** Backend dispatcher. Omitted defaults to "anthropic" for backwards compatibility. */
  backend?: "anthropic" | "openai";
  /** Literal model ID sent in the Codex request body; may differ from `value`. */
  openaiModelId?: string;
  /** Canonical pi provider for catalog models that are neither first-party Anthropic nor OpenAI.
   *  When set, resolution routes via registry.find(piProvider, value); `backend` stays unset so the
   *  non-OpenAI reasoning UI path is used. A closed union so a typo can't silently fall through to the
   *  Anthropic resolution branch. */
  piProvider?: "stepfun" | "deepseek" | "minimax" | "xai" | "kimi-coding" | "meta" | "github-copilot";
  /** pi's model id under `piProvider` when it differs from `value`: a value must be unique across the catalog, and
   *  GitHub Copilot serves ids other providers' entries use (`github-copilot/<pi id>`). */
  piModelId?: string;
  /** True when the provider bills a flat subscription (no per-token dollar cost), so dollar-budget
   *  enforcement does not apply. Set for StepFun, Kimi Code and GitHub Copilot, with every credential; unset (metered) for
   *  DeepSeek, MiniMax, xAI and Meta. A MiniMax model also bills flat while its applied key is a subscription
   *  key (`CustomProviderDef.flatFeeKey`). */
  flatFee?: boolean;
  /** The model's training-data cutoff as the system prompt states it ("June 2026"); unset when unknown, which states none. */
  knowledgeCutoff?: string;
  /** Why the chat cannot run this model: a remote chat's provider endpoint is a loopback address of the client, or the
   *  provider's sign-in lists the models of the user's plan and this one is not among them. */
  unavailable?: { reason: "loopback-endpoint"; endpoint: string } | { reason: "not-in-plan"; provider: AccountProviderId };
}

export interface AccountInfo {
  organization?: string;
  model?: string;
  /** False on a flat subscription, where a rendered dollar cost is an estimate rather than a charge. */
  dollarBilled: boolean;
  /** A remote host's Claude chat bills extra usage although its client chose the allowance: the host's bundled plugin did not load. */
  allowanceUnavailable?: true;
  /** The vendors the chat's model picker lists (`PiRuntime.pickerProviders`); absent before the model runtime exists. */
  pickerProviders?: ModelVendor[];
}

/** Why a provider sign-in ended without a credential. */
/** `denied`: the provider refused the sign-in; `remote`: a remote chat's core, which never changes this computer's sign-ins. */
export type ProviderSignInErrorKind = "cancelled" | "expired" | "denied" | "network" | "provider" | "remote";

/** `message` is core's fixed localized text for `kind`, never the provider's or pi's error text. */
export interface ProviderSignInError {
  kind: ProviderSignInErrorKind;
  message: string;
  status?: number;
}

/** One provider's sign-in flow as core runs it; `expiresAt` is epoch ms. */
export type ProviderSignInState =
  | { phase: "idle"; error?: ProviderSignInError }
  | { phase: "starting" }
  | { phase: "prompt"; prompt: "enterpriseDomain"; invalid?: true }
  | { phase: "deviceCode"; userCode: string; verificationUri: string; expiresAt?: number }
  | { phase: "browser"; paste: boolean; invalid?: true }
  | { phase: "finishing" };

/** A provider that serves a memory-judge classifier: Jev on TypeSafe or OpenRouter, GPT-6 Luna on OpenAI. */
export type ClassifierProvider = "typesafe" | "openrouter" | "openai";

/** Why a classifier provider's credential was refused: HTTP 401, 402 or 403. */
export type ClassifierRejection = "unauthorized" | "payment-required" | "forbidden";

/** Why a classifier cannot serve the memory judges: no key, or ChatGPT is the active OpenAI credential. */
export type ClassifierCredential = "ok" | "no-key" | "chatgpt-active";

/** Why a Memory judge chosen in `damocles.memory.judge` cannot run; `unrecognized`: the stored value is no judge this version offers. */
export type MemoryJudgeUnavailable = Exclude<ClassifierCredential, "ok"> | "rejected" | "signed-out" | "not-in-plan" | "unrecognized" | "not-in-catalog";

/**
 * The model the memory contradiction judge and reranks run on. `model` is `<provider>/<id>`. `unknown`: no
 * classifier key, and the judge model is resolved only once a chat has started pi. `forced`: the chosen
 * judge that cannot run, which never falls back to another.
 */
export type MemoryJudge = (
  | { kind: "classifier"; via: ClassifierProvider }
  | { kind: "model"; model: string }
  | { kind: "none"; forced?: { choice: string; reason: MemoryJudgeUnavailable } }
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
