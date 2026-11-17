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
  if (platform === 'win32') return networkPathHost(folder) !== undefined ? 'SMB' : undefined;
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

// The suffixes Windows' WebDAV redirector reads after a server: `@SSL`, `@<port>` or both, in that order.
const WEBDAV_SERVER = /^([^@]*)(?:@ssl)?(?:@\d+)?$/;

/**
 * The host a Windows network path names, lowercased, with a WebDAV `@SSL`, `@<port>` or `@SSL@<port>` suffix dropped:
 * `\\host\share`, its forward and mixed slash spellings, and its `\\?\UNC\`, `\\.\UNC\` and `\??\UNC\` forms. Empty for a server
 * that names no known host: none, or one with any other `@`. Undefined for any other path.
 */
export function networkPathHost(target: string): string | undefined {
  const server = uncServer(target);
  return server === undefined ? undefined : WEBDAV_SERVER.exec(server)?.[1] ?? '';
}

/** The server component of a UNC path as written, lowercased, any `@` suffix included. */
function uncServer(target: string): string | undefined {
  return (DEVICE_UNC_PATH.exec(target) ?? UNC_PATH.exec(target))?.[1]!.toLowerCase();
}

/**
 * Whether opening target on Windows may reach past this computer's drives: a network path whose host is neither in
 * allowedHosts nor WSL's, or that names no known host, and every device path (`\\?\C:\x`, `\\.\pipe\x`, `\??\x`), which this
 * text alone cannot place.
 */
export function leavesLocalDrives(target: string, allowedHosts: ReadonlySet<string>): boolean {
  const server = uncServer(target);
  if (server === undefined) return UNC_OR_DEVICE_PATH.test(target);
  const host = networkPathHost(target)!;
  // A server spelled with `@` goes to the WebDAV redirector, never to WSL's.
  return host === '' || !(WSL_HOSTS.has(server) || allowedHosts.has(host));
}

// A drive mapping's target components after `\Device\`: a component `;X:<logon id>` marks a network provider's drive, and Mup
// and the redirectors registered with it pass a raw `\Device\<name>\<server>\...` target to the server too.
const NETWORK_DEVICE = /^(?:mup|lanmanredirector|webdavredirector|rdpdr|p9rdr)$/i;

// The object-manager names of the DOS devices folder a subst target names its path in: `\??\` and its aliases.
const DOS_DEVICES_FOLDER = /^\\(?:\?\?|global\?\?|dosdevices)\\/i;

/**
 * The Win32 path Windows sends a drive's paths to, from its object-manager target (`queryDosDevice`): a network drive's
 * `\\server\share\...`, a subst drive's target (`\??\C:\dir`, `\??\UNC\server\share`, or through `\GLOBAL??\` or
 * `\DosDevices\`), and `\\?\GLOBALROOT` with the target, which names no host, for a network drive whose server it cannot read and
 * for any target outside `\Device\` and the DOS devices folder; null for a local volume (`\Device\HarddiskVolume2`, a CD-ROM).
 */
export function dosDeviceTargetPath(target: string): string | null {
  const folder = DOS_DEVICES_FOLDER.exec(target);
  if (folder) {
    const rest = target.slice(folder[0].length);
    if (/^unc\\/i.test(rest)) return `\\\\${rest.slice(4)}`;
    if (/^[a-z]:(?:\\|$)/i.test(rest)) return rest.length === 2 ? `${rest}\\` : rest;
    return `\\\\?\\${rest}`;
  }
  if (!/^\\device\\/i.test(target)) return `\\\\?\\GLOBALROOT${target}`;
  const components = target.slice(8).split('\\');
  const after = components.slice(1);
  if (!after.some((component) => /^;[a-z]:/i.test(component)) && !NETWORK_DEVICE.test(components[0] ?? '')) return null;
  const server = after.findIndex((component) => !component.startsWith(';'));
  return server >= 0 && after[server] !== '' ? `\\\\${after.slice(server).join('\\')}` : `\\\\?\\GLOBALROOT${target}`;
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
