import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { systemTheme } from '@shared/themes/system-theme';
import { loadShellLocale, shellI18n } from '../i18n';
import { changeText, originText } from '../overlay/settings/themes/theme-text';

const t = (key: string, values?: Record<string, unknown>): string => shellI18n.global.t(key, values ?? {});

afterEach(() => {
  shellI18n.global.locale.value = 'en';
});

describe('a history entry of a pick', () => {
  // names are wrapped in isolation marks, which the comparison leaves out
  const plain = (value: string): string => value.replace(/[\u2066-\u2069]/g, '');

  it('names the theme the look had, and none when that theme was no longer installed', () => {
    expect(plain(changeText(t, { kind: 'pick', look: 'dark', theme: 'Night', themeId: 'a', was: 'Damocles', wasId: 'damocles' }))).toBe('Dark look: Night (was Damocles)');
    expect(plain(changeText(t, { kind: 'pick', look: 'light', theme: 'Night', themeId: 'a', wasId: '75c07e6a-d17c-4a7c-9d0e-0c5a6f6f0b11' }))).toBe('Light look: Night');
  });
});

describe('a theme card\'s origin line', () => {
  it('says System colors\' description in the UI\'s language, and another built-in\'s origin', async () => {
    expect(originText(t, systemTheme({}), true, undefined)).toBe("Follows this computer's colors");
    expect(originText(t, BUILTIN_THEME, true, undefined)).toBe(shellI18n.global.t('settingsHost.themes.origin.builtin'));
    expect(await loadShellLocale('el')).toBe(true);
    shellI18n.global.locale.value = 'el';
    expect(originText(t, systemTheme({}), true, undefined)).toBe('Ακολουθεί τα χρώματα αυτού του υπολογιστή');
  });
});
