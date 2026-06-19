const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'file']);

/**
 * Neutralize script-executing URL schemes before a value reaches an `href`/`src`. Untrusted web content
 * (WebFetch markdown, Exa CodeSearch source links) flows through the webview, so this is defense-in-depth
 * on top of the nonce-locked CSP. An allowlist (not a denylist) closes the bypasses denylisting misses:
 * control chars / internal whitespace are stripped before the scheme is read (`java\tscript:` →
 * `javascript:`), so only known-safe schemes, scheme-relative/relative/anchor URLs, and `data:image/...`
 * survive; anything else collapses to `#`.
 */
export function sanitizeUrl(href: string): string {
  const scheme = href
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point (browsers ignore them in URLs)
    .replace(/[\u0000-\u0020\u007f]/g, '')
    .match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1]
    ?.toLowerCase();
  if (!scheme) return href; // relative, anchor (#…), or scheme-relative (//host) — no scheme to abuse
  if (SAFE_URL_SCHEMES.has(scheme)) return href;
  if (scheme === 'data') return /^\s*data:image\//i.test(href) ? href : '#';
  return '#';
}
