import { describe, expect, it } from 'vitest';
import { BUILTIN_MONO_STACK, BUILTIN_UI_STACK, bundledFonts, fontFaceCss, fontStack, quoteFamily } from '../fonts';

const SHA = 'ab12cd34'.padEnd(64, '0');

describe('quoteFamily', () => {
  it('escapes the backslash and the apostrophe, the two characters that end or escape a single-quoted CSS string', () => {
    expect(quoteFamily('Segoe UI')).toBe("'Segoe UI'");
    expect(quoteFamily("O'Neil")).toBe("'O\\'Neil'");
    expect(quoteFamily("dt-\\';all:u")).toBe("'dt-\\\\\\';all:u'");
  });
});

describe('a bundled font', () => {
  const font = { kind: 'font', mime: 'font/woff2', bytes: 1000, license: {} } as const;

  it('is named and declared under its renamed family', () => {
    expect(fontStack({ asset: SHA, family: 'Mono' }, 'mono')).toBe(`'dt-ab12cd34-Mono', ${BUILTIN_MONO_STACK}`);
    expect(bundledFonts({ style: { fonts: { mono: { asset: SHA, family: 'Mono' } } }, assets: { [SHA]: font } })).toEqual([{ sha256: SHA, family: 'dt-ab12cd34-Mono', mime: 'font/woff2' }]);
  });

  it('counts for nothing when its asset key is no SHA-256, whatever its family', () => {
    const asset = "\\';all:unset;x:'";
    expect(fontStack({ asset, family: 'Name' }, 'ui')).toBe(BUILTIN_UI_STACK);
    expect(fontStack({ asset: SHA.toUpperCase(), family: 'Name' }, 'ui')).toBe(BUILTIN_UI_STACK);
    const theme = { style: { fonts: { ui: { asset, family: 'Name' } } }, assets: { [asset]: font } };
    expect(bundledFonts(theme)).toEqual([]);
    expect(fontFaceCss(theme, 'app://damocles')).toBe('');
  });
});
