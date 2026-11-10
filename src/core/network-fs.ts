import * as fs from 'node:fs';
import * as path from 'node:path';

// statfs f_type magic numbers (linux/magic.h, and the file systems' own headers) of network and cluster file systems; FUSE
// counts as one since sshfs and most shared homes over FUSE are; other systems report no such magic
const NETWORK_FS = new Map<number, string>([
  [0x6969, 'NFS'],
  [0x517b, 'SMB'],
  [0xfe534d42, 'SMB2'],
  [0xff534d42, 'CIFS'],
  [0x01021997, '9P'],
  [0x65735546, 'FUSE'],
  [0x00c36400, 'CephFS'],
  [0x0bd00bd0, 'Lustre'],
  [0x47504653, 'GPFS'],
  [0x5346414f, 'AFS'],
  [0x6b414653, 'AFS'],
]);

/** The network file system a folder is on (Linux statfs, or a Windows UNC path), else undefined. */
export function networkFileSystem(folder: string, type: (folder: string) => number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') return networkPathHost(folder) ? 'SMB' : undefined;
  return platform === 'linux' ? NETWORK_FS.get(type(folder)) : undefined;
}

// A device path naming a UNC host: `\\?\UNC\`, `\\.\UNC\` or `\??\UNC\`, separators in any mix.
const DEVICE_UNC_PATH = /^(?:[\\/]{2}[?.]|[\\/]\?\?)[\\/]unc[\\/]([^\\/]*)/i;
// Two leading separators in any mix, not opening a `\\?\` or `\\.\` device path.
const UNC_PATH = /^[\\/]{2}(?![?.](?:[\\/]|$))([^\\/]*)/;
// Every path Windows reads as a UNC or device path; `\??\` is the NT namespace, which Win32 passes through unchanged.
const UNC_OR_DEVICE_PATH = /^(?:[\\/]{2}|[\\/]\?\?[\\/])/;
// WSL's file server, which Windows reaches through the P9 redirector, never SMB.
const WSL_HOSTS: ReadonlySet<string> = new Set(['wsl$', 'wsl.localhost']);

/**
 * The host a Windows network path names, lowercased, with a WebDAV `@SSL` or `@port` suffix dropped: `\\host\share`, its
 * forward and mixed slash spellings, and its `\\?\UNC\`, `\\.\UNC\` and `\??\UNC\` forms. Empty for two separators with no
 * host; undefined for any other path.
 */
export function networkPathHost(target: string): string | undefined {
  return uncServer(target)?.split('@', 1)[0];
}

/** The server component of a UNC path as written, lowercased, `@SSL` or `@port` included. */
function uncServer(target: string): string | undefined {
  return (DEVICE_UNC_PATH.exec(target) ?? UNC_PATH.exec(target))?.[1]!.toLowerCase();
}

/**
 * Whether opening target on Windows may reach past this computer's drives: a network path whose host is neither in
 * allowedHosts nor WSL's, and every device path (`\\?\C:\x`, `\\.\pipe\x`, `\??\x`), which this text alone cannot place.
 */
export function leavesLocalDrives(target: string, allowedHosts: ReadonlySet<string>): boolean {
  const server = uncServer(target);
  if (server === undefined) return UNC_OR_DEVICE_PATH.test(target);
  const host = server.split('@', 1)[0]!;
  // A server spelled with `@` goes to the WebDAV redirector, never to WSL's.
  return host === '' || !(WSL_HOSTS.has(server) || allowedHosts.has(host));
}

/**
 * The journal mode for a SQLite database at dbPath: DELETE on a network file system, where WAL's shared memory is not
 * shared between machines (sqlite.org/wal.html), WAL elsewhere. macOS reports no file system type Node can read, so it keeps WAL.
 */
export function sqliteJournalMode(dbPath: string, platform: NodeJS.Platform = process.platform): 'WAL' | 'DELETE' {
  // eslint-disable-next-line damocles/no-sync -- every opener calls it right before its synchronous DatabaseSync open
  const type = (folder: string): number => fs.statfsSync(folder).type;
  const folder = path.dirname(path.resolve(dbPath));
  // a mapped network drive's real path is its UNC path
  const real = platform === 'win32' ? fs.realpathSync.native(folder) : folder;
  return networkFileSystem(real, type, platform) === undefined ? 'WAL' : 'DELETE';
}
