import { describe, expect, it } from 'vitest';
import { visibleText } from '../visible-text';

describe('visibleText', () => {
  it('shows control and bidi characters of git text as visible escapes', () => {
    expect(visibleText('evil\u202Etxt.exe')).toBe('evil\\u{202E}txt.exe');
    expect(visibleText('a\nb')).toBe('a\\u{A}b');
    expect(visibleText('plain/name.ts')).toBe('plain/name.ts');
  });

  it('shows the Arabic letter mark, zero-width characters and line separators as escapes too', () => {
    expect(visibleText('a\u061Cb\u200Bc\u200Dd\u2060e\uFEFFf\u2028g\u2029h')).toBe('a\\u{61C}b\\u{200B}c\\u{200D}d\\u{2060}e\\u{FEFF}f\\u{2028}g\\u{2029}h');
  });
});
