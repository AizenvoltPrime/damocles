// What makes a worktree registry record valid (AD12), which live chat record a folder or project has, and the folders the
// registry places worktrees in. Stateless, so desktop main reads the records core mirrors to it by the same rules.
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { folderKey, folderKeyOn } from '../workspace-folders/folder-key';
import { isWorktreeId } from '../../shared/worktree-id';
import type { ChatWorktreeRecord, PendingBase, WorktreeId, WorktreeRecord } from './registry';

// AD12 Names: the folder name cut to 24 characters keeps worktree paths short on Windows.
const PROJECT_DIR_NAME_LENGTH = 24;

// The path rules of the registry's paths: this process's, or with os a remote core's target's.
function rulesOf(os: NodeJS.Platform | undefined): { readonly flavor: path.PlatformPath; readonly key: (fsPath: string) => string } {
  return os === undefined ? { flavor: path, key: folderKey } : { flavor: os === 'win32' ? path.win32 : path.posix, key: (fsPath) => folderKeyOn(os, fsPath) };
}

/** `<rootDir>/<project>/<chat>`: the project folder's name cut to 24 characters plus 6 hex of its path hash (AD12 Names). */
export function worktreeFolderFor(rootDir: string, projectPath: string, id: WorktreeId, os?: NodeJS.Platform): string {
  return rulesOf(os).flavor.join(projectWorktreesFolder(rootDir, projectPath, os), id);
}

/** `<rootDir>/<project>`, the folder holding every chat worktree of the project. */
export function projectWorktreesFolder(rootDir: string, projectPath: string, os?: NodeJS.Platform): string {
  const { flavor, key } = rulesOf(os);
  const name = flavor.basename(flavor.resolve(projectPath)).slice(0, PROJECT_DIR_NAME_LENGTH).replace(/[^A-Za-z0-9._-]/g, '_');
  const hash = crypto.createHash('sha256').update(key(projectPath)).digest('hex').slice(0, 6);
  return flavor.join(rootDir, `${name || 'project'}-${hash}`);
}

/** True when `child` is `parent` or lies inside it, compared with folderKey. */
export function folderContains(parent: string, child: string, os?: NodeJS.Platform): boolean {
  const { flavor, key } = rulesOf(os);
  const p = key(parent);
  const c = key(child);
  if (c === p) return true;
  const { sep } = flavor;
  const withSep = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(withSep);
}

/** The live chat record whose working folder is exactly `folder`. */
export function liveChatRecordAt(records: readonly WorktreeRecord[], folder: string, os?: NodeJS.Platform): ChatWorktreeRecord | undefined {
  const { key } = rulesOf(os);
  const folderKeyed = key(folder);
  return records.find((r): r is ChatWorktreeRecord => r.kind === 'chat' && r.deletedAt === undefined && key(r.workingFolder) === folderKeyed);
}

/** Live chat records of the project. */
export function liveChatRecords(records: readonly WorktreeRecord[], projectPath: string, os?: NodeJS.Platform): ChatWorktreeRecord[] {
  const { key } = rulesOf(os);
  const projectKeyed = key(projectPath);
  return records.filter((r): r is ChatWorktreeRecord => r.kind === 'chat' && r.deletedAt === undefined && key(r.projectPath) === projectKeyed);
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0');
export const isAbsolutePath = (v: unknown, os?: NodeJS.Platform): v is string => isString(v) && rulesOf(os).flavor.isAbsolute(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isObjectId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v);

function validPendingBase(raw: unknown): PendingBase | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  if (!isObjectId(p['commit']) || (p['side'] !== 'project' && p['side'] !== 'worktree')) return undefined;
  return { commit: p['commit'], side: p['side'] };
}

/**
 * The record `raw` holds, or undefined when this version cannot use it. Any process can write registry.json, so a chat record
 * is valid only at the one folder its project and id name under `rootDir`.
 */
export function validRecord(raw: unknown, rootDir: string, os?: NodeJS.Platform): WorktreeRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const { flavor, key } = rulesOf(os);
  const isAbsolute = (v: unknown): v is string => isAbsolutePath(v, os);
  const contains = (parent: string, child: string): boolean => folderContains(parent, child, os);
  const depth = (relative: string): number => (relative === '' ? 0 : relative.split(flavor.sep).length);
  if (!isWorktreeId(r['id'])) return undefined;
  if (!isAbsolute(r['repositoryRoot']) || !isAbsolute(r['worktreeRoot']) || !isAbsolute(r['workingFolder']) || !isTime(r['createdAt'])) return undefined;
  if (!contains(r['worktreeRoot'], r['workingFolder'])) return undefined;
  if (r['deletedAt'] !== undefined && !isTime(r['deletedAt'])) return undefined;
  const base = {
    id: r['id'],
    repositoryRoot: r['repositoryRoot'],
    worktreeRoot: r['worktreeRoot'],
    workingFolder: r['workingFolder'],
    createdAt: r['createdAt'],
    ...(r['deletedAt'] !== undefined ? { deletedAt: r['deletedAt'] as number } : {}),
  };
  if (r['kind'] === 'chat') {
    if (!isAbsolute(r['projectPath']) || !isString(r['branch']) || !isObjectId(r['baseCommit'])) return undefined;
    if (typeof r['index'] !== 'number' || !Number.isInteger(r['index']) || r['index'] < 1) return undefined;
    if (r['lastAppliedTree'] !== undefined && !isObjectId(r['lastAppliedTree'])) return undefined;
    const pendingBase = r['pendingBase'] === undefined ? undefined : validPendingBase(r['pendingBase']);
    if (r['pendingBase'] !== undefined && pendingBase === undefined) return undefined;
    if (r['usedAt'] !== undefined && !isTime(r['usedAt'])) return undefined;
    if (key(r['worktreeRoot']) !== key(worktreeFolderFor(rootDir, r['projectPath'], r['id'], os))) return undefined;
    if (contains(rootDir, r['projectPath']) || contains(rootDir, r['repositoryRoot'])) return undefined;
    // Apply writes into repositoryRoot, so it must hold the project, and the working folder the same subfolder of the worktree:
    // as deep, since the project keeps its own spelling (an 8.3 alias) and the working folder has git's names.
    if (!contains(r['repositoryRoot'], r['projectPath'])) return undefined;
    if (depth(flavor.relative(r['worktreeRoot'], r['workingFolder'])) !== depth(flavor.relative(r['repositoryRoot'], r['projectPath']))) return undefined;
    return {
      ...base,
      kind: 'chat',
      projectPath: r['projectPath'],
      branch: r['branch'],
      index: r['index'],
      baseCommit: r['baseCommit'],
      ...(r['lastAppliedTree'] !== undefined ? { lastAppliedTree: r['lastAppliedTree'] as string } : {}),
      ...(pendingBase !== undefined ? { pendingBase } : {}),
      ...(r['usedAt'] !== undefined ? { usedAt: r['usedAt'] as number } : {}),
    };
  }
  if (r['kind'] === 'adopted') {
    if (r['projectPath'] !== undefined && !isAbsolute(r['projectPath'])) return undefined;
    if (r['branch'] !== undefined && !isString(r['branch'])) return undefined;
    return {
      ...base,
      kind: 'adopted',
      ...(r['projectPath'] !== undefined ? { projectPath: r['projectPath'] as string } : {}),
      ...(r['branch'] !== undefined ? { branch: r['branch'] as string } : {}),
    };
  }
  return undefined;
}
