import { lookup } from 'dns';
import { isIP } from 'net';

/**
 * Guards extension-host fetches against page-controlled URLs (SSRF). Favicon candidate URLs come
 * from a DOM scan of an untrusted page, so a hostile page could point them at loopback, link-local,
 * or private-range addresses to probe services reachable only from the host. We reject any URL whose
 * host resolves to a non-public address BEFORE the fetch happens.
 */

/** True for IPv4/IPv6 literals that must never be reachable from a page-controlled fetch. */
export function isPrivateOrLocalAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]!; // strip zone id
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local fc00::/7
  // IPv4-mapped / -compatible (::ffff:a.b.c.d) — validate the embedded IPv4.
  const mapped = addr.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

/** Resolves a hostname to a single IP address string. Injectable so tests avoid real DNS. */
export type HostResolver = (hostname: string) => Promise<string>;

const defaultResolver: HostResolver = (hostname) =>
  new Promise((resolve, reject) => {
    lookup(hostname, (err, addr) => (err ? reject(err) : resolve(addr)));
  });

/**
 * Resolves a hostname and returns true if it is (or resolves to) a private/local address, or is an
 * obviously local name. Returns true on resolution failure so an unresolvable host is treated as
 * blocked rather than fetched blindly.
 */
export async function isBlockedFaviconHost(hostname: string, resolver: HostResolver = defaultResolver): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase(); // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host)) return isPrivateOrLocalAddress(host);
  try {
    const address = await resolver(host);
    return isPrivateOrLocalAddress(address);
  } catch {
    return true;
  }
}
