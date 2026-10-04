/**
 * `filePath` relative to `folder` when it lies inside it, else `filePath` unchanged, so a path outside the
 * chat's folder always shows in full. Windows paths compare case-insensitively and with either separator.
 */
export function folderRelativePath(filePath: string, folder: string | undefined): string {
  if (!folder) return filePath;
  const windows = /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith('\\\\');
  const separator = windows ? /[\\/]/ : /\//;
  const same = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const base = folder.replace(/[\\/]+$/, '').split(separator);
  const parts = filePath.split(separator);
  if (parts.length <= base.length || !base.every((segment, i) => same(segment, parts[i] ?? ''))) return filePath;
  // Offsets come from the path's own segments: lower-casing can change a string's length ('İ' becomes two code units).
  const relative = filePath.slice(parts.slice(0, base.length).reduce((length, segment) => length + segment.length + 1, 0));
  return relative === '' || relative.split(/[\\/]/).includes('..') ? filePath : relative;
}
