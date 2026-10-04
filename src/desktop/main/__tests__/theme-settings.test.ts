import { describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ native: { themeSource: 'system', shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() } }));
vi.mock('electron', () => ({ nativeTheme: H.native }));

import { currentTheme, followThemeSettings, onThemeChange, themePreference } from '../theme';

function fakeSettings(values: Record<string, unknown>) {
  let listener: (() => void) | undefined;
  return {
    values,
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
    onDidChange: (_section: string, cb: () => void) => {
      listener = cb;
      return { dispose: () => { listener = undefined; } };
    },
    fire: () => listener?.(),
  };
}

describe('desktop theme settings', () => {
  it('reads an unknown or missing theme as system', () => {
    expect(themePreference('light')).toBe('light');
    expect(themePreference('sepia')).toBe('system');
    expect(themePreference(undefined)).toBe('system');
  });

  it('sets themeSource at once and on change, and tells theme listeners when reduce motion flips', () => {
    const settings = fakeSettings({ 'damocles.desktop.theme': 'dark' });
    const themes: boolean[] = [];
    const listening = onThemeChange((theme) => themes.push(theme.reducedMotion));
    const following = followThemeSettings(settings);
    expect(H.native.themeSource).toBe('dark');
    expect(currentTheme().reducedMotion).toBe(false);

    settings.values['damocles.desktop.theme'] = 'light';
    settings.values['damocles.desktop.reduceMotion'] = true;
    settings.fire();
    expect(H.native.themeSource).toBe('light');
    expect(themes).toEqual([true]);
    expect(currentTheme().reducedMotion).toBe(true);

    settings.fire();
    expect(themes).toEqual([true]);

    settings.values['damocles.desktop.reduceMotion'] = false;
    settings.fire();
    expect(themes).toEqual([true, false]);
    following.dispose();
    listening.dispose();
  });
});
