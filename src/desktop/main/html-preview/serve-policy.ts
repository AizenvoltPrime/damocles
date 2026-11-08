// What an HTML preview serves, for the damocles-preview scheme and the loopback server alike (docs/invariants.md "Desktop
// host", HTML previews). Pure: no IO.
// The shell renderer imports this module too: no Node built-in, electron or desktop main import.
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../../shared/relative-path';

// The loopback server's own paths; no project file under it is ever served.
export const RESERVED_PREVIEW_SEGMENT = '__damocles_preview';

// view: the preview tab's own view, whose print() would stall main's event loop (D85); browser: the system browser
export type PreviewTarget = 'view' | 'browser';

const DENIED_EXTENSIONS: ReadonlySet<string> = new Set(['pem', 'key', 'crt', 'cer', 'p12', 'pfx', 'jks', 'keystore', 'ppk', 'p8']);
const DENIED_NAMES: ReadonlySet<string> = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk']);
// An NTFS 8.3 alias (GIT~1 for .git, ID_ED2~1 for id_ed25519) opens the long-named entry, so no segment may look like one.
const SHORT_NAME = /~\d/;

const MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['htm', 'text/html; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['map', 'application/json; charset=utf-8'],
  ['wasm', 'application/wasm'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['otf', 'font/otf'],
  ['txt', 'text/plain; charset=utf-8'],
  ['xml', 'application/xml'],
  ['csv', 'text/csv; charset=utf-8'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['ogg', 'audio/ogg'],
  ['vtt', 'text/vtt; charset=utf-8'],
  ['m4a', 'audio/mp4'],
  ['mov', 'video/quicktime'],
  ['flac', 'audio/flac'],
  ['aac', 'audio/aac'],
  ['opus', 'audio/ogg'],
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function isDeniedPath(relativePath: string, pnpm: boolean): boolean {
  const segments = relativePath.split('/');
  const name = segments.at(-1)!.toLowerCase();
  if (segments[0]!.toLowerCase() === RESERVED_PREVIEW_SEGMENT) return true;
  if (DENIED_NAMES.has(name) || DENIED_EXTENSIONS.has(extensionOf(name))) return true;
  return segments.some((segment, at) => {
    const lower = segment.toLowerCase();
    if (pnpm && lower === '.pnpm' && segments[at - 1]?.toLowerCase() === 'node_modules') return false;
    return (lower.startsWith('.') && lower !== '.well-known') || SHORT_NAME.test(lower);
  });
}

/** Whether a '/' separated project path names something a preview never serves: a dot entry, a key or certificate, an 8.3 alias. */
export function isDeniedPreviewPath(relativePath: string): boolean {
  return isDeniedPath(relativePath, false);
}

/** Whether a preview would serve the project path as named: a relative file path, Windows-safe and not denied. */
export function isServablePreviewPath(relativePath: string): boolean {
  return isRelativeFilePath(relativePath) && !hasUnsafeWindowsSegment(relativePath) && !isDeniedPreviewPath(relativePath);
}

/**
 * The deny list again on the file's real path relative to the project's real root, so a folder link cannot reach a dot
 * folder; pnpm's store, a `.pnpm` folder directly in a `node_modules` folder, is where its package links lead.
 */
export function isDeniedResolvedPath(resolvedPath: string): boolean {
  return isDeniedPath(resolvedPath, true);
}

/**
 * The project file a request's path names, decoded once: '' and a path ending in '/' name the folder's index.html; undefined
 * for anything that is no relative file path, would resolve elsewhere on Windows, or is denied.
 */
export function previewRequestPath(pathname: string): { readonly relativePath: string; readonly folderIndex: boolean } | undefined {
  if (!pathname.startsWith('/')) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(1));
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
  const folderIndex = decoded === '' || decoded.endsWith('/');
  const relativePath = folderIndex ? `${decoded}index.html` : decoded;
  if (!isServablePreviewPath(relativePath)) return undefined;
  return { relativePath, folderIndex };
}

// first-last (last open when absent) or the final suffix bytes, as RFC 9110 §14.1.1 writes them
export type ByteRangeSpec = { readonly first: number; readonly last?: number } | { readonly suffix: number };

// One range of the bytes unit; a list (a comma) never matches.
const SINGLE_RANGE = /^bytes=[ \t]*(\d*)-(\d*)[ \t]*$/i;

const position = (digits: string): number => Math.min(Number(digits), Number.MAX_SAFE_INTEGER);

/**
 * The one byte range a GET's Range header asks for; undefined serves the whole file, as RFC 9110 §14.2 allows for another unit,
 * several ranges or an invalid one. Responses carry no validator, so an If-Range never matches and the whole file is sent.
 */
export function requestedRange(range: string | undefined, ifRange: string | undefined): ByteRangeSpec | undefined {
  if (range === undefined || ifRange !== undefined) return undefined;
  const match = SINGLE_RANGE.exec(range);
  if (!match) return undefined;
  const [, first = '', last = ''] = match;
  if (first === '') return last === '' ? undefined : { suffix: position(last) };
  if (last === '') return { first: position(first) };
  // ordered as written, since positions past MAX_SAFE_INTEGER clamp to one value
  return BigInt(last) < BigInt(first) ? undefined : { first: position(first), last: position(last) };
}

/** The URL path of a project file, each segment percent-encoded, so it never reads as another origin ('//host'). */
export function previewUrlPath(relativePath: string): string {
  return `/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

export function previewContentType(relativePath: string): string {
  return MIME_TYPES.get(extensionOf(relativePath.slice(relativePath.lastIndexOf('/') + 1))) ?? 'application/octet-stream';
}

export function isHtmlType(contentType: string): boolean {
  return contentType.startsWith('text/html;');
}

// The bytes a browser's encoding prescan reads (WHATWG HTML "prescan a byte stream to determine its encoding").
export const CHARSET_PRESCAN_BYTES = 1024;

const BOMS: readonly (readonly number[])[] = [[0xef, 0xbb, 0xbf], [0xff, 0xfe], [0xfe, 0xff]];
// one attribute of a tag: its name and its value, double-quoted, single-quoted or bare
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

/**
 * Whether the start of an HTML file names its own encoding: a byte order mark, or a `<meta charset>` or `<meta http-equiv=
 * "content-type" content="...charset=...">` outside a comment. The name itself is the browser's to read.
 */
export function declaresCharset(head: Uint8Array): boolean {
  if (BOMS.some((bom) => bom.every((byte, at) => head[at] === byte))) return true;
  const text = Buffer.from(head.buffer, head.byteOffset, Math.min(head.byteLength, CHARSET_PRESCAN_BYTES)).toString('latin1').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const tag of text.matchAll(/<meta[\s/]([^>]*)/gi)) {
    const attributes = new Map<string, string>();
    for (const [, name, ...values] of tag[1]!.matchAll(ATTRIBUTE)) {
      const key = name!.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, values.find((value) => value !== undefined) ?? '');
    }
    if (attributes.has('charset')) return true;
    if (attributes.get('http-equiv')?.toLowerCase() === 'content-type' && /charset\s*=/i.test(attributes.get('content') ?? '')) return true;
  }
  return false;
}

// No allow-modals in the view, so Blink refuses a page's print(), whose dialog would stall main's event loop (D85). The view
// gets allow-popups so a popup reaches main's window-open handler, which denies it; docs/invariants.md "HTML previews" has the
// browser's popup and fetch rules.
export function previewCsp(trusted: boolean, target: PreviewTarget): string {
  if (!trusted) {
    return target === 'view'
      ? "sandbox allow-same-origin allow-popups; script-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'self'"
      : "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox; default-src 'self' https: data:; style-src 'self' https: data: 'unsafe-inline'; script-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'self'";
  }
  return target === 'view'
    ? "sandbox allow-scripts allow-same-origin allow-forms allow-popups; object-src 'none'; base-uri 'self'"
    : "sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox; object-src 'none'; base-uri 'self'";
}

/** The headers of every preview response, a refusal included; never a CORS header. */
export function previewHeaders(trusted: boolean, target: PreviewTarget): Record<string, string> {
  return {
    'Content-Security-Policy': previewCsp(trusted, target),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}
