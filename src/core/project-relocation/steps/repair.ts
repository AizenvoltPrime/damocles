// The `repair` step (docs/invariants.md "Project relocation"): `git worktree repair` re-links the relocated repository and
// its chat worktrees, which stay in place, in both directions. Git runs only while the new project folder is trusted; until
// then the step waits. Which links are broken is read from git's files before and after the run, so a rerun repairs only
// what is left.
import * as fs from 'node:fs/promises';
import { STEP_DONE, type StepOutcome } from './outcome';
import type { WorktreeRepairFailure } from '../types';
import { isLinked, repositoryDirs } from '../worktree-links';
import { folderContains } from '../../worktrees/records';

export interface RepairGitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RepairStepDeps {
  isTrusted(projectPath: string): boolean;
  /** Runs git with `args` in `cwd`: argv only, git's absolute path, GIT_EDITOR=true, GIT_TERMINAL_PROMPT=0; rejects when git cannot run. */
  git(args: readonly string[], cwd: string): Promise<RepairGitResult>;
}

export interface RepairStepInput {
  /** The relocated project folder, whose trust lets git run. */
  readonly project: string;
  /** The relocated repository root; undefined when the project has no chat worktrees. */
  readonly repository: string | undefined;
  /** The chat worktrees' roots, which a relocation leaves in place. */
  readonly worktrees: ReadonlyArray<{ readonly worktreeId: string; readonly root: string }>;
  readonly log: (line: string) => void;
}

export async function runRepairStep(input: RepairStepInput, deps: RepairStepDeps): Promise<StepOutcome> {
  if (input.repository === undefined) return STEP_DONE;
  // git runs where the journal says only when that is the trusted project's own repository
  if (!folderContains(input.repository, input.project)) return { kind: 'waiting', failure: { code: 'repositoryLayout', params: { path: input.repository } } };
  // A deleted chat worktree has no folder left to link.
  const present: Array<RepairStepInput['worktrees'][number]> = [];
  for (const worktree of input.worktrees) {
    const stat = await fs.stat(worktree.root).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined;
      throw err;
    });
    if (stat?.isDirectory()) present.push(worktree);
  }
  if (present.length === 0) return STEP_DONE;
  const repository = input.repository;
  const broken = async (): Promise<{ readonly self: boolean; readonly worktrees: typeof present }> => {
    const dirs = await repositoryDirs(repository);
    if (!dirs) return { self: false, worktrees: present };
    const unlinked: typeof present = [];
    for (const worktree of present) if (!(await isLinked(worktree.root, dirs.commonDir))) unlinked.push(worktree);
    return { self: dirs.linked && !(await isLinked(repository, dirs.commonDir)), worktrees: unlinked };
  };
  const before = await broken();
  if (!before.self && before.worktrees.length === 0) return STEP_DONE;
  if (!deps.isTrusted(input.project)) return { kind: 'waiting', failure: { code: 'untrusted', params: { count: before.worktrees.length } } };

  const dirs = await repositoryDirs(repository);
  if (dirs) {
    // A repository that is itself a linked worktree repairs its own link from inside, which git does only when it is named.
    const paths = [...(before.self ? [repository] : []), ...before.worktrees.map((worktree) => worktree.root)];
    const ran = await deps.git(['worktree', 'repair', '--', ...paths], dirs.linked ? input.project : repository).then(
      (result) => result,
      (err: unknown) => {
        input.log(`[ProjectRelocations] git worktree repair in ${repository} did not run: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      },
    );
    if (ran && ran.code !== 0) input.log(`[ProjectRelocations] git worktree repair in ${repository} exited with ${ran.code}: ${ran.stderr.trim().slice(0, 2000)}`);
  }

  const after = await broken();
  if (!after.self && after.worktrees.length === 0) return STEP_DONE;
  const code = dirs ? 'notRelinked' : 'noRepository';
  const repairFailures: WorktreeRepairFailure[] = after.worktrees.map((worktree) => ({ worktreeId: worktree.worktreeId, failure: { code } }));
  return { kind: 'waiting', failure: { code: 'repairFailed', params: { count: repairFailures.length + (after.self ? 1 : 0) } }, repairFailures };
}
