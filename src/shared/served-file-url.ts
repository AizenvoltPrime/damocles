// A served root's files in the agent's form (docs/invariants.md "Ports and the remote browser"): the agent names and reads
// file:// addresses, and no loopback port or one-time token of the server that serves them reaches it. Page output is hostile,
// so every scan here is linear.

/** The path of the one-time open URL; must stay equal to preview-http-server.ts OPEN_PATH (RESERVED_PREVIEW_SEGMENT). */
export const SERVED_OPEN_PATH = '/__damocles_preview/open';
/** The one-time open URL's parameter that carries the opened address's query into the server's redirect. */
export const SERVED_OPEN_QUERY = 'q';

/**
 * A file of one of a chat's roots, as its core resolved it: a project or design root by kind, never by a path; a folder the
 * permission gate granted to the chat by its path on the machine whose files it is.
 */
export type ServedFile =
  | { readonly kind: 'project'; readonly relPath: string }
  | { readonly kind: 'design'; readonly designId: string; readonly relPath: string }
  | { readonly kind: 'folder'; readonly folder: string; readonly relPath: string };

/** The most folders outside its project and design folders one chat's browser is served, each a loopback listener. */
export const MAX_SERVED_FOLDERS_PER_CHAT = 8;

/** What the remote core sends with a relayed BrowserOpen or BrowserNavigate of a root file; displayRoot is display only. */
export type RelayedServedFile = ServedFile & { readonly displayRoot: string };

/** The served root's answer to a file: the one-time URL that opens it and the origin its pages load from, or why it serves none. */
export type ServedFileAnswer = { readonly url: string; readonly origin: string } | { readonly refused: string };

export interface ServedMapping {
  // http://<label>.localhost:<port>, the origin of one chat's grant of a served root
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
 * (`file:///C:/`, `file:///c|/`, `file://C:/`), `//server/share/a` for a host. A query or fragment is dropped. Undefined for
 * anything else: an encoded `/` or `\`, which Chromium refuses in a file URL, a NUL and a bad escape.
 */
export function fileUrlPath(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== 'file:' || /%2f|%5c/i.test(parsed.pathname)) return undefined;
  const path = decoded(parsed.pathname);
  if (path === undefined || path.includes('\0')) return undefined;
  if (parsed.hostname !== '') return `//${parsed.hostname}${path}`;
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

/** The file:// form of a root path, POSIX, Windows or UNC, each segment percent-encoded. */
export function fileUrlOfRoot(displayRoot: string): string {
  const path = displayRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const drive = /^([A-Za-z]):/.exec(path);
  const segments = (drive ? path.slice(2) : path).split('/').map(encodeURIComponent).join('/');
  if (drive) return `file:///${drive[1]!.toUpperCase()}:${segments}`;
  // a UNC root's '//server' is the URL's host
  return path.startsWith('//') ? `file:${segments}` : `file://${segments}`;
}

// A chat's grant of a served root is a host of its own, `<label>.localhost`, so no other chat's cookie or page reaches it
// (docs/invariants.md "Browser"); the label is 128 random bits in lowercase hex.
// a trailing dot included, since Chrome loads that name too
const GRANT_HOST = /^[0-9a-f]{32}\.localhost\.?$/;
// a URL on a grant host, or the bare host (location.host), whatever its port, so none goes unmapped; linear
const SERVED_ORIGIN = /(\bhttp:\/\/)?(?<![\w.-])([0-9a-f]{32})\.localhost(\.?)(?::(\d+))?(?![\w.-])/gi;
// what a grant URL becomes in an answer to a chat that holds no mapping of it, so its host never reaches that chat
export const UNMAPPED_SERVED_PAGE = '[a served page this chat cannot open]';

/** Whether `hostname` (URL.hostname form) names a served grant's host the way Chrome loads it. */
export function isServedGrantHost(hostname: string): boolean {
  return GRANT_HOST.test(hostname);
}
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
 * A URL on a grant origin no mapping names becomes UNMAPPED_SERVED_PAGE, and so does such a bare host; a mapped bare host stays.
 */
export function servedToFile(text: string, mappings: readonly ServedMapping[]): string {
  const roots = new Map<string, string>();
  for (const mapping of mappings) roots.set(new URL(mapping.origin).host, fileUrlOfRoot(mapping.displayRoot));
  const scan = new RegExp(SERVED_ORIGIN.source, 'gi');
  let out = '';
  let from = 0;
  for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
    // a trailing dot or a missing port names no grant's origin, whose server refuses it
    const root = match[3] !== '' || match[4] === undefined ? undefined : roots.get(`${match[2]!.toLowerCase()}.localhost:${Number(match[4])}`);
    if (match[1] === undefined) {
      if (root !== undefined) continue;
      out += text.slice(from, match.index) + UNMAPPED_SERVED_PAGE;
      from = scan.lastIndex;
      continue;
    }
    if (root === undefined) {
      const stop = urlEnd(text, scan.lastIndex);
      out += text.slice(from, match.index) + UNMAPPED_SERVED_PAGE;
      from = stop;
      scan.lastIndex = stop;
      continue;
    }
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
