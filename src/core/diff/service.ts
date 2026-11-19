// The diff service, one per core process: each lane is a queue served by its own worker thread (docs/perf.md "Diff worker").
import type { FilePatch } from '../../shared/types/file-patch';
import { log } from '../logger';
import { editDiffWindows, type TextReplacement } from '../pi-session/tools/edit-diff';
import { FILE_PATCH_TIMEOUT_MS, filePatchOmitted } from '../pi-session/tools/file-patch';
import { DiffLane, type LaneHealth } from './lane';
import type { EditPatchJob, FilePatchJob, LineDiff, LineDiffJob } from './protocol';

export interface DiffOptions {
  readonly signal?: AbortSignal;
}

/**
 * Each method rejects only when its job throws, on the worker or while it is built, which is a bug; a caller treats the
 * rejection as no diff for that one item.
 * A signal that aborts while its job is queued answers the job over budget.
 */
export interface DiffService {
  /** The chat review's line diff, on the review lane; tooLarge past its bounds or when no worker could run it. */
  lineDiff(job: LineDiffJob, options?: DiffOptions): Promise<LineDiff>;
  /**
   * A Write's or Edit's patch (`filePatch` in `jobs.ts`), on the tool lane, which never waits behind a review diff; omitted
   * as too large past its bounds or when no worker could run it.
   */
  filePatch(path: string, before: string, after: string, options?: DiffOptions): Promise<FilePatch>;
  /**
   * A single-replacement Edit's patch of its LF texts, as pi's edit records it, on the tool lane; omitted as too large past
   * the tool lane's budget or when no worker could run it. Only the windows around the replacements are sent to the worker.
   */
  editPatch(path: string, baseContent: string, newContent: string, replacements: readonly TextReplacement[], options?: DiffOptions): Promise<FilePatch>;
  /** Answers every pending job over budget and stops the workers. */
  close(): Promise<void>;
}

export function filePatchJob(path: string, before: string, after: string): FilePatchJob {
  return { kind: 'filePatch', path, before, after, timeoutMs: FILE_PATCH_TIMEOUT_MS };
}

export function editPatchJob(path: string, baseContent: string, newContent: string, replacements: readonly TextReplacement[]): EditPatchJob {
  return { kind: 'editPatch', path, windows: editDiffWindows(baseContent, newContent, replacements), timeoutMs: FILE_PATCH_TIMEOUT_MS };
}

// Holds the diff of two files at the review's size bound (EDITOR_CONFIRM_DOCUMENT_BYTES), measured in docs/perf.md
// "Diff worker"; a job past it ends its worker out of memory and answers over budget.
export const DIFF_WORKER_HEAP_MB: number = 512;
// jsdiff checks its deadline once per edit step; the grace covers the linear work around it and GC.
export const DIFF_WATCHDOG_GRACE_MS: number = 2_000;
export const DIFF_WORKER_IDLE_MS: number = 5 * 60_000;
// consecutive workers that exited before ready (a missing or broken bundle) after which the service is off for the process
const START_FAILURES_OFF = 3;

/** The service on worker threads started from `entry` (dist/diff-worker.js) on first use. */
export function createThreadDiffService(entry: string, options: { readonly graceMs?: number; readonly idleMs?: number; readonly heapMb?: number } = {}): DiffService {
  let failures = 0;
  let off = false;
  const health: LaneHealth = {
    off: () => off,
    started: () => {
      failures = 0;
    },
    startFailed: (detail) => {
      failures++;
      if (off || failures < START_FAILURES_OFF) return;
      off = true;
      log('[diff] the diff worker %s failed to start %d times in a row (%s); every diff answers too large for the rest of the process', entry, failures, detail);
    },
  };
  const lane = (name: string): DiffLane =>
    new DiffLane({ name, entry, graceMs: options.graceMs ?? DIFF_WATCHDOG_GRACE_MS, idleMs: options.idleMs ?? DIFF_WORKER_IDLE_MS, heapMb: options.heapMb ?? DIFF_WORKER_HEAP_MB, health });
  const review = lane('review');
  const tool = lane('tool');
  return {
    lineDiff: (job, opts) => review.run(job, opts?.signal),
    // a binary or oversized text is answered here, never cloned to the worker
    filePatch: async (path, before, after, opts) => filePatchOmitted(before, after) ?? tool.run(filePatchJob(path, before, after), opts?.signal),
    editPatch: async (path, baseContent, newContent, replacements, opts) => tool.run(editPatchJob(path, baseContent, newContent, replacements), opts?.signal),
    close: async () => {
      await Promise.all([review.close(), tool.close()]);
    },
  };
}

let installed: DiffService | undefined;

export function installDiffService(service: DiffService): DiffService | undefined {
  const previous = installed;
  installed = service;
  return previous;
}

export function diffService(): DiffService {
  if (!installed) throw new Error('No diff service installed: the host must call installDiffService() before it opens a chat');
  return installed;
}
