import { describe, expect, it } from 'vitest';

import { BUILTIN_PALETTES, BUILTIN_THEME } from '../builtin';
import { deltaE, formatHex, fromOklch, over, parseHex, toOklch } from '../color';
import { AA, BACKGROUND_ANSI, checkPalette, contrast, describeIssue, NON_TEXT, TINTED_SURFACES } from '../contrast';
import { deriveLook, deriveLookDetails } from '../derive';
import { paletteCss } from '../palette-css';
import type { LookColors } from '../schema';
import {
  FONT_TOKENS, LOOK_KINDS, OPACITY_TOKEN, PALETTE_TOKENS, SAFETY_TOKENS, SEED_TONES, SHADOW_TOKEN, STYLE_TOKENS, SURFACE_ALPHA_TOKEN,
  type LookKind, type ThemePalette, type TokenName,
} from '../tokens';

// The tokens no seed reaches, which every look of a kind takes from the built-in palette as they are.
const fixedTokens = (kind: LookKind): readonly TokenName[] => [...FONT_TOKENS, ...STYLE_TOKENS, OPACITY_TOKEN, SURFACE_ALPHA_TOKEN, ...SAFETY_TOKENS, BACKGROUND_ANSI[kind]];

const shadowParts = (value: string): readonly [string, string] => {
  const match = /^(.*) (#[0-9a-f]{6,8})$/.exec(value)!;
  return [match[1]!, match[2]!];
};

/**
 * DeltaE OK between two colors as they paint: a translucent pair needs the same alpha and is compared over every surface a
 * tint sits on, since the built-in tints keep the reference hue while a derived tint is its fill.
 */
function paintedDistance(kind: LookKind, derived: string, builtin: string): number {
  const [a, b] = [parseHex(derived), parseHex(builtin)];
  if (!a || !b || a[3] !== b[3]) return Infinity;
  if (b[3] === 1) return deltaE(a, b);
  return Math.max(...TINTED_SURFACES.map((surface) => {
    const under = parseHex(BUILTIN_PALETTES[kind][surface]!)!;
    return deltaE(over(a, under), over(b, under));
  }));
}

// mulberry32: a seeded generator, so a failing sample reproduces.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeds a user could pick for `kind`: a background and panel of that kind's lightness, any text and any tones. */
function randomSeeds(next: () => number, kind: LookKind): LookColors {
  const surface = (l: number): string => formatHex(fromOklch({ l, c: next() * 0.04, h: next() * 360 }));
  const any = (): string => formatHex([next(), next(), next(), 1]);
  const l = kind === 'dark' ? 0.12 + next() * 0.16 : 0.93 + next() * 0.07;
  return {
    background: surface(l),
    panel: surface(Math.min(1, l + (next() - 0.5) * 0.06)),
    text: any(),
    ...(Object.fromEntries(SEED_TONES.map((tone) => [tone, any()])) as Pick<LookColors, (typeof SEED_TONES)[number]>),
  };
}

describe('deriveLook', () => {
  it.each(LOOK_KINDS)('gives the built-in %s palette exactly from the built-in seeds and overrides', (kind) => {
    const look = BUILTIN_THEME.looks[kind]!;
    expect(deriveLook(look.colors, kind, look.tokens)).toEqual(BUILTIN_PALETTES[kind]);
  });

  it.each(LOOK_KINDS)('derives every %s token within deltaE 3 of the built-in palette from its seeds alone, and the fixed ones exactly', (kind) => {
    const derived = deriveLook(BUILTIN_THEME.looks[kind]!.colors, kind);
    const builtin = BUILTIN_PALETTES[kind];
    expect(Object.keys(derived).sort()).toEqual([...PALETTE_TOKENS].sort());
    const fixed = new Set(fixedTokens(kind));
    const far = PALETTE_TOKENS.flatMap((token) => {
      const [value, expected] = [derived[token]!, builtin[token]!];
      if (fixed.has(token)) return value === expected ? [] : [`${token}: ${value}, not the built-in ${expected}`];
      const [[geometry, color], [builtinGeometry, builtinColor]] = token === SHADOW_TOKEN ? [shadowParts(value), shadowParts(expected)] : [['', value], ['', expected]];
      const distance = geometry === builtinGeometry ? paintedDistance(kind, color, builtinColor) : Infinity;
      return distance <= 3 ? [] : [`${token}: ${value} vs ${expected} (${distance.toFixed(2)})`];
    });
    expect(far).toEqual([]);
  });

  it.each(LOOK_KINDS)('keeps a %s seed fill exact, moves only its text to AA and reports the text move', (kind) => {
    const colors = { ...BUILTIN_THEME.looks[kind]!.colors, accent: kind === 'dark' ? '#1d3b8a' : '#ffd84a' };
    const { palette, moved } = deriveLookDetails(colors, kind);
    expect(palette['--d-accent-fill']).toBe(colors.accent);
    expect(palette['--d-accent']).not.toBe(colors.accent);
    expect(moved).toEqual([{ tone: 'accent', role: 'text', token: '--d-accent', shown: palette['--d-accent'] }]);
    expect(checkPalette(palette, kind).map((issue) => issue.rule)).toEqual(['fill', 'fill']);
  });

  it('reports no move of a token an Advanced override replaces', () => {
    const colors = { ...BUILTIN_THEME.looks.dark!.colors, accent: '#1d3b8a' };
    expect(deriveLookDetails(colors, 'dark', { '--d-accent': '#8ab4ff' }).moved).toEqual([]);
  });

  // White reaches 4.43:1 on #d728aa and the near-black about 4.35:1; a light success fill takes the near-black.
  it.each(LOOK_KINDS)('moves a %s fill neither label reaches AA on to the nearest lightness where one does, hue and chroma kept', (kind) => {
    const seed = '#d728aa';
    const { palette, moved } = deriveLookDetails({ ...BUILTIN_THEME.looks[kind]!.colors, accent: seed, success: '#ffd84a' }, kind);
    const nearBlack = palette['--d-on-success']!;
    expect(nearBlack).not.toBe('#ffffff');
    expect(Math.max(contrast('#ffffff', seed), contrast(nearBlack, seed))).toBeLessThan(AA);
    const fill = palette['--d-accent-fill']!;
    expect([nearBlack, '#ffffff']).toContain(palette['--d-on-accent']);
    expect(contrast(palette['--d-on-accent']!, fill)).toBeGreaterThanOrEqual(AA);
    const [before, after] = [toOklch(parseHex(seed)!), toOklch(parseHex(fill)!)];
    expect(Math.abs(after.l - before.l)).toBeLessThan(0.01);
    expect(Math.abs(after.h - before.h)).toBeLessThan(1);
    expect(Math.abs(after.c - before.c)).toBeLessThan(0.01);
    expect(moved).toContainEqual({ tone: 'accent', role: 'fill', token: '--d-accent-fill', shown: fill });
  });

  // On these surfaces no faint reaching 4.5:1 is within 3:1 of a white knob (white on hover is below 13.5:1).
  it('gives a dark accent fill on lighter dark surfaces the near-black knob, lightening the fill until it reaches AA', () => {
    const colors = { ...BUILTIN_THEME.looks.dark!.colors, background: '#241c2b', panel: '#182c23', accent: '#5e0764' };
    const { palette, moved } = deriveLookDetails(colors, 'dark');
    expect(contrast('#ffffff', palette['--d-hover']!)).toBeLessThan(AA * NON_TEXT);
    expect(palette['--d-on-accent']).not.toBe('#ffffff');
    expect(contrast(palette['--d-on-accent']!, palette['--d-faint']!)).toBeGreaterThanOrEqual(NON_TEXT);
    expect(contrast(palette['--d-on-accent']!, palette['--d-accent-fill']!)).toBeGreaterThanOrEqual(AA);
    expect(moved).toContainEqual({ tone: 'accent', role: 'fill', token: '--d-accent-fill', shown: palette['--d-accent-fill'] });
    expect(checkPalette(palette, 'dark').filter((issue) => issue.rule !== 'fill').map(describeIssue)).toEqual([]);
  });

  it('applies overrides last, lowercased, and ignores a malformed or non-overridable one', () => {
    const derived = deriveLook(BUILTIN_THEME.looks.dark!.colors, 'dark', { '--d-muted': '#ABCDEF', '--d-text': 'red', '--d-safety-danger': '#000000', '--d-font': "'Comic Sans'" });
    expect(derived['--d-muted']).toBe('#abcdef');
    expect(derived['--d-text']).toBe(BUILTIN_PALETTES.dark['--d-text']);
    expect(derived['--d-safety-danger']).toBe(BUILTIN_PALETTES.dark['--d-safety-danger']);
    expect(derived['--d-font']).toBe(BUILTIN_PALETTES.dark['--d-font']);
  });

  it.each(LOOK_KINDS)('writes the built-in and derived %s palettes as CSS, and refuses a value that could break out of it', (kind) => {
    expect(paletteCss(BUILTIN_PALETTES[kind], kind)).toMatch(new RegExp(`^:root \\{ color-scheme: ${kind}; .*--d-bg: ${BUILTIN_PALETTES[kind]['--d-bg']}; .* \\}$`));
    expect(() => paletteCss(deriveLook(BUILTIN_THEME.looks[kind]!.colors, kind), kind)).not.toThrow();
    expect(() => paletteCss({ ...BUILTIN_PALETTES[kind], '--d-bg': 'red; } body { display: none' }, kind)).toThrow(/--d-bg/);
    expect(() => paletteCss({ ...BUILTIN_PALETTES[kind], '--d-font': "'Geist'; } x {" }, kind)).toThrow(/--d-font/);
    expect(() => paletteCss({ ...BUILTIN_PALETTES[kind], '--d-x;}': '#000000' } as ThemePalette, kind)).toThrow();
  });

  // A fill seed below 3:1 on bg or panel is saved with its warning, the one rule derivation leaves to the user.
  it.each(LOOK_KINDS)('derives %s palettes from random seeds that pass every rule but the fill warnings', (kind) => {
    const next = random(kind === 'dark' ? 0x5eed : 0x11647);
    const failures = Array.from({ length: 150 }, () => randomSeeds(next, kind)).flatMap((colors) => {
      const derived = deriveLook(colors, kind);
      const issues = checkPalette(derived, kind).filter((issue) => issue.rule !== 'fill');
      return issues.length === 0 ? [] : [`${JSON.stringify(colors)}: ${issues.map(describeIssue).join('; ')}`];
    });
    expect(failures).toEqual([]);
  });
});
