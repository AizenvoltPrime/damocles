// The CSS main gives each renderer for the shown look (docs/invariants.md "Desktop themes"). Pure: no electron, no files.
import { BUILTIN_PALETTES } from '../../../shared/themes/builtin';
import { checkPalette } from '../../../shared/themes/contrast';
import { deriveLook } from '../../../shared/themes/derive';
import { BUILTIN_MONO_STACK, BUILTIN_UI_STACK, fontFaceCss } from '../../../shared/themes/fonts';
import { sanitizeThemeCss, themeCssFamilies } from '../../../shared/themes/css-sanitizer';
import type { CssRegion } from '../../../shared/themes/schema';
import { paletteCss } from '../../../shared/themes/palette-css';
import { styleTokens, TEXT_SIZE_RANGE, textSizeTokens, type ThemeStyle } from '../../../shared/themes/style';
import { APP_ORIGIN } from '../../app-urls';
import type { LookKind, ThemePalette } from '../../../shared/themes/tokens';
import type { ShownTheme } from './appearance';

// Derived palettes by theme id, kind and the look's own JSON, so an edit of the theme derives again.
const derived = new Map<string, ThemePalette>();
const MAX_DERIVED = 64;
const trusted = new WeakMap<ThemePalette, ThemePalette>();

/** Every token of the shown look: the built-in palette as it is, any other look derived from its colors and overrides. */
export function shownPalette(shown: Pick<ShownTheme, 'kind' | 'themeId' | 'look' | 'builtin'>): ThemePalette {
  if (shown.builtin) return BUILTIN_PALETTES[shown.kind];
  const key = `${shown.themeId}\n${shown.kind}\n${JSON.stringify(shown.look)}`;
  const known = derived.get(key);
  if (known) return known;
  const palette = deriveLook(shown.look.colors, shown.kind, shown.look.tokens);
  if (derived.size >= MAX_DERIVED) derived.clear();
  derived.set(key, palette);
  return palette;
}

/**
 * The palette trusted UI takes: the shown one while it passes every text contrast rule, else the built-in palette of its kind.
 * Warnings (fills below 3:1, the switch knob) keep the shown palette.
 */
export function trustedPalette(palette: ThemePalette, kind: LookKind): ThemePalette {
  if (palette === BUILTIN_PALETTES[kind]) return palette;
  const known = trusted.get(palette);
  if (known) return known;
  const result = checkPalette(palette, kind).every((issue) => issue.severity === 'warning') ? palette : BUILTIN_PALETTES[kind];
  trusted.set(palette, result);
  return result;
}

// region: shell and chat pages, where trusted UI carries data-trusted; root: the overlay and the notifier, which are trusted UI whole.
export type TrustedScope = 'region' | 'root';

/** Every token a page paints: the look's palette, the theme's style and the user's text size, which no theme sets. */
export function pagePalette(palette: ThemePalette, style: ThemeStyle | undefined, textSize: number, trusted = false): ThemePalette {
  return { ...palette, ...styleTokens(style, trusted), ...textSizeTokens(textSize) };
}

/** A page's theme CSS: the theme's bundled font faces, then its palette; Damocles' own faces come before it (FONT_FACE_CSS). */
export function pageCss(shown: Pick<ShownTheme, 'kind' | 'style' | 'assets'>, palette: ThemePalette, textSize: number): string {
  const faces = fontFaceCss({ ...(shown.style ? { style: shown.style } : {}), ...(shown.assets ? { assets: shown.assets } : {}) }, APP_ORIGIN);
  return `${faces ? `${faces}\n` : ''}${paletteCss(pagePalette(palette, shown.style, textSize), shown.kind)}`;
}

/**
 * Trusted UI's CSS: the trusted palette with the theme's style, except its fonts: trusted UI always uses Damocles' own. `extra`
 * sets tokens the trusted palette never derives, the surface alpha trusted cards keep over a wallpaper.
 */
export function trustedCss(palette: ThemePalette, kind: LookKind, scope: TrustedScope, style?: ThemeStyle, textSize: number = TEXT_SIZE_RANGE.default, extra: ThemePalette = {}): string {
  const css = paletteCss({ ...pagePalette(trustedPalette(palette, kind), style, textSize, true), ...extra }, kind, scope === 'root' ? ':root' : '[data-trusted]');
  // safety marks inside content areas keep the content's palette and take only Damocles' fonts, which the protected layer applies
  return scope === 'root' ? css : `${css}\n[data-trusted-mark] { --d-font: ${BUILTIN_UI_STACK}; --d-mono: ${BUILTIN_MONO_STACK}; }`;
}

// The regions whose scope roots each page has; the overlay, the notifier and the editor dock have none.
export type CustomCssPage = 'chat' | 'shell';
const PAGE_REGIONS: Readonly<Record<CustomCssPage, readonly CssRegion[]>> = {
  chat: ['transcript'],
  shell: ['sidebar', 'editorChrome', 'terminalChrome', 'titlebar'],
};

const scopedByTheme = new Map<string, Partial<Record<CssRegion, string>>>();
const MAX_SCOPED = 16;

/** The shown theme's custom CSS as the pages paint it: sanitized here again, whatever core stored, so only `scoped` output reaches a page. */
export function scopedThemeCss(shown: Pick<ShownTheme, 'css' | 'style'>): Partial<Record<CssRegion, string>> {
  if (shown.css === undefined) return {};
  const families = themeCssFamilies(shown);
  const key = JSON.stringify([shown.css, families]);
  const known = scopedByTheme.get(key);
  if (known) return known;
  const { scoped } = sanitizeThemeCss(shown.css, { families });
  if (scopedByTheme.size >= MAX_SCOPED) scopedByTheme.clear();
  scopedByTheme.set(key, scoped);
  return scoped;
}

/** The custom CSS one page gets: its regions' scoped CSS, or undefined when the theme styles none of them. */
export function pageCustomCss(scoped: Partial<Record<CssRegion, string>>, page: CustomCssPage): string | undefined {
  const parts = PAGE_REGIONS[page].flatMap((region) => (scoped[region] === undefined ? [] : [scoped[region]]));
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** What the window and every view paint before their page does: the look's --d-bg without any alpha an override gave it. */
export function opaqueBackground(palette: ThemePalette): string {
  return (palette['--d-bg'] ?? '#000000').slice(0, 7);
}
