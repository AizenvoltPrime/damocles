import { colorMix, over, parseHex, toLinear, TRANSPARENT, type Rgba } from './color';
import { fillToken, onToken, safetyOnToken, safetyToken, SEED_TONES, SYNTAX_TOKENS, TONES, toneTextToken, toneToken, type LookKind, type ThemePalette, type TokenName } from './tokens';

export { colorMix, over, TRANSPARENT, type Rgba } from './color';

// WCAG 2.2 AA for normal-size text and 1.4.11 non-text contrast. docs/invariants.md "Design tokens" lists every built-in value adjusted to reach them.
export const AA = 4.5;
export const NON_TEXT = 3;

/** A `#rrggbb` or `#rrggbbaa` color; throws on anything else. */
export function parse(hex: string): Rgba {
  const color = parseHex(hex);
  if (!color) throw new Error(`${hex} is not a #rrggbb or #rrggbbaa color`);
  return color;
}

export function luminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The kind of look a background makes, as `Rgba`, `#rrggbb` or `#rrggbbaa` with its alpha ignored: light above luminance 0.4. */
export function kindOfBackground(color: Rgba | string): LookKind {
  return luminance(typeof color === 'string' ? parse(color) : color) > 0.4 ? 'light' : 'dark';
}

export function contrast(a: Rgba | string, b: Rgba | string): number {
  const [hi, lo] = [a, b].map((c) => luminance(typeof c === 'string' ? parse(c) : c)).sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export const TEXT_TOKENS: readonly TokenName[] = ['--d-text', '--d-muted', '--d-faint', ...TONES.map(toneToken)];
export const SURFACES: readonly TokenName[] = ['--d-bg', '--d-panel', '--d-card', '--d-code'];
export const TINTED_SURFACES: readonly TokenName[] = ['--d-bg', '--d-panel', '--d-card', '--d-hover', '--d-code'];
// The strongest tint of its own tone that a tone's text sits on; docs/invariants.md "Design tokens" states it.
export const MAX_TINT = 0.22;
// DESIGN_STRIP (design-strip.ts): the design hue at 5% over the chat background, under the design header's labels.
export const DESIGN_STRIP_TINT = 0.05;
// The translucent rows (selected, added, deleted) and the text drawn on each; a hovered row is the opaque --d-hover.
export const ROW_TEXT: readonly TokenName[] = ['--d-text', '--d-muted', '--d-faint-text'];
export const TINTED_ROWS: Readonly<Record<string, readonly TokenName[]>> = {
  '--d-accent-soft': [...ROW_TEXT, '--d-accent-text'],
  '--d-add': [...ROW_TEXT, '--d-success-text'],
  '--d-del': [...ROW_TEXT, '--d-danger-text'],
};
// Any row may take --d-hover under the pointer, so plain faint text must pass there too.
export const HOVER_TEXT: readonly TokenName[] = [...ROW_TEXT, '--d-faint', ...TONES.map(toneTextToken)];
// The ANSI slot of the background's own polarity (black on dark, bright white on light) is a fill, not text.
export const BACKGROUND_ANSI: Readonly<Record<LookKind, TokenName>> = { dark: '--d-ansi-0', light: '--d-ansi-15' };

export type ContrastRule =
  | 'text' | 'on-fill' | 'tint-text' | 'row-text' | 'hover-text' | 'menu-hint' | 'design-strip' | 'ansi' | 'safety'
  // Non-text contrast (WCAG 1.4.11), warnings: a tone's fill below 3:1 on bg or panel, which the editor warns about and an
  // unfixed seed is saved with, and the switch knob, which derivation always meets and only an override can fail.
  | 'fill' | 'switch-knob';

const WARNING_RULES: ReadonlySet<ContrastRule> = new Set(['fill', 'switch-knob']);

/** What a pair's background is: an opaque token, or a translucent layer (a token at its own alpha, or at `alpha`) over one. */
export type Backdrop = { readonly token: TokenName } | { readonly layer: TokenName; readonly alpha?: number; readonly over: TokenName };

export interface ContrastPair {
  readonly rule: ContrastRule;
  readonly fg: TokenName;
  readonly bg: Backdrop;
  readonly min: number;
}

export interface ContrastIssue {
  readonly rule: ContrastRule | 'format';
  readonly severity: 'error' | 'warning';
  readonly fg: TokenName;
  readonly bg: string;
  readonly ratio: number;
  readonly min: number;
}

const opaque = (token: TokenName): Backdrop => ({ token });
const layered = (layer: TokenName, over: TokenName, alpha?: number): Backdrop => (alpha === undefined ? { layer, over } : { layer, alpha, over });
const each = (rule: ContrastRule, fgs: readonly TokenName[], bgs: readonly Backdrop[], min = AA): ContrastPair[] =>
  fgs.flatMap((fg) => bgs.map((bg) => ({ rule, fg, bg, min })));

/** Every contrast requirement of a palette of `kind`, the rules palette-contrast.test.ts holds the built-in looks to. */
export function contrastPairs(kind: LookKind): readonly ContrastPair[] {
  const ansi = Array.from({ length: 16 }, (_, i): TokenName => `--d-ansi-${i}`).filter((token) => token !== BACKGROUND_ANSI[kind]);
  return [
    ...each('text', [...TEXT_TOKENS, ...SYNTAX_TOKENS], SURFACES.map(opaque)),
    ...TONES.flatMap((tone) => each('on-fill', [onToken(tone)], [opaque(fillToken(tone))])),
    ...TONES.flatMap((tone) => each('tint-text', [toneTextToken(tone)], TINTED_SURFACES.map((surface) => layered(fillToken(tone), surface, MAX_TINT)))),
    ...Object.entries(TINTED_ROWS).flatMap(([row, texts]) => each('row-text', texts, TINTED_SURFACES.map((surface) => layered(row as TokenName, surface)))),
    ...each('hover-text', HOVER_TEXT, [opaque('--d-hover')]),
    // A menu row's hint (ContextMenu.vue) is faint-text on the card at rest; it alone tells same-named projects apart.
    ...each('menu-hint', ['--d-faint-text'], [opaque('--d-card')]),
    ...each('design-strip', ROW_TEXT, [layered(fillToken('design'), '--d-bg', DESIGN_STRIP_TINT)]),
    // ToggleSwitch's knob on its off track (WCAG 1.4.11 non-text contrast).
    ...each('switch-knob', ['--d-on-accent'], [opaque('--d-faint')], NON_TEXT),
    ...each('ansi', ansi, ['--d-bg', '--d-panel', '--d-card'].map((token) => opaque(token as TokenName))),
    ...SEED_TONES.flatMap((tone) => each('safety', [safetyOnToken(tone)], [opaque(safetyToken(tone))])),
    ...TONES.flatMap((tone) => each('fill', [fillToken(tone)], [opaque('--d-bg'), opaque('--d-panel')], NON_TEXT)),
  ];
}

/** The tokens a backdrop reads, the layer before what it lies over. */
export const backdropTokens = (bg: Backdrop): readonly TokenName[] => ('token' in bg ? [bg.token] : [bg.layer, bg.over]);

export const backdropLabel = (bg: Backdrop): string =>
  'token' in bg ? bg.token : `${bg.layer}${bg.alpha === undefined ? '' : ` ${Math.round(bg.alpha * 100)}%`} over ${bg.over}`;

/** Reads a token's color; `opaque` asks for an opaque one. Undefined when the token is missing, malformed or translucent where it must not be. */
export type ColorReader = (token: TokenName, opaque: boolean) => Rgba | undefined;

/** The opaque color a backdrop paints, composited as CSS does. */
export function backdropColor(bg: Backdrop, color: ColorReader): Rgba | undefined {
  if ('token' in bg) return color(bg.token, true);
  const [layer, base] = [color(bg.layer, false), color(bg.over, true)];
  if (!layer || !base) return undefined;
  return over(bg.alpha === undefined ? layer : colorMix(layer, bg.alpha, TRANSPARENT), base);
}

/** Every contrast rule a palette fails, plus a `format` error per unreadable token; only the non-text rules are warnings. */
export function checkPalette(palette: ThemePalette, kind: LookKind): ContrastIssue[] {
  const unreadable = new Set<TokenName>();
  const color: ColorReader = (token, opaque) => {
    const value = palette[token];
    const parsed = value === undefined ? undefined : parseHex(value);
    if (parsed && (!opaque || parsed[3] === 1)) return parsed;
    unreadable.add(token);
    return undefined;
  };
  const issues = contrastPairs(kind).flatMap((pair): ContrastIssue[] => {
    const fg = color(pair.fg, true);
    const bg = backdropColor(pair.bg, color);
    if (!fg || !bg) return [];
    const ratio = contrast(fg, bg);
    return ratio >= pair.min ? [] : [{ rule: pair.rule, severity: WARNING_RULES.has(pair.rule) ? 'warning' : 'error', fg: pair.fg, bg: backdropLabel(pair.bg), ratio, min: pair.min }];
  });
  const format = [...unreadable].map((fg): ContrastIssue => ({ rule: 'format', severity: 'error', fg, bg: 'missing, or not the #rrggbb color it must be', ratio: 0, min: 0 }));
  return [...format, ...issues];
}

/** Whether `palette` fails a text rule, which makes trusted UI take the built-in palette instead (trustedPalette). */
export const hasContrastError = (palette: ThemePalette, kind: LookKind): boolean => checkPalette(palette, kind).some((issue) => issue.severity === 'error');

export const describeIssue = (issue: ContrastIssue): string =>
  issue.rule === 'format' ? `${issue.fg}: ${issue.bg}` : `${issue.fg} on ${issue.bg}: ${issue.ratio.toFixed(2)} (needs ${issue.min})`;
