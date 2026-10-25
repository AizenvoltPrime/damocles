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
  if (platform === 'win32') return /^(?:[\\/]{2}[^\\/?.]|\\\\\?\\UNC\\)/i.test(folder) ? 'SMB' : undefined;
  return platform === 'linux' ? NETWORK_FS.get(type(folder)) : undefined;
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
