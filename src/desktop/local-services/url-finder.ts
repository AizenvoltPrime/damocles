// Loopback and hostname URLs in terminal and agent-shell output, after VS Code's urlFinder.ts (MIT, THIRD-PARTY-NOTICES.md):
// `localhost:5173`, `127.0.0.1:8000`, `0.0.0.0:3000`, `[::1]:4000`, `http://devbox:8080` (a hostname URL forwards
// localhost), and Python's "HTTP on 0.0.0.0 port 8000". Program output is hostile, so this is a scanner whose every step is
// bounded (no backtracking regex): its cost is linear in the output's length.
import { BlockList, isIP } from 'node:net';

export interface UrlHit {
  readonly host: 'localhost' | '127.0.0.1' | '0.0.0.0';
  readonly port: number;
}

// the longest line kept while its end has not arrived; a longer line is scanned in pieces
export const MAX_LINE_CHARS = 8192;
// a DNS name's longest form, so the look back from a ':' is bounded
const MAX_HOST_CHARS = 253;
// '[' + the longest IPv6 literal + ']'
const MAX_V6_CHARS = 47;
const NODE_INSPECTOR_PORT = 9229;
// a URL's host, ':' and port fit in the tail kept of an overlong line
const KEPT_TAIL_CHARS = MAX_HOST_CHARS + 8;

// CSI and OSC sequences and the other two-byte escapes; each alternative is a single pass with no nested repetition
// eslint-disable-next-line no-control-regex -- terminal escapes are control characters
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;

const isWord = (code: number): boolean => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const isHostChar = (code: number): boolean => isWord(code) || code === 45 || code === 46;
const isDigit = (code: number): boolean => code >= 48 && code <= 57;
// hex digits, ':' and the '.' of an IPv4-mapped tail
const isV6Char = (code: number): boolean => isDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102) || code === 58 || code === 46;

// a bracketed host that is the target itself: ::1, :: and the IPv4-mapped forms of 127/8 and 0.0.0.0
const BRACKETED_LOOPBACK = new BlockList();
BRACKETED_LOOPBACK.addAddress('::1', 'ipv6');
BRACKETED_LOOPBACK.addAddress('::', 'ipv6');
BRACKETED_LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
BRACKETED_LOOPBACK.addAddress('0.0.0.0', 'ipv4');

// the host before the ':' at `colon`, or undefined when what precedes it is no URL host
function hostBefore(line: string, colon: number): UrlHit['host'] | undefined {
  if (line.charCodeAt(colon - 1) === 93) {
    let at = colon - 2;
    while (at >= 0 && colon - at <= MAX_V6_CHARS && isV6Char(line.charCodeAt(at))) at--;
    if (at < 0 || line.charCodeAt(at) !== 91 || at >= colon - 2) return undefined;
    const address = line.slice(at + 1, colon - 1);
    return isIP(address) === 6 && BRACKETED_LOOPBACK.check(address, 'ipv6') ? 'localhost' : undefined;
  }
  let start = colon;
  while (start > 0 && colon - start < MAX_HOST_CHARS && isHostChar(line.charCodeAt(start - 1))) start--;
  if (start === colon) return undefined;
  const host = line.slice(start, colon).toLowerCase();
  if (host === '127.0.0.1' || host === '0.0.0.0') return host;
  // a word directly before the host makes it part of something else (`xlocalhost`); the scan stopped at a non-host char
  if (host === 'localhost') return 'localhost';
  return start >= 3 && line.startsWith('://', start - 3) ? 'localhost' : undefined;
}

/** Every URL hit in one line, in order. */
export function findUrls(raw: string): UrlHit[] {
  const line = raw.replace(ESCAPES, '');
  const hits: UrlHit[] = [];
  for (let colon = line.indexOf(':'); colon >= 0; colon = line.indexOf(':', colon + 1)) {
    let end = colon + 1;
    while (end < line.length && end - colon <= 5 && isDigit(line.charCodeAt(end))) end++;
    const digits = end - colon - 1;
    if (digits === 0 || digits > 5 || (end < line.length && isWord(line.charCodeAt(end)))) continue;
    const port = Number(line.slice(colon + 1, end));
    if (port < 1 || port > 65535) continue;
    const host = hostBefore(line, colon);
    if (host === undefined) continue;
    if (port !== NODE_INSPECTOR_PORT && line.startsWith('Debugger listening on')) continue;
    hits.push({ host, port });
  }
  if (hits.length > 0) return hits;
  return pythonServer(line);
}

// Python's http.server: "Serving HTTP on 0.0.0.0 port 8000 ..."
function pythonServer(line: string): UrlHit[] {
  const at = line.indexOf('HTTP on ');
  if (at < 0) return [];
  const rest = line.slice(at + 'HTTP on '.length, at + 'HTTP on '.length + 32);
  const host = rest.startsWith('127.0.0.1 port ') ? '127.0.0.1' : rest.startsWith('0.0.0.0 port ') ? '0.0.0.0' : undefined;
  if (!host) return [];
  const digits = /^\d{1,5}/.exec(rest.slice(host.length + ' port '.length))?.[0];
  const port = digits === undefined ? 0 : Number(digits);
  return port >= 1 && port <= 65535 ? [{ host, port }] : [];
}

export interface UrlFinder {
  // a chunk of output; hits are reported once their line ends
  push(text: string): void;
  // the output ended: its last line, which has no newline, is scanned too
  end(): void;
}

/** Output chunks joined into lines (a URL may arrive split), each line scanned once. */
export function createUrlFinder(onHit: (hit: UrlHit) => void): UrlFinder {
  let pending = '';
  const scan = (line: string): void => {
    for (const hit of findUrls(line)) onHit(hit);
  };
  return {
    push: (text) => {
      let start = 0;
      for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n', start)) {
        scan(pending + text.slice(start, newline));
        pending = '';
        start = newline + 1;
      }
      pending += text.slice(start);
      // a line past the bound is scanned up to a space before its kept tail, so no URL is cut in two; one with no space is junk
      if (pending.length > MAX_LINE_CHARS) {
        const cut = pending.lastIndexOf(' ', pending.length - KEPT_TAIL_CHARS);
        if (cut > 0) scan(pending.slice(0, cut));
        pending = cut > 0 ? pending.slice(cut) : pending.slice(-KEPT_TAIL_CHARS);
      }
    },
    end: () => {
      const last = pending;
      pending = '';
      if (last.length > 0) scan(last);
    },
  };
}
