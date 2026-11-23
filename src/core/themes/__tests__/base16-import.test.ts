// base16 and base24 schemes: both YAML layouts, the docs/themes.md mapping, the ANSI polarity per kind, and every refusal.
import { describe, expect, it } from 'vitest';
import { englishText } from '../../../shared/localized-text';
import { refusal, refused } from '../../../shared/themes/__tests__/scheme-refusal';
import { MAX_THEME_AUTHOR_CHARS, MAX_THEME_DESCRIPTION_CHARS, MAX_THEME_NAME_CHARS } from '../../../shared/themes/limits';
import type { Look } from '../../../shared/themes/schema';
import { importBase16Text } from '../base16-import';

// base00..base0F as #000000..#ffffff, so each key's color is told apart by its gray
const BASE16: Readonly<Record<string, string>> = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`base0${i.toString(16).toUpperCase()}`, `#${(i * 17).toString(16).padStart(2, '0').repeat(3)}`]));
const BRIGHT: Readonly<Record<string, string>> = { base12: '#ff0012', base13: '#ff0013', base14: '#ff0014', base15: '#ff0015', base16: '#ff0016', base17: '#ff0017' };

const yamlMap = (entries: Readonly<Record<string, string>>, indent = ''): string => Object.entries(entries).map(([key, value]) => `${indent}${key}: "${value}"`).join('\n');
const current = (extra: string, palette: Readonly<Record<string, string>> = BASE16): string => `system: "base16"\nname: "Fixture Night"\nauthor: "A. Author"\n${extra}\npalette:\n${yamlMap(palette, '  ')}\n`;

const lookOf = (text: string, fileName = 'fixture.yaml'): { readonly kind: string; readonly look: Look; readonly theme: Readonly<Record<string, unknown>> } => {
  const { theme } = importBase16Text(text, fileName);
  const [[kind, look]] = Object.entries(theme['looks'] as Record<string, Look>) as [[string, Look]];
  return { kind, look, theme };
};

describe('importBase16Text', () => {
  it('maps the current layout onto the seeds, syntax colors and ANSI colors', () => {
    const { kind, look, theme } = lookOf(current('variant: "dark"\ndescription: "A night scheme"'));
    expect(kind).toBe('dark');
    expect(theme).toMatchObject({ schemaVersion: 1, name: 'Fixture Night', author: 'A. Author', description: 'A night scheme' });
    expect(look.colors).toEqual({
      background: BASE16['base00'], panel: BASE16['base01'], text: BASE16['base05'], accent: BASE16['base0D'],
      success: BASE16['base0B'], warning: BASE16['base0A'], danger: BASE16['base08'], info: BASE16['base0C'],
    });
    expect(look.tokens).toMatchObject({
      '--s-kw': BASE16['base0E'], '--s-str': BASE16['base0B'], '--s-num': BASE16['base09'], '--s-com': BASE16['base03'], '--s-fn': BASE16['base0D'], '--s-type': BASE16['base0A'],
    });
    const ansi = Array.from({ length: 16 }, (_, i) => look.tokens?.[`--d-ansi-${i}`]);
    const normal = ['base08', 'base0B', 'base0A', 'base0D', 'base0E', 'base0C'].map((key) => BASE16[key]);
    // base16 repeats its six colors in the bright slots
    expect(ansi).toEqual([BASE16['base00'], ...normal, BASE16['base05'], BASE16['base03'], ...normal, BASE16['base07']]);
  });

  it('reads the legacy layout, an unquoted 000000 as a color, and names a theme by its file when the scheme does not', () => {
    const legacy = `scheme: "Legacy"\nauthor: "B"\n${Object.entries(BASE16).map(([key, value]) => `${key}: ${value.slice(1)}`).join('\n')}\n`;
    expect(lookOf(legacy).theme['name']).toBe('Legacy');
    expect(lookOf(legacy).look.colors.background).toBe('#000000');
    const unnamed = Object.entries(BASE16).map(([key, value]) => `${key}: "${value.slice(1)}"`).join('\n');
    expect(lookOf(unnamed, 'gruvbox-dark.yml').theme['name']).toBe('gruvbox-dark');
  });

  it('puts base24 bright colors in the bright slots, each missing one falling back to its base16 color', () => {
    const { base13: _missing, ...bright } = BRIGHT;
    const { look } = lookOf(current('variant: "dark"', { ...BASE16, ...bright }).replace('system: "base16"', 'system: "base24"'));
    const slots = Array.from({ length: 6 }, (_, i) => look.tokens?.[`--d-ansi-${9 + i}`]);
    expect(slots).toEqual([BRIGHT['base12'], BRIGHT['base14'], BASE16['base0A'], BRIGHT['base16'], BRIGHT['base17'], BRIGHT['base15']]);
    // a legacy file with bright keys is base24 too
    const legacy = Object.entries({ ...BASE16, ...BRIGHT }).map(([key, value]) => `${key}: "${value}"`).join('\n');
    expect(lookOf(legacy).look.tokens?.['--d-ansi-9']).toBe(BRIGHT['base12']);
  });

  it('puts base00 in the background ANSI slot of its kind: 0 on dark, 15 on light', () => {
    const { kind, look } = lookOf(current('variant: "light"'));
    expect(kind).toBe('light');
    expect(look.tokens?.['--d-ansi-0']).toBe(BASE16['base07']);
    expect(look.tokens?.['--d-ansi-15']).toBe(BASE16['base00']);
  });

  it('takes the kind from base00 when the scheme names no variant', () => {
    expect(lookOf(current('')).kind).toBe('dark');
    expect(lookOf(current('', { ...BASE16, base00: '#fafafa' })).kind).toBe('light');
  });

  it('refuses aliases, duplicate keys, bad and missing colors, an unknown system and a file that is no mapping', () => {
    expect(refusal(() => importBase16Text(`${current('')}\nextra: &a "x"\nmore: *a\n`, 'a.yaml'))).toBe('syntax');
    expect(refusal(() => importBase16Text(`${current('')}name: "Again"\n`, 'a.yaml'))).toBe('syntax');
    expect(refusal(() => importBase16Text(current('', { ...BASE16, base08: 'red' }), 'a.yaml'))).toBe('badColor');
    expect(refusal(() => importBase16Text(current('', { ...BASE16, base08: '#12345' }), 'a.yaml'))).toBe('badColor');
    const { base0F: _gone, ...short } = BASE16;
    expect(refusal(() => importBase16Text(current('', short), 'a.yaml'))).toBe('noColors');
    expect(refusal(() => importBase16Text(current('').replace('system: "base16"', 'system: "base32"'), 'a.yaml'))).toBe('system');
    expect(refusal(() => importBase16Text('- a\n- b\n', 'a.yaml'))).toBe('noColors');
    expect(refusal(() => importBase16Text('a: [unclosed\n', 'a.yaml'))).toBe('syntax');
  });

  it('words a YAML error by its line and code, never the file\'s text, and a duplicate key in its own sentence', () => {
    const long = refused(() => importBase16Text(`base00: |${'x'.repeat(10_000)}\n`, 'a.yaml'));
    expect(long.reason).toBe('syntax');
    expect(englishText(long.text)).toBe('a.yaml is not a base16 scheme: line 1 is not valid YAML (UNEXPECTED_TOKEN).');
    expect(englishText(refused(() => importBase16Text(`${current('')}name: "Again"\n`, 'a.yaml')).text)).toBe('a.yaml is not a base16 scheme: line 22 repeats a key.');
  });

  it('refuses YAML nested deeper than the cap before it parses, in flow and block style', () => {
    const tooDeep = 'a.yaml is not a base16 scheme: it nests more than 64 levels deep.';
    const flow = refused(() => importBase16Text(`base00: ${'['.repeat(100_000)}\n`, 'a.yaml'));
    expect(flow.reason).toBe('syntax');
    expect(englishText(flow.text)).toBe(tooDeep);
    const block = (depth: number): string => Array.from({ length: depth }, (_, i) => `${'  '.repeat(i)}k:`).join('\n');
    expect(englishText(refused(() => importBase16Text(block(65), 'a.yaml')).text)).toBe(tooDeep);
    // 64 levels pass the cap and are refused only as no scheme
    expect(refusal(() => importBase16Text(block(64), 'a.yaml'))).toBe('noColors');
    expect(englishText(refused(() => importBase16Text(`${'- '.repeat(100)}x\n`, 'a.yaml')).text)).toBe(tooDeep);
    // a sequence under a key at the key's own indent still counts
    const compact = Array.from({ length: 100 }, (_, i) => `${'  '.repeat(i)}- k:`).join('\n');
    expect(englishText(refused(() => importBase16Text(compact, 'a.yaml')).text)).toBe(tooDeep);
    // brackets inside a quoted scalar open nothing
    expect(lookOf(current(`description: "${'['.repeat(100)}"`)).theme['description']).toBe('['.repeat(100));
  });

  it('echoes only a string system, and reads a current-layout file without system as base24 by its bright keys', () => {
    expect(englishText(refused(() => importBase16Text(current('').replace('system: "base16"', 'system: {a: b}'), 'a.yaml')).text)).toBe('a.yaml is not a base16 scheme.');
    const { look } = lookOf(current('variant: "dark"', { ...BASE16, ...BRIGHT }).replace('system: "base16"\n', ''));
    expect(look.tokens?.['--d-ansi-9']).toBe(BRIGHT['base12']);
  });

  it('flattens the scheme\'s name, author and description to one line without control or bidi characters, cut to the theme limits', () => {
    const { theme } = lookOf(current(`description: "${'d'.repeat(1_200)}"`)
      .replace('name: "Fixture Night"', `name: "Fix\\u0007ture\\u202e\\tNight${'n'.repeat(80)}"`)
      .replace('author: "A. Author"', `author: "${'a'.repeat(300)}"`));
    expect(theme['name']).toBe(`Fix ture Night${'n'.repeat(49)}…`);
    expect([...theme['author'] as string]).toHaveLength(MAX_THEME_AUTHOR_CHARS);
    expect([...theme['description'] as string]).toHaveLength(MAX_THEME_DESCRIPTION_CHARS);
    expect([...theme['name'] as string]).toHaveLength(MAX_THEME_NAME_CHARS);
  });
});
