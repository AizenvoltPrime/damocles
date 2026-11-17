// The `checkpoints` step: every folder repo holding the old folder's checkpoints names the new folder in its folder.json,
// written under its own lock; no repo is renamed. The sessions step re-points each session's registrations as it moves it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { folderKey } from '../../workspace-folders/folder-key';
import { folderRepoIdsIn, getFolderRepoDir, getGitDir, relocateFolderRepoLocked, withRepoLock } from '../../pi-session/checkpoints';
import type { RelocationsSnapshot } from '../current';
import type { RelocationFolder } from '../types';
import { STEP_DONE, type StepOutcome } from './outcome';

/** `before`: the journal as the relocations before this one left it, which places the old folder's repos. */
export async function runCheckpointsStep(folders: readonly RelocationFolder[], before: RelocationsSnapshot): Promise<StepOutcome> {
  for (const folder of folders) {
    if (folderKey(folder.from) === folderKey(folder.to)) continue;
    for (const folderId of folderRepoIdsIn(before, folder.from)) {
      const repoDir = getFolderRepoDir(folderId);
      const initialized = await fs.promises.access(path.join(getGitDir(repoDir), 'HEAD')).then(() => true, () => false);
      if (!initialized) continue;
      await withRepoLock(repoDir, () => relocateFolderRepoLocked(repoDir, folder.from, folder.to));
    }
  }
  return STEP_DONE;
}
