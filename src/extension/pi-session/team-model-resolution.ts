import type { Model, Api } from '@earendil-works/pi-ai';
import type { ModelInfo } from '../../shared/types/settings';
import type { OpenAIAuthStatus } from './openai-auth';
import { resolvePiModel, piModelToModelInfo, type ModelLookup } from './pi-models';

/**
 * Multi-provider team model resolution (US-024c). Replaces the SDK path's Anthropic-only lead model.
 *
 * - **Lead** = the strongest authed model of the ACTIVE model's provider ("flagship per provider").
 *   `piSupportedModels()` is ordered flagship-first per backend, so we take the FIRST curated model of
 *   the active backend that resolves authed. Falls back to the active model when none is authed.
 * - **Specialists** default to the active panel model; an explicit per-agent value is honored when its
 *   provider is authed, else it fails soft to the active model.
 * - **allowedSpecialistModels** = the curated catalog values for the active backend (the spawn tool's
 *   advertised/validated whitelist).
 */

export interface ResolvedTeamModel {
  model?: Model<Api>;
  modelLabel?: string;
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

/** The backend of a curated model value, or undefined when the value is not in the catalog. */
function backendOf(value: string, supportedModels: readonly ModelInfo[]): 'anthropic' | 'openai' | undefined {
  const info = supportedModels.find((m) => m.value === value);
  if (!info) return undefined;
  return info.backend === 'openai' ? 'openai' : 'anthropic';
}

/** The short display label for a resolved pi model (falls back to the raw value). */
function labelFor(model: Model<Api> | undefined, value: string): string {
  return model ? piModelToModelInfo(model).displayName : value;
}

/** The curated specialist-model whitelist for the active backend (flagship-first order). */
export function allowedSpecialistModels(deps: TeamModelDeps): string[] {
  const backend = backendOf(deps.activeModel, deps.supportedModels);
  return deps.supportedModels
    .filter((m) => (m.backend === 'openai' ? 'openai' : 'anthropic') === (backend ?? 'anthropic'))
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
 * Resolve the lead model — the flagship (first curated, authed) model of the active backend. Falls back
 * to the active model when no flagship of that backend is authed.
 */
export function resolveLeadModel(deps: TeamModelDeps): ResolvedTeamModel {
  const backend = backendOf(deps.activeModel, deps.supportedModels) ?? 'anthropic';
  for (const info of deps.supportedModels) {
    const infoBackend = info.backend === 'openai' ? 'openai' : 'anthropic';
    if (infoBackend !== backend) continue;
    const res = resolvePiModel(info.value, deps.registry, deps.openai, deps.preferApiKey);
    if (res.model && res.authed) return { model: res.model, modelLabel: labelFor(res.model, info.value) };
  }
  return resolveActive(deps);
}

/**
 * Resolve a specialist model — an explicit value when its provider is authed, else the active panel
 * model (fail soft). `undefined` → the active model.
 */
export function resolveSpecialistModel(value: string | undefined, deps: TeamModelDeps): ResolvedTeamModel {
  if (value === undefined) return resolveActive(deps);
  const res = resolvePiModel(value, deps.registry, deps.openai, deps.preferApiKey);
  if (res.model && res.authed) return { model: res.model, modelLabel: labelFor(res.model, value) };
  // Explicit but unavailable/unauthed: fail soft to the active model.
  return resolveActive(deps);
}
