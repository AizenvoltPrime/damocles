import type { ITheme } from '@xterm/xterm';
import type { ISearchDecorationOptions } from '@xterm/addon-search';
import { HOST_THEME_STYLE_ID } from '@shared/host-theme';

// xterm's sixteen ANSI slots in order, filled from --d-ansi-0 to --d-ansi-15 (theme.ts, palette-contrast.test.ts).
const ANSI_SLOTS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const satisfies ReadonlyArray<keyof ITheme>;

const HEX6 = /^#[0-9a-f]{6}$/i;

/** `#rrggbb` at `alpha` (0..1) as `#rrggbbaa`, which xterm parses; any other form is returned as is. */
function withAlpha(color: string, alpha: number): string {
  return HEX6.test(color) ? `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}` : color;
}

/** Calls `apply` whenever the preload switches theme, by rewriting the host theme <style> and the body's theme class. */
export function watchHostTheme(apply: () => void): () => void {
  const observer = new MutationObserver(apply);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] });
  const hostStyle = document.getElementById(HOST_THEME_STYLE_ID);
  if (hostStyle) observer.observe(hostStyle, { childList: true, characterData: true, subtree: true });
  return () => observer.disconnect();
}

/** The xterm theme from the page's design tokens as they compute now; a theme switch calls it again. */
export function terminalTheme(style: CSSStyleDeclaration): ITheme {
  const token = (name: string): string => style.getPropertyValue(name).trim();
  const accent = token('--d-accent');
  const muted = token('--d-muted');
  const theme: ITheme = {
    background: token('--d-bg'),
    foreground: token('--d-text'),
    cursor: accent,
    cursorAccent: token('--d-bg'),
    selectionBackground: withAlpha(accent, 0.3),
    selectionInactiveBackground: withAlpha(muted, 0.25),
    // The editor tab strip's slider alphas (style.css), so both scrollbars read alike.
    scrollbarSliderBackground: withAlpha(muted, 0.4),
    scrollbarSliderHoverBackground: withAlpha(muted, 0.7),
    scrollbarSliderActiveBackground: withAlpha(token('--d-text'), 0.4),
  };
  ANSI_SLOTS.forEach((slot, index) => {
    theme[slot] = token(`--d-ansi-${index}`);
  });
  return theme;
}

/** Find's match highlights: every match tinted in the warning hue, the current one in the accent, as Monaco's find shows them. */
export function searchDecorations(style: CSSStyleDeclaration): ISearchDecorationOptions {
  const warning = style.getPropertyValue('--d-warning').trim();
  const accent = style.getPropertyValue('--d-accent').trim();
  return {
    matchBackground: withAlpha(warning, 0.3),
    matchOverviewRuler: warning,
    activeMatchBackground: withAlpha(accent, 0.5),
    activeMatchBorder: accent,
    activeMatchColorOverviewRuler: accent,
  };
}
