// The git links between a relocated repository and its chat worktrees, read from git's files without running git: a moved
// folder is not trusted yet, and git runs only in a trusted project. A path a repository file names is opened only when it
// stays on the folder's own host (`reachesAnotherHost`).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { findGitDir, GIT_FILE_READ_LIMIT, reachesAnotherHost, readBounded } from '../workspace-folders/git-head';
import { folderKey } from '../workspace-folders/folder-key';
import { folderContains } from '../worktrees/records';

export interface RepositoryDirs {
  readonly gitDir: string;
  /** The repository's common dir, whose `worktrees/` holds one admin dir per linked worktree. */
  readonly commonDir: string;
  /** The repository root is itself a linked worktree: its `.git` is a file. */
  readonly linked: boolean;
}

// A link inside an untrusted repository's git dir could lead a read to another host, so none is followed.
export async function isPlain(entry: string): Promise<boolean> {
  return (await fs.lstat(entry).catch(() => undefined))?.isSymbolicLink() === false;
}

// One line of a `gitdir` or `commondir` file, resolved against the folder holding it; undefined when it reaches another host.
async function pathFileTarget(file: string, base: string): Promise<string | undefined> {
  if (!(await isPlain(file))) return undefined;
  const text = await readBounded(file, GIT_FILE_READ_LIMIT);
  const line = text?.split(/\r?\n/)[0]?.trim();
  if (!line) return undefined;
  const target = path.resolve(base, line);
  return reachesAnotherHost(target, base) ? undefined : target;
}

/** The git dirs of the repository whose top level is `root`; undefined when `root` holds no `.git` git would use. */
export async function repositoryDirs(root: string): Promise<RepositoryDirs | undefined> {
  const dotGit = await fs.lstat(path.join(root, '.git')).catch(() => undefined);
  if (!dotGit || !(dotGit.isDirectory() || dotGit.isFile())) return undefined;
  const gitDir = await findGitDir(root);
  if (gitDir === undefined) return undefined;
  if (!(await isPlain(gitDir))) return undefined;
  const named = await fs.lstat(path.join(gitDir, 'commondir')).then(() => true, () => false);
  const commonDir = named ? await pathFileTarget(path.join(gitDir, 'commondir'), gitDir) : gitDir;
  return commonDir === undefined ? undefined : { gitDir, commonDir, linked: dotGit.isFile() };
}

/** The admin dir under `<commonDir>/worktrees/` whose `gitdir` names `dotGit`; what that file names is compared, never opened. */
export async function adminDirNaming(commonDir: string, dotGit: string): Promise<string | undefined> {
  const adminRoot = path.join(commonDir, 'worktrees');
  if (!(await isPlain(commonDir)) || !(await isPlain(adminRoot))) return undefined;
  const names = await fs.readdir(adminRoot).catch(() => [] as string[]);
  const wanted = folderKey(dotGit);
  for (const name of names.sort()) {
    const adminDir = path.join(adminRoot, name);
    if (!(await isPlain(adminDir))) continue;
    const named = await pathFileTarget(path.join(adminDir, 'gitdir'), adminDir);
    if (named !== undefined && folderKey(named) === wanted) return adminDir;
  }
  return undefined;
}

/** Whether `worktreeRoot`'s `.git` file names an admin dir of `commonDir` whose `gitdir` names it back. */
export async function isLinked(worktreeRoot: string, commonDir: string): Promise<boolean> {
  const text = await readBounded(path.join(worktreeRoot, '.git'), GIT_FILE_READ_LIMIT);
  const match = text === undefined ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match?.[1]) return false;
  const adminDir = path.resolve(worktreeRoot, match[1]);
  if (reachesAnotherHost(adminDir, worktreeRoot) || !folderContains(path.join(commonDir, 'worktrees'), adminDir)) return false;
  const named = await pathFileTarget(path.join(adminDir, 'gitdir'), adminDir);
  if (named === undefined) return false;
  const dotGit = path.join(worktreeRoot, '.git');
  if (folderKey(named) === folderKey(dotGit)) return true;
  // git writes the path it resolved (links followed, 8.3 names expanded); only our own side is resolved, the named one is text
  const own = await fs.realpath(dotGit).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  return own !== undefined && folderKey(named) === folderKey(own);
}
