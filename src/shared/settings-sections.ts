// The settings modal's sections in nav order. Main validates openAppSettings and the overlay settings request against this list.
export const SETTINGS_SECTION_IDS = [
  'chat',
  'defaults',
  'accounts',
  'teams',
  'workspace',
  'application',
  'integrations',
  'voice',
  'appearance',
  'editor',
  'terminal',
  'files',
  'sourceControl',
  'about',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === 'string' && (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

// Providers whose API key lives in the host secret store and reaches pi only in memory, in account display order.
export const KEY_PROVIDER_IDS = ['deepseek', 'stepfun', 'minimax', 'xai', 'openrouter', 'typesafe'] as const;

export type KeyProviderId = (typeof KEY_PROVIDER_IDS)[number];

/** Where pi's credential for a key provider comes from when Damocles did not apply it: an environment variable, or pi's own models.json or auth.json. */
export type ExternalKeySource = 'environment' | 'piConfig';

export function isKeyProviderId(value: unknown): value is KeyProviderId {
  return typeof value === 'string' && (KEY_PROVIDER_IDS as readonly string[]).includes(value);
}

// Proper nouns, never translated.
export const KEY_PROVIDER_NAMES: Readonly<Record<KeyProviderId, string>> = {
  deepseek: 'DeepSeek',
  stepfun: 'StepFun',
  minimax: 'MiniMax',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  typesafe: 'TypeSafe',
};

// The Accounts section's account rows; a settings request may name one to open expanded.
export const SETTINGS_ACCOUNT_IDS: readonly ['anthropic', 'openai', ...typeof KEY_PROVIDER_IDS] = ['anthropic', 'openai', ...KEY_PROVIDER_IDS];

export type SettingsAccountId = (typeof SETTINGS_ACCOUNT_IDS)[number];

export function isSettingsAccountId(value: unknown): value is SettingsAccountId {
  return typeof value === 'string' && (SETTINGS_ACCOUNT_IDS as readonly string[]).includes(value);
}

/** Where a request opens the settings: a section, and the Accounts row or the What's new release to expand there. */
export interface SettingsTarget {
  readonly section?: SettingsSectionId;
  readonly account?: SettingsAccountId;
  // a version of the desktop release index; only main sets it
  readonly release?: string;
}
