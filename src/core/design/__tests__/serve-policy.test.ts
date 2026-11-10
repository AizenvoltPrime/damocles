import { describe, expect, it } from 'vitest';
import { servedContentType, servedCsp, servedHeaders } from '../serve-policy';

describe('the design serve policy', () => {
  it('serves the allowlisted types by extension, in any case, and nothing else', () => {
    expect(servedContentType('screens/S1-contacts.html')).toBe('text/html; charset=utf-8');
    expect(servedContentType('tokens.css')).toBe('text/css; charset=utf-8');
    expect(servedContentType('variants/a/app.js')).toBe('text/javascript; charset=utf-8');
    expect(servedContentType('manifest.json')).toBe('application/json; charset=utf-8');
    expect(servedContentType('assets/LOGO.PNG')).toBe('image/png');
    expect(servedContentType('assets/photo.jpg')).toBe('image/jpeg');
    expect(servedContentType('assets/a.webp')).toBe('image/webp');
    expect(servedContentType('assets/photo.avif')).toBe('image/avif');
    expect(servedContentType('assets/a.gif')).toBe('image/gif');
    expect(servedContentType('assets/icon.svg')).toBe('image/svg+xml');
    expect(servedContentType('assets/Inter.woff')).toBe('font/woff');
    expect(servedContentType('assets/Inter.woff2')).toBe('font/woff2');
    expect(servedContentType('assets/Inter.ttf')).toBe('font/ttf');
    expect(servedContentType('assets/Inter.otf')).toBe('font/otf');
    expect(servedContentType('assets/favicon.ico')).toBe('image/x-icon');
    expect(servedContentType('notes.txt')).toBe('text/plain; charset=utf-8');
    // ImportAsset saves a JPEG as .jpg, the one JPEG name every app version serves.
    for (const refused of ['design.md', 'screens/S1.journey.spec.ts', 'assets/photo.jpeg', 'a.htm', 'a.xhtml', 'a.mjs', 'a.wasm', 'a.pdf', 'Makefile', '.html', 'assets/.png', 'a.html.exe', 'dir.html/']) {
      expect(servedContentType(refused), refused).toBeUndefined();
    }
  });

  it('runs scripts only for an interactive design: static and no fidelity decision get script-src none', () => {
    const shared = "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";
    expect(servedCsp('interactive')).toBe(`default-src 'none'; script-src 'self' 'unsafe-inline'; ${shared}`);
    expect(servedCsp('static')).toBe(`default-src 'none'; script-src 'none'; ${shared}`);
    expect(servedCsp(null)).toBe(servedCsp('static'));
  });

  it('sends the CSP and the security headers', () => {
    expect(servedHeaders('static')).toEqual({
      'Content-Security-Policy': servedCsp('static'),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    expect(servedHeaders('interactive')['Content-Security-Policy']).toBe(servedCsp('interactive'));
  });
});
