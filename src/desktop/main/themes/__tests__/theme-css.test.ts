import { describe, expect, it } from 'vitest';

import { DESKTOP_FONT_FILES } from '../../desktop-fonts';
import { BUILTIN_PALETTES } from '../../../../shared/themes/builtin';
import { BUILTIN_FONT_FAMILIES, BUILTIN_MONO_STACK, BUILTIN_UI_STACK, fontFaceCss, fontStack } from '../../../../shared/themes/fonts';
import { themeErrorEnglish, validateTheme, type ThemeFile } from '../../../../shared/themes/schema';
import { isValidTokenValue } from '../../../../shared/themes/tokens';
import { pageCss, pageCustomCss, pagePalette, scopedThemeCss, trustedCss } from '../theme-css';

const ID = '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b';
const SHA = '0123456789abcdef'.repeat(4);
const COLORS = { background: '#f6f1e7', panel: '#ede5d6', text: '#2a241c', accent: '#a34a1b', success: '#3d7536', warning: '#99600a', danger: '#b23a2e', info: '#3b5c93' };
const FONT_ASSET = { kind: 'font', mime: 'font/woff2', bytes: 1000, family: 'Fixture', license: { spdx: 'OFL-1.1' } } as const;

function theme(style: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, id: ID, name: 'Type', looks: { light: { colors: COLORS } }, style, ...extra };
}

const errorsOf = (json: unknown): readonly string[] => {
  const result = validateTheme(json, { folder: ID });
  return result.ok ? [] : result.errors.map(themeErrorEnglish);
};

describe('theme fonts in CSS', () => {
  it('quotes an installed family, escapes its apostrophe and keeps Damocles\' stack behind it', () => {
    const stack = fontStack({ installed: "Bob's & Co. Sans" }, 'ui');
    expect(stack).toBe(`'Bob\\'s & Co. Sans', ${BUILTIN_UI_STACK}`);
    expect(isValidTokenValue('--d-font', stack)).toBe(true);
    expect(fontStack(undefined, 'mono')).toBe(BUILTIN_MONO_STACK);
  });

  it('renames a bundled family dt-<sha8>-<name>, so it never shadows a built-in family', () => {
    const shadowing = { asset: SHA, family: 'Geist Variable' };
    expect(fontStack(shadowing, 'ui')).toBe(`'dt-01234567-Geist Variable', ${BUILTIN_UI_STACK}`);
    const css = fontFaceCss({ style: { fonts: { ui: shadowing } }, assets: { [SHA]: { ...FONT_ASSET, family: 'Geist Variable' } } }, 'app://damocles');
    expect(css).toBe(`@font-face { font-family: 'dt-01234567-Geist Variable'; font-style: normal; font-display: swap; src: url(app://damocles/theme-blob/${SHA}) format('woff2'); }`);
    for (const family of BUILTIN_FONT_FAMILIES) expect(css).not.toContain(`font-family: '${family}'`);
  });

  it('declares each bundled font once, and none whose asset is missing or not a font type', () => {
    const fonts = { ui: { asset: SHA, family: 'Fixture' }, mono: { asset: SHA, family: 'Fixture' } };
    expect(fontFaceCss({ style: { fonts }, assets: { [SHA]: FONT_ASSET } }, 'app://damocles').match(/@font-face/g)).toHaveLength(1);
    expect(fontFaceCss({ style: { fonts } }, 'app://damocles')).toBe('');
    expect(fontFaceCss({ style: { fonts }, assets: { [SHA]: { ...FONT_ASSET, mime: 'image/svg+xml' } } }, 'app://damocles')).toBe('');
  });

  it('refuses a theme naming a built-in family or a renamed family as an installed font', () => {
    for (const name of ['Geist Variable', 'geist mono variable', ' Inter Variable', 'dt-01234567-Fixture', 'DT-x']) {
      expect(errorsOf(theme({ fonts: { ui: { installed: name } } })).join('\n')).toMatch(/keeps for its own fonts|is not a font name/);
    }
    expect(errorsOf(theme({ fonts: { ui: { installed: 'Georgia' } } }))).toEqual([]);
  });

  it('refuses font names that could break out of a CSS string', () => {
    for (const name of ["x'; } body { display: none", 'a</style>', 'a\\27', 'a;b', 'a"b', 'a\nb']) {
      expect(errorsOf(theme({ fonts: { mono: { installed: name } } })).length).toBeGreaterThan(0);
    }
  });

  it('refuses a theme with any size field, which only the user sets', () => {
    expect(errorsOf(theme({ fontSize: 14 })).length).toBeGreaterThan(0);
    expect(errorsOf(theme({ fonts: { textSize: 2 } })).length).toBeGreaterThan(0);
    expect(errorsOf(theme({}, { size: 3 })).length).toBeGreaterThan(0);
  });

  it('caps a theme at 8 bundled fonts of at most 10 MB each', () => {
    const assets = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i).repeat(64).slice(0, 64), FONT_ASSET]));
    expect(errorsOf(theme({}, { assets })).join('\n')).toMatch(/9 fonts, more than 8/);
    expect(errorsOf(theme({}, { assets: { [SHA]: { ...FONT_ASSET, bytes: 10 * 1024 * 1024 + 1 } } })).join('\n')).toMatch(/larger than 10 MB/);
  });
});

describe('a page\'s theme CSS', () => {
  const look = BUILTIN_PALETTES.light;
  const style = { fonts: { ui: { asset: SHA, family: 'Fixture' } }, lineHeight: 1.2, radius: 0, density: 0.85, chatColumn: 'full' } as const satisfies ThemeFile['style'];

  it('carries the theme\'s style, the bundled font faces and the user\'s text size', () => {
    const css = pageCss({ kind: 'light', style, assets: { [SHA]: FONT_ASSET } }, look, 20);
    expect(css.startsWith("@font-face { font-family: 'dt-01234567-Fixture'")).toBe(true);
    for (const declaration of [
      `--d-font: 'dt-01234567-Fixture', ${BUILTIN_UI_STACK};`, '--d-line-scale: 1.2;', '--d-radius-scale: 0;', '--d-density: 0.85;',
      '--d-chat-column: 100%;', '--d-hit-min: 1.5rem;', '--d-font-size: 20px;', '--d-mono-size: 20px;',
    ]) expect(css).toContain(declaration);
  });

  it('keeps Damocles\' values with no style, and a chat column in rem', () => {
    const palette = pagePalette(look, undefined, 13);
    expect(palette).toMatchObject({ '--d-line-scale': '1', '--d-radius-scale': '1', '--d-density': '1', '--d-chat-column': '50rem', '--d-hit-min': 'auto', '--d-font-size': '13px' });
    expect(pagePalette(look, { chatColumn: 40, density: 1.15 }, 13)).toMatchObject({ '--d-chat-column': '40rem', '--d-hit-min': 'auto' });
  });

  it('gives trusted UI the theme\'s corners, density and line spacing but always Damocles\' fonts', () => {
    const css = trustedCss(look, 'light', 'root', style, 16);
    expect(css).toContain(`--d-font: ${BUILTIN_UI_STACK};`);
    expect(css).toContain(`--d-mono: ${BUILTIN_MONO_STACK};`);
    expect(css).not.toContain('dt-');
    for (const declaration of ['--d-radius-scale: 0;', '--d-density: 0.85;', '--d-line-scale: 1.2;', '--d-font-size: 16px;']) expect(css).toContain(declaration);
    expect(css.startsWith(':root {')).toBe(true);
  });

  it('names the built-in families the desktop fonts declare', () => {
    expect([...BUILTIN_FONT_FAMILIES].sort()).toEqual([...new Set(DESKTOP_FONT_FILES.map((font) => font.family))].sort());
  });
});

describe('the custom CSS main paints', () => {
  const WRAP = '@layer damocles-user { @scope ([data-theme-scope~="transcript"]) to ([data-trusted], [data-trusted-mark], .monaco-editor, .xterm) { ';

  it('sanitizes again whatever core stored: only the regenerated allowlisted rules reach a page', () => {
    const scoped = scopedThemeCss({ css: { transcript: '[data-trusted], p { display: none; color: red } :root { color: blue } @import url(https://evil.example/x.css);', sidebar: 'body { color: red }' } });
    expect(scoped).toEqual({ transcript: `${WRAP}:where(:scope) p{color:red} } }` });
    expect(pageCustomCss(scoped, 'chat')).toBe(scoped.transcript);
    expect(pageCustomCss(scoped, 'shell')).toBeUndefined();
  });

  it('sanitizes for the families the shown theme declares, not the ones a cached result was made for', () => {
    const css = { transcript: "p { font-family: 'Fixture Sans' }" };
    const declared = scopedThemeCss({ css, style: { fonts: { ui: { installed: 'Fixture Sans' } } } });
    expect(declared.transcript).toBe(`${WRAP}:where(:scope) p{font-family:"Fixture Sans"} } }`);
    expect(scopedThemeCss({ css }).transcript).toBe(`${WRAP}:where(:scope) p{} } }`);
    expect(scopedThemeCss({ css, style: { fonts: { ui: { installed: 'Fixture Sans' } } } })).toBe(declared);
  });

  it('paints nothing for a theme with no CSS', () => {
    expect(scopedThemeCss({})).toEqual({});
    expect(pageCustomCss({}, 'chat')).toBeUndefined();
  });
});
