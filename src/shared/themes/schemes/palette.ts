// The color roles a desktop color scheme gives one look, and the look they make over a set of default seeds.
import type { LocalizedText } from '../../localized-text';
import { formatHex, over, parseHex, type Rgba } from '../color';
import { LOOK_SEEDS, type Look, type LookColors } from '../schema';
import type { LookKind, TokenName } from '../tokens';
import { CSS_NAMED_COLORS } from './css-colors';

export type LookSeed = (typeof LOOK_SEEDS)[number];

/** One look's colors as a scheme sets them: `#rrggbb` or `#rrggbbaa`, each role the scheme leaves out absent. */
export interface PaletteRoles {
  readonly kind: LookKind;
  readonly seeds: Partial<Record<LookSeed, string>>;
  readonly tokens: Partial<Record<TokenName, string>>;
  // seeds the scheme sets to a value its parser could not read and already warned about: absent from `seeds`, yet not left out
  readonly unread?: readonly LookSeed[];
}

/** What a scheme parser read: its own name as written, the roles of each kind it covers, and what the card warns about. */
export interface SchemeRoles {
  readonly name?: string;
  readonly palettes: Partial<Record<LookKind, PaletteRoles>>;
  readonly warnings: readonly LocalizedText[];
}

/** `color` as opaque lowercase `#rrggbb`, a translucent one painted over `under`; undefined when there is no color. */
export function opaqueOver(color: Rgba | undefined, under: string): string | undefined {
  if (!color) return undefined;
  return formatHex(color[3] < 1 ? over(color, parseHex(under) ?? [0, 0, 0, 1]) : color).slice(0, 7);
}

const QT_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8}|[0-9a-f]{9}|[0-9a-f]{12})$/i;

/**
 * A color as Qt's QColor names it: `#rgb`, `#rrggbb`, `#aarrggbb` (alpha first), `#rrrgggbbb`, `#rrrrggggbbbb`, or an SVG
 * color name in any case and spacing; undefined otherwise.
 */
export function qtColor(value: string): Rgba | undefined {
  const text = value.trim().toLowerCase();
  const named = CSS_NAMED_COLORS.get(text.replace(/[ \t]/g, ''));
  if (named !== undefined) return parseHex(named);
  if (!QT_HEX.test(text)) return undefined;
  const digits = text.slice(1);
  if (digits.length === 3) return parseHex(`#${[...digits].map((digit) => digit.repeat(2)).join('')}`);
  if (digits.length === 9 || digits.length === 12) {
    // QColor widens each 12-bit channel to 16 bits as (v << 4) | (v >> 8)
    const width = digits.length / 3;
    const channel = (i: number): number => {
      const v = Number.parseInt(digits.slice(i * width, (i + 1) * width), 16);
      return (width === 3 ? (v << 4) | (v >> 8) : v) / 0xffff;
    };
    return [channel(0), channel(1), channel(2), 1];
  }
  return parseHex(digits.length === 8 ? `#${digits.slice(2)}${digits.slice(0, 2)}` : text);
}

/**
 * The look `roles` make, each seed they leave out taken from `defaults`, and the seeds so taken. A translucent background is
 * painted over the defaults' background, and every other translucent color over the look's background.
 */
export function lookFromRoles(roles: PaletteRoles, defaults: LookColors): { readonly look: Look; readonly filled: readonly LookSeed[] } {
  const own = (value: string | undefined, under: string): string | undefined => (value === undefined ? undefined : opaqueOver(parseHex(value), under));
  const background = own(roles.seeds.background, defaults.background);
  const under = background ?? defaults.background;
  const filled: LookSeed[] = [];
  const colors = Object.fromEntries(LOOK_SEEDS.map((seed) => {
    const color = seed === 'background' ? background : own(roles.seeds[seed], under);
    if (color === undefined) filled.push(seed);
    return [seed, color ?? defaults[seed]];
  })) as unknown as LookColors;
  const tokens = Object.fromEntries((Object.entries(roles.tokens) as [TokenName, string][])
    .flatMap(([token, value]) => {
      const color = own(value, under);
      return color === undefined ? [] : [[token, color]];
    }));
  return { look: Object.keys(tokens).length > 0 ? { colors, tokens } : { colors }, filled };
}
