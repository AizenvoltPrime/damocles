import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() } }));

import { DARK_THEME, LIGHT_THEME, type ThemePalette } from '../theme';

// WCAG 2.2 AA for normal-size text (D21). docs/invariants.md "Design tokens" lists every value adjusted to reach it.
const AA = 4.5;
const TEXT_TOKENS = ['--d-text', '--d-muted', '--d-faint', '--d-accent', '--d-success', '--d-warning', '--d-danger', '--d-info'] as const;
const SYNTAX_TOKENS = ['--s-kw', '--s-str', '--s-num', '--s-com', '--s-fn', '--s-type'] as const;
const SURFACES = ['--d-bg', '--d-panel', '--d-card', '--d-code'] as const;
const TONES = ['accent', 'success', 'warning', 'danger', 'info'] as const;
const TINTED_SURFACES = ['--d-bg', '--d-panel', '--d-card', '--d-hover', '--d-code'] as const;
// The strongest tint of its own tone that a tone's text sits on; docs/invariants.md "Design tokens" states it.
const MAX_TINT = 0.22;
// The translucent rows (selected, added, deleted) and the text drawn on each; a hovered row is the opaque --d-hover.
const ROW_TEXT = ['--d-text', '--d-muted', '--d-faint-text'] as const;
const TINTED_ROWS = {
  '--d-accent-soft': [...ROW_TEXT, '--d-accent-text'],
  '--d-add': [...ROW_TEXT, '--d-success-text'],
  '--d-del': [...ROW_TEXT, '--d-danger-text'],
} as const;
// Any row may take --d-hover under the pointer, so plain faint text must pass there too.
const HOVER_TEXT = [...ROW_TEXT, '--d-faint', ...TONES.map((tone) => `--d-${tone}-text`)];

/** sRGB channels and alpha, each 0 to 1. */
type Rgba = readonly [number, number, number, number];
const TRANSPARENT: Rgba = [0, 0, 0, 0];

function color(palette: ThemePalette, token: string): Rgba {
  const value = palette[token as `--d-${string}`];
  if (value === undefined || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) throw new Error(`${token} is ${value}, not a #rrggbb or #rrggbbaa color`);
  return parse(value);
}

function parse(hex: string): Rgba {
  const channel = (i: number): number => (i < hex.length ? Number.parseInt(hex.slice(i, i + 2), 16) / 255 : 1);
  return [channel(1), channel(3), channel(5), channel(7)];
}

function opaque(palette: ThemePalette, token: string): Rgba {
  const value = color(palette, token);
  if (value[3] !== 1) throw new Error(`${token} is translucent`);
  return value;
}

// color-mix(in srgb, a p, b): interpolates premultiplied channels, so mixing toward transparent keeps a's color at alpha p.
function colorMix(a: Rgba, p: number, b: Rgba): Rgba {
  const alpha = a[3] * p + b[3] * (1 - p);
  if (alpha === 0) return TRANSPARENT;
  const channel = (i: 0 | 1 | 2): number => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

/** A translucent color painted over an opaque surface. */
function over(top: Rgba, surface: Rgba): Rgba {
  return colorMix([top[0], top[1], top[2], 1], top[3], surface);
}

function luminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgba | string, b: Rgba | string): number {
  const [hi, lo] = [a, b].map((c) => luminance(typeof c === 'string' ? parse(c) : c)).sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function failures(palette: ThemePalette, foregrounds: readonly string[], backgrounds: readonly string[]): string[] {
  return foregrounds.flatMap((fg) => backgrounds.flatMap((bg) => {
    const ratio = contrast(opaque(palette, fg), opaque(palette, bg));
    return ratio >= AA ? [] : [`${fg} on ${bg}: ${ratio.toFixed(2)}`];
  }));
}

/** `text` on each `tint` painted over every tinted surface; a tint is a palette token or a [label, color] pair. */
function tintFailures(palette: ThemePalette, text: string, tints: readonly (string | readonly [string, Rgba])[]): string[] {
  const fg = opaque(palette, text);
  return tints.flatMap((tint) => {
    const [label, top] = typeof tint === 'string' ? [tint, color(palette, tint)] : tint;
    return TINTED_SURFACES.flatMap((surface) => {
      const ratio = contrast(fg, over(top, opaque(palette, surface)));
      return ratio >= AA ? [] : [`${text} on ${label} over ${surface}: ${ratio.toFixed(2)}`];
    });
  });
}

describe('desktop palette contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('mixes and paints like CSS color-mix(in srgb) over an opaque surface', () => {
    const tint = colorMix(parse('#ff0000'), 0.25, TRANSPARENT);
    expect(tint).toEqual([1, 0, 0, 0.25]);
    expect(over(tint, parse('#ffffff')).map((c) => Math.round(c * 255))).toEqual([255, 191, 191, 255]);
    expect(colorMix(parse('#000000'), 0.5, parse('#ffffff')).map((c) => Math.round(c * 255))).toEqual([128, 128, 128, 255]);
  });

  // tokens.css picks VS Code's --d-on-danger and --d-on-warning the same way: white below luminance 0.179, else black.
  it.each(['#f85149', '#f48771', '#a1260d', '#b5200d', '#cca700', '#bf8803', '#ffd370', '#895503'])('the VS Code foreground on a solid status fill reaches AA on %s', (fill) => {
    const on = luminance(parse(fill)) < 0.179 ? '#ffffff' : '#000000';
    expect(contrast(on, fill)).toBeGreaterThanOrEqual(AA);
  });

  describe.each([
    ['dark', DARK_THEME, '--d-ansi-0'],
    ['light', LIGHT_THEME, '--d-ansi-15'],
  ] as const)('%s', (_kind, palette, backgroundAnsi) => {
    it('text and syntax tokens reach AA on bg, panel, card and code', () => {
      expect(failures(palette, [...TEXT_TOKENS, ...SYNTAX_TOKENS], SURFACES)).toEqual([]);
    });

    it('text on an accent, danger or warning fill reaches AA', () => {
      expect(failures(palette, ['--d-on-accent'], ['--d-accent'])).toEqual([]);
      expect(failures(palette, ['--d-on-danger'], ['--d-danger'])).toEqual([]);
      expect(failures(palette, ['--d-on-warning'], ['--d-warning'])).toEqual([]);
    });

    it.each(TONES)('--d-%s-text reaches AA on its tone tinted up to MAX_TINT over every surface', (tone) => {
      const tint = [`--d-${tone} ${MAX_TINT * 100}%`, colorMix(color(palette, `--d-${tone}`), MAX_TINT, TRANSPARENT)] as const;
      expect(tintFailures(palette, `--d-${tone}-text`, [tint])).toEqual([]);
    });

    it.each(Object.entries(TINTED_ROWS))('text on a %s row reaches AA over every surface', (row, texts) => {
      expect(texts.flatMap((text) => tintFailures(palette, text, [row]))).toEqual([]);
    });

    it('text on a hovered row reaches AA', () => {
      expect(failures(palette, HOVER_TEXT, ['--d-hover'])).toEqual([]);
    });

    // ToggleSwitch's knob on its off track (WCAG 1.4.11 non-text contrast).
    it('the switch knob (on-accent) reaches 3:1 on the off track (faint)', () => {
      expect(contrast(opaque(palette, '--d-on-accent'), opaque(palette, '--d-faint'))).toBeGreaterThanOrEqual(3);
    });

    // The ANSI slot of the background's own polarity (black on dark, bright white on light) is a fill, not text.
    it('every ANSI color used as text reaches AA on bg, panel and card', () => {
      const ansi = Array.from({ length: 16 }, (_, i) => `--d-ansi-${i}`).filter((token) => token !== backgroundAnsi);
      expect(failures(palette, ansi, ['--d-bg', '--d-panel', '--d-card'])).toEqual([]);
    });
  });
});
