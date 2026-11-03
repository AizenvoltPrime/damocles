import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalHexColor, hexColorParts, type HexColor } from '../../../shared/hex-color';
import { HOST_TONES } from '../../../shared/host-colors';
import { DARK_THEME, LIGHT_THEME, type ThemePalette } from '../../theme-palettes';

// WCAG 2.2 AA for normal-size text: a host's badge label and its title bar stripe label in every palette tone.
const AA = 4.5;
const ROOT = path.resolve(__dirname, '../../../..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

// The surfaces a host badge sits on: the Projects list (plain, hovered, selected), the chat page, cards and dialogs.
const BADGE_SURFACES = ['--d-bg', '--d-panel', '--d-card', '--d-hover', '--d-input'] as const;

type Rgba = readonly [number, number, number, number];

function parse(hex: string): Rgba {
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) throw new Error(`${hex} is not a #rrggbb or #rrggbbaa color`);
  const channel = (i: number): number => (i < hex.length ? Number.parseInt(hex.slice(i, i + 2), 16) / 255 : 1);
  return [channel(1), channel(3), channel(5), channel(7)];
}

function token(palette: ThemePalette, name: string): Rgba {
  const value = palette[name as `--d-${string}`];
  if (value === undefined) throw new Error(`${name} is not in the palette`);
  return parse(value);
}

/** color at alpha painted over an opaque surface, as color-mix toward transparent and then compositing does. */
function over(color: Rgba, alpha: number, surface: Rgba): Rgba {
  const a = color[3] * alpha;
  return [0, 1, 2].map((i) => color[i]! * a + surface[i]! * (1 - a)).concat(1) as unknown as Rgba;
}

function luminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// HostBadge tints its background with bg-(--tone)/<percent>; the test reads the percent so the two never drift apart.
function badgeTint(): number {
  const match = /bg-\(--tone\)\/(\d+)/.exec(read('src/webview/components/HostBadge.vue'));
  if (!match) throw new Error('HostBadge.vue has no bg-(--tone)/<percent> tint');
  return Number(match[1]) / 100;
}

// The .d-tone-<tone> rule of the shared stylesheet, which every badge, swatch and stripe of that tone takes.
function toneRule(tone: string): string {
  const match = new RegExp(`\\.d-tone-${tone}\\s*\\{([^}]*)\\}`).exec(read('src/webview/style.css'));
  if (!match) throw new Error(`style.css has no .d-tone-${tone} rule`);
  return match[1]!;
}

// Custom colors sampled over the corners and middle of the RGB cube, opaque, half and a tenth opaque.
const CUSTOM_SAMPLES: readonly HexColor[] = ['00', '80', 'ff'].flatMap((r) =>
  ['00', '80', 'ff'].flatMap((g) => ['00', '80', 'ff'].flatMap((b) => ['ff', '80', '1a'].map((a) => canonicalHexColor(`#${r}${g}${b}${a}`)!))),
);

function customColor(color: HexColor): { rgb: Rgba; alpha: number } {
  const { r, g, b, alpha } = hexColorParts(color);
  return { rgb: [r / 255, g / 255, b / 255, 1], alpha };
}

const BLACK: Rgba = [0, 0, 0, 1];
const WHITE: Rgba = [1, 1, 1, 1];

/** The label .d-tone-custom's --tone-on picks on a fill: white below WCAG luminance 0.179, black from it. */
const pickedLabel = (fill: Rgba): Rgba => (luminance(fill) < 0.179 ? WHITE : BLACK);

describe('host safety colors', () => {
  it.each(HOST_TONES)('.d-tone-%s gives a badge its text shade and a stripe label its solid-fill text', (tone) => {
    const rule = toneRule(tone);
    expect(rule).toContain(`--tone: var(--d-${tone});`);
    expect(rule).toContain(`color: var(--d-${tone}-text);`);
    expect(rule).toContain(`--tone-on: var(--d-on-${tone});`);
  });

  it('.d-tone-custom carries the opacity into --tone, labels a tint with --d-text and picks --tone-on over the composite', () => {
    const rule = toneRule('custom').replace(/\s+/g, ' ');
    expect(rule).toContain('--tone: rgb(var(--host-rgb) / var(--host-alpha));');
    expect(rule).toContain('color: var(--d-text);');
    const composite = 'color-mix(in srgb, rgb(var(--host-rgb)) calc(var(--host-alpha) * 100%), var(--tone-surface, var(--d-panel)))';
    const channel = 'clamp(0, (0.179 - (0.2126 * r + 0.7152 * g + 0.0722 * b)) * 1000000, 1)';
    expect(rule).toContain(`--tone-on: color(from ${composite} srgb-linear ${channel} ${channel} ${channel} / 1);`);
  });

  describe.each([
    ['dark', DARK_THEME],
    ['light', LIGHT_THEME],
  ] as const)('%s', (_kind, palette) => {
    it.each(HOST_TONES)('the %s badge label reaches AA on its tint over every surface it sits on', (tone) => {
      const tint = badgeTint();
      const text = token(palette, `--d-${tone}-text`);
      const failures = BADGE_SURFACES.flatMap((surface) => {
        const ratio = contrast(text, over(token(palette, `--d-${tone}`), tint, token(palette, surface)));
        return ratio >= AA ? [] : [`${surface}: ${ratio.toFixed(2)}`];
      });
      expect(failures).toEqual([]);
    });

    it.each(HOST_TONES)('the %s badge label reaches AA on a selected Projects row', (tone) => {
      const selected = over(token(palette, '--d-accent-soft'), 1, token(palette, '--d-panel'));
      const ratio = contrast(token(palette, `--d-${tone}-text`), over(token(palette, `--d-${tone}`), badgeTint(), selected));
      expect(ratio).toBeGreaterThanOrEqual(AA);
    });

    it.each(HOST_TONES)('the %s tone is a #rrggbb color, which the custom color picker starts from', (tone) => {
      expect(canonicalHexColor(palette[`--d-${tone}`] ?? '')).toMatch(/^#[0-9a-f]{6}ff$/);
    });

    // WCAG 1.4.11: a custom color has no contrast floor, so a custom-colored Projects group's icon keeps the header's
    // --d-muted, and --d-text when hovered (projects-view.test.ts).
    it('a Projects group header icon reaches 3:1 non-text contrast on its plain and hovered row', () => {
      expect(contrast(token(palette, '--d-muted'), token(palette, '--d-panel'))).toBeGreaterThanOrEqual(3);
      expect(contrast(token(palette, '--d-text'), token(palette, '--d-hover'))).toBeGreaterThanOrEqual(3);
    });

    it.each(HOST_TONES)('the %s stripe label reaches AA on the solid fill', (tone) => {
      expect(contrast(token(palette, `--d-on-${tone}`), token(palette, `--d-${tone}`))).toBeGreaterThanOrEqual(AA);
    });

    it('--d-text reaches AA on the badge tint of every sampled custom color over every surface it sits on', () => {
      const text = token(palette, '--d-text');
      const failures = CUSTOM_SAMPLES.flatMap((color) => {
        const { rgb, alpha } = customColor(color);
        return BADGE_SURFACES.flatMap((surface) => {
          const ratio = contrast(text, over(rgb, alpha * badgeTint(), token(palette, surface)));
          return ratio >= AA ? [] : [`${color} on ${surface}: ${ratio.toFixed(2)}`];
        });
      });
      expect(failures).toEqual([]);
    });

    it('the luminance-picked label reaches AA on every sampled custom color composited over --d-panel', () => {
      const failures = CUSTOM_SAMPLES.flatMap((color) => {
        const { rgb, alpha } = customColor(color);
        const fill = over(rgb, alpha, token(palette, '--d-panel'));
        const ratio = contrast(pickedLabel(fill), fill);
        return ratio >= AA ? [] : [`${color}: ${ratio.toFixed(2)}`];
      });
      expect(failures).toEqual([]);
    });
  });
});
