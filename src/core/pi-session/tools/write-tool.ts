import { promises as fs } from 'node:fs';
import { mkdir } from 'fs/promises';
import type { ToolDefinition, WriteToolInput } from '@earendil-works/pi-coding-agent';
import type { AnyToolDefinition } from './any-tool-definition';
import type { PiCodingAgentModule } from '../pi-loader';
import type { WriteDetails } from '../../../shared/types/file-patch';
import type { DiffService } from '../../diff';
import { log } from '../../logger';
import { readTextForPatch } from './patch-text';
import { notARegularFileToWrite, queueKeyOf, writeRegularFile } from './local-file-operations';
import { resolveToCwd } from './search-tools';


/** What the change does to the file: its patch, why there is none, or that the write creates it. */
async function writeDetails(diff: Pick<DiffService, 'filePatch'>, path: string, absolutePath: string, content: string, signal: AbortSignal | undefined): Promise<WriteDetails> {
  const before = await readTextForPatch(absolutePath);
  if (before === undefined) return { created: true };
  return typeof before === 'string' ? diff.filePatch(path, before, content, signal ? { signal } : {}) : before;
}

/**
 * The `write` override: pi's own write does the write, and its schema and prompt text reach the model
 * unchanged. A write that replaces a file also records its patch, or why it has none (`readTextForPatch`);
 * a new file records `created` instead, since the tool input holds every line of it. The write alone decides
 * the outcome; a path that is not a regular file is refused, in every mode, and nothing is written to it.
 * The name stays the literal lowercase `write`, which is what replaces pi's built-in, and it is never
 * paired with an `excludeTools` entry, which would drop the replacement too ("Tool overrides").
 * The old content is read in pi's `writeFile` operation, inside the write's mutation queue slot. A second
 * `withFileMutationQueue` around `execute` would deadlock, since pi's call queues behind it on that key.
 * The patch is computed on the diff worker's tool lane within that slot, so the slot also waits for the jobs queued ahead on that lane.
 * Sequential, so pi runs any batch holding a write one call at a time, in the model's order.
 */
export function createWriteTool(pi: PiCodingAgentModule, cwd: string, diff: Pick<DiffService, 'filePatch'>): ToolDefinition {
  const metadata: AnyToolDefinition = pi.createWriteToolDefinition(cwd);
  return {
    ...metadata,
    executionMode: 'sequential',
    execute: async (toolCallId, params: WriteToolInput, signal, onUpdate, ctx) => {
      // Refused here in the path's own spelling; the write refuses one swapped in after this stat from its handle. A stat error is the write's to report.
      const entry = await fs.stat(resolveToCwd(params.path, ctx?.cwd || cwd)).catch(() => undefined);
      if (entry !== undefined && !entry.isFile()) throw new Error(notARegularFileToWrite(params.path));
      let details: WriteDetails | undefined;
      // pi's default local operations (`write.js`) on the bundle's fs, built per call so the read lands in this call's slot.
      const write: AnyToolDefinition = pi.createWriteToolDefinition(cwd, {
        operations: {
          realpath: queueKeyOf,
          mkdir: async (dir) => {
            await mkdir(dir, { recursive: true });
          },
          writeFile: async (absolutePath, content) => {
            details = await writeDetails(diff, params.path, absolutePath, content, signal).catch((error: unknown) => {
              log('[write] no diff recorded for %s: %O', absolutePath, error);
              return undefined;
            });
            // pi's write checks the signal only around this operation, so a Stop during the patch must refuse the write here.
            if (signal?.aborted) throw new Error('Operation aborted');
            await writeRegularFile(absolutePath, content, notARegularFileToWrite(absolutePath));
          },
        },
      });
      const result = await write.execute(toolCallId, params, signal, onUpdate, ctx);
      return details ? { ...result, details } : result;
    },
  };
}
