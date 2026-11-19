// The diff jobs, run only on the diff worker (and the inline service of tests): jsdiff's cost grows with file length times
// changed lines, so no host thread runs it (docs/perf.md "Diff worker").
import { createTwoFilesPatch, FILE_HEADERS_ONLY, formatPatch, structuredPatch, type StructuredPatchHunk } from 'diff';
import type { FilePatch } from '../../shared/types/file-patch';
import type { EditWindow } from '../pi-session/tools/edit-diff';
import { FILE_PATCH_MAX_CHANGED_LINES, filePatchOmitted, normalized } from '../pi-session/tools/file-patch';
import type { DiffJob, DiffResult, LineDiff, LineDiffJob } from './protocol';

function lineDiff(job: LineDiffJob): LineDiff {
  const patch = structuredPatch('', '', job.before, job.after, undefined, undefined, { context: job.context, maxEditLength: job.maxEditLength, timeout: job.timeoutMs });
  if (!patch) return { kind: 'tooLarge' };
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { kind: 'diff', hunks: patch.hunks, added, removed };
}

/**
 * The patch a file change renders from, in pi's edit's shape: `generateUnifiedPatch`'s jsdiff call with its four context
 * lines and file headers, plus the edit-length and time bounds pi's helper does not expose. `write-tool.test.ts` pins the
 * output to pi's helper.
 */
export function filePatch(path: string, before: string, after: string, timeoutMs: number): FilePatch {
  const omitted = filePatchOmitted(before, after);
  if (omitted) return omitted;
  const patch = createTwoFilesPatch(path, path, normalized(before), normalized(after), undefined, undefined, {
    context: 4,
    headerOptions: FILE_HEADERS_ONLY,
    maxEditLength: FILE_PATCH_MAX_CHANGED_LINES,
    timeout: timeoutMs,
  });
  return patch === undefined ? { patchOmitted: 'tooLarge' } : { patch };
}

/**
 * An edit's unified patch from its windows (`editDiffWindows`), as pi's edit records it: it matches `generateUnifiedPatch`
 * over the whole contents, except that jsdiff may align runs of repeated lines differently within a window. Omitted as too
 * large once the windows' diffs pass `timeoutMs` together.
 */
export function windowedEditPatch(path: string, windows: readonly EditWindow[], timeoutMs: number): FilePatch {
  const deadline = Date.now() + timeoutMs;
  const hunks: StructuredPatchHunk[] = [];
  for (const window of windows) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { patchOmitted: 'tooLarge' };
    const patch = structuredPatch(path, path, window.oldText, window.newText, undefined, undefined, { context: 4, timeout: remaining });
    if (!patch) return { patchOmitted: 'tooLarge' };
    for (const hunk of patch.hunks) {
      hunks.push({ ...hunk, oldStart: hunk.oldStart + window.oldLine, newStart: hunk.newStart + window.newLine });
    }
  }
  return { patch: formatPatch({ oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks }, FILE_HEADERS_ONLY) };
}

export function runDiffJob<J extends DiffJob>(job: J): DiffResult<J> {
  switch (job.kind) {
    case 'lineDiff':
      return lineDiff(job) as DiffResult<J>;
    case 'filePatch':
      return filePatch(job.path, job.before, job.after, job.timeoutMs) as DiffResult<J>;
    case 'editPatch':
      return windowedEditPatch(job.path, job.windows, job.timeoutMs) as DiffResult<J>;
  }
}
