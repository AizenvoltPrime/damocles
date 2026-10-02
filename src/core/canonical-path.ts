import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import * as path from 'node:path';

/** How many dangling links `canonicalPath` follows, as the OS bounds a link chain. */
const MAX_LINK_HOPS = 40;

/** The target of `linkPath` when it is a link, or null when it is not one or cannot be read. */
function linkTarget(linkPath: string): string | null {
  try {
    return lstatSync(linkPath).isSymbolicLink() ? path.resolve(path.dirname(linkPath), readlinkSync(linkPath)) : null;
  } catch {
    return null;
  }
}

/**
 * A UNC host as one comparable name. Windows spells an IPv6 address in a UNC host as
 * `0--1.ipv6-literal.net`, `-` for `:` and `s` before a zone id, and `0::1` and `::1` are one address.
 */
function hostKey(host: string): string {
  const literal = /^(.+)\.ipv6-literal\.net$/i.exec(host);
  const name = literal ? literal[1]!.replace(/-/g, ':').replace(/s.*$/i, '') : host.replace(/^\[(.*)\]$/, '$1');
  return isIPv6(name) ? new URL(`http://[${name}]`).hostname.slice(1, -1) : name.toLowerCase();
}

/** The names a UNC path can reach this machine by: localhost, its host name and every interface address. */
function localHostNames(): Set<string> {
  const names = new Set(['localhost', hostname().toLowerCase()]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) names.add(hostKey(entry.address));
  }
  return names;
}

/**
 * On win32, a drive's admin share on this machine (`\\localhost\C$\x`, `\\127.0.0.1\c$\x`,
 * `\\?\UNC\<host>\C$\x`) as the drive path `C:\x`, which realpath leaves as a network path.
 */
function localDrivePath(target: string): string {
  if (process.platform !== 'win32') return target;
  const match = /^\\\\(?:[?.]\\UNC\\)?([^\\]+)\\([A-Za-z])\$(\\.*)?$/i.exec(target);
  if (!match) return target;
  const [, host = '', drive = '', rest] = match;
  return localHostNames().has(hostKey(host)) ? `${drive.toUpperCase()}:${rest ?? '\\'}` : target;
}

/**
 * The native realpath of the deepest ancestor that resolves plus the segments below it, so a link,
 * junction, 8.3 name or loopback admin share resolves even for a file that does not exist yet.
 */
export function canonicalPath(target: string): string {
  const local = localDrivePath(target);
  const missing: string[] = [];
  let current = local;
  for (let hops = 0; ; ) {
    try {
      return path.join(realpathSync.native(current), ...missing);
    } catch {
      // A dangling link still leads somewhere: writing through it creates its target.
      const dangling = hops < MAX_LINK_HOPS ? linkTarget(current) : null;
      if (dangling !== null) {
        hops++;
        current = localDrivePath(dangling);
        continue;
      }
      // Missing, unreadable or looping: a tool opening the path stops at the same segment, and a throw
      // here would block the call through the gate's error fallback instead of applying the rules.
      const parent = path.dirname(current);
      if (parent === current) return local;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * `target` as the file system spells it (8.3 names expanded, stored case, no `\\?\` prefix, a loopback
 * admin share as its drive) without following any link: the walk keeps every segment from the first
 * link, or the first segment that does not resolve, as written.
 */
export function spelledPath(target: string): string {
  const local = localDrivePath(path.resolve(target));
  const { root } = path.parse(local);
  const segments = local.slice(root.length).split(path.sep).filter(Boolean);
  let spelled = root;
  for (let index = 0; index < segments.length; index++) {
    const next = path.join(spelled, segments[index]!);
    try {
      if (lstatSync(next).isSymbolicLink()) return path.join(next, ...segments.slice(index + 1));
      spelled = realpathSync.native(next);
    } catch {
      // Missing or unreadable: the tool opening the path stops at this segment too.
      return path.join(next, ...segments.slice(index + 1));
    }
  }
  return spelled;
}
