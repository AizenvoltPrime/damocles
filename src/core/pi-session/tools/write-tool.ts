import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import type { ToolDefinition, WriteToolInput } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { WriteDetails } from '../../../shared/types/file-patch';
import { log } from '../../logger';
import { FILE_PATCH_MAX_BYTES, filePatch } from './file-patch';

/** pi's definitions carry their own schema and render types; only the erased shape is assignable both ways. */
type AnyToolDefinition = ToolDefinition<any, any, any>;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** What the change does to the file: its patch, why there is none, or that the write creates it. */
async function writeDetails(path: string, absolutePath: string, content: string): Promise<WriteDetails> {
  let size: number;
  try {
    size = (await stat(absolutePath)).size;
  } catch (error) {
    if (isMissing(error)) return { created: true };
    throw error;
  }
  // Read only a file the diff could use, so a huge one is never loaded into memory.
  if (size > FILE_PATCH_MAX_BYTES) return { patchOmitted: 'tooLarge' };
  return filePatch(path, (await readFile(absolutePath)).toString('utf-8'), content);
}

/**
 * The `write` override: pi's own write does the write, and its schema and prompt text reach the model
 * unchanged. A write that replaces a file also records its patch; a new file records `created` instead,
 * since the tool input holds every line of it. Details that cannot be computed are left out, and
 * `writeFile` alone decides the outcome.
 * The name stays the literal lowercase `write`, which is what replaces pi's built-in, and it is never
 * paired with an `excludeTools` entry, which would drop the replacement too ("Tool overrides").
 * The old content is read through pi's `operations`, inside the write's mutation queue slot. A second
 * `withFileMutationQueue` around `execute` would deadlock, since pi's call queues behind it on that key.
 */
export function createWriteTool(pi: PiCodingAgentModule, cwd: string): ToolDefinition {
  const metadata: AnyToolDefinition = pi.createWriteToolDefinition(cwd);
  return {
    ...metadata,
    execute: async (toolCallId, params: WriteToolInput, signal, onUpdate, ctx) => {
      let details: WriteDetails | undefined;
      // pi's default local operations (`write.js`), built per call so the read lands in this call's slot.
      const write: AnyToolDefinition = pi.createWriteToolDefinition(cwd, {
        operations: {
          mkdir: async (dir) => {
            await mkdir(dir, { recursive: true });
          },
          writeFile: async (absolutePath, content) => {
            details = await writeDetails(params.path, absolutePath, content).catch((error: unknown) => {
              log('[write] no diff recorded for %s: %O', absolutePath, error);
              return undefined;
            });
            await writeFile(absolutePath, content, 'utf-8');
          },
        },
      });
      const result = await write.execute(toolCallId, params, signal, onUpdate, ctx);
      return details ? { ...result, details } : result;
    },
  };
}
