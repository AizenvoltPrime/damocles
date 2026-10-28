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
  'remoteHosts',
  'about',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === 'string' && (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

// Providers whose API key lives in the host secret store and reaches pi only in memory, in account display order.
export const KEY_PROVIDER_IDS = ['deepseek', 'stepfun', 'minimax', 'xai', 'kimi-coding', 'meta', 'openrouter', 'typesafe'] as const;

export type KeyProviderId = (typeof KEY_PROVIDER_IDS)[number];

/** Where pi's credential for a key provider comes from when Damocles did not apply it: an environment variable, or pi's own models.json or auth.json. */
export type ExternalKeySource = 'environment' | 'piConfig';

/** Which credential pi uses for a provider: a stored sign-in, the key saved in Damocles, an external key, or none. */
export type ProviderCredentialActive = 'signIn' | 'apiKey' | 'external' | 'none';

export function isKeyProviderId(value: unknown): value is KeyProviderId {
  return typeof value === 'string' && (KEY_PROVIDER_IDS as readonly string[]).includes(value);
}

// Every provider with an Accounts row of its own: the key providers, then the sign-in-only ones.
export const ACCOUNT_PROVIDER_IDS: readonly [...typeof KEY_PROVIDER_IDS, 'github-copilot'] = [...KEY_PROVIDER_IDS, 'github-copilot'];

export type AccountProviderId = (typeof ACCOUNT_PROVIDER_IDS)[number];

export function isAccountProviderId(value: unknown): value is AccountProviderId {
  return typeof value === 'string' && (ACCOUNT_PROVIDER_IDS as readonly string[]).includes(value);
}

// Account providers that offer a pi OAuth sign-in in the Accounts section.
export const SIGN_IN_PROVIDER_IDS: readonly ['xai', 'kimi-coding', 'meta', 'openrouter', 'github-copilot'] = ['xai', 'kimi-coding', 'meta', 'openrouter', 'github-copilot'] as const satisfies readonly AccountProviderId[];

export type SignInProviderId = (typeof SIGN_IN_PROVIDER_IDS)[number];

export function isSignInProviderId(value: unknown): value is SignInProviderId {
  return typeof value === 'string' && (SIGN_IN_PROVIDER_IDS as readonly string[]).includes(value);
}

// Proper nouns, never translated.
export const ACCOUNT_PROVIDER_NAMES: Readonly<Record<AccountProviderId, string>> = {
  deepseek: 'DeepSeek',
  stepfun: 'StepFun',
  minimax: 'MiniMax',
  xai: 'xAI',
  'kimi-coding': 'Kimi Code',
  meta: 'Meta',
  openrouter: 'OpenRouter',
  typesafe: 'TypeSafe',
  'github-copilot': 'GitHub Copilot',
};

// The Accounts section's account rows; a settings request may name one to open expanded.
export const SETTINGS_ACCOUNT_IDS: readonly ['anthropic', 'openai', ...typeof ACCOUNT_PROVIDER_IDS] = ['anthropic', 'openai', ...ACCOUNT_PROVIDER_IDS];

export type SettingsAccountId = (typeof SETTINGS_ACCOUNT_IDS)[number];

export function isSettingsAccountId(value: unknown): value is SettingsAccountId {
  return typeof value === 'string' && (SETTINGS_ACCOUNT_IDS as readonly string[]).includes(value);
}

// Anthropic's and OpenAI's rows, outside ACCOUNT_PROVIDER_IDS, each take an API key and a sign-in.
export function accountTakesKey(account: SettingsAccountId): boolean {
  return !isAccountProviderId(account) || isKeyProviderId(account);
}

export function accountSignsIn(account: SettingsAccountId): boolean {
  return !isAccountProviderId(account) || isSignInProviderId(account);
}

/** Where a request opens the settings: a section, and the Accounts row or the What's new release to expand there. */
export interface SettingsTarget {
  readonly section?: SettingsSectionId;
  readonly account?: SettingsAccountId;
  // a version of the desktop release index; only main sets it
  readonly release?: string;
  // a saved host's id for the Remote hosts section; only main sets it, after checking the host store
  readonly host?: string;
}
