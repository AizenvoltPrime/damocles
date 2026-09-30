import { createHash } from 'crypto';
import * as path from 'path';
import { DAMOCLES_HOME_DIR } from '../../paths';
import { folderKey } from '../../workspace-folders/folder-key';

/**
 * Root under which every session's private bare checkpoint repo lives. Kept entirely separate from
 * the user's own git repo and from pi's session JSONL store.
 */
const SESSIONS_BASE_DIR = path.join(DAMOCLES_HOME_DIR, 'pi', 'checkpoints', 'sessions');

/** The shared parent directory of all per-workspace checkpoint repo trees. */
export function getCheckpointsBaseDir(): string {
  return SESSIONS_BASE_DIR;
}

/**
 * Longest `GIT_DIR` git accepts: setup.c dies with "'$GIT_DIR' too big" past `PATH_MAX - 40`, and
 * `core.longpaths` does not lift it. `PATH_MAX` is 260 in Git for Windows, 1024 on macOS, 4096 on Linux.
 */
export const GIT_DIR_MAX_LENGTH: number = process.platform === 'win32' ? 220 : process.platform === 'darwin' ? 984 : 4056;

/**
 * The checkpoint repo subdir for one workspace — `<base>/<encoded-cwd>/`. `sessionDir` is that
 * workspace's pi session dir (`.../sessions/<encoded-cwd>/`); its basename is the same encoded-cwd
 * component `getRepoDir` nests repos under. The orphan-prune sweep MUST be scoped to this dir so it
 * never deletes another workspace's repos.
 */
export function getWorkspaceCheckpointDir(sessionDir: string): string {
  return path.join(SESSIONS_BASE_DIR, path.basename(sessionDir));
}

/**
 * Resolve the per-session checkpoint repo directory for a pi session file: `<base>/<encoded-cwd>/<basename>`.
 * These repos hold v2 checkpoint entries and are only read, plus copied on fork to a sibling of the same
 * length; new checkpoints go to the fixed-length folder repo (`getFolderRepoDir`). Sessions without a
 * backing file (not yet persisted) share a single `ephemeral` slot.
 */
export function getRepoDir(sessionFile: string | undefined): string {
  if (!sessionFile) return path.join(SESSIONS_BASE_DIR, 'ephemeral');
  const workspaceDir = path.basename(path.dirname(sessionFile));
  const base = path.basename(sessionFile, '.jsonl');
  return path.join(SESSIONS_BASE_DIR, workspaceDir, base);
}

const FOLDERS_BASE_DIR = path.join(DAMOCLES_HOME_DIR, 'pi', 'checkpoints', 'folders');

/** Parent of every folder repo. A sibling of the sessions base, so no session-repo sweep reaches it. */
export function getFolderReposBaseDir(): string {
  return FOLDERS_BASE_DIR;
}

/** First 16 hex of sha256(folderKey(cwd)): the same folder always maps to the same repo, at a fixed path length. */
export function folderIdFor(cwd: string): string {
  return createHash('sha256').update(folderKey(cwd)).digest('hex').slice(0, 16);
}

export function isFolderId(id: string): boolean {
  return /^[0-9a-f]{16}$/.test(id);
}

/** The folder repo dir for `folderId`; the caller validates the id with `isFolderId` when it came from disk. */
export function getFolderRepoDir(folderId: string): string {
  return path.join(FOLDERS_BASE_DIR, folderId);
}

/** Location of the bare git directory inside a checkpoint repo directory. */
export function getGitDir(repoDir: string): string {
  return path.join(repoDir, '.git');
}

/** Location of the dedicated git index file (kept beside `.git`, never the work tree's index). */
export function getIndexPath(repoDir: string): string {
  return path.join(repoDir, 'index');
}
