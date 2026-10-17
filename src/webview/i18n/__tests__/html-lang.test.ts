// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { applyLocale, i18n, setLocale } from '../index';

afterEach(() => {
  applyLocale('en');
});

describe('the page language follows the locale', () => {
  it('sets <html lang> from the locale the host gives and from the user\'s choice, so uppercase Greek drops its accents', () => {
    applyLocale('el-GR');
    expect(document.documentElement.lang).toBe('el');
    expect(i18n.global.locale.value).toBe('el');
    setLocale('en');
    expect(document.documentElement.lang).toBe('en');
    applyLocale('fr');
    expect(document.documentElement.lang).toBe('en');
  });
});
