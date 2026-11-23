import * as path from 'node:path';
import { protocol, type Protocol } from 'electron';
import { readFile, realpath, stat as statFile } from '../../core/resource-fs';
import { APP_HOST, APP_ORIGIN, APP_SCHEME, isInside, SERVED_FILES, SERVED_ROOTS } from '../app-urls';
import { NOTIFIER_PAGE_PATH, THEME_EDITOR_PAGE_PATH } from '../preload/page-paths';
import { THEME_SHOT_ID, THEME_SHOT_PATH } from '../../shared/themes/wallpapers';

export { APP_HOST, APP_ORIGIN, APP_SCHEME, appResourceUri } from '../app-urls';
export { THEME_SHOT_URL_PREFIX } from '../../shared/themes/wallpapers';

// Every page is generated in memory under its CSP; the built index.html files carry none, so they are never served.
const BUILT_PAGE = /\.html?$/i;

// Script responses carry a policy of their own: a worker does not inherit its page's CSP, and Monaco's workers are served here.
const SCRIPT_CSP = `default-src 'none'; script-src ${APP_ORIGIN}`;
// An SVG is a document when opened directly, and third-party icons are served same-origin; as an <img> it never runs script.
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";

// A panel id is one URL path segment of this alphabet, so panelPageUrl serves it.
const PANEL_PAGE = /^\/panel\/([A-Za-z0-9-]+)\/index\.html$/;
const PANEL_ID = /^[A-Za-z0-9-]+$/;
const SHELL_PAGE = '/shell/index.html';
// an account picture of this computer's core (main/forge/avatar-cache.ts); the key is core's SHA-256 hex
const FORGE_AVATAR = /^\/forge\/avatar\/([0-9a-f]{64})$/;
// a theme's bundled font or wallpaper under ~/.damocles/themes/blobs (main/themes/theme-blobs.ts); the key is its SHA-256 hex
const THEME_BLOB = /^\/theme-blob\/([0-9a-f]{64})$/;
// a file the theme renderer derived from a wallpaper, under ~/.damocles/themes/cache/<sha256>/
const THEME_CACHE = /^\/theme-cache\/([0-9a-f]{64})\/(thumb-480\.webp|still\.png)$/;
// a community store thumbnail core kept under ~/.damocles/themes/store/thumbs/ once it matched its pinned SHA-256 hex
const STORE_THUMB = /^\/store-thumb\/([0-9a-f]{64})$/;
const OVERLAY_PAGE = '/overlay/index.html';
// the theme renderer's page, generated per request with a fresh script nonce and served only in its own session
// (main/themes/theme-render-page.ts)
const THEME_RENDER_PAGE = '/theme-render/index.html';
export const THEME_RENDER_PAGE_URL: string = `${APP_ORIGIN}${THEME_RENDER_PAGE}`;

// The window's own page; main generates it per request with a fresh script nonce.
export const SHELL_PAGE_URL: string = `${APP_ORIGIN}${SHELL_PAGE}`;
// The overlay view's page, generated the same way.
export const OVERLAY_PAGE_URL: string = `${APP_ORIGIN}${OVERLAY_PAGE}`;
// The desktop popup window's page (D52), generated the same way.
export const NOTIFIER_PAGE_URL: string = `${APP_ORIGIN}${NOTIFIER_PAGE_PATH}`;
// The theme editor dock's page, the overlay bundle at its editor route, generated the same way.
export const THEME_EDITOR_PAGE_URL: string = `${APP_ORIGIN}${THEME_EDITOR_PAGE_PATH}`;

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

export type AppRequestTarget =
  | { readonly kind: 'file'; readonly root: string; readonly filePath: string }
  | { readonly kind: 'panel'; readonly panelId: string }
  | { readonly kind: 'shell' }
  | { readonly kind: 'overlay' }
  | { readonly kind: 'notifier' }
  | { readonly kind: 'themeEditor' }
  | { readonly kind: 'forgeAvatar'; readonly key: string }
  | { readonly kind: 'themeBlob'; readonly sha256: string }
  | { readonly kind: 'themeCache'; readonly sha256: string; readonly file: string }
  | { readonly kind: 'storeThumb'; readonly sha256: string }
  | { readonly kind: 'themeRender' }
  | { readonly kind: 'themeShot'; readonly id: string };

/** A served blob: its type and size, and a stream of the bytes from `start` to `end`, both inclusive. */
export interface ServedBlob {
  readonly mime: string;
  readonly size: number;
  body(start: number, end: number): ReadableStream<Uint8Array>;
}

export interface AppPages {
  panel(panelId: string): string | undefined;
  shell(): string;
  overlay(): string;
  notifier(): string;
  themeEditor(): string;
  /** A Git hosting account picture; undefined for a key this computer's core does not list. */
  forgeAvatar(key: string): Promise<{ readonly bytes: Uint8Array; readonly mime: string } | undefined>;
  /** A theme blob a theme main read or the transient preview names, with the type its bytes sniffed as; undefined for any other. */
  themeBlob(sha256: string): Promise<ServedBlob | undefined>;
  /** A wallpaper's thumbnail or a moving one's still frame, which core wrote; undefined before its analysis. */
  themeCache(sha256: string, file: string): Promise<Uint8Array | undefined>;
  /** A community store thumbnail core kept; undefined for one it did not keep or that no longer matches its name. */
  storeThumb(sha256: string): Promise<Uint8Array | undefined>;
  /** A screenshot ThemeRead's card shows; undefined once dropped or expired. */
  themeShot(id: string): Uint8Array | undefined;
  /** Each theme blob answer's status and Content-Range, for the e2e hooks only. */
  themeBlobServed?(sha256: string, status: number, contentRange: string | null): void;
}

/** What the theme renderer's session serves besides the built files. */
export interface ThemeRenderPages {
  themeRender(): string;
  /** A theme blob the renderer's running job names (the file under analysis included), or one every page may load. */
  themeBlob(sha256: string): Promise<ServedBlob | undefined>;
  themeBlobServed?(sha256: string, status: number, contentRange: string | null): void;
}

export function isPanelId(panelId: string): boolean {
  return PANEL_ID.test(panelId);
}

export function panelPageUrl(panelId: string): string {
  return `${APP_ORIGIN}/panel/${panelId}/index.html`;
}

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Maps an app:// URL to what it may serve; undefined for anything outside the served set. */
export function resolveAppRequest(url: string, resourceRoot: string): AppRequestTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes('\0')) return undefined;

  const panel = PANEL_PAGE.exec(pathname);
  if (panel?.[1] !== undefined) return { kind: 'panel', panelId: panel[1] };
  if (pathname === SHELL_PAGE) return { kind: 'shell' };
  if (pathname === OVERLAY_PAGE) return { kind: 'overlay' };
  if (pathname === NOTIFIER_PAGE_PATH) return { kind: 'notifier' };
  if (pathname === THEME_EDITOR_PAGE_PATH) return { kind: 'themeEditor' };
  const avatar = FORGE_AVATAR.exec(pathname);
  if (avatar?.[1] !== undefined) return { kind: 'forgeAvatar', key: avatar[1] };
  const blob = THEME_BLOB.exec(pathname);
  if (blob?.[1] !== undefined) return { kind: 'themeBlob', sha256: blob[1] };
  const cached = THEME_CACHE.exec(pathname);
  if (cached?.[1] !== undefined && cached[2] !== undefined) return { kind: 'themeCache', sha256: cached[1], file: cached[2] };
  const storeThumb = STORE_THUMB.exec(pathname);
  if (storeThumb?.[1] !== undefined) return { kind: 'storeThumb', sha256: storeThumb[1] };
  if (pathname === THEME_RENDER_PAGE) return { kind: 'themeRender' };
  // a screenshot for ThemeRead's card, from main's memory (main/themes/screenshots.ts)
  const shot = pathname.startsWith(THEME_SHOT_PATH) ? pathname.slice(THEME_SHOT_PATH.length) : '';
  if (THEME_SHOT_ID.test(shot)) return { kind: 'themeShot', id: shot };

  const file = SERVED_FILES.get(pathname);
  if (file) return { kind: 'file', root: resourceRoot, filePath: path.join(resourceRoot, ...file) };

  const [, prefix, ...rest] = pathname.split('/');
  const rootParts = prefix !== undefined ? SERVED_ROOTS.get(prefix) : undefined;
  if (!rootParts) return undefined;
  const root = path.join(resourceRoot, ...rootParts);
  const filePath = path.resolve(root, rest.join('/'));
  return isInside(root, filePath) && !BUILT_PAGE.test(filePath) ? { kind: 'file', root, filePath } : undefined;
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function serveFile(root: string, filePath: string): Promise<Response> {
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(filePath), realpath(root)]);
  } catch {
    return notFound();
  }
  // A symlink or junction inside a served root must not lead out of it.
  if (!isInside(realRoot, real)) return notFound();
  const stat = await statFile(real);
  if (!stat.isFile()) return notFound();
  const body = await readFile(real);
  const contentType = mimeTypeFor(real);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'x-content-type-options': 'nosniff',
      ...(contentType.startsWith('text/javascript') ? { 'content-security-policy': SCRIPT_CSP } : {}),
      ...(contentType === 'image/svg+xml' ? { 'content-security-policy': SVG_CSP } : {}),
    },
  });
}

// The design preview's scheme (PD-31): served only in the design-preview partition (design/design-session.ts).
export const DESIGN_SCHEME = 'damocles-design';

// The HTML preview's scheme, damocles-preview://<rootToken>/<path>: served only in the html-preview partition
// (html-preview/preview-session.ts).
export const PREVIEW_SCHEME = 'damocles-preview';

// Must run before app `ready`, once: Electron keeps only the last call's schemes. The app scheme gets stream, without which a
// media element expects the whole body at once and a video wallpaper cannot seek or loop. The design scheme gets no fetch, CORS,
// service worker or CSP bypass privilege; the preview scheme gets fetch and CORS, so fetch() and module scripts load
// same-origin, and no service worker, code cache, stream or CSP bypass.
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, stream: true } },
    { scheme: DESIGN_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

function htmlPage(html: string): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' } });
}

async function serveAvatar(pages: AppPages, key: string): Promise<Response> {
  let image: { readonly bytes: Uint8Array; readonly mime: string } | undefined;
  try {
    image = await pages.forgeAvatar(key);
  } catch {
    // core logged the failed fetch; the renderer keeps showing the initial
    return notFound();
  }
  if (!image) return notFound();
  return new Response(new Uint8Array(image.bytes), {
    status: 200,
    headers: { 'content-type': image.mime, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cache-control': 'no-store' },
  });
}

export type ByteRange =
  | { readonly kind: 'whole' }
  | { readonly kind: 'part'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i;

/**
 * What a Range header asks of a body of `size` bytes, per RFC 9110 section 14: no header, another unit or several ranges (which
 * a server may ignore) get the whole body; one byte range gets its part, its end clamped to the body; a range that does not
 * parse, ends before it starts or starts past the end is unsatisfiable.
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
  if (header === null) return { kind: 'whole' };
  const value = header.trim();
  if (!/^bytes\s*=/i.test(value) || value.includes(',')) return { kind: 'whole' };
  const match = SINGLE_RANGE.exec(value);
  if (!match || (match[1] === '' && match[2] === '')) return { kind: 'unsatisfiable' };
  const [, first = '', last = ''] = match;
  if (first === '') {
    // a suffix: the last n bytes
    const length = Number(last);
    if (length === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'part', start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || (last !== '' && Number(last) < start)) return { kind: 'unsatisfiable' };
  return { kind: 'part', start, end };
}

// A blob is content-addressed, so a URL's bytes never change and the renderer may keep them. A media element reads a video in
// byte ranges; each answer streams only its part.
async function serveThemeBlob(pages: Pick<AppPages, 'themeBlob' | 'themeBlobServed'>, sha256: string, rangeHeader: string | null): Promise<Response> {
  let blob: ServedBlob | undefined;
  try {
    blob = await pages.themeBlob(sha256);
  } catch {
    return notFound();
  }
  if (!blob) return notFound();
  const headers = {
    'content-type': blob.mime,
    'x-content-type-options': 'nosniff',
    'content-security-policy': blob.mime === 'image/svg+xml' ? SVG_CSP : "default-src 'none'",
    'cache-control': 'max-age=31536000, immutable',
    'accept-ranges': 'bytes',
  };
  const range = parseByteRange(rangeHeader, blob.size);
  if (range.kind === 'unsatisfiable') {
    pages.themeBlobServed?.(sha256, 416, `bytes */${blob.size}`);
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${blob.size}`, 'content-length': '0' } });
  }
  const { start, end } = range.kind === 'part' ? range : { start: 0, end: blob.size - 1 };
  const length = Math.max(0, end - start + 1);
  const body = length === 0 ? null : blob.body(start, end);
  if (range.kind === 'whole') {
    pages.themeBlobServed?.(sha256, 200, null);
    return new Response(body, { status: 200, headers: { ...headers, 'content-length': String(length) } });
  }
  const contentRange = `bytes ${start}-${end}/${blob.size}`;
  pages.themeBlobServed?.(sha256, 206, contentRange);
  return new Response(body, { status: 206, headers: { ...headers, 'content-length': String(length), 'content-range': contentRange } });
}

// A derived file is named by its wallpaper's content, so a URL's bytes never change once written.
async function serveThemeCache(pages: AppPages, sha256: string, file: string): Promise<Response> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await pages.themeCache(sha256, file);
  } catch {
    return notFound();
  }
  if (!bytes) return notFound();
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': mimeTypeFor(file),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cache-control': 'max-age=31536000, immutable',
    },
  });
}

// A store thumbnail is named by its content, so a URL's bytes never change once kept.
async function serveStoreThumb(pages: AppPages, sha256: string): Promise<Response> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await pages.storeThumb(sha256);
  } catch {
    return notFound();
  }
  if (!bytes) return notFound();
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/webp', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cache-control': 'max-age=31536000, immutable' },
  });
}

// A screenshot may show file names and chat text, so no renderer keeps it.
function serveThemeShot(pages: AppPages, id: string): Response {
  const png = pages.themeShot(id);
  if (!png) return notFound();
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cache-control': 'no-store' },
  });
}

export function handleAppProtocol(resourceRoot: string, pages: AppPages): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET') return notFound();
    const target = resolveAppRequest(request.url, resourceRoot);
    if (!target) return notFound();
    if (target.kind === 'shell') return htmlPage(pages.shell());
    if (target.kind === 'overlay') return htmlPage(pages.overlay());
    if (target.kind === 'notifier') return htmlPage(pages.notifier());
    if (target.kind === 'themeEditor') return htmlPage(pages.themeEditor());
    if (target.kind === 'forgeAvatar') return serveAvatar(pages, target.key);
    if (target.kind === 'themeBlob') return serveThemeBlob(pages, target.sha256, request.headers.get('range'));
    if (target.kind === 'themeCache') return serveThemeCache(pages, target.sha256, target.file);
    if (target.kind === 'storeThumb') return serveStoreThumb(pages, target.sha256);
    if (target.kind === 'themeRender') return notFound();
    if (target.kind === 'themeShot') return serveThemeShot(pages, target.id);
    if (target.kind === 'panel') {
      const html = pages.panel(target.panelId);
      return html === undefined ? notFound() : htmlPage(html);
    }
    return serveFile(target.root, target.filePath);
  });
}

/**
 * The app scheme in the theme renderer's own session (`sessionProtocol` is that session's): its page, the built files the page
 * loads and the blobs of its job. No other session serves a blob still under analysis, and this one serves no other page.
 */
export function handleThemeRenderProtocol(sessionProtocol: Pick<Protocol, 'handle'>, resourceRoot: string, pages: ThemeRenderPages): void {
  sessionProtocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET') return notFound();
    const target = resolveAppRequest(request.url, resourceRoot);
    if (target?.kind === 'themeRender') return htmlPage(pages.themeRender());
    if (target?.kind === 'themeBlob') return serveThemeBlob(pages, target.sha256, request.headers.get('range'));
    if (target?.kind === 'file') return serveFile(target.root, target.filePath);
    return notFound();
  });
}
