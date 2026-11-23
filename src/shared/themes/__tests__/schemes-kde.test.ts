// KDE color schemes: the docs/themes.md mapping, the accent's two sources, alpha, the name, the kind, and every refusal.
// The fixture is written for this test in the .colors layout; its colors are its own.
import { describe, expect, it } from 'vitest';
import { kdeColor, kdeRoles, kdeRolesOfIni, readIni, type SchemeRoles } from '../schemes';
import { refusal } from './scheme-refusal';

const group = (name: string, entries: Readonly<Record<string, string>>): string => `[${name}]\n${Object.entries(entries).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;

const VIEW = {
  BackgroundNormal: '20,22,30', BackgroundAlternate: '24,26,34', ForegroundNormal: '220,221,230', ForegroundInactive: '140,142,150',
  ForegroundActive: '90,160,250', ForegroundLink: '80,150,240', ForegroundVisited: '170,120,220',
  ForegroundNegative: '240,80,90', ForegroundNeutral: '240,170,40', ForegroundPositive: '70,200,120',
};
const SCHEME = [
  '# written for the Damocles tests',
  group('ColorEffects:Disabled', { ColorAmount: '0', ColorEffect: '0' }),
  group('Colors:View', VIEW),
  group('Colors:Window', { ...VIEW, BackgroundNormal: '30,32,42' }),
  group('Colors:Header][Inactive', { ...VIEW, BackgroundNormal: '1,1,1' }),
  group('Colors:Selection', { ...VIEW, BackgroundNormal: '200,100,50' }),
  group('General', { ColorScheme: 'FixtureNight', Name: 'Fixture Night', 'Name[el]': 'Νύχτα', shadeSortColumn: 'true' }),
].join('\n');

const only = (roles: SchemeRoles) => {
  const entries = Object.entries(roles.palettes);
  expect(entries).toHaveLength(1);
  return entries[0]![1]!;
};

describe('kdeRoles', () => {
  it('maps View, Window and Selection onto the seeds and View/ForegroundInactive onto --d-muted', () => {
    const roles = kdeRoles(SCHEME, 'FixtureNight.colors');
    expect(roles.name).toBe('Fixture Night');
    const palette = only(roles);
    expect(palette.kind).toBe('dark');
    expect(palette.seeds).toEqual({
      background: '#14161e', panel: '#1e202a', text: '#dcdde6', accent: '#c86432',
      success: '#46c878', warning: '#f0aa28', danger: '#f0505a', info: '#5aa0fa',
    });
    expect(palette.tokens).toEqual({ '--d-muted': '#8c8e96' });
  });

  it('takes the accent from [General] AccentColor when the file sets it', () => {
    const roles = kdeRoles(`${SCHEME}AccentColor=61,174,233\n`, 'kdeglobals');
    expect(only(roles).seeds.accent).toBe('#3daee9');
  });

  it('keeps a color\'s alpha for the look to paint over the background, and reads #rrggbb', () => {
    const roles = kdeRoles(group('Colors:View', { BackgroundNormal: '#fafafa', ForegroundNormal: '0,0,0,128' }), 'a.colors');
    const palette = only(roles);
    expect(palette.kind).toBe('light');
    expect(palette.seeds).toEqual({ background: '#fafafa', text: '#00000080' });
  });

  it('names the scheme by ColorScheme without a Name, and gives no name without either', () => {
    expect(kdeRoles(SCHEME.replace('Name=Fixture Night\n', ''), 'a.colors').name).toBe('FixtureNight');
    expect(kdeRoles(group('Colors:View', VIEW), 'a.colors').name).toBeUndefined();
  });

  it('takes the kind from the text when the file sets no background, an empty value being unset', () => {
    expect(only(kdeRoles(group('Colors:View', { ForegroundNormal: '20,20,20' }), 'a.colors')).kind).toBe('light');
    const empty = only(kdeRoles(group('Colors:View', { BackgroundNormal: '', ForegroundNormal: '20,20,20' }), 'a.colors'));
    expect(empty).toMatchObject({ kind: 'light', seeds: { text: '#141414' } });
    expect(empty.seeds.background).toBeUndefined();
  });

  it('reads a scheme that starts with a BOM, and its Name with KConfig escapes and literal quotes', () => {
    const roles = kdeRoles(`\uFEFF${group('General', { Name: '"Night"\\sOwl\\t\\x21\\xc3\\xa9\\\\' })}${group('Colors:View', VIEW)}`, 'a.colors');
    expect(roles.name).toBe('"Night" Owl\t!é\\');
    expect(only(roles).seeds.background).toBe('#14161e');
  });

  it('reads [General] AccentColor without reading the selection color', () => {
    const roles = kdeRoles(`${SCHEME.replace('BackgroundNormal=200,100,50', 'BackgroundNormal=not a color')}AccentColor=61,174,233\n`, 'kdeglobals');
    expect(only(roles).seeds.accent).toBe('#3daee9');
  });

  it('refuses a file with neither View/BackgroundNormal nor View/ForegroundNormal, and a value that is no color', () => {
    expect(refusal(() => kdeRoles(group('Colors:Window', VIEW), 'a.colors'))).toBe('noColors');
    expect(refusal(() => kdeRoles(group('Colors:View', { ...VIEW, ForegroundPositive: '1,2' }), 'a.colors'))).toBe('badColor');
    expect(refusal(() => kdeRoles(group('Colors:View', { ...VIEW, ForegroundPositive: '1,2,300' }), 'a.colors'))).toBe('badColor');
  });

  it('lenient, reads a value that is no color as the default for its key, else as unset', () => {
    const ini = readIni(`${group('Colors:View', { ...VIEW, ForegroundPositive: '1,2', ForegroundNeutral: 'nope' })}${group('General', { AccentColor: 'x' })}${group('Colors:Selection', { BackgroundNormal: '200,100,50' })}`, 'kdeglobals');
    const defaults = new Map([['Colors:View', new Map([['ForegroundPositive', '0,128,0']])]]);
    const { seeds } = only(kdeRolesOfIni(ini, 'kdeglobals', { lenient: true, defaults }));
    expect(seeds).toMatchObject({ success: '#008000', accent: '#c86432' });
    expect(seeds.warning).toBeUndefined();
  });
});

describe('kdeColor', () => {
  it('reads r,g,b and r,g,b,a as KConfig does, #rrggbb and color names, and nothing else', () => {
    expect(kdeColor(' 255, 0 ,128 ')).toEqual([1, 0, 128 / 255, 1]);
    expect(kdeColor('0,0,0,0')).toEqual([0, 0, 0, 0]);
    expect(kdeColor('+5,0255,007')).toEqual([5 / 255, 1, 7 / 255, 1]);
    expect(kdeColor('#336699')).toEqual([0x33 / 255, 0x66 / 255, 0x99 / 255, 1]);
    expect(kdeColor('red')).toEqual([1, 0, 0, 1]);
    expect(kdeColor('1.5,2,3')).toBeUndefined();
    expect(kdeColor('-1,2,3')).toBeUndefined();
    expect(kdeColor('0256,2,3')).toBeUndefined();
    expect(kdeColor('1,2,3,4,5')).toBeUndefined();
  });
});
