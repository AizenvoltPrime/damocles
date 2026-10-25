import type { ModelInfo } from './types/settings';
import { DEFAULT_MODELS } from './types/constants';
import { ACCOUNT_PROVIDER_NAMES, type SettingsAccountId } from './settings-sections';

export type ModelVendor = 'anthropic' | 'openai' | NonNullable<ModelInfo['piProvider']>;

/** The vendor whose logo and group a listed model shows under. */
export function modelVendor(model: ModelInfo): ModelVendor {
  return model.backend === 'openai' ? 'openai' : (model.piProvider ?? 'anthropic');
}

// Brands, shown as written in every language; every vendor is an account, and every account is named.
export const MODEL_VENDOR_NAMES: Readonly<Record<SettingsAccountId, string>> = { anthropic: 'Anthropic', openai: 'OpenAI', ...ACCOUNT_PROVIDER_NAMES };

/**
 * A model's name in a flat list: its display name, qualified with its vendor ("Opus 5.5 (GitHub Copilot)") when an earlier
 * catalog entry has the same name. A list grouped by vendor shows the plain name.
 */
export function modelLabel(info: ModelInfo): string {
  const index = DEFAULT_MODELS.findIndex((m) => m.value === info.value);
  const shared = DEFAULT_MODELS.some((m, i) => i < index && m.displayName === info.displayName);
  return shared ? `${info.displayName} (${MODEL_VENDOR_NAMES[modelVendor(info)]})` : info.displayName;
}

/** Every vendor with a catalog model, in catalog order. */
export const MODEL_VENDORS: readonly ModelVendor[] = [...new Set(DEFAULT_MODELS.map(modelVendor))];

/** Per vendor, whether its models are listed in the chat's model picker; an unset vendor follows whether it has a credential. */
export const MODEL_PICKER_SETTING = 'damocles.modelPicker.providers';

/** The pi providers whose credential serves a vendor's models: OpenAI's run on its API key or on the Codex sign-in. */
export function vendorPiProviders(vendor: ModelVendor): readonly string[] {
  return vendor === 'openai' ? ['openai', 'openai-codex'] : [vendor];
}

/** The catalog entry of a pi model recorded as `provider`/`modelId`, matched by its exact provider; undefined outside the catalog. */
export function catalogEntryOfPiModel(provider: string, modelId: string): ModelInfo | undefined {
  return DEFAULT_MODELS.find((info) => vendorPiProviders(modelVendor(info)).includes(provider) && (info.openaiModelId ?? info.piModelId ?? info.value) === modelId);
}

export function isModelVendor(value: unknown): value is ModelVendor {
  return typeof value === 'string' && (MODEL_VENDORS as readonly string[]).includes(value);
}
