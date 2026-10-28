// Paths on a remote host as its workspace names them: '/' separated on POSIX targets, '\' with a drive root on Windows.

export type RemoteSeparator = '/' | '\\';

/** A folder's child, with exactly one separator between them whether or not the parent is a root ('/', 'C:\'). */
export function childPath(parent: string, name: string, separator: RemoteSeparator): string {
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`;
}

export interface Crumb {
  readonly label: string;
  readonly path: string;
}

/** Each folder from the root down to path, labelled by its own name; the root's label is the root itself. */
export function breadcrumbs(path: string, separator: RemoteSeparator): Crumb[] {
  const parts = path.split(separator).filter((part) => part !== '');
  // POSIX roots at '/'; a Windows path's first part is its drive ('C:'), whose root is 'C:\'.
  const root = separator === '/' ? '/' : `${parts.shift() ?? ''}\\`;
  const crumbs: Crumb[] = [{ label: root, path: root }];
  for (const part of parts) crumbs.push({ label: part, path: childPath(crumbs[crumbs.length - 1]!.path, part, separator) });
  return crumbs;
}
