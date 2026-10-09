import * as fs from 'node:fs';
import * as path from 'node:path';
import { protocol } from 'electron';
import { NOTIFIER_PAGE_PATH } from '../preload/page-paths';

export const APP_SCHEME = 'app';
export const APP_HOST = 'damocles';
export const APP_ORIGIN: string = `${APP_SCHEME}://${APP_HOST}`;

// URL path prefix → directory under resourceRoot; nothing outside these directories is ever served. A Map, so a prefix
// such as __proto__ or constructor finds nothing.
const SERVED_ROOTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['webview', ['dist', 'webview']],
  ['desktop-shell', ['dist', 'desktop-shell']],
]);

// Every page is generated in memory under its CSP; the built index.html files carry none, so they are never served.
const BUILT_PAGE = /\.html?$/i;

// Script responses carry a policy of their own: a worker does not inherit its page's CSP, and Monaco's workers are served here.
const SCRIPT_CSP = `default-src 'none'; script-src ${APP_ORIGIN}`;

// Single files outside the served roots, matched by exact URL path.
const SERVED_FILES: Readonly<Record<string, readonly string[]>> = {
  '/resources/icon.png': ['resources', 'icon.png'],
};

const PANEL_PAGE = /^\/panel\/([A-Za-z0-9-]+)\/index\.html$/;
const SHELL_PAGE = '/shell/index.html';
const OVERLAY_PAGE = '/overlay/index.html';

// The window's own page; main generates it per request with a fresh script nonce.
export const SHELL_PAGE_URL: string = `${APP_ORIGIN}${SHELL_PAGE}`;
// The overlay view's page, generated the same way.
export const OVERLAY_PAGE_URL: string = `${APP_ORIGIN}${OVERLAY_PAGE}`;
// The desktop popup window's page (D52), generated the same way.
export const NOTIFIER_PAGE_URL: string = `${APP_ORIGIN}${NOTIFIER_PAGE_PATH}`;

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
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export type AppRequestTarget =
  | { readonly kind: 'file'; readonly root: string; readonly filePath: string }
  | { readonly kind: 'panel'; readonly panelId: string }
  | { readonly kind: 'shell' }
  | { readonly kind: 'overlay' }
  | { readonly kind: 'notifier' };

export interface AppPages {
  panel(panelId: string): string | undefined;
  shell(): string;
  overlay(): string;
  notifier(): string;
}

export function panelPageUrl(panelId: string): string {
  return `${APP_ORIGIN}/panel/${panelId}/index.html`;
}

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
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

  const file = SERVED_FILES[pathname];
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
    [real, realRoot] = await Promise.all([fs.promises.realpath(filePath), fs.promises.realpath(root)]);
  } catch {
    return notFound();
  }
  // A symlink or junction inside a served root must not lead out of it.
  if (!isInside(realRoot, real)) return notFound();
  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) return notFound();
  const body = await fs.promises.readFile(real);
  const contentType = mimeTypeFor(real);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'x-content-type-options': 'nosniff',
      ...(contentType.startsWith('text/javascript') ? { 'content-security-policy': SCRIPT_CSP } : {}),
    },
  });
}

// Must run before app `ready`.
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
}

function htmlPage(html: string): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' } });
}

export function handleAppProtocol(resourceRoot: string, pages: AppPages): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET') return notFound();
    const target = resolveAppRequest(request.url, resourceRoot);
    if (!target) return notFound();
    if (target.kind === 'shell') return htmlPage(pages.shell());
    if (target.kind === 'overlay') return htmlPage(pages.overlay());
    if (target.kind === 'notifier') return htmlPage(pages.notifier());
    if (target.kind === 'panel') {
      const html = pages.panel(target.panelId);
      return html === undefined ? notFound() : htmlPage(html);
    }
    return serveFile(target.root, target.filePath);
  });
}

/** The app:// URL serving an absolute path; throws for a path the protocol handler would refuse. */
export function appResourceUri(resourceRoot: string, absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  for (const [urlPath, parts] of Object.entries(SERVED_FILES)) {
    if (resolved === path.join(resourceRoot, ...parts)) return `${APP_ORIGIN}${urlPath}`;
  }
  for (const [prefix, parts] of SERVED_ROOTS) {
    const root = path.join(resourceRoot, ...parts);
    if (!isInside(root, resolved)) continue;
    const relative = path.relative(root, resolved).split(path.sep).map(encodeURIComponent).join('/');
    return `${APP_ORIGIN}/${prefix}/${relative}`;
  }
  throw new Error(`${absolutePath} is outside the paths app:// serves`);
}
