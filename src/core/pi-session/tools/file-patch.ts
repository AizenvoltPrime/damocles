import { EDITOR_CONFIRM_DOCUMENT_BYTES } from '../../../shared/types/messages';
import type { FilePatch } from '../../../shared/types/file-patch';
import { stripBom } from '../../config/bom';

/** A file the editor will not open is not diffed either; this also bounds what a patch adds to the session file. */
export const FILE_PATCH_MAX_BYTES: number = EDITOR_CONFIRM_DOCUMENT_BYTES;

/**
 * Inserted plus deleted lines above which no patch is computed. jsdiff's cost grows with the square of
 * the edit length, about 60 ms at this bound against seconds for a few thousand lines.
 */
export const FILE_PATCH_MAX_CHANGED_LINES: number = 1000;

/** A patch's time budget on the diff worker's tool lane, past which it is omitted as too large (VS Code's quick-diff value). */
export const FILE_PATCH_TIMEOUT_MS: number = 1_000;

/** git's binary test (`buffer_is_binary`): a NUL among the first 8000 bytes. */
const BINARY_PROBE_LENGTH = 8000;

/** pi's edit diffs text with the BOM split off and line endings normalized (`splitBom`, `normalizeToLF`). */
export function normalized(text: string): string {
  return stripBom(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** git's binary test applied to decoded text. */
export function isBinaryText(text: string): boolean {
  return text.slice(0, BINARY_PROBE_LENGTH).includes('\0');
}

/** Why no patch of the texts is computed (binary, or over the size bound), checked before a text is sent to the diff worker. */
export function filePatchOmitted(before: string, after: string): FilePatch | undefined {
  if (isBinaryText(before)) return { patchOmitted: 'binary' };
  if (Buffer.byteLength(before) > FILE_PATCH_MAX_BYTES || Buffer.byteLength(after) > FILE_PATCH_MAX_BYTES) {
    return { patchOmitted: 'tooLarge' };
  }
  return undefined;
}
