// How Linux watches a recursive root (docs/invariants.md "File watching modes"): the inotify tree, or snapshot polling on WSL 1,
// which cannot rename a folder holding a live watch (microsoft/WSL#3395), and on 9p or drvfs mounts, where inotify misses
// changes made from Windows (microsoft/WSL#4739).
import * as fs from 'node:fs';
import * as path from 'node:path';

export type WatchMode = 'inotifyTree' | 'poll';

// the file systems WSL mounts Windows drives with: 9p on WSL 2, drvfs on WSL 1
const POLLED_FILE_SYSTEMS: ReadonlySet<string> = new Set(['9p', 'drvfs']);

/** WSL 1's kernel release ends in -Microsoft (4.4.0-26100-Microsoft); WSL 2 reports microsoft-standard-WSL2. */
export function isWsl1(osrelease: string): boolean {
  return osrelease.trim().endsWith('-Microsoft');
}

/** Whether the kernel release is any WSL's. */
export function isWsl(osrelease: string): boolean {
  return /microsoft/i.test(osrelease);
}

// mountinfo writes a space, tab, newline or backslash in a path as a three-digit octal escape
const unescapeMountPath = (text: string): string => text.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

const isUnder = (mountPoint: string, target: string): boolean => mountPoint === '/' || target === mountPoint || target.startsWith(`${mountPoint}/`);

/**
 * The file system type of the mount holding target, an absolute path, in a /proc/self/mountinfo text: the longest mount point
 * above it, the later of two equal ones (a mount over a mount shadows it); undefined when no row holds it.
 */
export function fileSystemOf(mountinfo: string, target: string): string | undefined {
  let best: { readonly length: number; readonly type: string } | undefined;
  for (const line of mountinfo.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(' ');
    const type = line.slice(separator + 3).split(' ')[0];
    const mountPoint = fields[4] === undefined ? undefined : unescapeMountPath(fields[4]);
    if (mountPoint === undefined || type === undefined || type === '' || !isUnder(mountPoint, target)) continue;
    if (!best || mountPoint.length >= best.length) best = { length: mountPoint.length, type };
  }
  return best?.type;
}

export interface WatchModeSources {
  // /proc/sys/kernel/osrelease; undefined when it cannot be read
  osrelease(): string | undefined;
  // /proc/self/mountinfo, read for each root since mounts change; undefined when it cannot be read
  mountinfo(): string | undefined;
  // the root with every link resolved, or the root itself when it does not exist (yet)
  realpath(root: string): string;
  readonly log: (line: string) => void;
}

/** The mode of a recursive watch of root: poll on WSL 1 and on 9p or drvfs mounts, else the inotify tree. */
export function watchModeOf(root: string, sources: WatchModeSources): WatchMode {
  const release = sources.osrelease();
  if (release !== undefined && isWsl1(release)) return 'poll';
  const mountinfo = sources.mountinfo();
  if (mountinfo === undefined) {
    sources.log(`[watcher] /proc/self/mountinfo could not be read; ${root} uses the inotify tree`);
    return 'inotifyTree';
  }
  const type = fileSystemOf(mountinfo, sources.realpath(root));
  return type !== undefined && POLLED_FILE_SYSTEMS.has(type) ? 'poll' : 'inotifyTree';
}

const readText = (file: string, log: (line: string) => void): string | undefined => {
  try {
    // eslint-disable-next-line damocles/no-sync -- the factory picks a root's watch inside its synchronous subscribe; /proc files are kernel memory
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    log(`[watcher] could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
};

/** This process's sources: the kernel release read once, mountinfo read per root. */
export function procWatchModeSources(log: (line: string) => void): WatchModeSources {
  let release: { readonly text: string | undefined } | undefined;
  return {
    osrelease: () => (release ??= { text: readText('/proc/sys/kernel/osrelease', log) }).text,
    mountinfo: () => readText('/proc/self/mountinfo', log),
    realpath: (root) => {
      try {
        return fs.realpathSync.native(root);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return path.resolve(root);
        throw err;
      }
    },
    log,
  };
}
