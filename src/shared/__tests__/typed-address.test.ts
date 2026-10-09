import { describe, expect, it } from 'vitest';
import { isNotSecurePage, MAX_BROWSER_URL_LENGTH, typedAddress } from '../typed-address';
import { AS_TYPED, HTTP_AT_ONCE, UPGRADED } from './typed-address-cases';

describe('typed address', () => {
  it.each(UPGRADED)('upgrades %s to https, marked for the http fallback', (_kind, typed, url) => {
    expect(typedAddress(typed)).toEqual({ url, upgraded: true });
  });

  it.each(HTTP_AT_ONCE)('opens %s over http at once', (_kind, typed, url) => {
    expect(typedAddress(typed)).toEqual({ url, upgraded: false });
  });

  it.each(AS_TYPED)('keeps %s as typed', (_kind, typed, url) => {
    expect(typedAddress(typed)).toEqual({ url, upgraded: false });
  });

  it('reads nothing from blank text, two words or a host it cannot parse', () => {
    for (const typed of ['', '   ', '::1', 'two words', 'host:99999']) expect(typedAddress(typed)).toBeUndefined();
  });

  it('reads nothing from text past MAX_BROWSER_URL_LENGTH, so core is bounded on both hosts', () => {
    const longest = `example.com/${'x'.repeat(MAX_BROWSER_URL_LENGTH - 'example.com/'.length)}`;
    expect(typedAddress(longest)?.upgraded).toBe(true);
    expect(typedAddress(`${longest}x`)).toBeUndefined();
  });
});

describe('not secure page', () => {
  it('calls an http page not secure unless it is on this computer, as Chrome does', () => {
    for (const url of ['http://plain.example/', 'http://192.168.1.5:3000/', 'http://devbox/', 'HTTP://Upper.example/']) expect(isNotSecurePage(url)).toBe(true);
    for (const url of ['https://docs.example/', 'http://localhost:3000/', 'http://app.localhost/', 'http://127.0.0.1:8080/', 'http://127.9.9.9/', 'http://[::1]:5173/', 'about:blank', '', 'not a url']) expect(isNotSecurePage(url)).toBe(false);
  });
});
