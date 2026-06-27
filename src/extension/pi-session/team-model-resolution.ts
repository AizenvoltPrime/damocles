import type { Model, Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelInfo } from '../../shared/types/settings';
import type { OpenAIAuthStatus } from './openai-auth';
import { resolvePiModel, piModelToModelInfo, type ModelLookup } from './pi-models';

/**
 * Multi-provider team model resolution (US-024c). Replaces the SDK path's Anthropic-only lead model.
 *
 * - **Lead** = the strongest authed model of the ACTIVE model's provider. A backend may pin an explicit
 *   preferred lead (see `PREFERRED_LEAD_MODEL`); otherwise `piSupportedModels()` is ordered flagship-first
 *   per backend, so we take the FIRST curated model of the active backend that resolves authed. Falls back
 *   to the active model when none is authed.
 * - **Specialists** default to the active panel model; an explicit per-agent value is honored when its
 *   provider is authed, else it fails soft to the active model.
 * - **allowedSpecialistModels** = the curated catalog values for the active backend (the spawn tool's
 *   advertised/validated whitelist).
 *
 * **Anthropic policy:** when the active backend is Anthropic, every team agent is pinned to Opus 4.8 and
 * given a fixed reasoning depth — the lead and reviewer specialists run at `xhigh`, implementor
 * specialists at `high`. The specialist whitelist collapses to Opus only (the lead cannot pick
 * Sonnet/Haiku/Fable), and an explicit `model` arg is ignored rather than rejected. Every other backend
 * (OpenAI, DeepSeek, StepFun) keeps the multi-provider behavior above and sets no `thinkingLevel`.
 */

/** Classifies a specialist for thinking-depth only (set by the lead on spawn): implementors write code
 *  at `high`; reviewers read/judge at `xhigh`. Purely a reasoning-depth tag — no role/ownership semantics. */
export type SpecialistKind = 'implementor' | 'reviewer';

/** Per-backend preferred lead model, overriding the flagship-first walk when the value is authed.
 *  Anthropic leads with Opus 4.8 (tuned for agentic coordination) rather than the catalog flagship. */
const PREFERRED_LEAD_MODEL: Record<string, string> = {
  anthropic: 'claude-opus-4-8',
};

/** On Anthropic, every team specialist is pinned to Opus 4.8 (no Sonnet/Haiku/Fable). */
const FORCED_ANTHROPIC_SPECIALIST_MODEL = 'claude-opus-4-8';
const ANTHROPIC_LEAD_THINKING: ThinkingLevel = 'xhigh';
const ANTHROPIC_SPECIALIST_THINKING: Record<SpecialistKind, ThinkingLevel> = {
  implementor: 'high',
  reviewer: 'xhigh',
};

export interface ResolvedTeamModel {
  model?: Model<Api>;
  modelLabel?: string;
  /** The fixed reasoning depth for this agent's session (Anthropic policy only; unset elsewhere). */
  thinkingLevel?: ThinkingLevel;
  error?: string;
}

export interface TeamModelDeps {
  registry: ModelLookup;
  openai: OpenAIAuthStatus;
  preferApiKey: boolean;
  /** The active panel model value. */
  activeModel: string;
  /** The curated model catalog (flagship-first per backend) — `piSupportedModels()`. */
  supportedModels: readonly ModelInfo[];
}

/** The provider-identity key of a curated model value (openai / piProvider / anthropic), or undefined
 *  when the value is not in the catalog. Keeps StepFun/DeepSeek in their own bucket rather than
 *  mis-classifying everything non-OpenAI as Anthropic. */
function backendOf(value: string, supportedModels: readonly ModelInfo[]): string | undefined {
  const info = supportedModels.find((m) => m.value === value);
  if (!info) return undefined;
  return info.backend === 'openai' ? 'openai' : (info.piProvider ?? 'anthropic');
}

/** The provider-identity key of a catalog entry (openai / piProvider / anthropic). */
function providerKey(m: ModelInfo): string {
  return m.backend === 'openai' ? 'openai' : (m.piProvider ?? 'anthropic');
}

/** Whether the active panel backend is Anthropic — the trigger for the forced-Opus + thinking policy. */
function isAnthropic(deps: TeamModelDeps): boolean {
  return backendOf(deps.activeModel, deps.supportedModels) === 'anthropic';
}

/** Single source of truth for the specialist-model-forced policy: true iff the active backend is
 *  Anthropic (where specialists are pinned to Opus and an explicit `model` arg is ignored). */
export function isSpecialistModelForced(deps: TeamModelDeps): boolean {
  return isAnthropic(deps);
}

/** The short display label for a resolved pi model (falls back to the raw value). */
function labelFor(model: Model<Api> | undefined, value: string): string {
  return model ? piModelToModelInfo(model).displayName : value;
}

/** The curated specialist-model whitelist for the active backend (flagship-first order). On Anthropic the
 *  whitelist collapses to Opus 4.8 only — the lead cannot select Sonnet/Haiku/Fable. */
export function allowedSpecialistModels(deps: TeamModelDeps): string[] {
  if (isAnthropic(deps)) return [FORCED_ANTHROPIC_SPECIALIST_MODEL];
  const backend = backendOf(deps.activeModel, deps.supportedModels);
  return deps.supportedModels
    .filter((m) => providerKey(m) === (backend ?? 'anthropic'))
    .map((m) => m.value);
}

/**
 * Resolve the active model itself as a fail-soft fallback (used when no flagship/explicit is authed).
 * Requires `authed` (mirroring the explicit branches): an unauthed-but-resolvable active model would
 * spawn an unusable session that fails at runtime, so we return no `model` and let the caller degrade
 * to the engine default instead.
 */
function resolveActive(deps: TeamModelDeps): ResolvedTeamModel {
  const res = resolvePiModel(deps.activeModel, deps.registry, deps.openai, deps.preferApiKey);
  if (res.model && res.authed) return { model: res.model, modelLabel: labelFor(res.model, deps.activeModel) };
  return { modelLabel: deps.activeModel };
}

/**
 * Resolve the lead model — the backend's preferred lead (when authed) else the flagship (first curated,
 * authed) model of the active backend. Falls back to the active model when none of those is authed.
 */
export function resolveLeadModel(deps: TeamModelDeps): ResolvedTeamModel {
  // On Anthropic the lead always runs at xhigh — attach it to every returned branch below.
  const anthropic = isAnthropic(deps);
  const withThinking = (res: ResolvedTeamModel): ResolvedTeamModel =>
    anthropic ? { ...res, thinkingLevel: ANTHROPIC_LEAD_THINKING } : res;

  const backend = backendOf(deps.activeModel, deps.supportedModels) ?? 'anthropic';
  const preferred = PREFERRED_LEAD_MODEL[backend];
  if (preferred) {
    const res = resolvePiModel(preferred, deps.registry, deps.openai, deps.preferApiKey);
    if (res.model && res.authed) return withThinking({ model: res.model, modelLabel: labelFor(res.model, preferred) });
  }
  for (const info of deps.supportedModels) {
    const infoBackend = providerKey(info);
    if (infoBackend !== backend) continue;
    const res = resolvePiModel(info.value, deps.registry, deps.openai, deps.preferApiKey);
    if (res.model && res.authed) return withThinking({ model: res.model, modelLabel: labelFor(res.model, info.value) });
  }
  return withThinking(resolveActive(deps));
}

/**
 * Resolve a specialist model. On Anthropic, the `value` is ignored: the specialist is pinned to Opus 4.8
 * with the kind's fixed thinking depth (implementor → high, reviewer → xhigh); if Opus is unauthed it
 * fails soft to the active model but still carries that thinking level. On every other backend the legacy
 * behavior holds — an explicit `value` is honored when its provider is authed, else the active model;
 * `kind` is ignored and no `thinkingLevel` is set. `undefined` value → the active model.
 */
export function resolveSpecialistModel(
  value: string | undefined,
  deps: TeamModelDeps,
  kind?: SpecialistKind,
): ResolvedTeamModel {
  if (isAnthropic(deps)) {
    const thinkingLevel = ANTHROPIC_SPECIALIST_THINKING[kind ?? 'implementor'];
    const res = resolvePiModel(FORCED_ANTHROPIC_SPECIALIST_MODEL, deps.registry, deps.openai, deps.preferApiKey);
    if (res.model && res.authed) {
      return { model: res.model, modelLabel: labelFor(res.model, FORCED_ANTHROPIC_SPECIALIST_MODEL), thinkingLevel };
    }
    // Opus unauthed: degrade to the active model but keep the policy thinking level.
    return { ...resolveActive(deps), thinkingLevel };
  }
  if (value === undefined) return resolveActive(deps);
  const res = resolvePiModel(value, deps.registry, deps.openai, deps.preferApiKey);
  if (res.model && res.authed) return { model: res.model, modelLabel: labelFor(res.model, value) };
  // Explicit but unavailable/unauthed: fail soft to the active model.
  return resolveActive(deps);
}
