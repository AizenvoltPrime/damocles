import { constants } from 'node:fs';
import { access, open, readFile, realpath, writeFile } from 'node:fs/promises';
import type { EditOperations } from '@earendil-works/pi-coding-agent';
import { IMAGE_SNIFF_BYTES, sniffReadableImageType } from '../../../shared/inline-image';
import type { PiCodingAgentModule } from '../pi-loader';

/*
 * pi's default file operations (pi-coding-agent 1.5.2 with patches/README.md 004), written here so the build gives them
 * `original-fs` under Electron: pi's own run on the patched `fs` an external gets, which opens and holds a user's `.asar`
 * (docs/invariants.md "Tool overrides"). An override passes every operation pi's tool takes, `exists` and `realpath` included.
 */

/** pi's `pathExists` (`path-utils.js`). */
export function fileExists(absolutePath: string): Promise<boolean> {
  return access(absolutePath, constants.F_OK).then(() => true, () => false);
}

/** The mutation queue's key of a file, as pi's default keys it; every queued call on one file must key it the same way. */
export function queueKeyOf(absolutePath: string): Promise<string> {
  return realpath(absolutePath);
}

/** `withFileMutationQueue` keyed through `queueKeyOf`. */
export function onFileQueue<T>(pi: PiCodingAgentModule, absolutePath: string, fn: () => Promise<T>): Promise<T> {
  return pi.withFileMutationQueue(absolutePath, fn, queueKeyOf);
}

/** pi's `detectSupportedImageMimeTypeFromFile` (`utils/mime.js`). */
export async function detectImageMimeType(absolutePath: string): Promise<string | null> {
  const handle = await open(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(IMAGE_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, IMAGE_SNIFF_BYTES, 0);
    return sniffReadableImageType(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** pi's default edit operations (`edit.js`). */
export const editOperations: EditOperations = {
  readFile: (absolutePath) => readFile(absolutePath),
  writeFile: (absolutePath, content) => writeFile(absolutePath, content, 'utf-8'),
  access: (absolutePath) => access(absolutePath, constants.R_OK | constants.W_OK),
  realpath: queueKeyOf,
};
