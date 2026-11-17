// The `compass` step: the old folder's index is a derived cache, so it is deleted and rebuilt on use in the new folder.
// The index is keyed by the folder's raw spelling, so only the recorded spelling's index goes; another spelling's is an orphan cache.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compassIndexPath } from '../../compass/util';
import type { RelocationFolder } from '../types';
import { STEP_DONE, type StepOutcome } from './outcome';

export async function runCompassStep(folders: readonly RelocationFolder[], log: (line: string) => void): Promise<StepOutcome> {
  for (const folder of folders) {
    const indexDir = path.dirname(compassIndexPath(folder.from));
    await fs.promises.rm(indexDir, { recursive: true, force: true }).catch((err: unknown) => {
      log(`[ProjectRelocations] the Compass index ${indexDir} of a moved folder stays: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return STEP_DONE;
}
