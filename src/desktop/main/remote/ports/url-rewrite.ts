// A remote chat's browser runs on this computer, so its addresses are translated between the target's form (what the
// agent and the target's programs use) and the local forward's (docs/invariants.md "Ports and the remote browser").
import { BlockList, isIP } from 'node:net';

export interface RewriteTarget {
  readonly host: string;
  readonly port: number;
}

export interface RewriteTunnel {
  readonly localPort: number;
  readonly remote: RewriteTarget;
}

// The TunnelManager's forward and list, which return a tunnel that already exists for the target.
export interface ForwardingTunnels {
  list(authority: string): readonly RewriteTunnel[];
  forward(authority: string, remote: RewriteTarget): Promise<RewriteTunnel>;
}

const TARGET_LOOPBACK = new BlockList();
TARGET_LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
TARGET_LOOPBACK.addAddress('0.0.0.0', 'ipv4');
TARGET_LOOPBACK.addAddress('::1', 'ipv6');
TARGET_LOOPBACK.addAddress('::', 'ipv6');

// The loopback forms the proxy reaches a forward on; they keep the page's origin when the port is the same.
const KEPT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function bare(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host.replace(/\.$/, '');
}

/** Whether `hostname` (URL.hostname form, brackets optional) names the target itself: localhost, 127/8, 0.0.0.0, ::1, :: and their IPv4-mapped forms. */
export function isTargetLoopbackHost(hostname: string): boolean {
  const host = bare(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = isIP(host);
  return family !== 0 && TARGET_LOOPBACK.check(host, family === 6 ? 'ipv6' : 'ipv4');
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * `url` as this computer's browser opens it: a target loopback http(s) URL moves to its forward's local port, forwarding
 * the port first when no tunnel has it, and a URL naming another forwarded target moves to that forward. Every other
 * URL, and anything that is not one, comes back unchanged.
 */
export async function rewriteInbound(url: string, authority: string, tunnels: ForwardingTunnels): Promise<string> {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
  const port = parsed.port === '' ? defaultPort(parsed.protocol) : Number(parsed.port);
  let tunnel: RewriteTunnel | undefined;
  if (isTargetLoopbackHost(parsed.hostname)) {
    tunnel = tunnels.list(authority).find((each) => each.remote.port === port && isTargetLoopbackHost(each.remote.host))
      ?? await tunnels.forward(authority, { host: 'localhost', port });
  } else {
    const host = bare(parsed.hostname);
    tunnel = tunnels.list(authority).find((each) => each.remote.port === port && bare(each.remote.host) === host);
    if (!tunnel) return url;
  }
  if (!KEPT_HOSTS.has(parsed.hostname)) parsed.hostname = 'localhost';
  parsed.port = String(tunnel.localPort);
  return parsed.href;
}

// Linear: the userinfo class excludes '@' and every URL delimiter, so each scheme match scans its own address once.
const LOCAL_URL = /\b((?:https?|wss?):\/\/(?:[^\s/?#@\\]*@)?)(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(?!\d)/gi;

/** `text` with every http, https, ws and wss URL on a forward's local port put back in its target's form. */
export function rewriteOutbound(text: string, tunnels: readonly RewriteTunnel[]): string {
  const byLocalPort = new Map<number, RewriteTarget>();
  for (const tunnel of tunnels) byLocalPort.set(tunnel.localPort, tunnel.remote);
  if (byLocalPort.size === 0) return text;
  return text.replace(LOCAL_URL, (match, prefix: string, host: string, port: string) => {
    const remote = byLocalPort.get(Number(port));
    if (!remote) return match;
    if (isTargetLoopbackHost(remote.host)) return `${prefix}${host}:${remote.port}`;
    return `${prefix}${isIP(remote.host) === 6 ? `[${remote.host}]` : remote.host}:${remote.port}`;
  });
}
