// Which destinations an untrusted project's preview may not reach: loopback and private networks (docs/invariants.md
// "Desktop host", HTML previews). Pure: the resolver is passed in.
import { isIPv4, isIPv6 } from 'node:net';

// [first address as a 32-bit number, prefix length]
const PRIVATE_IPV4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // this network, 0.0.0.0 included
  [0x7f000000, 8], // loopback
  [0x0a000000, 8], // RFC 1918
  [0xac100000, 12], // RFC 1918
  [0xc0a80000, 16], // RFC 1918
  [0xa9fe0000, 16], // link-local
  [0x64400000, 10], // CGNAT, RFC 6598
];

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

function isPrivateIpv4Number(value: number): boolean {
  return PRIVATE_IPV4.some(([base, prefix]) => Math.floor(value / 2 ** (32 - prefix)) === Math.floor(base / 2 ** (32 - prefix)));
}

// The eight 16-bit groups of an IPv6 address, a dotted IPv4 tail included; undefined for anything that is not one.
function ipv6Groups(text: string): number[] | undefined {
  const address = text.replace(/%.*$/, '');
  if (!isIPv6(address)) return undefined;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  const hex = tail ? `${address.slice(0, tail.index)}${(ipv4Number(tail[1]!) >>> 16).toString(16)}:${(ipv4Number(tail[1]!) & 0xffff).toString(16)}` : address;
  const [left = '', right] = hex.split('::');
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((group) => parseInt(group, 16)));
  const head = parse(left);
  if (right === undefined) return head;
  const rest = parse(right);
  return [...head, ...Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

/**
 * Whether an IP address (IPv4 dotted, or IPv6 with or without brackets) is loopback, private, link-local, CGNAT, ULA or
 * unspecified; text that is no address counts as private.
 */
export function isPrivateAddress(address: string): boolean {
  if (isIPv4(address)) return isPrivateIpv4Number(ipv4Number(address));
  const groups = ipv6Groups(address.replace(/^\[(.*)\]$/, '$1'));
  if (!groups) return true;
  // ::ffff:a.b.c.d, the IPv4 address it maps
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return isPrivateIpv4Number(groups[6]! * 0x10000 + groups[7]!);
  // :: and ::1
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7]! <= 1) return true;
  // fe80::/10 link-local, fc00::/7 unique local
  return (groups[0]! & 0xffc0) === 0xfe80 || (groups[0]! & 0xfe00) === 0xfc00;
}

// session.resolveHost's answer, as Electron gives it
export type ResolveHost = (host: string) => Promise<{ readonly endpoints: ReadonlyArray<{ readonly address: string }> }>;

/**
 * Why a URL's host is a private destination, or undefined for a public one: an IP literal in a private range, `localhost` or
 * a name under it, or a name any of whose addresses is private. A name that does not resolve is refused too.
 */
export async function privateDestination(url: URL, resolveHost: ResolveHost): Promise<string | undefined> {
  // the WHATWG parser already turned 2130706433, 0x7f.1, 017700000001 and 127.1 into 127.0.0.1
  const host = url.hostname.replace(/\.$/, '');
  if (host.startsWith('[') || isIPv4(host)) return isPrivateAddress(host) ? 'a private address' : undefined;
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  let endpoints: ReadonlyArray<{ readonly address: string }>;
  try {
    ({ endpoints } = await resolveHost(host));
  } catch (err) {
    return `a name that did not resolve (${err instanceof Error ? err.message : String(err)})`;
  }
  if (endpoints.length === 0) return 'a name with no address';
  return endpoints.some((endpoint) => isPrivateAddress(endpoint.address)) ? 'a name with a private address' : undefined;
}
