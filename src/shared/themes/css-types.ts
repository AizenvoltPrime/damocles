// What the sanitizer reports about a theme's custom CSS, as the wire and the renderers carry it. Kept apart from
// css-sanitizer.ts so a type import never pulls css-tree into a program that does not run the sanitizer.
import type { CssRegion } from './schema';

export const CSS_DROP_REASONS = [
  'regionTooLarge', 'totalTooLarge', 'tooManyRules', 'selectorTooLong', 'nestedRule', 'parseError',
  'atRule', 'mediaFeature', 'selector', 'pseudoElement',
  'property', 'valueOutOfRange', 'function', 'url', 'colorAlpha', 'fontFamily',
] as const;
export type CssDropReason = (typeof CSS_DROP_REASONS)[number];

export const CSS_DROPPED_TEXT_CHARS = 120;
export const CSS_REGION_LIMIT_BYTES: number = 32 * 1024;
export const CSS_TOTAL_LIMIT_BYTES: number = 64 * 1024;
export const CSS_MAX_RULES = 400;
export const CSS_MAX_SELECTOR_CHARS = 512;
export const CSS_MAX_DATA_URL_CHARS: number = 16 * 1024;
// The least opacity a text color may have unless it is a token.
export const CSS_MIN_TEXT_ALPHA = 0.4;

export interface CssDroppedPart {
  readonly region: CssRegion;
  readonly reason: CssDropReason;
  // the dropped source, whitespace collapsed, at most CSS_DROPPED_TEXT_CHARS characters, raw: renderers show it as text only
  readonly text: string;
  // 1-based line in the region's source
  readonly line?: number;
}

export interface CssDropReasonArgs {
  readonly named: Readonly<Record<string, string>>;
  // picks the message's plural form
  readonly count?: number;
}

/** The limit a drop reason's message names, as that message's placeholders in `locale`. */
export function cssDropReasonArgs(reason: CssDropReason, locale: string): CssDropReasonArgs {
  const number = (value: number): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  switch (reason) {
    case 'regionTooLarge':
      return { named: { limit: number(CSS_REGION_LIMIT_BYTES / 1024) } };
    case 'totalTooLarge':
      return { named: { limit: number(CSS_TOTAL_LIMIT_BYTES / 1024) } };
    case 'tooManyRules':
      return { named: { n: number(CSS_MAX_RULES) }, count: CSS_MAX_RULES };
    case 'selectorTooLong':
      return { named: { n: number(CSS_MAX_SELECTOR_CHARS) }, count: CSS_MAX_SELECTOR_CHARS };
    case 'url':
      return { named: { limit: number(CSS_MAX_DATA_URL_CHARS / 1024) } };
    case 'colorAlpha':
      return { named: { percent: new Intl.NumberFormat(locale, { style: 'percent' }).format(CSS_MIN_TEXT_ALPHA) } };
    default:
      return { named: {} };
  }
}
