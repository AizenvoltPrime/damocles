// Host to diff worker and back.
import type { StructuredPatchHunk } from 'diff';
import type { FilePatch } from '../../shared/types/file-patch';
import type { EditWindow } from '../pi-session/tools/edit-diff';

export const DIFF_WORKER_MARKER = 'damocles-diff-worker';

export interface DiffWorkerData {
  readonly marker: typeof DIFF_WORKER_MARKER;
}

/** One line diff of two texts, bounded by an edit count and a time budget (timeoutMs, which the lane's watchdog also reads). */
export interface LineDiffJob {
  readonly kind: 'lineDiff';
  readonly before: string;
  readonly after: string;
  // context lines around each hunk
  readonly context: number;
  readonly maxEditLength: number;
  readonly timeoutMs: number;
}

/** The hunks and their added and removed line counts, or tooLarge: over the edit or time bound, with no counts. */
export type LineDiff =
  | { readonly kind: 'diff'; readonly hunks: readonly StructuredPatchHunk[]; readonly added: number; readonly removed: number }
  | { readonly kind: 'tooLarge' };

/** A Write's or Edit's whole-file patch (`filePatch` in `jobs.ts`), bounded by its changed lines and timeoutMs. */
export interface FilePatchJob {
  readonly kind: 'filePatch';
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly timeoutMs: number;
}

/** A single-replacement Edit's patch, diffed only in the windows around its replacements (`tools/edit-diff.ts`), bounded by timeoutMs. */
export interface EditPatchJob {
  readonly kind: 'editPatch';
  readonly path: string;
  readonly windows: readonly EditWindow[];
  readonly timeoutMs: number;
}

export type DiffJob = LineDiffJob | FilePatchJob | EditPatchJob;

export interface DiffResults {
  readonly lineDiff: LineDiff;
  readonly filePatch: FilePatch;
  readonly editPatch: FilePatch;
}

export type DiffResult<J extends DiffJob> = DiffResults[J['kind']];

/** The answer to a job past its budget, and to one a crash, a watchdog stop, an abort or a closed service ended. */
export function overBudget<J extends DiffJob>(job: J): DiffResult<J> {
  switch (job.kind) {
    case 'lineDiff':
      return { kind: 'tooLarge' } as DiffResult<J>;
    case 'filePatch':
    case 'editPatch':
      return { patchOmitted: 'tooLarge' } as DiffResult<J>;
  }
}

export interface DiffRequest {
  readonly id: number;
  readonly job: DiffJob;
}

// ready: the worker's handler is listening; failed: the job threw, which is a bug
export type DiffAnswer =
  | { readonly type: 'ready' }
  | { readonly type: 'done'; readonly id: number; readonly result: DiffResult<DiffJob> }
  | { readonly type: 'failed'; readonly id: number; readonly message: string };
