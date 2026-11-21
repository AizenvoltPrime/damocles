// Where a machine keeps application data and its OS keeps pseudo and system files (docs/invariants.md "Desktop host", HTML
// previews). Pure: the host that reads a path passes its own platform, env, home and drive mounts (host-data-stores.ts).
import type { WindowsDriveMount } from '../mountinfo';

export interface StoreHost {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  // the Windows drives a WSL distro mounts (windowsDriveMounts); read on Linux only
  readonly drives: readonly WindowsDriveMount[];
}

export interface DataStores {
  readonly platform: string;
  // per-user application data stores and the OS's pseudo and system file systems, absolute
  readonly stores: readonly string[];
  // folders inside a store that hold ordinary content: Windows' temp folder and pnpm's default store
  readonly ordinary: readonly string[];
  // the Windows drives a WSL distro mounts, whose stores are named by the drive's own folders (dataStoreOf)
  readonly drives: readonly WindowsDriveMount[];
}

const XDG_STORES = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

const isWindowsAbsolute = (value: string): boolean => /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(value);

// a Win32 file namespace prefix: `\\?\C:\x` names C:\x and `\\?\UNC\host\share` names \\host\share
const withoutNamespace = (value: string): string => value.replace(/^[\\/]{2}\?[\\/]unc[\\/]/i, '\\\\').replace(/^[\\/]{2}\?[\\/]/, '');

// Windows names environment variables case-blind; a relative value names no store (XDG Base Directory spec).
function envPath(host: StoreHost, name: string): string | undefined {
  const windows = host.platform === 'win32';
  const raw = windows ? Object.entries(host.env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1] : host.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = windows ? withoutNamespace(raw) : raw;
  return (windows ? isWindowsAbsolute(value) : value.startsWith('/')) ? value : undefined;
}

function joined(platform: string, base: string | undefined, ...names: string[]): string | undefined {
  if (base === undefined) return undefined;
  const separator = platform === 'win32' ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...names].join(separator);
}

const present = (paths: ReadonlyArray<string | undefined>): string[] => paths.filter((each): each is string => each !== undefined);

/** The data stores of the host, and the ordinary folders inside them, from its own env and home. */
export function dataStoresOf(host: StoreHost): DataStores {
  const { platform, home } = host;
  const env = (name: string): string | undefined => envPath(host, name);
  const xdg = XDG_STORES.map(env);
  const pnpm = [joined(platform, env('PNPM_HOME'), 'store'), joined(platform, env('XDG_DATA_HOME'), 'pnpm', 'store')];
  const found = ((): { stores: Array<string | undefined>; ordinary: Array<string | undefined> } => {
    if (platform === 'win32') {
      return {
        stores: [env('APPDATA'), env('LOCALAPPDATA'), env('ProgramData'), env('SystemRoot'), joined(platform, home, 'AppData')],
        ordinary: [
          env('TEMP'),
          env('TMP'),
          joined(platform, home, 'AppData', 'Local', 'Temp'),
          joined(platform, env('LOCALAPPDATA'), 'pnpm', 'store'),
          joined(platform, home, 'AppData', 'Local', 'pnpm', 'store'),
          ...pnpm,
        ],
      };
    }
    if (platform === 'darwin') {
      // the File Provider folders (Dropbox, OneDrive, Google Drive, Box) and iCloud Drive hold the user's own files
      const cloud = [joined(platform, home, 'Library', 'CloudStorage'), joined(platform, home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')];
      return { stores: [joined(platform, home, 'Library'), '/dev', ...xdg], ordinary: [joined(platform, home, 'Library', 'pnpm', 'store'), ...cloud, ...pnpm] };
    }
    // udisks2 mounts removable media under /run/media, and GVFS its network and device mounts under the runtime folder
    return { stores: ['/proc', '/sys', '/dev', '/run', ...xdg], ordinary: ['/run/media', joined(platform, env('XDG_RUNTIME_DIR'), 'gvfs'), ...pnpm] };
  })();
  // a value naming a root is no store, nor an XDG value naming the home folder or a folder holding it: either would refuse
  // every ordinary folder
  const homeKey = comparable(home, platform);
  const xdgValues = new Set(present(xdg));
  const isStore = (store: string): boolean => {
    const key = comparable(store, platform);
    return !isRoot(key) && !(xdgValues.has(store) && within(homeKey, key));
  };
  return { platform, stores: present(found.stores).filter(isStore), ordinary: present(found.ordinary), drives: platform === 'linux' ? [...host.drives] : [] };
}

// a comparable path that names a drive, a share or the file system's root
function isRoot(key: string): boolean {
  return key === '/' || /^[a-z]:$/.test(key) || /^\/\/[^/]+(?:\/[^/]+)?$/.test(key);
}

// Windows and macOS's default volume compare names case-blind; a path loses its trailing separators, a root keeps its own.
function comparable(file: string, platform: string): string {
  const slashed = platform === 'win32' ? file.replace(/\\/g, '/') : file;
  const trimmed = slashed.length > 1 ? slashed.replace(/(.)\/+$/, '$1') : slashed;
  return platform === 'win32' || platform === 'darwin' ? trimmed.toLowerCase() : trimmed;
}

function within(file: string, folder: string): boolean {
  return file === folder || file.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

// Windows, and drvfs for WSL, look a name up case-blind and also answer an 8.3 alias (PROGRA~3). Where `shortNames`, a path no
// realpath expanded (WSL's drive mounts), an 8.3 segment may name any store; a native drive path is judged on its realpath.
const SHORT_NAME = /~\d/;
const names = (segment: string | undefined, name: string, shortNames: boolean): boolean => segment !== undefined && (segment.toLowerCase() === name || (shortNames && SHORT_NAME.test(segment)));
const startsWith = (segments: readonly string[], prefix: readonly string[]): boolean => prefix.every((name, index) => segments[index]?.toLowerCase() === name);
// the folders below an AppData that hold ordinary content: Windows' temp folder and pnpm's default store
const APPDATA_ORDINARY: readonly (readonly string[])[] = [['local', 'temp'], ['local', 'pnpm', 'store']];

// The segments of a Linux path below a drive's mount point, or undefined when the mount point does not hold it.
function belowMount(file: string, mount: string): string[] | undefined {
  const [key, mountKey] = [comparable(file, 'linux'), comparable(mount, 'linux')];
  return within(key, mountKey) ? key.slice(mountKey.length).split('/').filter(Boolean) : undefined;
}

// How many of a Windows drive's folder segments name the store they lie in: Windows or ProgramData at the drive's root, or
// any AppData outside its Local\Temp and pnpm store, named in full; undefined for ordinary content.
function driveStoreDepth(segments: readonly string[], shortNames: boolean): number | undefined {
  if (names(segments[0], 'windows', shortNames) || names(segments[0], 'programdata', shortNames)) return 1;
  for (let at = 0; at < segments.length; at++) {
    if (!names(segments[at], 'appdata', shortNames)) continue;
    const below = segments.slice(at + 1);
    if (!APPDATA_ORDINARY.some((folder) => startsWith(below, folder))) return at + 1;
  }
  return undefined;
}

// Each AppData's temp folder and pnpm store, named in full, that `file`, a comparable path, lies in, with the AppData holding it.
function appDataOrdinary(file: string): Array<{ readonly appData: string; readonly folder: string }> {
  const segments = file.split('/');
  return segments.flatMap((segment, at) => {
    const folder = segment.toLowerCase() === 'appdata' ? APPDATA_ORDINARY.find((names) => startsWith(segments.slice(at + 1), names)) : undefined;
    return folder === undefined ? [] : [{ appData: segments.slice(0, at + 1).join('/'), folder: segments.slice(0, at + 1 + folder.length).join('/') }];
  });
}

// The store names below a drive's folder `segments` that it holds: a drive root's Windows folder, a Users folder's or a
// profile's AppData; an AppData at any other depth is not known without listing the folder.
function driveHeld(segments: readonly string[], shortNames: boolean): string[] | undefined {
  if (segments.length === 0) return ['Windows'];
  if (!names(segments[0], 'users', shortNames)) return undefined;
  if (segments.length === 1) return ['<user>', 'AppData'];
  return segments.length === 2 ? ['AppData'] : undefined;
}

// A path on a Windows drive: `base`, its folder showing the drive's folder `prefix`, and its segments below base.
interface OnDrive {
  readonly base: string;
  readonly prefix: readonly string[];
  readonly below: readonly string[];
  readonly separator: string;
  // an 8.3 segment may name a store (names)
  readonly shortNames: boolean;
}

// A Windows host's path on a lettered drive, `viaWsl` when it is a WSL drive mount's path as its drive spells it
// (wslDriveAlias), or the deepest WSL drive mount holding a Linux one.
function onDrive(file: string, stores: DataStores, viaWsl: boolean): OnDrive | undefined {
  if (stores.platform === 'win32') {
    const drive = /^([A-Za-z]:)(?:[\\/](.*))?$/s.exec(file);
    return drive ? { base: drive[1]!, prefix: [], below: (drive[2] ?? '').split(/[\\/]/).filter(Boolean), separator: '\\', shortNames: viaWsl } : undefined;
  }
  let found: OnDrive | undefined;
  for (const { mountPoint, prefix } of stores.drives) {
    const below = belowMount(file, mountPoint);
    if (below !== undefined && (found === undefined || found.below.length >= below.length)) found = { base: mountPoint.replace(/\/+$/, ''), prefix, below, separator: '/', shortNames: true };
  }
  return found;
}

const joinedOn = (base: string, separator: string, ...names: string[]): string => [base.replace(/[\\/]+$/, ''), ...names].join(separator);

// WSL's file server hosts, as network-fs.ts names them; WSL mounts each drive at /mnt/<letter> by default (automount root).
const WSL_HOSTS: ReadonlySet<string> = new Set(['wsl$', 'wsl.localhost']);
const WSL_DRIVE = /^[\\/]{2}([^\\/]+)[\\/][^\\/]+[\\/]mnt[\\/]([a-z])(?=[\\/]|$)(.*)$/s;
const WSL_DRIVES_FOLDER = /^[\\/]{2}([^\\/]+)[\\/][^\\/]+[\\/]mnt[\\/]*$/;

/** The drive path a Windows path into a WSL distro's drive mount names: `\\wsl$\<distro>\mnt\c\x` is `C:\x`; else undefined. */
export function wslDriveAlias(file: string): string | undefined {
  const match = WSL_DRIVE.exec(file);
  if (!match || !WSL_HOSTS.has(match[1]!.toLowerCase())) return undefined;
  return `${match[2]!.toUpperCase()}:${match[3]!.replace(/\//g, '\\') || '\\'}`;
}

export interface NamedSegments {
  readonly segments: readonly string[];
  // whether a segment names `name`, given in lower case, as the path's file system looks it up
  readonly names: (segment: string | undefined, name: string) => boolean;
}

/**
 * The segments of `absolute`, a path of the host `stores` describes, and how its file system looks a name up: Windows, macOS's
 * default volume and a WSL drive mount case-blind, a WSL drive mount and a Windows path into one (wslDriveAlias) also by any
 * 8.3 alias, and any other Linux path exactly.
 */
export function namedSegments(absolute: string, stores: Pick<DataStores, 'platform' | 'drives'>): NamedSegments {
  const { platform } = stores;
  const segments = absolute.split(platform === 'win32' ? /[\\/]/ : '/').filter(Boolean);
  if (platform === 'win32' || platform === 'darwin') {
    const shortNames = platform === 'win32' && wslDriveAlias(absolute) !== undefined;
    return { segments, names: (segment, name) => names(segment, name, shortNames) };
  }
  if (stores.drives.some(({ mountPoint }) => belowMount(absolute, mountPoint) !== undefined)) return { segments, names: (segment, name) => names(segment, name, true) };
  return { segments, names: (segment, name) => segment === name };
}

/**
 * The data store `absolute`, a path of the host `stores` describes, lies in, as listed or, on a Windows drive, as its drive
 * path spells it; undefined when it lies in none or in an ordinary folder strictly inside that store. A Windows host judges a
 * path into a WSL distro's drive mount as that drive's path (wslDriveAlias).
 */
export function dataStoreOf(absolute: string, stores: DataStores): string | undefined {
  const { platform } = stores;
  const alias = platform === 'win32' ? wslDriveAlias(absolute) : undefined;
  const ordinary = stores.ordinary.map((folder) => comparable(folder, platform));
  // an AppData's own temp folder and pnpm store exempt it and a store inside it, whatever the env spells them as
  const inside = (file: string, store: string) => (folder: string): boolean => within(file, folder) && folder !== store && within(folder, store);
  const exempt = (file: string, store: string): boolean => ordinary.some(inside(file, store)) || appDataOrdinary(file).some(({ appData, folder }) => within(store, appData) && inside(file, store)(folder));
  for (const spelled of alias === undefined ? [absolute] : [absolute, alias]) {
    const file = comparable(spelled, platform);
    const listed = stores.stores.find((each) => within(file, comparable(each, platform)) && !exempt(file, comparable(each, platform)));
    if (listed !== undefined) return listed;
  }
  const drivePath = alias ?? absolute;
  const drive = onDrive(drivePath, stores, alias !== undefined);
  const depth = drive === undefined ? undefined : driveStoreDepth([...drive.prefix, ...drive.below], drive.shortNames);
  if (drive === undefined || depth === undefined) return undefined;
  const store = joinedOn(drive.base, drive.separator, ...drive.below.slice(0, Math.max(0, depth - drive.prefix.length)));
  return exempt(comparable(drivePath, platform), comparable(store, platform)) ? undefined : store;
}

/** Whether `absolute` lies in a data store of the host `stores` describes and in no ordinary folder inside it (dataStoreOf). */
export function inDataStore(absolute: string, stores: DataStores): boolean {
  return dataStoreOf(absolute, stores) !== undefined;
}

/**
 * A data store `folder` is or holds, among those listed, or a Windows drive's that `folder` holds (driveHeld): on WSL a folder
 * at or above a drive's mount point holds what the mount's drive folder holds, or the mount itself when that folder lies in a
 * store; on Windows `\\wsl$\<distro>\mnt` holds each drive WSL mounts there.
 */
export function storeHeldBy(folder: string, stores: DataStores): string | undefined {
  const { platform } = stores;
  const alias = platform === 'win32' ? wslDriveAlias(folder) : undefined;
  for (const spelled of alias === undefined ? [folder] : [folder, alias]) {
    const key = comparable(spelled, platform);
    const listed = stores.stores.find((store) => within(comparable(store, platform), key));
    if (listed !== undefined) return listed;
  }
  if (platform === 'win32') {
    const mnt = WSL_DRIVES_FOLDER.exec(folder);
    if (mnt && WSL_HOSTS.has(mnt[1]!.toLowerCase())) return joinedOn(folder, '\\', '<drive>', 'Windows');
    const drive = onDrive(alias ?? folder, stores, alias !== undefined);
    const held = drive === undefined ? undefined : driveHeld(drive.below, drive.shortNames);
    return held === undefined ? undefined : joinedOn(folder, '\\', ...held);
  }
  for (const { mountPoint, prefix } of stores.drives) {
    if (within(comparable(mountPoint, 'linux'), comparable(folder, 'linux'))) {
      const held = driveHeld(prefix, true) ?? (driveStoreDepth(prefix, true) === undefined ? undefined : []);
      if (held !== undefined) return joinedOn(mountPoint, '/', ...held);
      continue;
    }
    const below = belowMount(folder, mountPoint);
    const held = below === undefined ? undefined : driveHeld([...prefix, ...below], true);
    if (held !== undefined) return joinedOn(folder, '/', ...held);
  }
  return undefined;
}
