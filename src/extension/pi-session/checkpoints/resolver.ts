import * as path from 'path';
import { DAMOCLES_HOME_DIR } from '../../auth/paths';

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
 * The checkpoint repo subdir for one workspace — `<base>/<encoded-cwd>/`. `sessionDir` is that
 * workspace's pi session dir (`.../sessions/<encoded-cwd>/`); its basename is the same encoded-cwd
 * component `getRepoDir` nests repos under. The orphan-prune sweep MUST be scoped to this dir so it
 * never deletes another workspace's repos.
 */
export function getWorkspaceCheckpointDir(sessionDir: string): string {
  return path.join(SESSIONS_BASE_DIR, path.basename(sessionDir));
}

/**
 * Resolve the checkpoint repo directory for a given pi session file: `<base>/<encoded-cwd>/<basename>`.
 * Repos are nested under the session file's parent-dir name (pi's encoded-cwd dir, e.g.
 * `--c--GameDev-proj--`) so each workspace owns a disjoint subtree — without this, repos from every
 * workspace shared one flat dir keyed by file basename and a per-workspace prune wiped other
 * workspaces' repos. The basename mapping stays stable/reversible for pruning. Sessions without a
 * backing file (not yet persisted) share a single `ephemeral` slot.
 */
export function getRepoDir(sessionFile: string | undefined): string {
  if (!sessionFile) return path.join(SESSIONS_BASE_DIR, 'ephemeral');
  const workspaceDir = path.basename(path.dirname(sessionFile));
  const base = path.basename(sessionFile, '.jsonl');
  return path.join(SESSIONS_BASE_DIR, workspaceDir, base);
}

/** Location of the bare git directory inside a checkpoint repo directory. */
export function getGitDir(repoDir: string): string {
  return path.join(repoDir, '.git');
}

/** Location of the dedicated git index file (kept beside `.git`, never the work tree's index). */
export function getIndexPath(repoDir: string): string {
  return path.join(repoDir, 'index');
}
