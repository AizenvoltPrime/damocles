import { describe, it, expect } from 'vitest';
import { sanitizeUrl } from '../sanitize-url';

/**
 * URL scheme allowlist (Phase 7 web-tools): used for both MarkdownRenderer hrefs and CodeSearch source
 * links. Asserts safe schemes pass, script-executing schemes collapse to `#`, and the denylist bypasses
 * (internal whitespace / control chars in the scheme) are closed.
 */
describe('sanitizeUrl', () => {
  it('passes safe and relative URLs through unchanged', () => {
    for (const url of [
      'https://example.com/x',
      'http://example.com',
      'mailto:a@b.com',
      'tel:+123',
      'file:///etc/hosts',
      '/relative/path',
      './rel.ts',
      '#anchor',
      '//cdn.example.com/x',
      'data:image/png;base64,AAAA',
    ]) {
      expect(sanitizeUrl(url)).toBe(url);
    }
  });

  it('neutralizes script-executing and non-image data schemes', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('#');
    expect(sanitizeUrl('JavaScript:alert(1)')).toBe('#');
    expect(sanitizeUrl('vbscript:msgbox(1)')).toBe('#');
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
  });

  it('closes whitespace/control-char scheme bypasses', () => {
    expect(sanitizeUrl('java\tscript:alert(1)')).toBe('#');
    expect(sanitizeUrl('java\nscript:alert(1)')).toBe('#');
    expect(sanitizeUrl(' javascript:alert(1)')).toBe('#');
  });
});
