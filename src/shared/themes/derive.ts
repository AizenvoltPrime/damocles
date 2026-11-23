import { BUILTIN_PALETTES } from './builtin';
import { BLACK, colorMix, formatHex, fromOklch, parseHex, quantize, toOklch, WHITE, withAlpha, type Oklch, type Rgba } from './color';
import { AA, BACKGROUND_ANSI, backdropColor, contrast, contrastPairs, NON_TEXT, type ColorReader, type ContrastPair } from './contrast';
import type { LookColors } from './schema';
import {
  ANSI_TOKENS, fillToken, FONT_TOKENS, isValidTokenValue, onToken, OPACITY_TOKEN, OVERRIDABLE_TOKENS, PANE_SURFACES, PANE_TOKENS, SAFETY_TOKENS, SEED_TONES, SHADOW_TOKEN,
  STYLE_TOKENS, SURFACE_ALPHA_TOKEN, SYNTAX_TOKENS, TONES, toneTextToken, toneToken, type LookKind, type SeedTone, type ThemePalette, type Tone, type TokenName,
} from './tokens';

// deriveLook: a look's 8 colors to every token of its kind (plan section 5.6). Offsets, mix ratios and alphas come
// from the built-in palette of the kind, so the built-in seeds derive close to it; its overrides make it exact.

const DERIVED_SURFACES = ['--d-card', '--d-hover', '--d-border', '--d-border2', '--d-input', '--d-code'] as const;
const SURFACE_CHROMA_CAP = 0.1;
// Lightness steps of the search for the first passing value, in OKLCH L.
const L_STEP = 0.001;
const MIX_STEP = 0.005;

const builtinColor = (kind: LookKind, token: TokenName): Rgba => parseHex(BUILTIN_PALETTES[kind][token]!)!;
const alphaOf = (kind: LookKind, token: TokenName): number => builtinColor(kind, token)[3];

/** The share of `text` in a mix of `text` toward `panel` that best gives `target`, by least squares over the channels. */
function mixShare(text: Rgba, panel: Rgba, target: Rgba): number {
  const [num, den] = [0, 1, 2].reduce(([n, d], i) => [n + (target[i]! - panel[i]!) * (text[i]! - panel[i]!), d + (text[i]! - panel[i]!) ** 2], [0, 0]);
  return den === 0 ? 1 : Math.min(1, Math.max(0, num / den));
}

/** An OKLCH lightness and chroma offset from a base color. */
interface Step { readonly dl: number; readonly dc: number }

function stepOf(base: Rgba, target: Rgba): Step {
  const [from, to] = [toOklch(base), toOklch(target)];
  return { dl: to.l - from.l, dc: to.c - from.c };
}

/** `base` moved by `step`, its hue kept and its chroma capped. */
const stepped = (base: Oklch, { dl, dc }: Step): Rgba =>
  quantize(fromOklch({ l: base.l + dl, c: Math.min(SURFACE_CHROMA_CAP, Math.max(0, base.c + dc)), h: base.h }));

interface Reference {
  // from panel
  readonly surfaces: Readonly<Record<(typeof DERIVED_SURFACES)[number], Step>>;
  readonly muted: number;
  readonly faint: number;
  // from bg
  readonly scrim: Step;
  readonly shadow: Step;
  readonly shadowGeometry: string;
  readonly shadowAlpha: number;
}

function reference(kind: LookKind): Reference {
  const [bg, panel, text] = [builtinColor(kind, '--d-bg'), builtinColor(kind, '--d-panel'), builtinColor(kind, '--d-text')];
  const surfaces = Object.fromEntries(DERIVED_SURFACES.map((token) => [token, stepOf(panel, builtinColor(kind, token))])) as Reference['surfaces'];
  const shadow = /^(.*) (#[0-9a-f]{6,8})$/.exec(BUILTIN_PALETTES[kind][SHADOW_TOKEN]!)!;
  const shadowColor = parseHex(shadow[2]!)!;
  return {
    surfaces,
    muted: mixShare(text, panel, builtinColor(kind, '--d-muted')),
    faint: mixShare(text, panel, builtinColor(kind, '--d-faint')),
    scrim: stepOf(bg, builtinColor(kind, '--d-scrim')),
    shadow: stepOf(bg, shadowColor),
    shadowGeometry: shadow[1]!,
    shadowAlpha: shadowColor[3],
  };
}

const REFERENCES: Readonly<Record<LookKind, Reference>> = { dark: reference('dark'), light: reference('light') };

interface Constraint { readonly against: Rgba; readonly min: number }

const passes = (c: Rgba, constraints: readonly Constraint[]): boolean => constraints.every(({ against, min }) => contrast(c, against) >= min);
const worst = (c: Rgba, constraints: readonly Constraint[]): number => Math.min(...constraints.map(({ against, min }) => contrast(c, against) / min));

/** `seed` with its OKLCH lightness moved to the nearest value `ok` accepts, hue and chroma kept; undefined when none does. */
function moveLightness(seed: Rgba, ok: (c: Rgba) => boolean): Rgba | undefined {
  const start = quantize(seed);
  if (ok(start)) return start;
  const lch = toOklch(seed);
  for (let step = 1; step * L_STEP <= 1; step++) {
    for (const l of [lch.l + step * L_STEP, lch.l - step * L_STEP]) {
      if (l < 0 || l > 1) continue;
      const candidate = quantize(fromOklch({ ...lch, l }));
      if (ok(candidate)) return candidate;
    }
  }
  return undefined;
}

/** `seed` with its lightness moved to the nearest value that meets every constraint; white or black when none does. */
function adjustLightness(seed: Rgba, constraints: readonly Constraint[]): Rgba {
  return moveLightness(seed, (c) => passes(c, constraints)) ?? (worst(WHITE, constraints) >= worst(BLACK, constraints) ? WHITE : BLACK);
}

/**
 * The nearest mix of `from` toward `to` to share `start` of `to` that meets every constraint, looking toward `to` first,
 * else the first from `start` toward `to` that meets the text ones (AA); `to` itself at worst.
 */
function mixUntil(from: Rgba, to: Rgba, start: number, constraints: readonly Constraint[]): Rgba {
  const mix = (share: number): Rgba => quantize(colorMix(to, share, from));
  const forward: Rgba[] = [];
  for (let share = start; share < 1; share += MIX_STEP) forward.push(mix(share));
  const backward: Rgba[] = [];
  for (let share = start - MIX_STEP; share >= 0; share -= MIX_STEP) backward.push(mix(share));
  const text = constraints.filter(({ min }) => min >= AA);
  return forward.find((c) => passes(c, constraints)) ?? backward.find((c) => passes(c, constraints)) ?? forward.find((c) => passes(c, text)) ?? quantize(to);
}

/**
 * `seed` as a solid fill and the label of `labels` that contrasts most with it; when no label reaches AA on the seed, the
 * fill's lightness moves to the nearest value where one does.
 */
function labeledFill(seed: Rgba, labels: readonly Rgba[]): { readonly fill: Rgba; readonly label: Rgba } {
  const best = (fill: Rgba): Rgba => labels.reduce((a, b) => (contrast(b, fill) > contrast(a, fill) ? b : a));
  // white reaches AA on any fill dark enough and a near-black on any light enough, so the search always ends
  const fill = moveLightness(seed, (c) => contrast(best(c), c) >= AA)!;
  return { fill, label: best(fill) };
}

type Palette = Map<TokenName, Rgba>;

/** What `token` must contrast with, given the tokens derived so far: the pairs it is the text of, and the knob pair it is the track of. */
function constraintsOf(token: TokenName, pairs: readonly ContrastPair[], palette: Palette): Constraint[] {
  const read: ColorReader = (name, opaque) => {
    const c = palette.get(name);
    return c && (!opaque || c[3] === 1) ? c : undefined;
  };
  return pairs.flatMap((pair): Constraint[] => {
    if (pair.rule === 'fill') return [];
    const against = pair.fg === token ? backdropColor(pair.bg, read) : 'token' in pair.bg && pair.bg.token === token ? read(pair.fg, true) : undefined;
    return against ? [{ against, min: pair.min }] : [];
  });
}

/** A near-black of the background's hue, for text on light fills. */
function nearBlack(bg: Rgba): Rgba {
  const lch = toOklch(bg);
  return quantize(fromOklch({ l: 0.16, c: Math.min(lch.c, 0.04), h: lch.h }));
}

function seedColor(hex: string): Rgba {
  const c = parseHex(hex);
  if (!c || c[3] !== 1) throw new Error(`${hex} is not an opaque #rrggbb color`);
  return c;
}

/** Every color token of a `kind` palette from a look's 8 colors; `refused` names, per on-tone token, the hex of a label it may not take. */
function deriveColors(colors: LookColors, kind: LookKind, pairs: readonly ContrastPair[], refused: ReadonlyMap<TokenName, string>): Palette {
  const ref = REFERENCES[kind];
  const palette: Palette = new Map();
  const set = (token: TokenName, c: Rgba): Rgba => {
    palette.set(token, c);
    return c;
  };

  const bg = set('--d-bg', seedColor(colors.background));
  const panel = set('--d-panel', seedColor(colors.panel));
  const panelLch = toOklch(panel);
  for (const token of DERIVED_SURFACES) set(token, stepped(panelLch, ref.surfaces[token]));
  const bgLch = toOklch(bg);
  set('--d-scrim', withAlpha(stepped(bgLch, ref.scrim), alphaOf(kind, '--d-scrim')));

  // White or the near-black, whichever contrasts more with the fill; the fill moves only when neither reaches AA.
  const dark = nearBlack(bg);
  const fillSeeds = new Map<Tone, Rgba>(SEED_TONES.map((tone) => [tone, seedColor(colors[tone])]));
  fillSeeds.set('design', adjustLightness(builtinColor(kind, '--d-design-fill'), [bg, panel].map((against) => ({ against, min: NON_TEXT }))));
  for (const tone of TONES) {
    const labels = [WHITE, dark].filter((label) => formatHex(label) !== refused.get(onToken(tone)));
    const { fill, label } = labeledFill(fillSeeds.get(tone)!, labels);
    set(fillToken(tone), fill);
    set(onToken(tone), label);
  }

  set('--d-accent-soft', withAlpha(palette.get('--d-accent-fill')!, alphaOf(kind, '--d-accent-soft')));
  set('--d-add', withAlpha(palette.get('--d-success-fill')!, alphaOf(kind, '--d-add')));
  set('--d-del', withAlpha(palette.get('--d-danger-fill')!, alphaOf(kind, '--d-del')));

  // Every text token falls back to --d-text, so --d-text meets all their constraints but the switch knob's.
  const textFamily: readonly TokenName[] = ['--d-text', '--d-muted', '--d-faint', '--d-faint-text', ...TONES.map(toneTextToken)];
  const textPairs = pairs.filter((pair) => pair.rule !== 'switch-knob');
  const text = set('--d-text', adjustLightness(seedColor(colors.text), textFamily.flatMap((token) => constraintsOf(token, textPairs, palette))));

  for (const tone of TONES) set(toneToken(tone), adjustLightness(palette.get(fillToken(tone))!, constraintsOf(toneToken(tone), pairs, palette)));
  set('--d-muted', mixUntil(panel, text, ref.muted, constraintsOf('--d-muted', pairs, palette)));
  const faint = set('--d-faint', mixUntil(panel, text, ref.faint, constraintsOf('--d-faint', pairs, palette)));
  for (const tone of SEED_TONES) set(toneTextToken(tone), mixUntil(palette.get(toneToken(tone))!, text, 0, constraintsOf(toneTextToken(tone), pairs, palette)));
  // No seed names the design tone, so its text shade, like its fill, is the built-in one moved in lightness.
  set(toneTextToken('design'), adjustLightness(builtinColor(kind, toneTextToken('design')), constraintsOf(toneTextToken('design'), pairs, palette)));
  set('--d-faint-text', mixUntil(faint, text, 0, constraintsOf('--d-faint-text', pairs, palette)));

  for (const token of [...SYNTAX_TOKENS, ...ANSI_TOKENS]) {
    const builtin = builtinColor(kind, token);
    set(token, token === BACKGROUND_ANSI[kind] ? builtin : adjustLightness(builtin, constraintsOf(token, pairs, palette)));
  }
  return palette;
}

/** The hex of each on-tone label whose switch-knob pair `palette` fails, which that token must not take. */
function failedKnobs(palette: Palette, pairs: readonly ContrastPair[]): Map<TokenName, string> {
  return new Map(pairs.flatMap((pair): Array<[TokenName, string]> => {
    if (pair.rule !== 'switch-knob' || !('token' in pair.bg)) return [];
    const [knob, track] = [palette.get(pair.fg)!, palette.get(pair.bg.token)!];
    return contrast(knob, track) >= pair.min ? [] : [[pair.fg, formatHex(knob)]];
  }));
}

/** A seed tone whose fill or text color the derivation moved off the seed to keep 4.5:1, and the color it shows as. */
export interface SeedMove {
  readonly tone: SeedTone;
  readonly role: 'fill' | 'text';
  readonly token: TokenName;
  readonly shown: string;
}

export interface LookDerivation {
  /** Every token from the look's 8 colors alone. */
  readonly derived: ThemePalette;
  /** `derived` with the look's Advanced overrides applied. */
  readonly palette: ThemePalette;
  /** The seed colors the derivation moved, except where an override replaces the moved token. */
  readonly moved: readonly SeedMove[];
}

/** deriveLook's palette with the palette before overrides and the seed colors it moved. */
export function deriveLookDetails(colors: LookColors, kind: LookKind, tokens?: Readonly<Partial<Record<TokenName, string>>>): LookDerivation {
  const pairs = contrastPairs(kind);
  const first = deriveColors(colors, kind, pairs, new Map());
  // A knob that fails on its faint track takes the other label, which sits across the surfaces from faint and so passes.
  const refused = failedKnobs(first, pairs);
  const colorsOut = refused.size === 0 ? first : deriveColors(colors, kind, pairs, refused);

  const derived: Record<TokenName, string> = Object.fromEntries([...colorsOut].map(([token, c]) => [token, formatHex(c)]));
  derived[SHADOW_TOKEN] = `${REFERENCES[kind].shadowGeometry} ${formatHex(withAlpha(stepped(toOklch(colorsOut.get('--d-bg')!), REFERENCES[kind].shadow), REFERENCES[kind].shadowAlpha))}`;
  const fixed: readonly TokenName[] = [...FONT_TOKENS, ...STYLE_TOKENS, OPACITY_TOKEN, ...SAFETY_TOKENS];
  for (const token of fixed) derived[token] = BUILTIN_PALETTES[kind][token]!;

  const palette: Record<TokenName, string> = { ...derived };
  const overridable = new Set<TokenName>(OVERRIDABLE_TOKENS);
  const overridden = new Set<TokenName>();
  for (const [token, value] of Object.entries(tokens ?? {}) as [TokenName, string | undefined][]) {
    const lower = value?.toLowerCase();
    if (lower === undefined || !overridable.has(token) || !isValidTokenValue(token, lower)) continue;
    palette[token] = lower;
    overridden.add(token);
  }
  for (const out of [derived, palette]) {
    // opaque: a pane turns transparent only while it shows a wallpaper (wallpaperTokens)
    for (const [pane, token] of Object.entries(PANE_TOKENS) as [keyof typeof PANE_TOKENS, TokenName][]) out[token] = out[PANE_SURFACES[pane]]!.slice(0, 7);
    out[SURFACE_ALPHA_TOKEN] = '1';
  }

  const moved = SEED_TONES.flatMap((tone) => {
    const seed = formatHex(seedColor(colors[tone]));
    return ([['fill', fillToken(tone)], ['text', toneToken(tone)]] as const).flatMap(([role, token]): SeedMove[] =>
      derived[token] === seed || overridden.has(token) ? [] : [{ tone, role, token, shown: derived[token]! }]);
  });
  return { derived, palette, moved };
}

/** Every token of a `kind` palette from a look's 8 colors, then its Advanced overrides, which are format-checked but not enforced. */
export function deriveLook(colors: LookColors, kind: LookKind, tokens?: Readonly<Partial<Record<TokenName, string>>>): ThemePalette {
  return deriveLookDetails(colors, kind, tokens).palette;
}
