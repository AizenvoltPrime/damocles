import { describe, expect, it } from 'vitest';

import { BUILTIN_PALETTES } from '../builtin';
import { colorMix, deltaE, formatHex, fromOklch, parseHex, toOklch } from '../color';
import { backdropColor, checkPalette, contrast, contrastPairs, describeIssue, kindOfBackground, type ColorReader } from '../contrast';
import { LOOK_KINDS, type ThemePalette, type TokenName } from '../tokens';

describe('color', () => {
  it('reads and writes #rrggbb and #rrggbbaa', () => {
    expect(parseHex('#FF0000')).toEqual([1, 0, 0, 1]);
    expect(parseHex('#00000080')![3]).toBeCloseTo(128 / 255);
    expect(parseHex('#fff')).toBeUndefined();
    expect(parseHex('red')).toBeUndefined();
    expect(formatHex([1, 0.5, 0, 1])).toBe('#ff8000');
    expect(formatHex([0, 0, 0, 0.5])).toBe('#00000080');
  });

  it.each(['#0b0f14', '#4cc2ff', '#cd333a', '#ffffff', '#000000', '#7a3fd1'])('round-trips %s through OKLCH', (hex) => {
    expect(formatHex(fromOklch(toOklch(parseHex(hex)!)))).toBe(hex);
  });

  it('keeps lightness and hue and lowers chroma to fit the gamut', () => {
    const lch = { l: 0.7, c: 0.4, h: 140 };
    const fitted = toOklch(fromOklch(lch));
    expect(fitted.l).toBeCloseTo(0.7, 2);
    expect(fitted.h).toBeCloseTo(140, 0);
    expect(fitted.c).toBeLessThan(0.4);
  });

  it('measures OKLab deltaE on the 0 to 100 scale', () => {
    expect(deltaE(parseHex('#000000')!, parseHex('#ffffff')!)).toBeCloseTo(100, 0);
    expect(deltaE(parseHex('#4cc2ff')!, parseHex('#4cc2ff')!)).toBe(0);
  });
});

describe('kindOfBackground', () => {
  it('is light above luminance 0.4, ignoring alpha', () => {
    // #a9a9a9 has luminance 0.397 and #aaaaaa 0.402
    expect(kindOfBackground('#a9a9a9')).toBe('dark');
    expect(kindOfBackground('#aaaaaa')).toBe('light');
    expect(kindOfBackground('#aaaaaa00')).toBe('light');
    expect(kindOfBackground([0xaa / 255, 0xaa / 255, 0xaa / 255, 1])).toBe('light');
  });
});

describe.each(LOOK_KINDS)('checkPalette on the %s palette', (kind) => {
  const builtin = BUILTIN_PALETTES[kind];
  const read: ColorReader = (token) => parseHex(builtin[token] ?? '');

  it('passes the built-in palette', () => {
    expect(checkPalette(builtin, kind)).toEqual([]);
  });

  // Each rule's first pair, its text set to the color it sits on, must fail as that rule.
  it.each([...new Set(contrastPairs(kind).map((pair) => pair.rule))])('reports a broken %s pair', (rule) => {
    const pair = contrastPairs(kind).find((p) => p.rule === rule)!;
    const broken: ThemePalette = { ...builtin, [pair.fg]: formatHex(backdropColor(pair.bg, read)!) };
    const issue = checkPalette(broken, kind).find((i) => i.rule === rule && i.fg === pair.fg);
    expect(issue).toBeDefined();
    expect(issue!.ratio).toBeLessThan(pair.min);
    expect(issue!.severity).toBe(rule === 'fill' || rule === 'switch-knob' ? 'warning' : 'error');
  });

  it('reports a missing, malformed or translucent text token as a format error', () => {
    const rest = Object.fromEntries(Object.entries(builtin).filter(([token]) => token !== '--d-muted'));
    const issues = checkPalette({ ...rest, '--d-faint': '#7f8b9980', '--d-text': 'white' } as ThemePalette, kind);
    expect(issues.filter((issue) => issue.rule === 'format').map((issue) => issue.fg).sort()).toEqual(['--d-faint', '--d-muted', '--d-text']);
  });

  it('composites a tint over its surface as CSS does', () => {
    const tint = backdropColor({ layer: '--d-accent-fill', alpha: 0.22, over: '--d-panel' }, read)!;
    const expected = colorMix(read('--d-accent-fill', true)!, 0.22, read('--d-panel', true)!);
    expect(formatHex(tint)).toBe(formatHex(expected));
  });

  it('describes an issue with its ratio and need', () => {
    const issue = checkPalette({ ...builtin, '--d-muted': builtin['--d-bg']! }, kind).find((i) => i.fg === ('--d-muted' as TokenName))!;
    expect(describeIssue(issue)).toMatch(/^--d-muted on --d-\w+: 1\.\d\d \(needs 4\.5\)$/);
    expect(contrast(builtin['--d-muted']!, builtin['--d-bg']!)).toBeGreaterThan(4.5);
  });
});
