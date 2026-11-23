import { describe, expect, it } from 'vitest';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { AA, checkPalette, contrast, NON_TEXT } from '@shared/themes/contrast';
import { deriveLook } from '@shared/themes/derive';
import { colorWarnings, floorRatio, issueBackdrop, lightnessFix } from '../overlay/theme-editor/colors';
import { durationParts, stableStringify } from '../overlay/theme-editor/format';

// The theme editor's pure parts: the contrast warnings on a look's 8 colors and their lightness fix, which surfaces a
// failing pair reads, and how ratios, durations and drafts are written and compared.
const DARK = BUILTIN_THEME.looks.dark!.colors;

describe('colorWarnings', () => {
  it('finds nothing in a look whose colors pass', () => {
    expect(colorWarnings(DARK)).toEqual([]);
  });

  it('names the surface a color fails worst on, what it needs, and a fix that passes on both surfaces', () => {
    const [warning, ...rest] = colorWarnings({ ...DARK, text: '#6b7280' });
    expect(rest).toEqual([]);
    expect(warning).toMatchObject({ seed: 'text', need: AA, on: 'panel' });
    expect(warning!.ratio).toBeLessThan(AA);
    expect(contrast(warning!.fixed!, DARK.background)).toBeGreaterThanOrEqual(AA);
    expect(contrast(warning!.fixed!, DARK.panel)).toBeGreaterThanOrEqual(AA);
    expect(warning!.fixedRatio).toBe(contrast(warning!.fixed!, DARK.panel));
  });

  it('holds a tone\'s fill to 3:1, not to 4.5:1', () => {
    const dim = colorWarnings({ ...DARK, accent: '#2a3b55' });
    expect(dim).toHaveLength(1);
    expect(dim[0]).toMatchObject({ seed: 'accent', need: NON_TEXT });
  });

  it('offers no fix when no lightness passes on both surfaces', () => {
    const [warning] = colorWarnings({ ...DARK, background: '#000000', panel: '#999999' }).filter((candidate) => candidate.seed === 'text');
    expect(warning).toMatchObject({ seed: 'text', on: 'panel' });
    expect(warning).not.toHaveProperty('fixed');
    expect(warning).not.toHaveProperty('fixedRatio');
  });

  it('judges nothing against a translucent surface', () => {
    expect(colorWarnings({ ...DARK, background: '#10141880', text: '#000000' })).toEqual([]);
  });
});

describe('lightnessFix', () => {
  it('moves only the lightness, to the nearest value that passes, and keeps a color that already passes', () => {
    expect(lightnessFix('#e6edf3', ['#101418'], AA)).toBe('#e6edf3');
    const fixed = lightnessFix('#6b7280', ['#101418', '#151a20'], AA)!;
    expect(fixed).not.toBe('#6b7280');
    expect(contrast(fixed, '#151a20')).toBeGreaterThanOrEqual(AA);
  });

  it('answers nothing when no lightness passes, or the color cannot be read', () => {
    expect(lightnessFix('#e6edf3', ['#000000', '#999999'], AA)).toBeUndefined();
    expect(lightnessFix('nope', ['#000000'], AA)).toBeUndefined();
  });
});

describe('floorRatio', () => {
  it('rounds down to a tenth, so a ratio below a threshold never reads as the threshold', () => {
    expect(floorRatio(4.46)).toBe(4.4);
    expect(floorRatio(4.5)).toBe(4.5);
    expect(floorRatio(2.999)).toBe(2.9);
    expect(floorRatio(21)).toBe(21);
  });
});

describe('issueBackdrop', () => {
  it('names the surface a failing text pair reads, and both colors of a tinted row', () => {
    const palette = { ...deriveLook(DARK, 'dark'), '--d-bg': '#ffffff' };
    const issues = checkPalette(palette, 'dark');
    const text = issues.find((issue) => issue.rule === 'text' && issue.fg === '--d-text' && issue.bg === '--d-bg')!;
    expect(issueBackdrop(text, 'dark')).toEqual(['--d-bg']);
    const row = issues.find((issue) => issue.rule === 'row-text' && issue.bg.endsWith('over --d-bg'))!;
    expect(issueBackdrop(row, 'dark')).toHaveLength(2);
    expect(issueBackdrop(row, 'dark')[1]).toBe('--d-bg');
  });

  it('names no surface for a color that cannot be read', () => {
    const [format] = checkPalette({ ...deriveLook(DARK, 'dark'), '--d-card': '#15203080' }, 'dark').filter((issue) => issue.rule === 'format');
    expect(format).toMatchObject({ fg: '--d-card' });
    expect(issueBackdrop(format!, 'dark')).toEqual([]);
  });
});

describe('durationParts', () => {
  it('rounds to a tenth of a second before it splits minutes from seconds', () => {
    expect(durationParts(500)).toEqual({ minutes: 0, seconds: 0.5 });
    expect(durationParts(59_960)).toEqual({ minutes: 1, seconds: 0 });
    expect(durationParts(59_940)).toEqual({ minutes: 0, seconds: 59.9 });
    expect(durationParts(125_040)).toEqual({ minutes: 2, seconds: 5 });
  });
});

describe('stableStringify', () => {
  it('writes the same text for the same theme whatever order its keys were set in, and keeps the order of lists', () => {
    expect(stableStringify({ name: 'Dusk', author: 'me', looks: { dark: { b: 1, a: 2 } } })).toBe(stableStringify({ looks: { dark: { a: 2, b: 1 } }, author: 'me', name: 'Dusk' }));
    expect(stableStringify({ list: [2, 1] })).not.toBe(stableStringify({ list: [1, 2] }));
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});
