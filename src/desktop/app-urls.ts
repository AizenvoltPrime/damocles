import * as path from 'node:path';

// The app:// origin's URL rules, shared by main's protocol handler and core's panel proxies; no electron import.

export const APP_SCHEME = 'app';
export const APP_HOST = 'damocles';
export const APP_ORIGIN: string = `${APP_SCHEME}://${APP_HOST}`;

// URL path prefix → directory under resourceRoot; nothing outside these directories is ever served. A Map, so a prefix
// such as __proto__ or constructor finds nothing.
export const SERVED_ROOTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['webview', ['dist', 'webview']],
  ['desktop-shell', ['dist', 'desktop-shell']],
]);

// Single files outside the served roots, matched by exact URL path; a Map for SERVED_ROOTS' reason.
export const SERVED_FILES: ReadonlyMap<string, readonly string[]> = new Map([
  ['/resources/icon.png', ['resources', 'icon.png']],
]);

// CSP worker-src of a chat: the directory the app:// handler serves the built webview assets from (SERVED_ROOTS).
export const CHAT_WORKER_SRC: string = `${APP_ORIGIN}/webview/assets/`;

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The app:// URL serving an absolute path; throws for a path the protocol handler would refuse. */
export function appResourceUri(resourceRoot: string, absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  for (const [urlPath, parts] of SERVED_FILES) {
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
