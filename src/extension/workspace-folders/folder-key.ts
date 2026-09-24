import * as path from 'path';

/**
 * Resolved absolute form, case-folded only on win32, where the filesystem is case-insensitive and a
 * drive letter may legitimately differ in case between two sides of a comparison.
 */
export function folderKey(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
