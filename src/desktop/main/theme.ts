import { nativeTheme } from 'electron';
import type { Disposable } from '../../platform/disposable';
import type { PanelTheme, ThemeKind } from '../preload/panel-channels';

// Every --vscode-* variable the webview reads (theme-parity.test.ts enforces it); values follow VS Code's Dark Modern and Light Modern themes.
export type ThemePalette = Readonly<Record<`--vscode-${string}`, string>>;

const FONTS = {
  '--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif',
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': '"SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Droid Sans Mono", "Courier New", monospace',
  '--vscode-editor-font-size': '13px',
} as const;

export const DARK_THEME: ThemePalette = {
  ...FONTS,
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-errorForeground': '#f85149',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-widget-border': '#313131',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-editorGroup-border': '#ffffff17',
  '--vscode-editorInfo-foreground': '#3794ff',
  '--vscode-editorLineNumber-foreground': '#6e7681',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-button-background': '#0078d4',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#026ec1',
  '--vscode-button-secondaryBackground': '#313131',
  '--vscode-button-secondaryForeground': '#cccccc',
  '--vscode-charts-blue': '#3794ff',
  '--vscode-charts-foreground': '#cccccc',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-lines': '#cccccc80',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-diffEditor-insertedTextBackground': '#9ccc2c33',
  '--vscode-diffEditor-removedTextBackground': '#ff000033',
  '--vscode-input-background': '#313131',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-list-inactiveSelectionBackground': '#37373d',
  '--vscode-menu-background': '#1f1f1f',
  '--vscode-menu-foreground': '#cccccc',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-sideBar-background': '#181818',
  '--vscode-terminal-ansiCyan': '#11a8cd',
  '--vscode-terminal-ansiGreen': '#0dbc79',
  '--vscode-textBlockQuote-background': '#2b2b2b',
  '--vscode-textBlockQuote-border': '#616161',
  '--vscode-textBlockQuote-foreground': '#cccccc',
  '--vscode-textCodeBlock-background': '#2b2b2b',
  '--vscode-textLink-activeForeground': '#4daafc',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-textPreformat-foreground': '#d0d0d0',
};

export const LIGHT_THEME: ThemePalette = {
  ...FONTS,
  '--vscode-foreground': '#3b3b3b',
  '--vscode-descriptionForeground': '#616161',
  '--vscode-errorForeground': '#f85149',
  '--vscode-focusBorder': '#005fb8',
  '--vscode-widget-border': '#e5e5e5',
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#3b3b3b',
  '--vscode-editorGroup-border': '#e5e5e5',
  '--vscode-editorInfo-foreground': '#1a85ff',
  '--vscode-editorLineNumber-foreground': '#6e7681',
  '--vscode-editorWarning-foreground': '#bf8803',
  '--vscode-editorWidget-background': '#f8f8f8',
  '--vscode-button-background': '#005fb8',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#0258a8',
  '--vscode-button-secondaryBackground': '#e5e5e5',
  '--vscode-button-secondaryForeground': '#3b3b3b',
  '--vscode-charts-blue': '#1a85ff',
  '--vscode-charts-foreground': '#616161',
  '--vscode-charts-green': '#388a34',
  '--vscode-charts-lines': '#61616180',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-purple': '#652d90',
  '--vscode-charts-red': '#e51400',
  '--vscode-charts-yellow': '#bf8803',
  '--vscode-diffEditor-insertedTextBackground': '#9ccc2c40',
  '--vscode-diffEditor-removedTextBackground': '#ff000033',
  '--vscode-input-background': '#ffffff',
  '--vscode-list-hoverBackground': '#f2f2f2',
  '--vscode-list-inactiveSelectionBackground': '#e4e6f1',
  '--vscode-menu-background': '#ffffff',
  '--vscode-menu-foreground': '#3b3b3b',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-sideBar-background': '#f8f8f8',
  '--vscode-terminal-ansiCyan': '#0598bc',
  '--vscode-terminal-ansiGreen': '#00bc00',
  '--vscode-textBlockQuote-background': '#f8f8f8',
  '--vscode-textBlockQuote-border': '#e5e5e5',
  '--vscode-textBlockQuote-foreground': '#3b3b3b',
  '--vscode-textCodeBlock-background': '#f8f8f8',
  '--vscode-textLink-activeForeground': '#005fb8',
  '--vscode-textLink-foreground': '#005fb8',
  '--vscode-textPreformat-foreground': '#3b3b3b',
};

export const THEME_PALETTES: Readonly<Record<ThemeKind, ThemePalette>> = { dark: DARK_THEME, light: LIGHT_THEME };

export function themeCss(kind: ThemeKind): string {
  const declarations = Object.entries(THEME_PALETTES[kind]).map(([name, value]) => `${name}: ${value};`).join(' ');
  return `:root { color-scheme: ${kind}; ${declarations} }`;
}

export function currentThemeKind(): ThemeKind {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export function currentTheme(): PanelTheme {
  const kind = currentThemeKind();
  return { kind, css: themeCss(kind) };
}

// nativeTheme fires `updated` for OS changes and for themeSource writes alike.
export function onThemeChange(listener: (theme: PanelTheme) => void): Disposable {
  const handler = (): void => listener(currentTheme());
  nativeTheme.on('updated', handler);
  return { dispose: () => { nativeTheme.off('updated', handler); } };
}
