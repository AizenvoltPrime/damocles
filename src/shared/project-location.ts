// Where a project lives and how main names and joins its paths. Renderers import types only.
import * as path from 'node:path';

export type Authority =
  | { readonly kind: 'local' }
  | { readonly kind: 'loopback' }
  | { readonly kind: 'ssh'; readonly hostId: string }
  | { readonly kind: 'wsl'; readonly distro: string }
  | { readonly kind: 'container'; readonly key: string; readonly via?: string };

export type AuthorityKind = Authority['kind'];

// path is native to the target, os the target's process.platform
export interface ProjectLocation {
  readonly authority: Authority;
  readonly path: string;
  readonly os: NodeJS.Platform;
}

// Separates a remote project key's authority key from the folder key computed on the target; no authority key holds it.
const KEY_SEPARATOR = '|';
// A local key is folderKey(path), an absolute path, so it never starts with one of these prefixes.
const REMOTE_KEY = /^(loopback|ssh\+[^|]+|wsl\+[^|]+|container\+[^|]+)\|/;

/** Whether a folder key is absolute in either path flavor, as every folderKey on any target is. */
export function isAbsoluteFolderKey(key: string): boolean {
  return path.posix.isAbsolute(key) || path.win32.isAbsolute(key);
}

/** The authority's stable text form: local, loopback, ssh+<hostId>, wsl+<distro> or container+<key>. */
export function authorityKey(authority: Authority): string {
  switch (authority.kind) {
    case 'local': return 'local';
    case 'loopback': return 'loopback';
    case 'ssh': return `ssh+${authority.hostId}`;
    case 'wsl': return `wsl+${authority.distro}`;
    case 'container': return `container+${authority.key}`;
  }
}

/** The key the renderers name a project by: folderKey for a local one, `<authorityKey>|<folderKey on the target>` otherwise. */
export function projectKeyOf(authority: Authority, targetFolderKey: string): string {
  if (!isAbsoluteFolderKey(targetFolderKey)) throw new Error(`A project key needs an absolute folder key, not ${JSON.stringify(targetFolderKey.slice(0, 64))}`);
  return authority.kind === 'local' ? targetFolderKey : `${authorityKey(authority)}${KEY_SEPARATOR}${targetFolderKey}`;
}

/** The authority key a project key carries; 'local' for a local key. */
export function authorityKeyOfProject(projectKey: string): string {
  const match = REMOTE_KEY.exec(projectKey);
  return match ? match[1]! : 'local';
}

/** The folder key on the target a remote project key carries, or undefined for a local key. */
export function targetFolderKeyOf(projectKey: string): string | undefined {
  const match = REMOTE_KEY.exec(projectKey);
  return match ? projectKey.slice(match[1]!.length + KEY_SEPARATOR.length) : undefined;
}

/** Path arithmetic in the project's own flavor, never the client's node:path. */
export function pathFor(location: { readonly os: NodeJS.Platform }): path.PlatformPath {
  return location.os === 'win32' ? path.win32 : path.posix;
}

/**
 * Whether a path is absolute by its host's rules alone: on Windows a drive or UNC path, never a root-relative one (`\srv`),
 * which path.win32 resolves against this computer's current drive.
 */
export function isAbsoluteOn(location: { readonly os: NodeJS.Platform }, target: string): boolean {
  return location.os === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(target) : path.posix.isAbsolute(target);
}

/** Whether target is folder or lies below it, in the project's own path flavor; both must be absolute there. */
export function isInsideFolder(location: { readonly os: NodeJS.Platform }, folder: string, target: string): boolean {
  if (!isAbsoluteOn(location, folder) || !isAbsoluteOn(location, target)) return false;
  const flavor = pathFor(location);
  const relative = flavor.relative(folder, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative));
}
