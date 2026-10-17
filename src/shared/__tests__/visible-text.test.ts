import { describe, expect, it } from 'vitest';
import { visibleLines, visibleText } from '../visible-text';

describe('visibleText', () => {
  it('shows control and bidi characters of git text as visible escapes', () => {
    expect(visibleText('evil\u202Etxt.exe')).toBe('evil\\u{202E}txt.exe');
    expect(visibleText('a\nb')).toBe('a\\u{A}b');
    expect(visibleText('plain/name.ts')).toBe('plain/name.ts');
  });

  it('keeps a tab as whitespace, in one line and in many, and escapes the other controls around it', () => {
    expect(visibleText('fix\tthe\u0007 parser\r')).toBe('fix\tthe\\u{7} parser\\u{D}');
    expect(visibleLines('# Conflicts:\r\n#\tconflict.ts\u000B\n')).toBe('# Conflicts:\n#\tconflict.ts\\u{B}\n');
  });

  it('shows text hidden in tag characters, variation selectors and other invisible characters as escapes', () => {
    // "run" smuggled in tag characters, which render as nothing and read as ASCII to a model
    const smuggled = `fix${[...'run'].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join('')}`;
    expect(visibleText(smuggled)).toBe('fix\\u{E0072}\\u{E0075}\\u{E006E}');
    expect(visibleLines(`a\u{E0001}b\n`)).toBe('a\\u{E0001}b\n');
    expect(visibleText('a\uFE0Fb\u{E0100}c\u2061d\u2064e\u180Ef\uFFF9g\uFFFBh')).toBe('a\\u{FE0F}b\\u{E0100}c\\u{2061}d\\u{2064}e\\u{180E}f\\u{FFF9}g\\u{FFFB}h');
    // an emoji is a surrogate pair, not two hidden characters
    expect(visibleText('ok 😀')).toBe('ok 😀');
  });

  it('keeps one presentation selector after a visible non-ASCII character, as in a gitmoji subject, and escapes every other', () => {
    expect(visibleText('\u267B\uFE0F refactor the parser')).toBe('\u267B\uFE0F refactor the parser');
    expect(visibleLines('\u2B06\uFE0F bump\n\u270F\uFE0F typo\n')).toBe('\u2B06\uFE0F bump\n\u270F\uFE0F typo\n');
    expect(visibleText('\u263A\uFE0E text style')).toBe('\u263A\uFE0E text style');
    // a run of selectors carries data: only the first after the emoji stays
    expect(visibleText('♻\uFE0F\uFE0E\uFE0F')).toBe('♻\uFE0F\\u{FE0E}\\u{FE0F}');
    // after ASCII, at the start, or after a hidden character
    expect(visibleText('a\uFE0F')).toBe('a\\u{FE0F}');
    expect(visibleText('\uFE0Fx')).toBe('\\u{FE0F}x');
    expect(visibleText('\u200B\uFE0F')).toBe('\\u{200B}\\u{FE0F}');
    // the supplementary selectors and the other basic ones are always escaped
    expect(visibleText('♻\u{E0100}')).toBe('♻\\u{E0100}');
    expect(visibleText('♻\uFE01')).toBe('♻\\u{FE01}');
  });

  it('shows the Arabic letter mark, zero-width characters and line separators as escapes too', () => {
    expect(visibleText('a\u061Cb\u200Bc\u200Dd\u2060e\uFEFFf\u2028g\u2029h')).toBe('a\\u{61C}b\\u{200B}c\\u{200D}d\\u{2060}e\\u{FEFF}f\\u{2028}g\\u{2029}h');
  });
});
