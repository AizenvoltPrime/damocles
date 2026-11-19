import { constants, promises as fs } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import type { EditOperations } from '@earendil-works/pi-coding-agent';
import { IMAGE_SNIFF_BYTES, sniffReadableImageType } from '../../../shared/inline-image';
import { EDITOR_HARD_MAX_DOCUMENT_BYTES } from '../../../shared/types/messages';
import { OPEN_READ_NONBLOCKING, readOpenedFile } from '../../file-bytes';
import type { PiCodingAgentModule } from '../pi-loader';

/*
 * pi's default file operations (pi-coding-agent 1.5.2 with patches/README.md 004), written here so the build gives them
 * `original-fs` under Electron: pi's own run on the patched `fs` an external gets, which opens and holds a user's `.asar`
 * (docs/invariants.md "Tool overrides"). An override passes every operation pi's tool takes, `exists` and `realpath` included.
 * Edit's and write's reads and writes go through checked handles instead of pi's `readFile` and `writeFile`.
 */

// O_NONBLOCK where it exists, so a FIFO with no reader fails the open with ENXIO instead of blocking a thread; win32 has none.
const OPEN_WRITE_NONBLOCKING = constants.O_WRONLY | constants.O_CREAT | (constants.O_NONBLOCK ?? 0);

/** pi's edit's refusal of a file it cannot access (`edit.js`), which `replace_all` gives too. */
export function couldNotEdit(path: string, error: unknown): string {
  const reason = error instanceof Error && 'code' in error ? `Error code: ${String(error.code)}` : String(error);
  return `Could not edit file: ${path}. ${reason}.`;
}

/** The refusal of a folder, FIFO or device, which neither the Edit tool nor its approval opens. */
export function notARegularFile(path: string): string {
  return `Could not edit file: ${path}. It is not a regular file.`;
}

/** The write tool's refusal of a folder, FIFO or device, which neither the tool nor its approval opens. */
export function notARegularFileToWrite(path: string): string {
  return `Could not write file: ${path}. It is not a regular file.`;
}

/** The Edit tool's refusal of a file over the editor's hard limit, which it never reads whole. */
export function editTooLarge(path: string, bytes: number): string {
  return `Could not edit file: ${path}. It is ${bytes} bytes, over the ${EDITOR_HARD_MAX_DOCUMENT_BYTES}-byte limit of the Edit tool.`;
}

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

/**
 * `content` as UTF-8 in the regular file at absolutePath, created when missing, else rejects with `refusal`. Opened without
 * O_TRUNC and checked through the handle before anything changes, then written and cut to length (CERT FIO32-C), so a FIFO
 * or device swapped in after any check is refused at once and nothing is written to it.
 */
export async function writeRegularFile(absolutePath: string, content: string, refusal: string): Promise<void> {
  const handle = await fs.open(absolutePath, OPEN_WRITE_NONBLOCKING).catch((error: unknown) => {
    // A regular file never answers ENXIO; a FIFO with no reader does.
    throw (error as NodeJS.ErrnoException).code === 'ENXIO' ? new Error(refusal) : error;
  });
  try {
    if (!(await handle.stat()).isFile()) throw new Error(refusal);
    const bytes = Buffer.from(content, 'utf-8');
    await handle.writeFile(bytes);
    await handle.truncate(bytes.length);
  } finally {
    await handle.close();
  }
}

/** A regular file's bytes, read from the handle the open gave, up to the editor's hard limit; anything else rejects with Edit's refusal. */
async function readFileToEdit(absolutePath: string): Promise<Buffer> {
  const handle = await fs.open(absolutePath, OPEN_READ_NONBLOCKING);
  try {
    const read = await readOpenedFile(handle, EDITOR_HARD_MAX_DOCUMENT_BYTES);
    switch (read.kind) {
      case 'bytes': return read.bytes;
      case 'notAFile': throw new Error(notARegularFile(absolutePath));
      case 'tooLarge': throw new Error(editTooLarge(absolutePath, read.bytes));
      case 'unreadable': throw new Error(couldNotEdit(absolutePath, read.code !== undefined ? Object.assign(new Error(read.error), { code: read.code }) : read.error));
    }
  } finally {
    await handle.close();
  }
}

/** The Edit tool's file operations (`runEdit`), pi's edit defaults (`edit.js`) reading and writing only through checked handles. */
export const editOperations: EditOperations = {
  readFile: readFileToEdit,
  writeFile: (absolutePath, content) => writeRegularFile(absolutePath, content, notARegularFile(absolutePath)),
  access: (absolutePath) => access(absolutePath, constants.R_OK | constants.W_OK),
  realpath: queueKeyOf,
};
