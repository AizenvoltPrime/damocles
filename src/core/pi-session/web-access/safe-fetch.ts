/**
 * SSRF-hardened fetch for `WebFetch` (Phase 7, US-028.2). The model — or a fetched page — picks the
 * URLs, so a naive `fetch` is a readable SSRF: a URL pointing at loopback, the LAN, or the cloud
 * metadata endpoint (`169.254.169.254`) would have its body returned to the model. This wrapper applies
 * the OWASP SSRF controls: reject non-http(s) schemes, resolve the host via DNS and reject any answer in
 * a private/loopback/link-local/ULA range (checking the resolved IP, not the literal, so a public
 * hostname that points inward is still caught), and follow redirects manually so every hop is
 * re-validated (a public URL cannot 302 into internal space). `readBodyCapped` enforces the size limit
 * on the body stream itself, since a `Content-Length` header can be absent or lie.
 *
 * Residual gap: between the DNS check and the kernel's own resolution inside `fetch`, a rebinding TTL=0
 * record could flip to a private IP. Pinning the resolved IP would need a custom undici dispatcher;
 * resolve-and-validate is the standard mitigation for the realistic threat here (the model fetching an
 * internal address directly, or a page linking to one).
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const MAX_REDIRECTS = 5;

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
function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return true;
  return BLOCKED_RANGES.check(ip, version === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Reject `url` unless it is an http(s) URL whose host resolves only to public addresses. IP literals are
 * checked directly; hostnames are resolved (all records) so a name pointing at a private IP is caught.
 * DNS failure is surfaced (recoverable upstream → Jina); a blocked address throws a `Blocked` error.
 */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`Blocked private address: ${host}`);
    return;
  }
  const addresses = await lookup(host, { all: true, family: 0 }); // both A and AAAA — validate every answer
  if (addresses.length === 0) throw new Error(`DNS resolution failed for ${host}`);
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw new Error(`Blocked private address: ${host} → ${address}`);
  }
}

/**
 * SSRF-guarded `fetch` that follows redirects manually, re-validating each hop against the private-range
 * blocklist. Validation errors are prefixed `Blocked` so the caller can treat them as non-recoverable.
 */
export async function safeFetch(initialUrl: string, init: RequestInit): Promise<Response> {
  let current = initialUrl;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(new URL(current));
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
      current = new URL(location, current).href;
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
  const tooLarge = (): Error => new Error(`Response too large (>${Math.ceil(maxBytes / 1024 / 1024)}MB)`);
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
