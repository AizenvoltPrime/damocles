import { describe, expect, it, vi } from 'vitest';
import { linkUrlParts, MAX_WARNED_ORIGINS } from '../overlay/link-url';

const host = (url: string): string[] => linkUrlParts(url).filter((part) => part.role === 'host').map((part) => part.text);

describe('linkUrlParts', () => {
  it('joins back to the URL and emphasizes only its host and port', () => {
    const url = 'https://github.com.evil.example/login/device';
    expect(linkUrlParts(url)).toEqual([
      { role: 'other', text: 'https://' },
      { role: 'host', text: 'github.com.evil.example' },
      { role: 'other', text: '/login/device' },
    ]);
    expect(host('http://localhost:8123/cb?code=1')).toEqual(['localhost:8123']);
  });

  it('keeps a user name out of the host, so github.com@evil.example reads as evil.example', () => {
    expect(linkUrlParts('https://github.com@evil.example/')).toEqual([
      { role: 'other', text: 'https://github.com@' },
      { role: 'host', text: 'evil.example' },
      { role: 'other', text: '/' },
    ]);
    expect(host('https://user:secret@example.test:8443/x')).toEqual(['example.test:8443']);
  });

  it('shows an IPv6 address in brackets and an internationalized name as punycode, as the URL opens', () => {
    expect(host('http://[::1]:5173/')).toEqual(['[::1]:5173']);
    expect(host('https://xn--80ak6aa92e.com/')).toEqual(['xn--80ak6aa92e.com']);
    expect(linkUrlParts('https://xn--80ak6aa92e.com/').map((part) => part.text).join('')).toBe('https://xn--80ak6aa92e.com/');
  });

  it('shows a URL that is not its own canonical href whole, unemphasized, and logs its origin once, never the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(linkUrlParts('https://аррӏе.com/')).toEqual([{ role: 'other', text: 'https://аррӏе.com/' }]);
      expect(linkUrlParts('HTTPS://Example.com/cb?token=secret')).toEqual([{ role: 'other', text: 'HTTPS://Example.com/cb?token=secret' }]);
      expect(linkUrlParts('not a url secret')).toEqual([{ role: 'other', text: 'not a url secret' }]);
      linkUrlParts('HTTPS://Example.com/cb?token=secret');
      linkUrlParts('HTTPS://Example.com/other');
      expect(warn.mock.calls.map(([, origin]) => origin)).toEqual(['https://xn--80ak6aa92e.com', 'https://example.com', 'text that is no URL']);
    } finally {
      warn.mockRestore();
    }
  });

  it('remembers a bounded number of logged origins, so an origin past them logs again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i <= MAX_WARNED_ORIGINS; i++) linkUrlParts(`HTTPS://bound-${i}.example/`);
      linkUrlParts(`HTTPS://bound-${MAX_WARNED_ORIGINS}.example/`);
      expect(warn).toHaveBeenCalledTimes(MAX_WARNED_ORIGINS + 1);
      linkUrlParts('HTTPS://bound-0.example/');
      expect(warn).toHaveBeenCalledTimes(MAX_WARNED_ORIGINS + 2);
    } finally {
      warn.mockRestore();
    }
  });
});
