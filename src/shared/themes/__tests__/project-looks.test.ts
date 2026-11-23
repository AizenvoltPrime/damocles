import { describe, expect, it } from 'vitest';
import { checkProjectLook, MAX_PROJECT_KEY_CHARS, parseProjectLooks } from '../project-looks';

describe('parseProjectLooks', () => {
  it('skips a __proto__ key, which would set the record\'s prototype', () => {
    const looks = parseProjectLooks(JSON.parse('{"version":1,"looks":{"__proto__":{"mode":"full","themeId":"damocles","look":"dark"},"p":{"mode":"full","themeId":"damocles","look":"auto"}}}'));
    expect(Object.getPrototypeOf(looks)).toBe(Object.prototype);
    expect(looks).toEqual({ p: { mode: 'full', themeId: 'damocles', look: 'auto' } });
    expect((looks as Record<string, unknown>)['mode']).toBeUndefined();
  });

  it('skips a key longer than any project key, which the core protocol could not carry', () => {
    const look = { mode: 'full', themeId: 'damocles', look: 'auto' };
    const longest = 'p'.repeat(MAX_PROJECT_KEY_CHARS);
    expect(Object.keys(parseProjectLooks({ version: 1, looks: { [longest]: look, [`${longest}p`]: look } }))).toEqual([longest]);
  });
});

describe('checkProjectLook', () => {
  it('refuses a look whose accent or character set is not text, as it does one that is malformed', () => {
    expect(checkProjectLook({ mode: 'touches', accent: '#FFFFFF', characterSet: 'damocles' })).toEqual({ mode: 'touches', accent: '#ffffff', characterSet: 'damocles' });
    expect(checkProjectLook({ mode: 'touches', accent: 5, characterSet: 'damocles' })).toBeUndefined();
    expect(checkProjectLook({ mode: 'touches', accent: null, characterSet: 'damocles' })).toBeUndefined();
    expect(checkProjectLook({ mode: 'touches', accent: '#ffffff', characterSet: 5 })).toBeUndefined();
    expect(checkProjectLook({ mode: 'touches', accent: 'red' })).toBeUndefined();
  });

  it('takes a theme id only in the lowercase form every theme has', () => {
    expect(checkProjectLook({ mode: 'full', themeId: '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b', look: 'dark' })).toBeDefined();
    expect(checkProjectLook({ mode: 'full', themeId: '3F1C2A4E-9B7D-4C1E-8A2F-5D6E7F809A1B', look: 'dark' })).toBeUndefined();
  });
});
