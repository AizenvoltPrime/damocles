import type { FilePatchOmitted } from '../../../shared/types/file-patch';
import { readFileBytes } from '../../file-bytes';
import { FILE_PATCH_MAX_BYTES, isBinaryText } from './file-patch';

/**
 * A file's text for a change's patch and approval diff, decoded `toString('utf-8')` as the Edit and write tools decode the bytes
 * they read: undefined when the file does not exist, or why it cannot be diffed. Only a regular file within the bound is opened,
 * and no read goes past the bound (`readFileBytes`). Kept out of `file-patch.ts`, which the diff worker bundles.
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
