// scripts/generate-settings-schema.mjs imports this file through Node's type stripping: erasable TypeScript and no imports.
// Desktop-only settings, merged into the desktop settings store's contributed set; they never enter package.json.

export const THEME_SETTING = 'damocles.desktop.theme';
export const REDUCE_MOTION_SETTING = 'damocles.desktop.reduceMotion';
export const LANGUAGE_SETTING = 'damocles.desktop.language';
export const RESTORE_LAYOUT_SETTING = 'damocles.desktop.restoreLayout';
export const NOTIFICATIONS_SETTING = 'damocles.desktop.notifications.enabled';

export const THEME_PREFERENCES = ['system', 'dark', 'light'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const DESKTOP_LANGUAGES = ['system', 'en', 'el'] as const;
export type DesktopLanguageSetting = (typeof DESKTOP_LANGUAGES)[number];

// The one check every reader of damocles.desktop.language uses, the --lang switch included; anything else reads as system.
export function parseDesktopLanguage(value: unknown): DesktopLanguageSetting {
  return (DESKTOP_LANGUAGES as readonly unknown[]).includes(value) ? (value as DesktopLanguageSetting) : 'system';
}

export interface DesktopSettingProperty {
  readonly type: string;
  readonly default: unknown;
  readonly scope: 'application';
  readonly description: string;
  readonly enum?: readonly string[];
  readonly enumDescriptions?: readonly string[];
}

export const DESKTOP_CONFIGURATION: Readonly<Record<string, DesktopSettingProperty>> = {
  [THEME_SETTING]: {
    type: 'string',
    enum: THEME_PREFERENCES,
    enumDescriptions: ['Follow the operating system.', 'Damocles Dark.', 'Damocles Light.'],
    default: 'system',
    scope: 'application',
    description: 'Color theme of the desktop app.',
  },
  [REDUCE_MOTION_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'Stop non-essential animation in the desktop app. The operating system\'s reduced-motion preference applies as well.',
  },
  [LANGUAGE_SETTING]: {
    type: 'string',
    enum: DESKTOP_LANGUAGES,
    enumDescriptions: ['Follow the operating system.', 'English.', 'Greek.'],
    default: 'system',
    scope: 'application',
    description: 'Display language of the desktop app. A change applies after a restart.',
  },
  [RESTORE_LAYOUT_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Reopen the window layout and the chats that were open when the app last quit. When off, the app starts with the default layout and a new chat.',
  },
  [NOTIFICATIONS_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Also show each in-app notification as an operating system notification while the window is not focused.',
  },
};

/** Whether `value` fits the declared type and enum of the desktop setting `key`; false for a key that is not declared. */
export function isDesktopSettingValue(key: string, value: unknown): boolean {
  if (!Object.hasOwn(DESKTOP_CONFIGURATION, key)) return false;
  const property = DESKTOP_CONFIGURATION[key]!;
  if (property.type === 'boolean') return typeof value === 'boolean';
  if (property.type !== 'string' || typeof value !== 'string') return false;
  return property.enum === undefined || property.enum.includes(value);
}
