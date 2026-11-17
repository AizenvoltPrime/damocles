import { constants } from 'node:fs';
import { access, open, readFile } from 'node:fs/promises';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { AnyToolDefinition } from './any-tool-definition';
import { detectImageMimeType, fileExists, onFileQueue } from './local-file-operations';

/**
 * `read` inside the file's mutation queue slot, or unqueued when the queue cannot key the file: pi rethrows any error of its
 * `realpath` but ENOENT and ENOTDIR (ELOOP, EPERM, some virtual drives). pi's write and edit fail on that same key, so no writer
 * of this process holds the slot, and pi's own read never queues.
 */
async function queuedRead<T>(pi: PiCodingAgentModule, absolutePath: string, read: () => Promise<T>): Promise<T> {
  let started = false;
  try {
    return await onFileQueue(pi, absolutePath, () => {
      started = true;
      return read();
    });
  } catch (err) {
    if (started) throw err;
    return read();
  }
}

/**
 * pi's `readLocalFileChunks` (pi-coding-agent 1.5.2 `dist/core/tools/read.js:41`), which its package does not export: a regular
 * file up to its size when opened, as `readFile` reads it, so a growing file still ends; a file reporting size 0 and other
 * file types until EOF.
 */
async function* readLocalFileChunks(absolutePath: string, signal: AbortSignal | undefined): AsyncGenerator<Uint8Array> {
  const handle = await open(absolutePath, 'r');
  try {
    const stats = await handle.stat();
    const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
    // A stream built on an aborted signal also emits its AbortError where no listener catches it, an uncaught exception.
    signal?.throwIfAborted();
    yield* handle.createReadStream({ end, signal, autoClose: false });
  } finally {
    await handle.close();
  }
}

/**
 * `readLocalFileChunks` holding the file's mutation queue slot from before the open until the stream ends or its reader stops,
 * or unqueued where `queuedRead` reads unqueued. A generator, so a stream its reader never starts takes no slot.
 */
async function* queuedReadStream(pi: PiCodingAgentModule, absolutePath: string, signal: AbortSignal | undefined): AsyncGenerator<Uint8Array> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let queued!: Promise<void>;
  const inSlot = await new Promise<boolean>((resolve) => {
    queued = onFileQueue(pi, absolutePath, () => {
      resolve(true);
      return released;
    });
    // The slot's operation never rejects, so a rejection is the queue failing to key the file.
    queued.catch(() => resolve(false));
  });
  try {
    yield* readLocalFileChunks(absolutePath, signal);
  } finally {
    release();
    if (inSlot) await queued;
  }
}

/**
 * The `read` override: pi's read, whose file reads, text stream and image sniff take the file's mutation queue slot, so a read
 * never sees a file a `write` or Edit of this process holds truncated (docs/invariants.md "Tool overrides").
 * pi replaces its default operations wholesale, so all five are given, each on the bundle's fs. Never queue `execute` itself:
 * its own queued reads would wait behind the slot it holds.
 */
export function createReadTool(pi: PiCodingAgentModule, cwd: string): ToolDefinition {
  const read: AnyToolDefinition = pi.createReadToolDefinition(cwd, {
    operations: {
      readFile: (absolutePath) => queuedRead(pi, absolutePath, () => readFile(absolutePath)),
      createReadStream: (absolutePath, { signal }) => queuedReadStream(pi, absolutePath, signal),
      access: (absolutePath) => access(absolutePath, constants.R_OK),
      exists: fileExists,
      detectImageMimeType: (absolutePath) => queuedRead(pi, absolutePath, () => detectImageMimeType(absolutePath)),
    },
  });
  return read;
}
