// qt5ct/qt6ct palettes: the QPalette role order, the optional Accent, the roles Qt lacks, and every refusal. The fixture is
// written for this test in the qt6ct layout; each role's color encodes its index, so a shifted role order shows.
import { describe, expect, it } from 'vitest';
import { formatHex } from '../color';
import { qtColor, qtRoles, qtRolesOfIni, QT_ROLES, readIni } from '../schemes';
import { refusal } from './scheme-refusal';

// role i is #ff1010<i as two hex digits>, Base and Window get their own so the kind is dark
const roleColor = (i: number): string => `#ff1010${i.toString(16).padStart(2, '0')}`;
const colors = (count: number, overrides: Readonly<Record<number, string>> = {}): string =>
  Array.from({ length: count }, (_, i) => overrides[i] ?? roleColor(i)).join(', ');
const conf = (list: string): string => `[ColorScheme]\nactive_colors=${list}\ndisabled_colors=${list}\ninactive_colors=${list}\n`;
const hexOf = (i: number): string => `#1010${i.toString(16).padStart(2, '0')}`;

describe('qtRoles', () => {
  it('reads Base, Window, Text, Highlight and Link in QPalette order, and PlaceholderText as --d-muted', () => {
    const roles = qtRoles(conf(colors(21)), 'fixture.conf');
    expect(roles.name).toBeUndefined();
    const palette = roles.palettes.dark!;
    expect(palette.kind).toBe('dark');
    expect(palette.seeds).toEqual({
      background: hexOf(QT_ROLES.indexOf('Base')), panel: hexOf(QT_ROLES.indexOf('Window')), text: hexOf(QT_ROLES.indexOf('Text')),
      accent: hexOf(QT_ROLES.indexOf('Highlight')), info: hexOf(QT_ROLES.indexOf('Link')),
    });
    expect(palette.tokens).toEqual({ '--d-muted': hexOf(QT_ROLES.indexOf('PlaceholderText')) });
    expect([9, 10, 6, 12, 14, 20]).toEqual(['Base', 'Window', 'Text', 'Highlight', 'Link', 'PlaceholderText'].map((role) => QT_ROLES.indexOf(role as never)));
  });

  it('takes the accent from Accent when Qt 6.6 wrote it, keeps alpha, and reads a light Base as a light look', () => {
    const roles = qtRoles(conf(colors(22, { 9: '#fff0f0f0', 6: '#80000000' })), 'light.conf');
    const palette = roles.palettes.light!;
    expect(palette.seeds.accent).toBe(hexOf(21));
    expect(palette.seeds.text).toBe('#00000080');
  });

  it('reads a palette written before PlaceholderText, with no --d-muted', () => {
    expect(qtRoles(conf(colors(20)), 'old.conf').palettes.dark!.tokens).toEqual({});
  });

  it('reads Accent without reading Highlight, and a comment after the list', () => {
    const roles = qtRoles(conf(`${colors(22, { 12: 'not-a-color' })} ; written by hand`), 'a.conf');
    expect(roles.palettes.dark!.seeds.accent).toBe(hexOf(21));
  });

  it('refuses a file without active_colors, a list shorter than 20, and a used role that is no color', () => {
    expect(refusal(() => qtRoles('[Appearance]\nstyle=Fusion\n', 'a.conf'))).toBe('noColors');
    expect(refusal(() => qtRoles(conf(colors(19)), 'a.conf'))).toBe('noColors');
    expect(refusal(() => qtRoles(conf(colors(21, { 10: 'not-a-color' })), 'a.conf'))).toBe('badColor');
    expect(refusal(() => qtRoles(conf(colors(21, { 9: '' })), 'a.conf'))).toBe('noColors');
  });

  it('lenient, reads a role that is no color as unset', () => {
    const { seeds } = qtRolesOfIni(readIni(conf(colors(21, { 10: 'not-a-color', 12: 'nope' })), 'a.conf'), 'a.conf', { lenient: true }).palettes.dark!;
    expect(seeds.panel).toBeUndefined();
    expect(seeds.accent).toBeUndefined();
    expect(seeds.background).toBe(hexOf(QT_ROLES.indexOf('Base')));
  });
});

describe('qtColor', () => {
  it('reads #aarrggbb with alpha first, #rrggbb, #rgb, #rrrgggbbb, #rrrrggggbbbb and SVG names, ignoring case and spaces', () => {
    expect(qtColor('#80ff0000')).toEqual([1, 0, 0, 128 / 255]);
    expect(qtColor('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(qtColor('#f00')).toEqual([1, 0, 0, 1]);
    expect(formatHex(qtColor('#fff000800')!)).toBe('#ff0080');
    expect(formatHex(qtColor('#ffff00008080')!)).toBe('#ff0080');
    expect(qtColor('DarkSlateGray')).toEqual([0x2f / 255, 0x4f / 255, 0x4f / 255, 1]);
    expect(qtColor('Dark Slate Gray')).toEqual([0x2f / 255, 0x4f / 255, 0x4f / 255, 1]);
    expect(qtColor('#ff00')).toBeUndefined();
    expect(qtColor('rgb(1,2,3)')).toBeUndefined();
    expect(qtColor('constructor')).toBeUndefined();
    expect(qtColor('__proto__')).toBeUndefined();
  });
});
