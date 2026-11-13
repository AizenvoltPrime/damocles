/**
 * SSRF-hardened fetch for `WebFetch` (Phase 7, US-028.2). The model — or a fetched page — picks the
 * URLs, so a naive `fetch` is a readable SSRF: a URL pointing at loopback, the LAN, or the cloud
 * metadata endpoint (`169.254.169.254`) would have its body returned to the model. This wrapper applies
 * the OWASP SSRF controls: reject non-http(s) schemes, reject an IP literal in a private/loopback/link-local/ULA
 * range, resolve a name inside the connection's own lookup and reject it when any answer is in such a range,
 * connect only to the answers that lookup checked (the hostname stays the Host header, the SNI name and the
 * certificate's subject), and follow redirects manually so every hop is checked again. `readBodyCapped` enforces
 * the size limit on the body stream itself, since a `Content-Length` header can be absent or lie.
 */

import type { LookupAddress, LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';
import type { AddressResolver, ResolvedAddress } from '../../browser/client-network-policy';

const MAX_REDIRECTS = 5;

/** A fetch the guard refused: a blocked scheme or address, too many redirects, a body over its cap, or a refused redirect. */
export class FetchRefusedError extends Error {}

/** A redirect `safeFetch` did not follow because its caller refused the target (`SafeFetchOptions.redirectRefused`). */
export class RedirectRefusedError extends FetchRefusedError {
  readonly from: string;
  readonly location: string;
  readonly status: number;

  constructor(from: string, location: string, status: number) {
    super(`Redirect not followed: ${from} redirects (HTTP ${status}) to ${location}`);
    this.from = from;
    this.location = location;
    this.status = status;
  }
}

export interface SafeFetchOptions {
  /** Refuse an http hop, the first or a redirect's. */
  readonly httpsOnly?: boolean;
  /** Whether a redirect to this absolute URL must not be followed; the fetch then throws `RedirectRefusedError`. */
  readonly redirectRefused?: (target: string) => boolean;
}

/**
 * Loopback/private/link-local/ULA/reserved ranges that must never be fetched. `BlockList` is the
 * platform primitive for this — it canonicalizes IP forms (decimal/octal/hex literals collapse in the
 * URL parser, and IPv4-mapped IPv6 like `::ffff:7f00:1` is matched against the IPv4 rules), so a
 * hand-rolled range check can't miss an alternate encoding.
 */
const BLOCKED_RANGES = new BlockList();
BLOCKED_RANGES.addSubnet('0.0.0.0', 8); // "this" network
BLOCKED_RANGES.addSubnet('10.0.0.0', 8); // private
BLOCKED_RANGES.addSubnet('100.64.0.0', 10); // CGNAT
BLOCKED_RANGES.addSubnet('127.0.0.0', 8); // loopback
BLOCKED_RANGES.addSubnet('169.254.0.0', 16); // link-local + cloud metadata
BLOCKED_RANGES.addSubnet('172.16.0.0', 12); // private
BLOCKED_RANGES.addSubnet('192.168.0.0', 16); // private
BLOCKED_RANGES.addSubnet('224.0.0.0', 4); // multicast
BLOCKED_RANGES.addSubnet('240.0.0.0', 4); // reserved + broadcast
BLOCKED_RANGES.addAddress('::1', 'ipv6'); // loopback
BLOCKED_RANGES.addSubnet('::', 128, 'ipv6'); // unspecified
BLOCKED_RANGES.addSubnet('fc00::', 7, 'ipv6'); // unique-local
BLOCKED_RANGES.addSubnet('fe80::', 10, 'ipv6'); // link-local
BLOCKED_RANGES.addSubnet('ff00::', 8, 'ipv6'); // multicast

/** True if `ip` (an IP literal) is in a blocked range. A non-IP string is blocked conservatively. */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return true;
  return BLOCKED_RANGES.check(ip, version === 6 ? 'ipv6' : 'ipv4');
}

// both A and AAAA: every answer is checked
const resolveAll: AddressResolver = (hostname) => lookup(hostname, { all: true, family: 0 });

/** Refuses a scheme other than http(s) and a blocked IP literal; answers the host without IPv6 brackets. */
function checkedLiteral(url: URL): string {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchRefusedError(`Blocked URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(host) && isBlockedIp(host)) throw new FetchRefusedError(`Blocked private address: ${host}`);
  return host;
}

/** The answers for `hostname` when none is blocked, in the family asked for; throws a `Blocked` refusal otherwise. */
function publicAnswers(hostname: string, answers: readonly ResolvedAddress[], family: number): readonly ResolvedAddress[] {
  if (answers.length === 0) throw new Error(`DNS resolution failed for ${hostname}`);
  for (const { address } of answers) {
    if (isBlockedIp(address)) throw new FetchRefusedError(`Blocked private address: ${hostname} → ${address}`);
  }
  const wanted = family === 4 || family === 6 ? answers.filter((answer) => answer.family === family) : answers;
  if (wanted.length === 0) throw Object.assign(new Error(`DNS resolution found no IPv${family} address for ${hostname}`), { code: 'ENOTFOUND' });
  return wanted;
}

/**
 * Reject `url` unless it is an http(s) URL whose host resolves only to public addresses. IP literals are
 * checked directly; hostnames are resolved (all records) so a name pointing at a private IP is caught.
 * This checks a name before another party resolves it (a reader service, a proxy); a connection Damocles
 * makes itself checks at connect time instead (`guardedLookup`).
 */
export async function assertPublicUrl(url: URL, resolve: AddressResolver = resolveAll): Promise<void> {
  const host = checkedLiteral(url);
  if (isIP(host)) return;
  publicAnswers(host, await resolve(host), 0);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A socket's own lookup: the name resolves once, any blocked answer refuses it, and the socket connects only to the
 * answers checked here, so a DNS answer that changes between a check and the connection reaches nothing.
 */
export function guardedLookup(resolve: AddressResolver = resolveAll): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : (options.family ?? 0);
    resolve(hostname).then((answers) => publicAnswers(hostname, answers, family)).then(
      (answers) => {
        if (options.all === true) callback(null, answers.map(({ address, family: version }) => ({ address, family: version })));
        else callback(null, answers[0]!.address, answers[0]!.family);
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), ''),
    );
  };
}

/** How the process reaches an origin through a proxy, or undefined where it connects directly. */
export type ProxyRoute = (origin: string) => Promise<Dispatcher | undefined>;

let proxyRoute: ProxyRoute | undefined;

/**
 * Sends the guarded fetch through the process's proxy for an origin that has one; answers the undo. Through a proxy the
 * guard checks the URL's literal and this computer's DNS answers for its name before the request, but the proxy resolves
 * the name again itself, so the address it connects to (an intranet or split-horizon answer included) goes unchecked.
 */
export function routeGuardedFetchThroughProxies(route: ProxyRoute): () => void {
  proxyRoute = route;
  return () => {
    if (proxyRoute === route) proxyRoute = undefined;
  };
}

/** A fetch the host's own network stack makes, with its own proxy resolution. */
export type HostFetch = (url: string, init: RequestInit) => Promise<Response>;

let hostFetch: HostFetch | undefined;

/**
 * Sends every guarded fetch through the host's own fetch (VS Code's, which resolves system, PAC and `http.proxy` proxies
 * and offers extensions no per-URL proxy lookup); answers the undo. The guard then checks the URL's literal and this
 * computer's DNS answers before each hop, and the host's connection resolves the name again, so it cannot pin the address.
 */
export function connectGuardedFetchThroughHost(fetch: HostFetch): () => void {
  hostFetch = fetch;
  return () => {
    if (hostFetch === fetch) hostFetch = undefined;
  };
}

/** The guard's refusal behind a failed fetch (undici wraps a connect error as `cause`), else undefined. */
function refusalIn(err: unknown): FetchRefusedError | undefined {
  for (let current: unknown = err, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth++) {
    if (current instanceof FetchRefusedError) return current;
  }
  return undefined;
}

export type GuardedFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A fetch of one hop that connects only to public addresses: the literal is checked first, a name in `guardedLookup`. */
export function createGuardedFetch(resolve: AddressResolver = resolveAll): GuardedFetch {
  const direct = new Agent({ connect: { lookup: guardedLookup(resolve) } });
  return async (url, init) => {
    const target = new URL(url);
    checkedLiteral(target);
    if (hostFetch) {
      await assertPublicUrl(target, resolve);
      return hostFetch(url, init);
    }
    const proxy = await proxyRoute?.(target.origin);
    if (proxy) await assertPublicUrl(target, resolve);
    try {
      return (await undiciFetch(url, { ...(init as unknown as UndiciRequestInit), dispatcher: proxy ?? direct })) as unknown as Response;
    } catch (err) {
      throw refusalIn(err) ?? err;
    }
  };
}

export const guardedFetch: GuardedFetch = createGuardedFetch();

/**
 * SSRF-guarded `fetch` that follows redirects manually, checking each hop through `guardedFetch`. Validation errors are
 * `FetchRefusedError`s prefixed `Blocked`, so the caller can treat them as non-recoverable.
 */
export async function safeFetch(initialUrl: string, init: RequestInit, options: SafeFetchOptions = {}): Promise<Response> {
  let current = initialUrl;
  for (let hop = 0; ; hop++) {
    const url = new URL(current);
    if (options.httpsOnly && url.protocol !== 'https:') throw new FetchRefusedError(`Blocked URL scheme: ${url.protocol} (only https is fetched)`);
    const response = await guardedFetch(current, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      // An unread body holds its connection until it is collected.
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new FetchRefusedError(`Too many redirects (>${MAX_REDIRECTS})`);
      const next = new URL(location, current).href;
      if (options.redirectRefused?.(next)) throw new RedirectRefusedError(current, next, response.status);
      current = next;
      continue;
    }
    return response;
  }
}

/**
 * Read a response body as bytes, aborting once `maxBytes` is exceeded — so a chunked or lying
 * `Content-Length` cannot drive unbounded buffering. Throws a `Response too large` error at the cap.
 * A null body (per WHATWG fetch: only empty/bodyless responses — 204, HEAD, etc.) reads as empty,
 * which keeps the cap honest (we never buffer-before-checking, even on that path).
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = (): Error => new FetchRefusedError(`Response too large (>${Math.ceil(maxBytes / 1024 / 1024)}MB)`);
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
