import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import { EDITOR_CONFIRM_DOCUMENT_BYTES } from '../../../shared/types/messages';
import type { FilePatch, FilePatchOmitted } from '../../../shared/types/file-patch';
import { stripBom } from '../../config/bom';
import { readFileBytes } from '../../file-bytes';

/** A file the editor will not open is not diffed either; this also bounds what a patch adds to the session file. */
export const FILE_PATCH_MAX_BYTES: number = EDITOR_CONFIRM_DOCUMENT_BYTES;

/**
 * Inserted plus deleted lines above which no patch is computed. jsdiff's cost grows with the square of
 * the edit length, about 60 ms at this bound against seconds for a few thousand lines.
 */
export const FILE_PATCH_MAX_CHANGED_LINES: number = 1000;

/** git's binary test (`buffer_is_binary`): a NUL among the first 8000 bytes. */
const BINARY_PROBE_LENGTH = 8000;

/** pi's edit diffs text with the BOM split off and line endings normalized (`splitBom`, `normalizeToLF`). */
export function normalized(text: string): string {
  return stripBom(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function isBinaryText(text: string): boolean {
  return text.slice(0, BINARY_PROBE_LENGTH).includes('\0');
}

/**
 * A file's text for a change's patch and approval diff, decoded `toString('utf-8')` as pi's edit and write decode the bytes they
 * read: undefined when the file does not exist, or why it cannot be diffed. Only a regular file within the bound is opened, and
 * no read goes past the bound (`readFileBytes`).
 */
export async function readTextForPatch(absolutePath: string): Promise<string | { patchOmitted: FilePatchOmitted } | undefined> {
  const read = await readFileBytes(absolutePath, FILE_PATCH_MAX_BYTES);
  switch (read.kind) {
    case 'missing': return undefined;
    case 'tooLarge': return { patchOmitted: 'tooLarge' };
    case 'notAFile': return { patchOmitted: 'notAFile' };
    case 'unreadable': return { patchOmitted: 'unreadable' };
    case 'bytes': {
      const text = read.bytes.toString('utf-8');
      return isBinaryText(text) ? { patchOmitted: 'binary' } : text;
    }
  }
}

/**
 * The patch a file change renders from, in pi's edit's shape: `generateUnifiedPatch`'s jsdiff call with
 * its four context lines and file headers, plus the edit-length bound pi's helper does not expose.
 * `write-tool.test.ts` pins the output to pi's helper.
 */
export function filePatch(path: string, before: string, after: string): FilePatch {
  if (isBinaryText(before)) return { patchOmitted: 'binary' };
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
