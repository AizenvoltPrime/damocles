import { describe, expect, it } from 'vitest';

import { BUILTIN_EXAMPLE_IDS, BUILTIN_THEME, BUILTIN_THEME_ID, DEFAULT_THEME_ID, isBuiltinThemeId, SYSTEM_THEME_ID } from '../builtin';
import { formatHex, parseHex, toOklch } from '../color';
import { checkPalette, contrast, AA, describeIssue } from '../contrast';
import { deriveLook } from '../derive';
import { validateTheme, type Look, type ThemeFile } from '../schema';
import { opaqueOver, type PaletteRoles } from '../schemes';
import { systemTheme, systemThemeDetails, type SystemColors } from '../system-theme';
import { LOOK_KINDS, OVERRIDABLE_TOKENS, SEED_TONES, SHADOW_TOKEN, type LookKind, type TokenName } from '../tokens';

const look = (theme: ThemeFile, kind: LookKind): Look => {
  const found = theme.looks[kind];
  if (!found) throw new Error(`System colors has no ${kind} look`);
  return found;
};

const errors = (theme: ThemeFile, kind: LookKind) => {
  const { colors, tokens } = look(theme, kind);
  return checkPalette(deriveLook(colors, kind, tokens), kind).filter((issue) => issue.severity === 'error');
};

// what System colors never gives: a contrast error, or a fill below 3:1 on bg or panel
const failures = (theme: ThemeFile, kind: LookKind): string[] => {
  const { colors, tokens } = look(theme, kind);
  return checkPalette(deriveLook(colors, kind, tokens), kind).filter((issue) => issue.severity === 'error' || issue.rule === 'fill').map(describeIssue);
};

const OPAQUE = /^#[0-9a-f]{6}$/;
// macOS's dark appearance: labelColor and secondaryLabelColor are white at 85% and 55%, separatorColor white at 10%.
const MAC_DARK: PaletteRoles = {
  kind: 'dark',
  seeds: { background: '#1e1e1e', panel: '#323232', text: '#ffffffd8', accent: '#0a84ff', success: '#32d74b', warning: '#ff9f0a', danger: '#ff453a', info: '#0a84ff' },
  tokens: { '--d-border': '#ffffff1a', '--d-muted': '#ffffff8c' },
};

// the black fill fails 3:1 on the dark surfaces; the white label passes on it and fails only on the derived accent fill
const MULTI_ROUND_TOKENS: Partial<Record<TokenName, string>> = { '--d-accent-fill': '#000000', '--d-on-accent': '#ffffff', '--d-border': '#445566' };

// mulberry32: the same numbers on every run
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the System colors ids', () => {
  it('names damocles-system a built-in, the default, and no packed example', () => {
    expect(SYSTEM_THEME_ID).toBe('damocles-system');
    expect(DEFAULT_THEME_ID).toBe(SYSTEM_THEME_ID);
    expect(isBuiltinThemeId('damocles-system')).toBe(true);
    expect(BUILTIN_EXAMPLE_IDS).not.toContain('damocles-system');
    expect(BUILTIN_THEME_ID).toBe('damocles');
  });
});

describe('systemTheme', () => {
  it('with nothing read is the Damocles seeds of both kinds, derived, with no pinned override', () => {
    const theme = systemTheme({});
    expect(theme).toMatchObject({ schemaVersion: 1, id: 'damocles-system', name: 'System colors', description: 'Follows this computer\'s colors' });
    for (const kind of LOOK_KINDS) {
      expect(look(theme, kind).colors).toEqual(BUILTIN_THEME.looks[kind]!.colors);
      expect(look(theme, kind).tokens ?? {}).toEqual({});
      expect(errors(theme, kind)).toEqual([]);
    }
  });

  it('validates as a built-in theme under its own folder', () => {
    for (const colors of [{}, { accent: '#ffe100' }, { palettes: { dark: MAC_DARK } }]) {
      expect(validateTheme(systemTheme(colors), { builtin: true, folder: 'damocles-system' })).toMatchObject({ ok: true });
    }
  });

  it.each([['Windows blue', '#0078d4'], ['macOS blue', '#007aff'], ['libadwaita blue', '#3584e4']])('takes a %s OS accent unchanged in both looks', (_name, accent) => {
    const theme = systemTheme({ accent });
    for (const kind of LOOK_KINDS) {
      expect(look(theme, kind).colors).toEqual({ ...BUILTIN_THEME.looks[kind]!.colors, accent });
      expect(failures(theme, kind)).toEqual([]);
    }
  });

  it.each<[string, string, readonly LookKind[]]>([
    ['near-white', '#fdfdfd', ['light']],
    ['Windows gold', '#ffb900', ['light']],
    ['near-black', '#020202', ['dark']],
    ['macOS yellow', '#ffcc00', ['light']],
    ['macOS orange', '#ff9500', ['light']],
    ['yellow', '#ffe100', ['light']],
  ])('moves a %s OS accent only in lightness, to 3:1 on the surfaces of a look it fails, with its label at AA', (_name, accent, fails) => {
    const theme = systemTheme({ accent });
    for (const kind of LOOK_KINDS) {
      const { colors } = look(theme, kind);
      expect(failures(theme, kind), kind).toEqual([]);
      expect(colors.accent === accent, kind).toBe(!fails.includes(kind));
      expect({ ...colors, accent }).toEqual({ ...BUILTIN_THEME.looks[kind]!.colors, accent });
      if (fails.includes(kind) && toOklch(parseHex(accent)!).c > 0.05) expect(Math.abs(toOklch(parseHex(colors.accent)!).h - toOklch(parseHex(accent)!).h), kind).toBeLessThan(3);
    }
  });

  it("holds a macOS light palette's orange warning at 3:1", () => {
    const theme = systemTheme({ palettes: { light: { kind: 'light', seeds: { background: '#ffffff', panel: '#ececec', text: '#000000', warning: '#ff9500', success: '#28cd41' }, tokens: {} } } });
    expect(failures(theme, 'light')).toEqual([]);
    expect(look(theme, 'light').colors).toMatchObject({ background: '#ffffff', panel: '#ececec' });
    expect(look(theme, 'light').colors.warning).not.toBe('#ff9500');
  });

  it.each(['', 'ffe100', '#ffe1', 'accent', '#gggggg'])('reads the unusable accent %j as no accent', (accent) => {
    expect(systemTheme({ accent })).toEqual(systemTheme({}));
  });

  it('flattens a translucent OS accent, so no seed carries alpha', () => {
    const theme = systemTheme({ accent: '#0078d480' });
    for (const kind of LOOK_KINDS) {
      expect(look(theme, kind).colors.accent).toMatch(OPAQUE);
      expect(errors(theme, kind)).toEqual([]);
    }
  });

  it('flattens a translucent OS accent over the background of the look it is used in', () => {
    const accent = '#3584e4a0';
    const dark: PaletteRoles = { kind: 'dark', seeds: { background: '#2a2d33', panel: '#33373e', text: '#eeeeee' }, tokens: {} };
    const theme = systemTheme({ accent, palettes: { dark } });
    expect(theme.looks.dark).toEqual(systemTheme({ accent: opaqueOver(parseHex(accent), '#2a2d33')!, palettes: { dark } }).looks.dark);
    expect(theme.looks.light).toEqual(systemTheme({ accent: opaqueOver(parseHex(accent), BUILTIN_THEME.looks.light!.colors.background)! }).looks.light);
  });

  it('reads a fully transparent OS accent as the background it is painted over, held at 3:1', () => {
    const theme = systemTheme({ accent: '#0078d400' });
    for (const kind of LOOK_KINDS) expect(failures(theme, kind), kind).toEqual([]);
  });

  it('takes a kind\'s seeds from its palette, and gives the other kind the Damocles seeds with the OS accent', () => {
    const theme = systemTheme({ accent: '#bf5af2', palettes: { dark: { kind: 'dark', seeds: { background: '#101418', panel: '#1b2026', text: '#f2f2f2', accent: '#30d158' }, tokens: {} } } });
    expect(look(theme, 'dark').colors).toEqual({ ...BUILTIN_THEME.looks.dark!.colors, background: '#101418', panel: '#1b2026', text: '#f2f2f2', accent: '#30d158' });
    expect(look(theme, 'light').colors).toEqual({ ...BUILTIN_THEME.looks.light!.colors, accent: '#bf5af2' });
    for (const kind of LOOK_KINDS) expect(errors(theme, kind)).toEqual([]);
  });

  it('uses the OS accent for a palette that names none', () => {
    const theme = systemTheme({ accent: '#bf5af2', palettes: { light: { kind: 'light', seeds: { background: '#fafafa' }, tokens: {} } } });
    expect(look(theme, 'light').colors).toEqual({ ...BUILTIN_THEME.looks.light!.colors, background: '#fafafa', accent: '#bf5af2' });
  });

  it('paints a macOS-like translucent label over the background and keeps every text at AA', () => {
    const theme = systemTheme({ palettes: { dark: MAC_DARK } });
    const dark = look(theme, 'dark');
    for (const color of Object.values(dark.colors)) expect(color).toMatch(OPAQUE);
    // white at 85% over #1e1e1e
    expect(dark.colors.text).toBe('#dddddd');
    expect(dark.colors.background).toBe('#1e1e1e');
    expect(errors(theme, 'dark')).toEqual([]);
    // white at 10% over #1e1e1e; the border takes part in no contrast rule, and white at 55% fails 4.5:1 on a derived surface
    expect(dark.tokens).toEqual({ '--d-border': '#353535' });
    expect(look(theme, 'light').colors).toEqual(BUILTIN_THEME.looks.light!.colors);
  });

  it('drops an override the contrast check names and keeps the ones it does not', () => {
    const roles: PaletteRoles = { kind: 'dark', seeds: {}, tokens: { '--d-muted': '#30363d', '--d-border': '#445566' } };
    const background = BUILTIN_THEME.looks.dark!.colors.background;
    // the premise: this muted color fails 4.5:1 on the Damocles dark background
    expect(contrast('#30363d', background)).toBeLessThan(AA);
    const theme = systemTheme({ palettes: { dark: roles } });
    expect(look(theme, 'dark').tokens ?? {}).toEqual({ '--d-border': '#445566' });
    expect(errors(theme, 'dark')).toEqual([]);
  });

  it('keeps AA for a light palette of low-contrast seeds', () => {
    const theme = systemTheme({ palettes: { light: { kind: 'light', seeds: { background: '#ffffff', panel: '#f0f0f0', text: '#c8c8c8', accent: '#ffff66', success: '#ccffcc', warning: '#ffffaa', danger: '#ffcccc', info: '#cce5ff' }, tokens: { '--d-muted': '#eeeeee', '--d-faint': '#f5f5f5' } } } });
    expect(errors(theme, 'light')).toEqual([]);
  });

  it('keeps a translucent override that passes on every surface, painted over the background', () => {
    const theme = systemTheme({ palettes: { dark: { ...MAC_DARK, tokens: { '--d-muted': '#ffffffc0' } } } });
    expect(look(theme, 'dark').tokens).toEqual({ '--d-muted': '#c7c7c7' });
    expect(errors(theme, 'dark')).toEqual([]);
  });

  it('takes only the tones of a palette whose background is of the other kind, and none of its overrides', () => {
    const lightAsDark: PaletteRoles = { kind: 'dark', seeds: { background: '#ffffff', panel: '#ececec', text: '#000000', success: '#28cd41', danger: '#ff3b30' }, tokens: { '--d-border': '#cccccc' } };
    const details = systemThemeDetails({ accent: '#bf5af2', palettes: { dark: lightAsDark } });
    expect(look(details.theme, 'dark')).toEqual({ colors: { ...BUILTIN_THEME.looks.dark!.colors, accent: '#bf5af2', success: '#28cd41', danger: '#ff3b30' } });
    expect(details.fallbacks).toEqual([{ kind: 'dark', reason: 'otherKind' }]);
  });

  // seeds whose derived palette, with every fill held at 3:1, has a contrast error are not kept: the look is then the Damocles
  // seeds with the OS accent. `sound`: the derivation brings the seeds to AA by itself, so the palette's surfaces and text are kept
  it.each<[string, PaletteRoles['seeds'], boolean]>([
    // every fill moves to a dark gray for 3:1 on the gray, and text cannot reach AA on its tints
    ['one color for everything', { background: '#777777', panel: '#777777', text: '#777777', accent: '#777777', success: '#777777', warning: '#777777', danger: '#777777', info: '#777777' }, false],
    ['text equal to the background', { background: '#101010', panel: '#101010', text: '#101010' }, true],
    ['a mid-gray background', { background: '#6e6e6e', panel: '#808080', text: '#7a7a7a' }, false],
    ['a black look', { background: '#000000', panel: '#000000', text: '#ffffff' }, true],
  ])('is the seeds of the palette when they derive without a contrast error, else the defaults: %s', (_name, seeds, sound) => {
    const defaults = { ...BUILTIN_THEME.looks.dark!.colors, accent: '#bf5af2' };
    const own = { ...defaults, ...seeds };
    const details = systemThemeDetails({ accent: '#bf5af2', palettes: { dark: { kind: 'dark', seeds, tokens: {} } } });
    const kept = sound ? own : defaults;
    expect(look(details.theme, 'dark').colors).toMatchObject({ background: kept.background, panel: kept.panel, text: kept.text });
    expect(failures(details.theme, 'dark')).toEqual([]);
    expect(details.fallbacks).toEqual(sound ? [] : [{ kind: 'dark', reason: 'contrast' }]);
  });

  it('drops overrides over several rounds, as dropping one can make another fail', () => {
    const tokens = MULTI_ROUND_TOKENS;
    const theme = systemTheme({ palettes: { dark: { kind: 'dark', seeds: {}, tokens } } });
    // the premise: with every override, an issue names only the first one
    const named = checkPalette(deriveLook(BUILTIN_THEME.looks.dark!.colors, 'dark', tokens), 'dark').flatMap((issue) => [issue.fg, issue.bg]).join(' ');
    expect(Object.keys(tokens).filter((token) => named.includes(token))).toEqual([Object.keys(tokens)[0]]);
    expect(look(theme, 'dark').tokens ?? {}).toEqual({ '--d-border': '#445566' });
    expect(failures(theme, 'dark')).toEqual([]);
  });

  it('has no contrast error and no fill below 3:1 whatever the computer gives', () => {
    const next = seeded(20261123);
    const hex = (): string => formatHex([next(), next(), next(), next() < 0.3 ? next() : 1]);
    const COLOR_OVERRIDES = OVERRIDABLE_TOKENS.filter((token) => token !== SHADOW_TOKEN);
    const roles = (kind: LookKind): PaletteRoles => ({
      kind,
      seeds: Object.fromEntries((['background', 'panel', 'text', ...SEED_TONES] as const).flatMap((seed) => (next() < 0.7 ? [[seed, hex()]] : []))),
      tokens: Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, (): [TokenName, string] => [COLOR_OVERRIDES[Math.floor(next() * COLOR_OVERRIDES.length)]!, hex()])),
    });
    for (let i = 0; i < 60; i++) {
      const colors: SystemColors = { ...(next() < 0.8 ? { accent: hex() } : {}), palettes: Object.fromEntries(LOOK_KINDS.flatMap((kind) => (next() < 0.6 ? [[kind, roles(kind)]] : []))) };
      const theme = systemTheme(colors);
      for (const kind of LOOK_KINDS) expect(failures(theme, kind), `${kind} of ${JSON.stringify(colors)}`).toEqual([]);
    }
  }, 60_000);

  it('answers the same theme for the same colors', () => {
    expect(JSON.stringify(systemTheme({ accent: '#0078d4', palettes: { dark: MAC_DARK } }))).toBe(JSON.stringify(systemTheme({ accent: '#0078d4', palettes: { dark: MAC_DARK } })));
  });
});
