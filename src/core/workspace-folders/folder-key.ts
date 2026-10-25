import * as path from 'path';

/**
 * Resolved absolute form, case-folded only on win32, where the filesystem is case-insensitive and a
 * drive letter may legitimately differ in case between two sides of a comparison.
 */
export function folderKey(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** folderKey by the path rules of the OS a path is on, which for a remote project is the target's, not this process's. */
export function folderKeyOn(os: NodeJS.Platform, fsPath: string): string {
  const resolved = (os === 'win32' ? path.win32 : path.posix).resolve(fsPath);
  return os === 'win32' ? resolved.toLowerCase() : resolved;
}
