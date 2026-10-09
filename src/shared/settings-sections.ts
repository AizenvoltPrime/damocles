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
  'about',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === 'string' && (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

// The Accounts section's account rows; a settings request may name one to open expanded.
export const SETTINGS_ACCOUNT_IDS = ['anthropic', 'openai', 'deepseek', 'stepfun', 'openrouter', 'typesafe'] as const;

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
