import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renameWithRetry } from '../../config/json-config-write';
import type { FolderRepoHandle } from './folder-repo';
import { isHexCommit } from './types';

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Checks checkpoint `commit` of `handle`'s folder repo out into `targetDir`, which must not exist yet. The tree is written
 * into a new sibling folder under the repo lock through a temporary index, then renamed into place, so a failure leaves no
 * target folder and the only folder ever removed is that sibling, which this call created.
 */
export async function materializeCheckpoint(handle: FolderRepoHandle, commit: string, targetDir: string): Promise<void> {
  if (!isHexCommit(commit)) throw new Error(`not a checkpoint commit: ${JSON.stringify(commit)}`);
  if (await pathExists(targetDir)) throw new Error(`${targetDir} already exists`);
  const parent = path.dirname(targetDir);
  await fs.promises.mkdir(parent, { recursive: true });
  // A leading dot keeps the staging folder from ever reading as a design id (`isSafeAgentPathId`).
  const staging = path.join(parent, `.materialize-${randomUUID()}`);
  const indexDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'damocles-materialize-'));
  try {
    await handle.repo.withLock(async () => {
      if (!(await handle.repo.objectExists(commit, 'commit'))) throw new Error(`commit ${commit} is not in folder repo ${handle.folderId}`);
      await fs.promises.mkdir(staging);
      await handle.repo.checkoutTreeLocked(commit, staging, path.join(indexDir, 'index'));
    });
    // rename never replaces a folder that holds files, so a target that appeared meanwhile keeps its own.
    await renameWithRetry(staging, targetDir);
  } catch (err) {
    await fs.promises.rm(staging, { recursive: true, force: true });
    throw err;
  } finally {
    await fs.promises.rm(indexDir, { recursive: true, force: true });
  }
}
