import { nativeTheme } from 'electron';
import type { Disposable } from '../../platform/disposable';
import type { PanelTheme, ThemeKind } from '../preload/panel-channels';
import { REDUCE_MOTION_SETTING, THEME_PREFERENCES, THEME_SETTING, type ThemePreference } from './desktop-configuration';
import { DESKTOP_FONT_FILES } from './desktop-fonts';
import { APP_ORIGIN } from './protocol';

// The Damocles palettes: every --d-* the renderers read plus the desktop-only --s-* and --d-ansi-* (theme-parity.test.ts),
// with text at WCAG AA against bg, panel, card and code, and each --d-*-text (its tone mixed toward --d-text) at AA on a tint
// of its tone up to 22% and on hover, selected and diff rows (palette-contrast.test.ts). See docs/invariants.md "Design tokens".
export type ThemePalette = Readonly<Record<`--d-${string}` | `--s-${string}`, string>>;

const FONTS = {
  '--d-font': "'Geist Variable', 'Inter Variable', system-ui, sans-serif",
  '--d-mono': "'Geist Mono Variable', ui-monospace, Menlo, monospace",
  '--d-mono-size': '13px',
  '--d-font-size': '13px',
} as const;

// Colors with alpha are #rrggbbaa because Monaco parses only hex.
export const DARK_THEME: ThemePalette = {
  ...FONTS,
  '--d-bg': '#0b0f14',
  '--d-panel': '#0f141a',
  '--d-card': '#141a22',
  '--d-hover': '#1b232d',
  '--d-border': '#212a35',
  '--d-border2': '#2d3845',
  '--d-text': '#e6edf3',
  '--d-muted': '#9aa7b4',
  '--d-faint': '#7f8b99',
  '--d-accent': '#4cc2ff',
  '--d-on-accent': '#03121c',
  '--d-accent-soft': '#4cc2ff21',
  '--d-success': '#3fcf8e',
  '--d-warning': '#f0b429',
  '--d-danger': '#f2555a',
  '--d-on-danger': '#03121c',
  '--d-on-warning': '#03121c',
  '--d-info': '#8ab4ff',
  '--d-accent-text': '#4cc2ff',
  '--d-success-text': '#3fcf8e',
  '--d-warning-text': '#f0b429',
  '--d-danger-text': '#ef7d82',
  '--d-info-text': '#8ab4ff',
  '--d-faint-text': '#939faa',
  '--d-code': '#0e131a',
  '--d-input': '#121821',
  '--d-add': '#3fcf8e21',
  '--d-del': '#f2555a21',
  '--d-shadow': '0 18px 48px #00000080',
  '--d-scrim': '#03060a9e',
  '--s-kw': '#c792ea',
  '--s-str': '#a5e075',
  '--s-num': '#f5a97f',
  '--s-com': '#768390',
  '--s-fn': '#4cc2ff',
  '--s-type': '#f0c674',
  '--d-ansi-0': '#2d3845',
  '--d-ansi-1': '#f2555a',
  '--d-ansi-2': '#3fcf8e',
  '--d-ansi-3': '#f0b429',
  '--d-ansi-4': '#5c9cff',
  '--d-ansi-5': '#c792ea',
  '--d-ansi-6': '#39c5cf',
  '--d-ansi-7': '#c9d1d9',
  '--d-ansi-8': '#768391',
  '--d-ansi-9': '#ff7b7f',
  '--d-ansi-10': '#6be3a8',
  '--d-ansi-11': '#ffcf5c',
  '--d-ansi-12': '#8ab4ff',
  '--d-ansi-13': '#dbaaf7',
  '--d-ansi-14': '#7ee0e8',
  '--d-ansi-15': '#f5f8fa',
};

export const LIGHT_THEME: ThemePalette = {
  ...FONTS,
  '--d-bg': '#f7f9fb',
  '--d-panel': '#eef2f6',
  '--d-card': '#ffffff',
  '--d-hover': '#e4eaf0',
  '--d-border': '#dde4eb',
  '--d-border2': '#ccd5de',
  '--d-text': '#0f1720',
  '--d-muted': '#4f5d6b',
  '--d-faint': '#5d6a76',
  '--d-accent': '#0272bd',
  '--d-on-accent': '#ffffff',
  '--d-accent-soft': '#0a7fd01a',
  '--d-success': '#037e51',
  '--d-warning': '#9b6200',
  '--d-danger': '#cd333a',
  '--d-on-danger': '#ffffff',
  '--d-on-warning': '#ffffff',
  '--d-info': '#4867d2',
  '--d-accent-text': '#065993',
  '--d-success-text': '#066344',
  '--d-warning-text': '#784f08',
  '--d-danger-text': '#9a2b33',
  '--d-info-text': '#3952a4',
  '--d-faint-text': '#55616d',
  '--d-code': '#f3f6f9',
  '--d-input': '#ffffff',
  '--d-add': '#138a5a1a',
  '--d-del': '#d43a401a',
  '--d-shadow': '0 18px 48px #0f172029',
  '--d-scrim': '#0f172052',
  '--s-kw': '#7c3aed',
  '--s-str': '#16794a',
  '--s-num': '#c2410c',
  '--s-com': '#646f7c',
  '--s-fn': '#0b6fb8',
  '--s-type': '#9f6002',
  '--d-ansi-0': '#0f1720',
  '--d-ansi-1': '#b42318',
  '--d-ansi-2': '#046c45',
  '--d-ansi-3': '#855400',
  '--d-ansi-4': '#1d4fb0',
  '--d-ansi-5': '#6d28d9',
  '--d-ansi-6': '#0a6070',
  '--d-ansi-7': '#4f5d6b',
  '--d-ansi-8': '#63707d',
  '--d-ansi-9': '#ce323d',
  '--d-ansi-10': '#007e4f',
  '--d-ansi-11': '#996303',
  '--d-ansi-12': '#2d6bd0',
  '--d-ansi-13': '#8a48e5',
  '--d-ansi-14': '#01798e',
  '--d-ansi-15': '#a3adb8',
};

export const THEME_PALETTES: Readonly<Record<ThemeKind, ThemePalette>> = { dark: DARK_THEME, light: LIGHT_THEME };

// The window and every view paint this before their page does.
export const THEME_BACKGROUND: Readonly<Record<ThemeKind, string>> = { dark: DARK_THEME['--d-bg']!, light: LIGHT_THEME['--d-bg']! };

// AD7: the native window controls (Windows, Linux) on the title bar's panel colour; the shell's title bar is this tall.
export const TITLE_BAR_HEIGHT = 40;

export function titleBarOverlay(kind: ThemeKind): { readonly color: string; readonly symbolColor: string; readonly height: number } {
  const palette = THEME_PALETTES[kind];
  return { color: palette['--d-panel']!, symbolColor: palette['--d-muted']!, height: TITLE_BAR_HEIGHT };
}

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
const motionListeners = new Set<() => void>();

export function currentThemeKind(): ThemeKind {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export function currentTheme(): PanelTheme {
  const kind = currentThemeKind();
  return { kind, css: themeCss(kind), reducedMotion };
}

export function themePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
}

export interface ThemeSettings {
  get<T>(key: string): T | undefined;
  onDidChange(section: string, cb: () => void): Disposable;
}

/** Applies damocles.desktop.theme to nativeTheme.themeSource and damocles.desktop.reduceMotion, now and on every change. */
export function followThemeSettings(settings: ThemeSettings): Disposable {
  const apply = (): void => {
    const source = themePreference(settings.get<unknown>(THEME_SETTING));
    if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
    const motion = settings.get<unknown>(REDUCE_MOTION_SETTING) === true;
    if (motion === reducedMotion) return;
    reducedMotion = motion;
    for (const listener of [...motionListeners]) listener();
  };
  apply();
  return settings.onDidChange('damocles.desktop', apply);
}

// nativeTheme fires `updated` for OS changes and for themeSource writes alike; the reduce motion setting fires its own.
export function onThemeChange(listener: (theme: PanelTheme) => void): Disposable {
  const handler = (): void => listener(currentTheme());
  nativeTheme.on('updated', handler);
  motionListeners.add(handler);
  return {
    dispose: () => {
      nativeTheme.off('updated', handler);
      motionListeners.delete(handler);
    },
  };
}
