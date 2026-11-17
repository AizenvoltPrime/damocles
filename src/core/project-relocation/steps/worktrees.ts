// The `worktrees` step (docs/invariants.md "Project relocation"): one registry write re-points the project's chat worktree
// records to the new project folder. Their folders stay where they are, so nothing on disk moves and a rerun writes nothing new.
import type { WorktreeRegistry } from '../../worktrees/registry';
import type { RelocationFolder } from '../types';
import { pausedBy, RelocationPause, STEP_DONE, type StepOutcome } from './outcome';

export interface WorktreesStepDeps {
  /** Why registry.json does not parse now, which refuses the write. */
  registryUnreadable(): string | undefined;
  relocateProject(pairs: ReadonlyArray<{ readonly from: string; readonly to: string }>): Promise<void>;
}

export interface WorktreesStepInput {
  readonly folders: readonly RelocationFolder[];
  readonly log: (line: string) => void;
}

export async function runWorktreesStep(input: WorktreesStepInput, deps: WorktreesStepDeps): Promise<StepOutcome> {
  try {
    if (deps.registryUnreadable() !== undefined) return { kind: 'paused', failure: { code: 'registryUnreadable' } };
    await deps.relocateProject(input.folders.filter((folder) => folder.kind === 'project').map(({ from, to }) => ({ from, to })));
    return STEP_DONE;
  } catch (err) {
    if (!(err instanceof RelocationPause)) input.log(`[ProjectRelocations] worktrees step stopped: ${err instanceof Error ? err.message : String(err)}`);
    return pausedBy(err);
  }
}

export function defaultWorktreesStepDeps(registry: Pick<WorktreeRegistry, 'relocateProject' | 'unreadable'>): WorktreesStepDeps {
  return {
    registryUnreadable: () => registry.unreadable(),
    relocateProject: (pairs) => registry.relocateProject(pairs),
  };
}
