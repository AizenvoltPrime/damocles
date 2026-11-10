import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { AnyToolDefinition } from './any-tool-definition';

/**
 * `read` inside the file's mutation queue slot, or unqueued when pi cannot key the file: its `realpath` rethrows any error but
 * ENOENT and ENOTDIR (ELOOP, EPERM, some virtual drives). pi's write and edit fail on that same key, so no writer of this process
 * holds the slot, and pi's own read never queues.
 */
async function queuedRead<T>(pi: PiCodingAgentModule, absolutePath: string, read: () => Promise<T>): Promise<T> {
  let started = false;
  try {
    return await pi.withFileMutationQueue(absolutePath, () => {
      started = true;
      return read();
    });
  } catch (err) {
    if (started) throw err;
    return read();
  }
}

/**
 * The `read` override: pi's read, whose file reads and image sniff take the file's mutation queue slot, so a read never sees
 * a file a `write` or Edit of this process holds truncated (docs/invariants.md "Tool overrides").
 * pi replaces its default operations wholesale, so all three are given. Never queue `execute` itself: its own queued reads
 * would wait behind the slot it holds.
 */
export function createReadTool(pi: PiCodingAgentModule, cwd: string): ToolDefinition {
  const read: AnyToolDefinition = pi.createReadToolDefinition(cwd, {
    operations: {
      readFile: (absolutePath) => queuedRead(pi, absolutePath, () => readFile(absolutePath)),
      access: (absolutePath) => access(absolutePath, constants.R_OK),
      detectImageMimeType: (absolutePath) => queuedRead(pi, absolutePath, () => pi.detectSupportedImageMimeTypeFromFile(absolutePath)),
    },
  });
  return read;
}
