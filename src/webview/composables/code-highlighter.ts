import { inject, type InjectionKey } from 'vue';
import type { BundledTheme } from 'shiki';
import type { HighlighterCore } from 'shiki/core';
import { DAMOCLES_SHIKI_THEME } from './damoclesShikiTheme';

// The code highlighter a page's components share, provided on the page's app. Only types and pure helpers live here, so
// importing this file pulls in no grammar.

export type SupportedTheme = Extract<BundledTheme, 'github-dark' | 'github-light' | 'solarized-dark' | 'solarized-light' | 'nord' | 'min-dark' | 'min-light'>;

export type HighlightTheme = SupportedTheme | typeof DAMOCLES_SHIKI_THEME;

export interface CodeHighlighter {
  /** The highlighter's name for `language`: its own, an alias's target, or 'txt'. */
  normalizeLanguage(language: string | undefined): string;
  /** Whether `get(language, theme)` would resolve without loading anything. */
  isReady(language: string, theme: HighlightTheme): boolean;
  /** A highlighter with `language` and `theme` loaded. */
  get(language: string | undefined, theme: HighlightTheme): Promise<HighlighterCore>;
}

export const CODE_HIGHLIGHTER: InjectionKey<CodeHighlighter> = Symbol('code-highlighter');

/** The page's code highlighter; a component in an app that provides none is a bug. */
export function useCodeHighlighter(): CodeHighlighter {
  const highlighter = inject(CODE_HIGHLIGHTER, null);
  if (!highlighter) throw new Error('No app provides CODE_HIGHLIGHTER');
  return highlighter;
}

/** The desktop's token-fed theme (HostCapabilities.damoclesTheme), else one matched to the VS Code theme. */
export function codeHighlightTheme(damoclesTheme: boolean): HighlightTheme {
  return damoclesTheme ? DAMOCLES_SHIKI_THEME : getShikiTheme();
}

export function getShikiTheme(): SupportedTheme {
  const bodyClass = document.body.className.toLowerCase();
  const isLight = bodyClass.includes('light');

  const themeName = (document.body.dataset.vscodeThemeName || '').toLowerCase();

  if (themeName.includes('solarized')) {
    return isLight ? 'solarized-light' : 'solarized-dark';
  }

  if (themeName.includes('nord')) {
    return 'nord';
  }

  if (themeName.includes('min') || themeName.includes('minimal')) {
    return isLight ? 'min-light' : 'min-dark';
  }

  return isLight ? 'github-light' : 'github-dark';
}
