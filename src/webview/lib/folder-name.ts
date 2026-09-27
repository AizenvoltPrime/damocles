/** The last segment of a folder path, for either separator. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}
