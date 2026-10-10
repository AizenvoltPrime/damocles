/**
 * cheap-model.ts — Provider-matched cheap model for the built-in Explore/Plan agents (§4.9).
 *
 * New for the Damocles port. The built-in read-only agents don't hard-code a model; when nothing more
 * specific applies they fall back to the cheap model of the panel's CURRENT main provider:
 *   Anthropic main → PI_SMALL_FAST_ANTHROPIC (Haiku 5.5), OpenAI main → PI_SMALL_FAST_OPENAI (gpt-6-luna),
 *   a custom-provider main → that provider's designated cheap model (Step 4 — custom providers).
 * The caller runs the result at `medium` thinking, which pi clamps per model.
 */

import type { Model, Api } from '@earendil-works/pi-ai';
import type { SettingsStore } from '../../../platform/settings-store';
import type { ExploreSettings } from '../../../shared/types/settings';
import { DEFAULT_MODELS, migrateLegacyModelValue, supportedStoredEffort } from '../../../shared/types/constants';
import { EXPLORE_EFFORT_SETTING, EXPLORE_MODEL_SETTING } from '../../../shared/explore-settings';
import type { OpenAIAuthStatus } from '../openai-auth';
import { resolvePiModel, PI_SMALL_FAST_ANTHROPIC, PI_SMALL_FAST_OPENAI, type ModelLookup } from '../pi-models';
import { cheapModelValueForProvider } from '../custom-providers';

/** The Explore setting, user-level (application scope, no folder): a retired id maps to its successor, and an effort the model does not support reads as unset. */
export function readExploreSetting(settings: Pick<SettingsStore, 'get'>): ExploreSettings {
  const model = migrateLegacyModelValue(settings.get<string>(EXPLORE_MODEL_SETTING, ''));
  return { model, effort: supportedStoredEffort(model, settings.get<string>(EXPLORE_EFFORT_SETTING, '')) };
}

export interface CheapModelResolution {
  /** The curated/custom model value chosen. */
  value: string;
  /** The resolved pi Model, when its provider is authed. */
  model?: Model<Api>;
}

/** Whether a curated value is an OpenAI-backed model. */
function isOpenAIValue(value: string): boolean {
  return DEFAULT_MODELS.find((m) => m.value === value)?.backend === 'openai';
}

/**
 * Resolve the cheap model matched to the panel's current main model's provider. Returns the chosen
 * value plus the resolved authed `Model` (undefined when its provider isn't authed → caller fails soft).
 */
export function resolveCheapModelFor(
  mainModelValue: string,
  registry: ModelLookup,
  openai: OpenAIAuthStatus,
  preferApiKey: boolean,
): CheapModelResolution {
  // A custom-provider main (e.g. StepFun) uses that provider's declared cheap model.
  const customCheap = cheapModelValueForProvider(mainModelValue, registry);
  const value = customCheap ?? (isOpenAIValue(mainModelValue) ? PI_SMALL_FAST_OPENAI : PI_SMALL_FAST_ANTHROPIC);
  const res = resolvePiModel(value, registry, openai, preferApiKey);
  return { value, ...(res.model && res.authed ? { model: res.model } : {}) };
}
