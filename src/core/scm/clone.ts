// Clone (VS Code's extensions/git/src/git.ts clone and cloneManager.ts): the folder a URL clones into and the clone's argv.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isUnsafeWindowsName } from '../../shared/relative-path';
import { isRemoteUrl } from './remotes';

// VS Code tries the base name and then -1 to -19 before it gives up.
const MAX_NAME_ATTEMPTS = 20;
const MAX_FOLDER_NAME_LENGTH = 255;

/** A folder name a clone may create: one plain segment, no leading '-' or '.', nothing Windows resolves elsewhere. */
export function isCloneFolderName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (name.length === 0 || name.length > MAX_FOLDER_NAME_LENGTH || name.startsWith('-') || name.startsWith('.') || name.trim() !== name) return false;
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) return false;
  return platform !== 'win32' || !isUnsafeWindowsName(name);
}

/** VS Code's baseFolderName: the URL's last segment without '.git'; undefined when that is no name a clone may create. */
export function cloneFolderName(url: string, platform: NodeJS.Platform = process.platform): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURI(url);
  } catch {
    decoded = url;
  }
  const name = decoded.replace(/[/\\]+$/, '').replace(/^.*[/\\:]/, '').replace(/\.git$/, '') || 'repository';
  return isCloneFolderName(name, platform) ? name : undefined;
}

// Created exclusively, so a folder made by anything else is never the clone's and never removed after it.
export async function freeCloneTarget(parent: string, name: string, taken: (folder: string) => boolean): Promise<string | undefined> {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const target = path.join(parent, attempt === 0 ? name : `${name}-${attempt}`);
    if (taken(target)) continue;
    const created = await fs.mkdir(target).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST') return false;
        throw err;
      },
    );
    if (created) return target;
  }
  return undefined;
}

/** clone's argv: the URL and the target after `--`, so neither can be an option; recursive checks the submodules out too. */
export function cloneArgs(url: string, target: string, recursive: boolean): string[] {
  if (!isRemoteUrl(url)) throw new Error('Refused a clone URL that git could read as an option or a remote helper');
  return ['clone', ...(recursive ? ['--recurse-submodules'] : []), '--', url, target];
}

// Never follows a link or junction in the target's place.
export async function removeCloneTarget(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  if (!stat?.isDirectory()) return;
  // a git process the kill just ended may still hold a handle on Windows for a moment
  await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
