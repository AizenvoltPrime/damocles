// What a design served to a browser may load and run (docs/invariants.md "Design mode"). Desktop main may import it
// (PD-35, MAIN_CORE_IMPORTS), so it imports nothing but types.
import type { DesignFidelity } from '../../shared/types/design';

/** The served types by lower-case extension; any other extension is a 404. */
const SERVED_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['avif', 'image/avif'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['svg', 'image/svg+xml'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['otf', 'font/otf'],
  ['ico', 'image/x-icon'],
  ['txt', 'text/plain; charset=utf-8'],
]);

/** The Content-Type a design file is served with, by its name's extension; undefined for a type that is never served. */
export function servedContentType(relPath: string): string | undefined {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? SERVED_TYPES.get(name.slice(dot + 1).toLowerCase()) : undefined;
}

/** The served Content-Security-Policy: only an interactive design runs scripts, so a static one or one with no fidelity decision runs none. */
export function servedCsp(fidelity: DesignFidelity | null): string {
  return [
    "default-src 'none'",
    fidelity === 'interactive' ? "script-src 'self' 'unsafe-inline'" : "script-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** The headers of every response the design server sends, refusals included. */
export function servedHeaders(fidelity: DesignFidelity | null): Record<string, string> {
  return {
    'Content-Security-Policy': servedCsp(fidelity),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}
