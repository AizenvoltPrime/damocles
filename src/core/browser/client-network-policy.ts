// Which address a remote authority's browser may reach on this computer's network. Main's navigation guard and the
// local core's client-network proxy both decide here, so they never disagree (docs/invariants.md "Ports and the remote browser").
import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { isBlockedIp } from '../pi-session/web-access/safe-fetch';

export interface ClientNetworkPolicy {
  // the host's forwarded local ports, reachable on this computer's loopback
  readonly allowedPorts: readonly number[];
  // the host's switch: every address passes
  readonly allowLocalNetwork: boolean;
}

export const CLOSED_CLIENT_NETWORK: ClientNetworkPolicy = { allowedPorts: [], allowLocalNetwork: false };

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

// getaddrinfo, as Chrome resolves without a proxy, so the hosts file and `localhost` answer as they would there.
export const resolveAddresses: AddressResolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

// The TunnelManager listens on 127.0.0.1 for every forward, so a forwarded port is always reached there.
const FORWARD_ADDRESS = '127.0.0.1';
const FORWARD_ALIASES = new BlockList();
FORWARD_ALIASES.addAddress(FORWARD_ADDRESS, 'ipv4');
FORWARD_ALIASES.addAddress('::1', 'ipv6');

/** The address to connect to for `address`:`port`, or undefined when the policy refuses it. `address` is an IP literal. */
export function connectAddress(address: string, port: number, policy: ClientNetworkPolicy): string | undefined {
  if (policy.allowLocalNetwork || !isBlockedIp(address)) return address;
  const family = isIP(address);
  if (family !== 0 && policy.allowedPorts.includes(port) && FORWARD_ALIASES.check(address, family === 6 ? 'ipv6' : 'ipv4')) return FORWARD_ADDRESS;
  return undefined;
}

export type ClientTarget =
  | { readonly allowed: true; readonly addresses: readonly string[] }
  | { readonly allowed: false; readonly address: string };

/**
 * Where a connection to `host`:`port` goes: an IP literal (URL.hostname form, brackets allowed) is checked as written, a
 * name is resolved once and every answer is checked. An allowed target names the addresses to connect to, in the
 * resolver's order and each once; a refused one names the answer that was refused. Rejects when the name resolves to nothing.
 */
export async function resolveClientTarget(host: string, port: number, policy: ClientNetworkPolicy, resolve: AddressResolver = resolveAddresses): Promise<ClientTarget> {
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const answers = isIP(literal) !== 0 ? [literal] : (await resolve(literal)).map((answer) => answer.address);
  const targets: string[] = [];
  for (const address of answers) {
    const to = connectAddress(address, port, policy);
    if (to === undefined) return { allowed: false, address };
    if (!targets.includes(to)) targets.push(to);
  }
  if (targets.length === 0) throw new Error(`${host} resolved to no address`);
  return { allowed: true, addresses: targets };
}
