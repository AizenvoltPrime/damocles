import type { Api, Model, ModelThinkingLevel, ThinkingLevel } from '@earendil-works/pi-ai';
import type { SubCallPurpose } from '../usage-stats/subcall-ledger';
import type { SettingsStore } from '../../platform/settings-store';
import type { EffortLevel } from '../../shared/types/settings';
import { DEFAULT_MODELS, migrateLegacyModelValue, supportedStoredEffort } from '../../shared/types/constants';
import type { OpenAIAuthStatus } from './openai-auth';
import { effortToPiThinking, resolvePiModel, PI_SMALL_FAST_ANTHROPIC, PI_SMALL_FAST_OPENAI, type ModelLookup } from './pi-models';

/** Every purpose that runs through `PiRuntime.runStructuredCompletion`; `/btw` runs as a chat turn instead. */
export type StructuredSubCallPurpose = Exclude<SubCallPurpose, 'btw'>;

/** The thinking level each structured sub-call requests before pi's per-model clamp. */
export const SUBCALL_THINKING: Record<StructuredSubCallPurpose, 'off' | 'low'> = {
  'session-title': 'off',
  'memory-query-expansion': 'off',
  'memory-rerank': 'off',
  'memory-merge': 'off',
  'memory-extract': 'low',
  'memory-profile': 'low',
  'memory-audit': 'low',
};

export type ClampThinkingLevel = (model: Model<Api>, level: ModelThinkingLevel) => ModelThinkingLevel;

/**
 * The `reasoning` option for `completeSimple`: the requested level clamped by pi, or `undefined` only when
 * the model supports `off`. Omitting it on a model without `off` would not mean "no thinking": pi sends
 * adaptive thinking at `high` for `supportsMidConvoEffort` models.
 */
export function subCallReasoning(clamp: ClampThinkingLevel, model: Model<Api>, level: ModelThinkingLevel): ThinkingLevel | undefined {
  const clamped = clamp(model, level);
  return clamped === 'off' ? undefined : clamped;
}

export const BACKGROUND_MODEL_SETTING = 'damocles.background.model';
export const BACKGROUND_EFFORT_SETTING = 'damocles.background.effort';

/** The models Automatic tries for background work, in order; the first one resolved and signed in wins. */
export const AUTOMATIC_BACKGROUND_MODELS: readonly string[] = [PI_SMALL_FAST_ANTHROPIC, PI_SMALL_FAST_OPENAI, 'step-5-preview', 'deepseek-flash'];

/** The model a sub-call runs on, and the effort that replaces every purpose's `SUBCALL_THINKING` level when set. */
export interface SubCallModel {
  model: Model<Api>;
  effort?: EffortLevel;
}

function signedInModel(value: string, registry: ModelLookup, openai: OpenAIAuthStatus, preferApiKey: boolean): Model<Api> | undefined {
  const resolved = resolvePiModel(value, registry, openai, preferApiKey);
  return resolved.model && resolved.authed ? resolved.model : undefined;
}

/** The first `AUTOMATIC_BACKGROUND_MODELS` entry that resolves and is signed in, at each purpose's own level. */
export function resolveAutomaticModel(registry: ModelLookup, openai: OpenAIAuthStatus, preferApiKey: boolean): SubCallModel | null {
  for (const value of AUTOMATIC_BACKGROUND_MODELS) {
    const model = signedInModel(value, registry, openai, preferApiKey);
    if (model) return { model };
  }
  return null;
}

/**
 * A picked catalog model and its stored effort when supported. A value outside the catalog, or one that does not
 * resolve or is signed out, gives `null`, never another provider's model.
 */
export function resolvePickedModel(
  picked: string,
  storedEffort: string,
  registry: ModelLookup,
  openai: OpenAIAuthStatus,
  preferApiKey: boolean,
): SubCallModel | null {
  if (!DEFAULT_MODELS.some((m) => m.value === picked)) return null;
  const model = signedInModel(picked, registry, openai, preferApiKey);
  if (!model) return null;
  const effort = supportedStoredEffort(picked, storedEffort);
  return effort === null ? { model } : { model, effort };
}

/** The Background model (`damocles.background.*`, user settings only). Automatic ignores the stored effort. */
export function resolveBackgroundModel(
  registry: ModelLookup,
  settings: Pick<SettingsStore, 'get'>,
  openai: OpenAIAuthStatus,
  preferApiKey: boolean,
): SubCallModel | null {
  const picked = migrateLegacyModelValue(settings.get<string>(BACKGROUND_MODEL_SETTING, ''));
  if (picked === '') return resolveAutomaticModel(registry, openai, preferApiKey);
  return resolvePickedModel(picked, settings.get<string>(BACKGROUND_EFFORT_SETTING, ''), registry, openai, preferApiKey);
}

/** The level a sub-call of `purpose` requests before pi's clamp: the explicit effort when set, else the purpose's own. */
export function subCallLevel(purpose: StructuredSubCallPurpose, effort: EffortLevel | undefined): ModelThinkingLevel {
  return effort === undefined ? SUBCALL_THINKING[purpose] : effortToPiThinking(effort);
}
