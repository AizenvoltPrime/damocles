import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../../shared/types/messages';
import type { FilePatch } from '../../../shared/types/file-patch';

/** A file the editor will not open is not diffed either; this also bounds what a patch adds to the session file. */
export const FILE_PATCH_MAX_BYTES: number = EDITOR_MAX_DOCUMENT_BYTES;

/**
 * Inserted plus deleted lines above which no patch is computed. jsdiff's cost grows with the square of
 * the edit length, about 60 ms at this bound against seconds for a few thousand lines.
 */
export const FILE_PATCH_MAX_CHANGED_LINES: number = 1000;

/** git's binary test (`buffer_is_binary`): a NUL among the first 8000 bytes. */
const BINARY_PROBE_LENGTH = 8000;

/** pi's edit diffs text with the BOM split off and line endings normalized (`splitBom`, `normalizeToLF`). */
function normalized(text: string): string {
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return unmarked.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * The patch a file change renders from, in pi's edit's shape: `generateUnifiedPatch`'s jsdiff call with
 * its four context lines and file headers, plus the edit-length bound pi's helper does not expose.
 * `write-tool.test.ts` pins the output to pi's helper.
 */
export function filePatch(path: string, before: string, after: string): FilePatch {
  if (before.slice(0, BINARY_PROBE_LENGTH).includes('\0')) return { patchOmitted: 'binary' };
  if (Buffer.byteLength(before) > FILE_PATCH_MAX_BYTES || Buffer.byteLength(after) > FILE_PATCH_MAX_BYTES) {
    return { patchOmitted: 'tooLarge' };
  }
  const patch = createTwoFilesPatch(path, path, normalized(before), normalized(after), undefined, undefined, {
    context: 4,
    headerOptions: FILE_HEADERS_ONLY,
    maxEditLength: FILE_PATCH_MAX_CHANGED_LINES,
  });
  return patch === undefined ? { patchOmitted: 'tooLarge' } : { patch };
}
