// A served root's files in the agent's form (docs/invariants.md "Ports and the remote browser"): the agent names and reads
// file:// addresses, and no loopback port or one-time token of the server that serves them reaches it. Page output is hostile,
// so every scan here is linear.

/** The path of the one-time open URL; must stay equal to preview-http-server.ts OPEN_PATH (RESERVED_PREVIEW_SEGMENT). */
export const SERVED_OPEN_PATH = '/__damocles_preview/open';
/** The one-time open URL's parameter that carries the opened address's query into the server's redirect. */
export const SERVED_OPEN_QUERY = 'q';

/** A file of one of a chat's roots, as its core resolved it: the root by kind, never by a path. */
export type ServedFile = { readonly kind: 'project'; readonly relPath: string } | { readonly kind: 'design'; readonly designId: string; readonly relPath: string };

/** What the remote core sends with a relayed BrowserOpen or BrowserNavigate of a root file; displayRoot is display only. */
export type RelayedServedFile = ServedFile & { readonly displayRoot: string };

/**
 * main's answer to a served file: the one-time URL that opens it and the origin its pages load from, or why it serves none;
 * `unavailable` when main lists no root or server for the view, as opposed to a file the deny list or confinement refuses.
 */
export type ServedFileAnswer = { readonly url: string; readonly origin: string } | { readonly refused: string; readonly unavailable?: boolean };

export interface ServedMapping {
  // http://127.0.0.1:<port>, the origin of one served root
  readonly origin: string;
  // the root's path on the machine whose files it serves; display only, never used to read anything
  readonly displayRoot: string;
}

const DRIVE_PATH = /^\/([A-Za-z]):(?=\/|$)/;

function decoded(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
}

/**
 * The path a file:// URL names, as the browser would load it: dot segments resolved by the WHATWG parser (`%2e` ones too,
 * never above a drive letter), then percent-decoded once. `/home/u/a` for POSIX, `C:/Users/a` for a Windows drive
 * (`file:///C:/`, `file:///c|/`, `file://C:/`). A query or fragment is dropped. Undefined for anything else: a UNC host, and
 * an encoded `/` or `\`, which Chromium refuses in a file URL.
 */
export function fileUrlPath(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== 'file:' || parsed.hostname !== '' || /%2f|%5c/i.test(parsed.pathname)) return undefined;
  const path = decoded(parsed.pathname);
  if (path === undefined || path.includes('\0')) return undefined;
  const drive = DRIVE_PATH.exec(path);
  return drive ? `${drive[1]!.toUpperCase()}:${path.slice(drive[0].length)}` : path;
}

/** Whether the browser reads `url` as a file: URL, whatever fileUrlPath makes of it. */
export function isFileUrl(url: string): boolean {
  return URL.canParse(url) && new URL(url).protocol === 'file:';
}

/**
 * The one-time open URL of a file:// address: its query rides in SERVED_OPEN_QUERY, which the server's redirect appends, and
 * its fragment on the open URL itself, which the browser keeps across a redirect whose Location has none.
 */
export function withAddressParts(openUrl: string, address: string): string {
  if (!URL.canParse(address)) return openUrl;
  const { search, hash } = new URL(address);
  const open = new URL(openUrl);
  if (search.length > 1) open.searchParams.set(SERVED_OPEN_QUERY, search.slice(1));
  open.hash = hash;
  return open.href;
}

/** The file:// form of a root path, POSIX or Windows, each segment percent-encoded. */
export function fileUrlOfRoot(displayRoot: string): string {
  const path = displayRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const drive = /^([A-Za-z]):/.exec(path);
  const segments = (drive ? path.slice(2) : path).split('/').map(encodeURIComponent).join('/');
  return drive ? `file:///${drive[1]!.toUpperCase()}:${segments}` : `file://${segments}`;
}

// http on a loopback name the served servers accept as Host; linear, and the port is never a prefix of a longer number
const SERVED_ORIGIN = /\bhttp:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})(?!\d)/gi;
// where a URL in prose ends
const URL_END = /[\s"'<>`()[\]{}]/g;

function urlEnd(text: string, from: number): number {
  const scan = new RegExp(URL_END.source, 'g');
  scan.lastIndex = from;
  return scan.exec(text)?.index ?? text.length;
}

// The file a one-time open URL names, with the query and fragment it carries; never its token.
function openedAddress(rest: string): string {
  const hashAt = rest.indexOf('#');
  const query = hashAt < 0 ? rest : rest.slice(0, hashAt);
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : '');
  const relPath = params.get('p');
  const search = params.get(SERVED_OPEN_QUERY);
  const path = relPath === null ? '' : relPath.split('/').map(encodeURIComponent).join('/');
  return `${path}${search ? `?${search}` : ''}${hashAt < 0 ? '' : rest.slice(hashAt)}`;
}

/**
 * `text` with every URL on a mapped served origin in file:// form: the origin becomes `file://<displayRoot>`, its path, query
 * and fragment kept, and a one-time open URL becomes the file it opens with the query and fragment it carries, its token dropped.
 */
export function servedToFile(text: string, mappings: readonly ServedMapping[]): string {
  if (mappings.length === 0) return text;
  const roots = new Map<number, string>();
  for (const mapping of mappings) roots.set(Number(new URL(mapping.origin).port), fileUrlOfRoot(mapping.displayRoot));
  const scan = new RegExp(SERVED_ORIGIN.source, 'gi');
  let out = '';
  let from = 0;
  for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
    const root = roots.get(Number(match[1]));
    if (root === undefined) continue;
    let end = scan.lastIndex;
    let replacement = root;
    if (text.startsWith(SERVED_OPEN_PATH, end)) {
      const stop = urlEnd(text, end);
      replacement = `${root}/${openedAddress(text.slice(end + SERVED_OPEN_PATH.length, stop))}`;
      end = stop;
      scan.lastIndex = stop;
    }
    out += text.slice(from, match.index) + replacement;
    from = end;
  }
  return out + text.slice(from);
}
