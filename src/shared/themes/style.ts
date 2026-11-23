// The tokens a theme's style and the user's text size set (docs/themes.md "Style"). Pure: core, main and the renderers import it.
import { fontStack } from './fonts';
import { CHAT_COLUMN_RANGE, DENSITY_RANGE, LINE_HEIGHT_RANGE, RADIUS_RANGE } from './limits';
import type { ThemeFile } from './schema';
import type { ThemePalette, TokenName } from './tokens';

export { CHAT_COLUMN_RANGE, DENSITY_RANGE, LINE_HEIGHT_RANGE, RADIUS_RANGE } from './limits';

export type ThemeStyle = NonNullable<ThemeFile['style']>;

// Today's .chat-column maximum, in rem; tokens.css keeps it in VS Code.
export const DEFAULT_CHAT_COLUMN = 50;

// damocles.desktop.textSize in px; 13 is the size every rem in the renderers was drawn at.
export const TEXT_SIZE_RANGE = { min: 11, max: 20, default: 13 } as const;

const clamp = (value: number, range: { readonly min: number; readonly max: number }): number => Math.min(range.max, Math.max(range.min, value));
const number = (value: number): string => String(Math.round(value * 1000) / 1000);

/** The text size setting as a whole px value in range; anything else reads as the default. */
export function parseTextSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(clamp(value, TEXT_SIZE_RANGE)) : TEXT_SIZE_RANGE.default;
}

/** --d-font-size and --d-mono-size of the user's text size; a theme never sets them. */
export function textSizeTokens(px: number): Readonly<Record<TokenName, string>> {
  const size = `${parseTextSize(px)}px`;
  return { '--d-font-size': size, '--d-mono-size': size };
}

/** The style tokens of a theme. `trusted`: trusted UI's, which keep Damocles' own fonts and take the rest of the style. */
export function styleTokens(style: ThemeStyle | undefined, trusted = false): ThemePalette {
  const column = style?.chatColumn;
  const density = clamp(style?.density ?? 1, DENSITY_RANGE);
  return {
    '--d-font': fontStack(trusted ? undefined : style?.fonts?.ui, 'ui'),
    '--d-mono': fontStack(trusted ? undefined : style?.fonts?.mono, 'mono'),
    '--d-line-scale': number(clamp(style?.lineHeight ?? 1, LINE_HEIGHT_RANGE)),
    '--d-radius-scale': number(clamp(style?.radius ?? 1, RADIUS_RANGE)),
    '--d-density': number(density),
    '--d-chat-column': column === 'full' ? '100%' : `${number(clamp(column ?? DEFAULT_CHAT_COLUMN, CHAT_COLUMN_RANGE))}rem`,
    // auto leaves every control as it is; a denser theme keeps each one a 1.5rem target (WCAG 2.5.8)
    '--d-hit-min': density < 1 ? '1.5rem' : 'auto',
  };
}
