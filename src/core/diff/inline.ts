// The diff service on the calling thread, for tests: the worker's own jobs, without the thread.
import { runDiffJob } from './jobs';
import { overBudget } from './protocol';
import { editPatchJob, filePatchJob, type DiffService } from './service';

export function createInlineDiffService(): DiffService {
  let closed = false;
  return {
    lineDiff: async (job, options) => (closed || options?.signal?.aborted ? overBudget(job) : runDiffJob(job)),
    filePatch: async (path, before, after, options) => {
      const job = filePatchJob(path, before, after);
      return closed || options?.signal?.aborted ? overBudget(job) : runDiffJob(job);
    },
    editPatch: async (path, baseContent, newContent, replacements, options) => {
      const job = editPatchJob(path, baseContent, newContent, replacements);
      return closed || options?.signal?.aborted ? overBudget(job) : runDiffJob(job);
    },
    close: async () => {
      closed = true;
    },
  };
}
