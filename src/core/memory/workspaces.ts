import * as fs from 'fs';
import type { DatabaseInstance } from './types';

/** Separator- and (on win32) case-insensitive comparison key for a folder or file path. */
function pathKey(p: string, platform: NodeJS.Platform): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

export function sameWorkspace(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** The spelling in `known` that names the same folder as `candidate`, or null when none does. */
export function matchKnownWorkspace(
  candidate: string,
  known: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  return known.find(k => sameWorkspace(k, candidate, platform)) ?? null;
}

type FolderCheck = { result: Promise<boolean>; settledAt: number | null };

/**
 * Whether a folder exists, each answer cached for `ttlMs`. A check still running after `timeoutMs` answers false and
 * keeps running to fill the cache: a disconnected mapped drive takes about 21 s to fail on Windows, holding one libuv
 * pool thread that long, so a caller never waits on it and concurrent callers share one check.
 */
export function createFolderProbe(
  timeoutMs: number,
  ttlMs: number,
  access: (folder: string) => Promise<unknown> = folder => fs.promises.access(folder),
  now: () => number = Date.now,
): (folder: string) => Promise<boolean> {
  const checks = new Map<string, FolderCheck>();
  return async folder => {
    let check = checks.get(folder);
    if (!check || (check.settledAt !== null && now() - check.settledAt >= ttlMs)) {
      const started: FolderCheck = { result: access(folder).then(() => true, () => false), settledAt: null };
      void started.result.then(() => { started.settledAt = now(); });
      checks.set(folder, started);
      check = started;
    }
    if (check.settledAt !== null) return check.result;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>(resolve => { timer = setTimeout(resolve, timeoutMs, false); });
    try {
      return await Promise.race([check.result, late]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Distinct `workspace` values of live rows that `wanted` keeps and whose folder exists, plus the open folders,
 * leaving out `nonProject` folders (the home-directory bucket of a window with no folder open), which contain
 * nearly every path. Only a stored folder `wanted` keeps is checked. A database spelling wins over an open
 * folder's spelling of the same path, so a row filed under the result lands in the bucket other windows already query.
 */
export async function listKnownWorkspaces(
  db: DatabaseInstance,
  openFolders: readonly string[],
  nonProject: readonly string[],
  exists: (folder: string) => Promise<boolean>,
  wanted: (folder: string) => boolean = () => true,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const rows = db
    .prepare('SELECT DISTINCT workspace FROM memories WHERE is_latest = 1 AND forgotten = 0 AND workspace IS NOT NULL')
    .all() as Array<{ workspace: string }>;
  const admit = (folder: string, listed: readonly string[]): boolean =>
    !matchKnownWorkspace(folder, listed, platform) && !matchKnownWorkspace(folder, nonProject, platform);
  const stored: string[] = [];
  for (const { workspace } of rows) {
    if (workspace && wanted(workspace) && admit(workspace, stored)) stored.push(workspace);
  }
  const present = await Promise.all(stored.map(folder => exists(folder)));
  const known = stored.filter((_, i) => present[i]);
  for (const folder of openFolders) {
    if (admit(folder, known)) known.push(folder);
  }
  return known;
}

/** The known workspace containing absolute `file`, preferring the deepest match; null when none does. */
export function workspaceContaining(
  file: string,
  known: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const fileKey = pathKey(file, platform);
  let best: string | null = null;
  let bestLength = -1;
  for (const workspace of known) {
    const key = pathKey(workspace, platform);
    if ((fileKey === key || fileKey.startsWith(`${key}/`)) && key.length > bestLength) {
      best = workspace;
      bestLength = key.length;
    }
  }
  return best;
}

function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

/**
 * The single known workspace other than `current` that holds every one of `files`, or null. Files all
 * inside `current` (a nested known workspace included), any relative path, any file outside the known
 * set, or files split across workspaces keep the memory in `current`. `known` is read only when a
 * move is possible.
 */
export async function attributeFilesToWorkspace(
  files: readonly string[],
  current: string,
  known: () => Promise<readonly string[]>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (files.length === 0 || !files.every(isAbsolutePath)) return null;
  if (files.every(file => workspaceContaining(file, [current], platform) !== null)) return null;
  const folders = await known();
  let target: string | null = null;
  for (const file of files) {
    const owner = workspaceContaining(file, folders, platform);
    if (!owner) return null;
    if (target === null) target = owner;
    else if (!sameWorkspace(target, owner, platform)) return null;
  }
  return target !== null && !sameWorkspace(target, current, platform) ? target : null;
}
