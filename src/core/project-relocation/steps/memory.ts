// The `memory` step: the project's memory rows are re-keyed in one transaction, not aliased, because their workspace
// columns are SQL filters on hot paths. A store that cannot be written now leaves the step waiting, tried at the next start.
import type { MemoryWaitReason, RelocationFolder } from '../types';
import { STEP_DONE, type StepOutcome } from './outcome';

export interface MemoryRelocation {
  relocateWorkspace(from: string, to: string): Promise<{ readonly waiting?: MemoryWaitReason }>;
}

/** `now`: where a project's new path is now, which a relocation after this one may have moved on. */
export async function runMemoryStep(folders: readonly RelocationFolder[], memory: MemoryRelocation, now: (to: string) => string): Promise<StepOutcome> {
  for (const folder of folders) {
    if (folder.kind !== 'project') continue;
    const { waiting } = await memory.relocateWorkspace(folder.from, now(folder.to));
    if (waiting) return { kind: 'waiting', failure: { code: 'memoryReadOnly', params: { reason: waiting } } };
  }
  return STEP_DONE;
}
