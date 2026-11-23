import { describe, expect, it } from 'vitest';

import { BUILTIN_THEME } from '../builtin';
import { checkEveryThemePin } from '../characters';
import { checkProjectLook } from '../project-looks';
import { checkSchemaVersion, pointerSegments, themeErrorEnglish, validateTheme, type ThemeValidation } from '../schema';

const ID = '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b';
const SHA = 'a'.repeat(64);
const COLORS = { background: '#0b0f14', panel: '#0f141a', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };

function theme(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } }, ...extra };
}

const errorsOf = (result: ThemeValidation): readonly string[] => (result.ok ? [] : result.errors.map(themeErrorEnglish));

describe('validateTheme', () => {
  it('accepts the built-in theme as a built-in', () => {
    const result = validateTheme(JSON.parse(JSON.stringify(BUILTIN_THEME)), { builtin: true });
    expect(errorsOf(result)).toEqual([]);
    expect(result.ok && result.unknownKeys).toEqual([]);
  });

  it('accepts a full user theme', () => {
    const result = validateTheme(theme({
      description: 'Dark blue', author: 'Me', version: '1.0.0', license: 'CC-BY-4.0',
      looks: {
        dark: {
          colors: COLORS,
          tokens: { '--d-muted': '#9AA7B4', '--d-shadow': '0 18px 48px #00000080' },
          wallpapers: [{ name: 'Sky', span: { asset: SHA, panels: ['chat', 'editor'], fit: 'fill' }, panels: { sidebar: { asset: SHA, fit: 'tile', dim: 0.4, blur: 8 } } }],
          cycle: { minutes: null },
          surfaceOpacity: 0.8,
        },
        light: { colors: { ...COLORS, background: '#ffffff' } },
      },
      style: { fonts: { ui: { installed: 'Segoe UI' } }, lineHeight: 1.2, radius: 0, density: 1.15, chatColumn: 'full' },
      css: { transcript: '.x { color: red }' },
      layout: { grid: { slots: { main: 'editor', side: 'chat', bottom: 'terminal' }, visible: { editor: true, terminal: false }, sideWidth: 400, bottomHeight: 200 }, sectionOrder: ['chats', 'projects', 'files', 'scm', 'graph', 'repos', 'search'] },
      assets: { [SHA]: { kind: 'image', mime: 'image/png', bytes: 1000, width: 10, height: 10, license: { spdx: 'CC0-1.0' } } },
      origin: { kind: 'created', installedAt: 1 },
    }), { folder: ID });
    expect(errorsOf(result)).toEqual([]);
    expect(result.ok && result.unknownKeys).toEqual([]);
    expect(result.ok && result.theme.assets?.[SHA]?.kind).toBe('image');
  });

  it('drops a flash allowance a theme file carries, which only this computer\'s user gives, outside every theme file', () => {
    const video = { kind: 'video', mime: 'video/mp4', bytes: 1000, width: 640, height: 360, durationMs: 4000, flash: { flagged: true, atMs: 1250, allowed: true }, license: {} };
    const result = validateTheme(theme({
      looks: { dark: { colors: COLORS, wallpapers: [{ panels: { chat: { asset: SHA, fit: 'fill', dim: 0.3, blur: 2 } } }] } },
      assets: { [SHA]: video },
    }), { folder: ID });
    expect(errorsOf(result)).toEqual([]);
    expect(result.ok && result.theme.assets?.[SHA]?.flash).toEqual({ flagged: true, atMs: 1250 });
    expect(result.ok && result.unknownKeys).toEqual([`/assets/${SHA}/flash/allowed`]);
  });

  it('drops and lists the keys it does not know, overrides of tokens a look may not set included', () => {
    const result = validateTheme(theme({
      future: true,
      looks: { dark: { colors: COLORS, sparkle: 1, tokens: { '--d-safety-danger': '#000000', '--d-font': "'Comic Sans'", '--d-text': '#ffffff' } } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.unknownKeys].sort()).toEqual(['/future', '/looks/dark/sparkle', '/looks/dark/tokens/--d-font', '/looks/dark/tokens/--d-safety-danger']);
    expect(result.theme).not.toHaveProperty('future');
    expect(result.theme.looks.dark!.tokens).toEqual({ '--d-text': '#ffffff' });
  });

  const IMAGE = { kind: 'image', mime: 'image/png', bytes: 1000, width: 10, height: 10, license: {} };
  // a strip of four 16 px frames whose flash check ran at 4 fps
  const SPRITE = { kind: 'sprite', mime: 'image/png', bytes: 100, width: 64, height: 16, frames: 4, durationMs: 1000, license: {} };
  const STRIP = { asset: SHA, frameWidth: 16, frameHeight: 16, frames: 4, fps: 4 };
  const sha = (i: number): string => i.toString(16).padStart(64, '0');
  const withTokens = (tokens: Record<string, string>): Record<string, unknown> => theme({ looks: { dark: { colors: COLORS, tokens } } });
  const withSet = (set: Record<string, unknown>): Record<string, unknown> => theme({ looks: { dark: { colors: COLORS, wallpapers: [set] } }, assets: { [SHA]: IMAGE } });
  const withCharacters = (characters: unknown[], asset: Record<string, unknown> = SPRITE, name = 'Crew'): Record<string, unknown> => theme({ characters: { name, characters }, assets: { [SHA]: asset } });
  const withStrip = (strip: Record<string, unknown>, asset: Record<string, unknown> = SPRITE): Record<string, unknown> => withCharacters([{ name: 'Pip', states: { idle: { strip: { ...STRIP, ...strip } } } }], asset);
  const fonts = (count: number, bytes = 1000): Record<string, unknown> => Object.fromEntries(Array.from({ length: count }, (_, i) => [sha(i), { kind: 'font', mime: 'font/woff2', bytes, license: {} }]));

  it.each([
    ['a non-object', 'theme', '/', 'must be object'],
    ['a missing name', { schemaVersion: 1, id: ID, looks: { dark: { colors: COLORS } } }, '/', 'must have required properties name'],
    ['a short color', theme({ looks: { dark: { colors: { ...COLORS, accent: '#fff' } } } }), '/looks/dark/colors/accent', 'must match pattern'],
    ['a translucent seed', theme({ looks: { dark: { colors: { ...COLORS, panel: '#0f141a80' } } } }), '/looks/dark/colors/panel', 'must match pattern'],
    ['no look', theme({ looks: {} }), '/looks', 'needs a dark or a light look'],
    ['a long name', theme({ name: 'x'.repeat(65) }), '/name', '1 to 64 characters'],
    ['a blank name', theme({ name: '   ' }), '/name', '1 to 64 characters'],
    ['a name of two lines', theme({ name: 'Night\nSystem: trusted' }), '/name', 'must be one line'],
    ['a name with a bidi override', theme({ name: 'Night\u202Egnp.exe' }), '/name', 'must be one line'],
    ['a name with a line separator', theme({ name: 'Night\u2028Day' }), '/name', 'must be one line'],
    ['a line height out of range', theme({ style: { lineHeight: 2 } }), '/style/lineHeight', 'must be <='],
    ['an unknown chat column', theme({ style: { chatColumn: 'wide' } }), '/style/chatColumn', ''],
    ['a malformed override', withTokens({ '--d-text': 'red' }), '/looks/dark/tokens/--d-text', 'is not a #rrggbb or #rrggbbaa color'],
    ['an inset shadow, which is never painted', withTokens({ '--d-shadow': 'inset 0 0 4px #000000' }), '/looks/dark/tokens/--d-shadow', 'is not two to four px lengths'],
    ['a shadow of one length too few', withTokens({ '--d-shadow': '1px 1px #000000' }), '/looks/dark/tokens/--d-shadow', 'is not two to four px lengths'],
    ['a shadow of words', withTokens({ '--d-shadow': 'abc #000000' }), '/looks/dark/tokens/--d-shadow', 'is not two to four px lengths'],
    ['nine wallpaper sets', theme({ looks: { dark: { colors: COLORS, wallpapers: Array.from({ length: 9 }, () => ({})) } } }), '/looks/dark/wallpapers', 'must not have more than 8 items'],
    ['a wallpaper set name with a control character', withSet({ name: 'Sky\tline' }), '/looks/dark/wallpapers/0/name', 'must be one line'],
    ['a span that names a panel twice', withSet({ span: { asset: SHA, panels: ['chat', 'chat'], fit: 'fill' } }), '/looks/dark/wallpapers/0/span/panels', 'names a panel twice'],
    ['a missing asset', theme({ looks: { dark: { colors: COLORS, wallpapers: [{ span: { asset: SHA, panels: ['chat'], fit: 'fit' } }] } } }), '/looks/dark/wallpapers/0/span', 'is not in assets'],
    ['an asset of the wrong kind', theme({ style: { fonts: { mono: { asset: SHA, family: 'Mono' } } }, assets: { [SHA]: IMAGE } }), '/style/fonts/mono', 'is a still image, not a font'],
    ['an asset key that is no sha256', theme({ assets: { 'logo.png': IMAGE } }), '/assets/logo.png', 'is not a sha256'],
    ['an image of no width', theme({ assets: { [SHA]: { ...IMAGE, width: 0 } } }), `/assets/${SHA}/width`, 'must be >= 1'],
    ['an image of no height', theme({ assets: { [SHA]: { ...IMAGE, height: 0 } } }), `/assets/${SHA}/height`, 'must be >= 1'],
    ['more assets than an archive holds', theme({ assets: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [sha(i), IMAGE])) }), '/assets', 'must not have more than 512 properties'],
    ['nine fonts', theme({ assets: fonts(9) }), '/assets', 'holds 9 fonts, more than 8'],
    ['a font over 10 MB', theme({ assets: fonts(1, 10 * 1024 * 1024 + 1) }), `/assets/${sha(0)}`, 'a font larger than 10 MB'],
    ['an install time no date reaches', theme({ origin: { kind: 'created', installedAt: 1e300 } }), '/origin/installedAt', 'must be <='],
    ['a removal time no date reaches', theme({ origin: { kind: 'store', installedAt: 1, removedFromStore: { reason: '', at: 8.64e15 } } }), '/origin/removedFromStore/at', 'must be <='],
    ['a pane in two slots', theme({ layout: { grid: { slots: { main: 'chat', side: 'chat', bottom: 'terminal' }, visible: { editor: true, terminal: true }, sideWidth: 1, bottomHeight: 1 } } }), '/layout/grid/slots', 'exactly one slot'],
    ['a section order of two names', theme({ layout: { sectionOrder: ['chats', 'projects'] } }), '/layout/sectionOrder', 'must not have fewer than 6 items'],
    ['a section order that names a section twice', theme({ layout: { sectionOrder: ['chats', 'chats', 'projects', 'files', 'scm', 'repos', 'search'] } }), '/layout/sectionOrder', 'must not have duplicate items'],
    ['a section order of six names that leaves out another than the Graph', theme({ layout: { sectionOrder: ['projects', 'chats', 'files', 'scm', 'graph', 'repos'] } }), '/layout/sectionOrder', 'must name every section once'],
    ['a font name with markup', theme({ style: { fonts: { ui: { installed: 'Geist; } body {' } } } }), '/style/fonts/ui', 'is not a font name'],
    ['an id that is no UUID', theme({ id: 'night' }), '/id', 'is not a lowercase UUID'],
    ['an uppercase UUID', theme({ id: ID.toUpperCase() }), '/id', 'is not a lowercase UUID'],
    ['a character set with no name', withCharacters([], SPRITE, ''), '/characters/name', 'must not have fewer than 1 characters'],
    ['a character set named with spaces only', withCharacters([], SPRITE, ' '), '/characters/name', '1 to 64 characters'],
    ['a character set name with a bidi isolate', withCharacters([], SPRITE, 'Crew\u2066'), '/characters/name', 'must be one line'],
    ['a character with no name', withCharacters([{ name: '', states: { idle: { asset: SHA } } }]), '/characters/characters/0/name', 'must not have fewer than 1 characters'],
    ['a character named with spaces only', withCharacters([{ name: '  ', states: { idle: { asset: SHA } } }]), '/characters/characters/0/name', '1 to 64 characters'],
    ['a character name of two lines', withCharacters([{ name: 'Pip\nPop', states: { idle: { asset: SHA } } }]), '/characters/characters/0/name', 'must be one line'],
    ['two characters of one name', withCharacters([{ name: 'Pip', states: { idle: { asset: SHA } } }, { name: 'Pip', states: { idle: { asset: SHA } } }]), '/characters/characters', 'names a character twice'],
    ['a character frame that names a wallpaper image', withCharacters([{ name: 'Pip', states: { idle: { asset: SHA } } }], { ...IMAGE, bytes: 20 * 1024 * 1024, width: 8000, height: 5000 }), '/characters/characters/0/states/idle', 'is a still image, not a character sprite'],
    ['a strip over an animated wallpaper', withStrip({ frames: 1, frameWidth: 64, fps: 1 }, { kind: 'animated', mime: 'image/gif', bytes: 100, width: 64, height: 16, frames: 20, license: {} }), '/characters/characters/0/states/idle', 'is an animated image, not a character sprite'],
    ['a one-frame strip over an animated sprite', withStrip({ frames: 1, frameWidth: 64, fps: 1 }, { kind: 'sprite', mime: 'image/gif', bytes: 100, width: 64, height: 16, frames: 20, license: {} }), '/characters/characters/0/states/idle/strip', 'is animated already'],
    ['a strip cut into other frames than its flash check ran on', withStrip({ frames: 4, frameWidth: 16, fps: 24 }, { ...SPRITE, frames: 2, durationMs: 167 }), '/characters/characters/0/states/idle/strip', 'is not the 2 its image\'s flash check ran on'],
    ['a strip whose frames do not make the width', withStrip({ frameWidth: 10 }), '/characters/characters/0/states/idle/strip', 'do not make the image\'s 64 px width'],
    ['a strip whose frames are not the image\'s height', withStrip({ frameHeight: 8 }), '/characters/characters/0/states/idle/strip', 'do not match the image\'s 16 px height'],
    ['a strip that steps faster than its flash check', withStrip({ fps: 8 }), '/characters/characters/0/states/idle/strip', 'steps faster than the rate its flash check ran at'],
  ])('refuses %s', (_label, json, path, message) => {
    const result = validateTheme(json);
    expect(result.ok).toBe(false);
    expect(result.ok || result.needsNewer).toBeFalsy();
    expect(errorsOf(result).filter((error) => error.startsWith(`${path}: `) && error.includes(message))).not.toEqual([]);
  });

  it('accepts a strip that keeps its image\'s cut, and a name with joiners', () => {
    expect(errorsOf(validateTheme(withStrip({})))).toEqual([]);
    // a zero-width joiner and non-joiner, which names in Persian, Indic scripts and emoji sequences need
    expect(errorsOf(validateTheme(theme({ name: 'می\u200Cخواهم \u{1F468}\u200D\u{1F469}' })))).toEqual([]);
  });

  it('holds each token override to the format that is painted, whatever its case', () => {
    const result = validateTheme(withTokens({ '--d-shadow': '0 18PX 48px #00000080', '--d-muted': '#9AA7B4' }));
    expect(errorsOf(result)).toEqual([]);
  });

  it('returns a section order of the six names 3.9.0 saved as the seven of today', () => {
    const result = validateTheme(theme({ layout: { sectionOrder: ['chats', 'projects', 'scm', 'files', 'repos', 'search'] } }));
    expect(result.ok && result.theme.layout?.sectionOrder).toEqual(['chats', 'projects', 'scm', 'graph', 'files', 'repos', 'search']);
  });

  it('lists an unknown key as a JSON Pointer, which a key holding a slash or a tilde survives', () => {
    const result = validateTheme(theme({ 'a/b': 1, 'x~y': 2, looks: { dark: { colors: COLORS, 'p/q': 3 } } }));
    expect(result.ok && [...result.unknownKeys].sort()).toEqual(['/a~1b', '/looks/dark/p~1q', '/x~0y']);
    expect(pointerSegments('/looks/dark/p~1q')).toEqual(['looks', 'dark', 'p/q']);
    expect(pointerSegments('/x~0y')).toEqual(['x~y']);
    expect(pointerSegments('/a~01b')).toEqual(['a~1b']);
  });

  describe('never throws', () => {
    const own = (record: object, value: unknown): void => { Object.defineProperty(record, '__proto__', { value, enumerable: true, writable: true, configurable: true }); };
    // a deep copy each time: the cases change records in place
    const full = (): Record<string, unknown> => structuredClone(theme({
      looks: { dark: { colors: COLORS, tokens: { '--d-text': '#ffffff' }, wallpapers: [{ name: 'Sky', span: { asset: sha(1), panels: ['chat'], fit: 'fill' }, panels: { sidebar: { asset: sha(1), fit: 'tile', dim: 0.4, blur: 8 } }, spanLook: { chat: { dim: 0.5, blur: 2 } } }], cycle: { minutes: 5 } } },
      style: { fonts: { ui: { installed: 'Segoe UI' }, mono: { asset: sha(2), family: 'Mono' } } },
      characters: { name: 'Crew', characters: [{ name: 'Pip', states: { idle: { strip: STRIP }, running: { asset: SHA } } }] },
      css: { transcript: '.x { color: red }' },
      layout: { grid: { slots: { main: 'editor', side: 'chat', bottom: 'terminal' }, visible: { editor: true, terminal: false }, sideWidth: 400, bottomHeight: 200 }, sections: { chats: { collapsed: false } } },
      assets: { [SHA]: { ...SPRITE, flash: { flagged: false } }, [sha(1)]: IMAGE, [sha(2)]: { kind: 'font', mime: 'font/woff2', bytes: 1000, license: { spdx: 'OFL-1.1' } } },
      origin: { kind: 'store', installedAt: 1, store: { entryId: 'x', version: '1', sha256: SHA }, removedFromStore: { reason: '', at: 2 } },
    }));
    const records = (value: unknown): object[] => (typeof value !== 'object' || value === null ? [] : [...(Array.isArray(value) ? [] : [value]), ...Object.values(value).flatMap(records)]);

    it('accepts the theme the cases below are made from', () => {
      expect(errorsOf(validateTheme(full()))).toEqual([]);
    });

    it.each([
      ['an assets entry of null under a key that is no sha256', theme({ assets: { x: null } })],
      ['a __proto__ font', theme({ style: { fonts: JSON.parse('{"__proto__":5}') as unknown } })],
      ['a __proto__ state', theme({ characters: { name: 'Crew', characters: [{ name: 'Pip', states: JSON.parse(`{"idle":{"asset":"${SHA}"},"__proto__":5}`) as unknown }] }, assets: { [SHA]: SPRITE } })],
      ['a __proto__ panel', withSet({ panels: JSON.parse('{"__proto__":null}') as unknown })],
      ['a __proto__ asset', theme({ assets: JSON.parse('{"__proto__":null}') as unknown })],
      ['a __proto__ look', theme({ looks: JSON.parse(`{"dark":{"colors":${JSON.stringify(COLORS)}},"__proto__":{"colors":5}}`) as unknown })],
      ['null', null],
      ['a number', 5],
      ['an array of arrays', [[[]]]],
      ['looks of null', theme({ looks: null })],
      ['a name that is an object', theme({ name: { toString: 'x' } })],
      ['arrays where records go', theme({ looks: [], style: [], characters: [], css: [], layout: [], assets: [], origin: [] })],
      ['a theme that names itself a schema', theme({ properties: {}, anyOf: [], patternProperties: {}, items: {} })],
    ])('on %s', (_label, json) => {
      expect(() => validateTheme(json)).not.toThrow();
      expect(() => checkProjectLook({ mode: 'touches', wallpaper: json, assets: json })).not.toThrow();
      expect(() => checkEveryThemePin({ name: 'Pip', states: json, assets: json })).not.toThrow();
    });

    it('lists a top-level __proto__ key as unknown and returns a theme without it', () => {
      const result = validateTheme(JSON.parse(JSON.stringify(theme()).replace('{', '{"__proto__":5,')));
      expect(result.ok && result.unknownKeys).toEqual(['/__proto__']);
      expect(result.ok && Object.hasOwn(result.theme, '__proto__')).toBe(false);
    });

    it.each([[5], [null], ['x'], [[]], [{}], [{ kind: 'sprite' }]])('on a __proto__ key of %j in each record of a theme', (value) => {
      const count = records(full()).length;
      expect(count).toBeGreaterThan(25);
      for (let i = 0; i < count; i++) {
        const json = full();
        own(records(json)[i]!, value);
        let result: ThemeValidation | undefined;
        expect(() => { result = validateTheme(json); }).not.toThrow();
        // refused, or dropped and listed: never kept
        if (result?.ok) expect(result.unknownKeys.filter((key) => key.endsWith('/__proto__'))).toHaveLength(1);
      }
    });
  });

  it('refuses a theme whose folder is not its id', () => {
    expect(errorsOf(validateTheme(theme(), { folder: 'other' }))).toEqual([`/id: ${ID} does not match its folder other`]);
  });

  it('reports a newer schemaVersion as needing a newer Damocles, before any other check', () => {
    const result = validateTheme({ schemaVersion: 2, whatever: true });
    expect(result).toEqual({ ok: false, needsNewer: 2, errors: [{ path: '/schemaVersion', text: { message: 'format version {0} needs a newer Damocles', args: ['2'] } }] });
    expect(checkSchemaVersion({ schemaVersion: 2 })).toEqual({ kind: 'needsNewer', version: 2 });
    expect(checkSchemaVersion({ schemaVersion: 1 })).toEqual({ kind: 'supported' });
    for (const version of [0, 1.5, '2', null, undefined]) expect(checkSchemaVersion({ schemaVersion: version })).toEqual({ kind: 'invalid' });
    expect(checkSchemaVersion([])).toEqual({ kind: 'invalid' });
  });

  describe('reserved ids', () => {
    it.each(['damocles', 'damocles-aurora', 'damocles-paper-2'])('keeps %s for built-ins', (id) => {
      expect(validateTheme(theme({ id }), { builtin: true }).ok).toBe(true);
      expect(errorsOf(validateTheme(theme({ id })))).toEqual([`/id: ${id} is reserved for built-in themes`]);
    });

    it.each([ID, 'Damocles', 'damocles_x', 'damocles-'])('refuses %s as a built-in id', (id) => {
      expect(validateTheme(theme({ id }), { builtin: true }).ok).toBe(false);
    });
  });
});
