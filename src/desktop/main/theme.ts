import { nativeTheme } from 'electron';
import type { Disposable } from '../../platform/disposable';
import type { PanelTheme, ThemeKind } from '../preload/panel-channels';
import { FILE_ICON_THEME_SETTING, type FileIconTheme, parseFileIconTheme, REDUCE_MOTION_SETTING, THEME_PREFERENCES, THEME_SETTING, type ThemePreference } from '../local-services/desktop-configuration';
import { DESKTOP_FONT_FILES } from './desktop-fonts';
import { APP_ORIGIN } from './protocol';
import { DARK_THEME, LIGHT_THEME, THEME_PALETTES } from '../theme-palettes';

// The window and every view paint this before their page does.
export const THEME_BACKGROUND: Readonly<Record<ThemeKind, string>> = { dark: DARK_THEME['--d-bg']!, light: LIGHT_THEME['--d-bg']! };

// The served path must match vite.shell.config.ts, which copies DESKTOP_FONT_FILES into dist/desktop-shell/fonts/.
export const FONT_FACE_CSS: string = DESKTOP_FONT_FILES.map((font) =>
  `@font-face { font-family: '${font.family}'; font-style: normal; font-display: swap; font-weight: 100 900; `
  + `src: url(${APP_ORIGIN}/desktop-shell/fonts/${font.output}) format('woff2-variations'); unicode-range: ${font.unicodeRange}; }`,
).join('\n');

export function themeCss(kind: ThemeKind): string {
  const declarations = Object.entries(THEME_PALETTES[kind]).map(([name, value]) => `${name}: ${value};`).join(' ');
  return `${FONT_FACE_CSS}\n:root { color-scheme: ${kind}; ${declarations} }`;
}

let reducedMotion = false;
let fileIconTheme: FileIconTheme = 'material';
const appearanceListeners = new Set<() => void>();

export function currentThemeKind(): ThemeKind {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export function currentTheme(): PanelTheme {
  const kind = currentThemeKind();
  return { kind, css: themeCss(kind), reducedMotion, fileIconTheme };
}

export function themePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
}

export interface ThemeSettings {
  get<T>(key: string): T | undefined;
  onDidChange(section: string, cb: () => void): Disposable;
}

/** Applies damocles.desktop.theme to nativeTheme.themeSource, and damocles.desktop.reduceMotion and fileIconTheme, now and on every change. */
export function followThemeSettings(settings: ThemeSettings): Disposable {
  const apply = (): void => {
    const source = themePreference(settings.get<unknown>(THEME_SETTING));
    if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
    const motion = settings.get<unknown>(REDUCE_MOTION_SETTING) === true;
    const icons = parseFileIconTheme(settings.get<unknown>(FILE_ICON_THEME_SETTING));
    if (motion === reducedMotion && icons === fileIconTheme) return;
    reducedMotion = motion;
    fileIconTheme = icons;
    for (const listener of [...appearanceListeners]) listener();
  };
  apply();
  return settings.onDidChange('damocles.desktop', apply);
}

// nativeTheme fires `updated` for OS changes and for themeSource writes alike; the reduce motion and file icon settings fire their own.
export function onThemeChange(listener: (theme: PanelTheme) => void): Disposable {
  const handler = (): void => listener(currentTheme());
  nativeTheme.on('updated', handler);
  appearanceListeners.add(handler);
  return {
    dispose: () => {
      nativeTheme.off('updated', handler);
      appearanceListeners.delete(handler);
    },
  };
}
