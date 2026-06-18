import * as fs from 'fs';
import * as path from 'path';
import { getCheckpointsBaseDir } from './resolver';

/**
 * Delete checkpoint repos that no longer correspond to a live session. Each immediate subdirectory
 * of the sessions base is named after a session file's basename; any whose name is absent from
 * `liveSessionFileBases` is an orphan (its session was deleted) and is removed recursively.
 *
 * Fully defensive: a missing base directory is a no-op, and per-entry removal failures are swallowed
 * so a single locked/permission-denied repo can't abort the sweep. Never throws.
 */
export async function pruneOrphanCheckpointRepos(
  liveSessionFileBases: ReadonlySet<string>,
  baseDirOverride?: string,
): Promise<void> {
  const baseDir = baseDirOverride ?? getCheckpointsBaseDir();

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (liveSessionFileBases.has(dirent.name)) continue;
    await fs.promises.rm(path.join(baseDir, dirent.name), { recursive: true, force: true }).catch(() => undefined);
  }
}
