// The rows of a Linux /proc/self/mountinfo text (proc(5)): `id parent major:minor root mountPoint options [optional...] - type
// source superOptions`.

export interface MountRow {
  // the folder of the mounted file system the mount shows
  readonly root: string;
  readonly mountPoint: string;
  readonly type: string;
  readonly source: string;
  readonly superOptions: string;
}

// mountinfo writes a space, tab, newline or backslash in a path as a three-digit octal escape
const unescapeMountPath = (text: string): string => text.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** The rows of a mountinfo text that name a mount point and a type, in the text's order. */
export function mountRows(mountinfo: string): MountRow[] {
  const rows: MountRow[] = [];
  for (const line of mountinfo.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(' ');
    const [type, source, ...superOptions] = line.slice(separator + 3).split(' ');
    if (fields[3] === undefined || fields[4] === undefined || type === undefined || type === '') continue;
    rows.push({ root: unescapeMountPath(fields[3]), mountPoint: unescapeMountPath(fields[4]), type, source: unescapeMountPath(source ?? ''), superOptions: superOptions.join(' ') });
  }
  return rows;
}

// WSL 2 serves a drive over 9p as the drvfs share; its virtiofs mode tags a drive drvfs, or drvfsa for an elevated process
// (WSL's lxinitshared.h LX_INIT_DRVFS_VIRTIO_TAG, LX_INIT_DRVFS_ADMIN_VIRTIO_TAG)
function isWindowsDrive(row: MountRow): boolean {
  if (row.type === 'drvfs') return true;
  if (row.type === '9p') return row.superOptions.split(/[,;]/).includes('aname=drvfs');
  return row.type === 'virtiofs' && (row.source === 'drvfs' || row.source === 'drvfsa');
}

export interface WindowsDriveMount {
  readonly mountPoint: string;
  // the drive's folder the mount point shows, as segments below the drive's root
  readonly prefix: readonly string[];
}

const driveFolder = (path: string | undefined): string[] | undefined => {
  const drive = path === undefined ? undefined : /^[A-Za-z]:(?:\\(.*))?$/s.exec(path);
  return drive ? (drive[1] ?? '').split('\\').filter(Boolean) : undefined;
};

// 9p names the drive folder in its aname's `path=`, which it writes unescaped; drvfs in its source; virtiofs only by its tag,
// so a virtiofs mount of a drive's subfolder reads as the drive's root. A folder that cannot be read is the drive's root.
function drivePrefix(row: MountRow): string[] {
  const path = row.type === '9p' ? row.superOptions.split(/[,;]/).find((option) => option.startsWith('path='))?.slice(5) : row.type === 'drvfs' ? row.source : undefined;
  return [...(driveFolder(path) ?? []), ...row.root.split('/').filter(Boolean)];
}

/** The Windows drives a WSL distro's mountinfo lists (WSL 1's drvfs, WSL 2's 9p and virtiofs), with the drive folder each shows. */
export function windowsDriveMounts(mountinfo: string): WindowsDriveMount[] {
  return mountRows(mountinfo).filter(isWindowsDrive).map((row) => ({ mountPoint: row.mountPoint, prefix: drivePrefix(row) }));
}
