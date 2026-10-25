import { lstatSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import { isIPv6 } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import * as path from 'node:path';

/** How many dangling links `canonicalPath` follows, as the OS bounds a link chain. */
const MAX_LINK_HOPS = 40;

/** The file system reads the path functions take; a failed read is null, never a throw. */
export interface PathQueries {
  realpath(p: string): string | null;
  lstat(p: string): Stats | null;
  readlink(p: string): string | null;
}

function orNull<T>(read: (p: string) => T): (p: string) => T | null {
  return (p) => {
    try {
      return read(p);
    } catch {
      return null;
    }
  };
}

const fileSystem: PathQueries = {
  realpath: orNull((p) => realpathSync.native(p)),
  lstat: orNull((p) => lstatSync(p)),
  readlink: orNull((p) => readlinkSync(p)),
};

/** The target of `linkPath` when it is a link, or null when it is not one or cannot be read. */
function linkTarget(linkPath: string, queries: PathQueries): string | null {
  if (queries.lstat(linkPath)?.isSymbolicLink() !== true) return null;
  const target = queries.readlink(linkPath);
  return target === null ? null : path.resolve(path.dirname(linkPath), target);
}

function remembered<T>(read: (p: string) => T): (p: string) => T {
  const answers = new Map<string, T>();
  return (p) => {
    if (answers.has(p)) return answers.get(p)!;
    const answer = read(p);
    answers.set(p, answer);
    return answer;
  };
}

/** Answers are never refreshed: take one per decision or per search pass, so no answer outlives the state it read. */
export function rememberedPathQueries(): PathQueries {
  return { realpath: remembered(fileSystem.realpath), lstat: remembered(fileSystem.lstat), readlink: remembered(fileSystem.readlink) };
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
export function canonicalPath(target: string, queries: PathQueries = fileSystem): string {
  const local = localDrivePath(target);
  const missing: string[] = [];
  let current = local;
  for (let hops = 0; ; ) {
    const real = queries.realpath(current);
    if (real !== null) return path.join(real, ...missing);
    // A dangling link still leads somewhere: writing through it creates its target.
    const dangling = hops < MAX_LINK_HOPS ? linkTarget(current, queries) : null;
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

/**
 * `target` as the file system spells it (8.3 names expanded, stored case, no `\\?\` prefix, a loopback
 * admin share as its drive) without following any link: the walk keeps every segment from the first
 * link, or the first segment that does not resolve, as written.
 */
export function spelledPath(target: string, queries: PathQueries = fileSystem): string {
  const local = localDrivePath(path.resolve(target));
  const { root } = path.parse(local);
  const segments = local.slice(root.length).split(path.sep).filter(Boolean);
  let spelled = root;
  for (let index = 0; index < segments.length; index++) {
    const next = path.join(spelled, segments[index]!);
    // A link keeps its spelling; a missing or unreadable segment stops the tool opening the path there too.
    const stats = queries.lstat(next);
    const real = stats !== null && !stats.isSymbolicLink() ? queries.realpath(next) : null;
    if (real === null) return path.join(next, ...segments.slice(index + 1));
    spelled = real;
  }
  return spelled;
}
