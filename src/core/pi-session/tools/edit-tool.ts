import { constants } from 'node:fs';
import { access, readFile, writeFile } from 'fs/promises';
import { Type } from 'typebox';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition, EditToolDetails, EditToolInput } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { FilePatch } from '../../../shared/types/file-patch';
import { TOOL_EDIT } from '../../../shared/tool-names';
import { filePatch } from './file-patch';
import { resolveToCwd } from './search-tools';

/**
 * Claude-Code-shaped Edit schema (`file_path`/`old_string`/`new_string`/`replace_all`). This REPLACES
 * pi's native `edit` (which uses `{ path, edits: [{ oldText, newText }] }`) so the Damocles diff
 * approval + webview Edit renderer receive the exact shape they already key off (US-003, decision 1).
 */
const editSchema = Type.Object(
  {
    file_path: Type.String({ description: 'The absolute path to the file to modify' }),
    old_string: Type.String({ description: 'The text to replace' }),
    new_string: Type.String({ description: 'The text to replace it with (must be different from old_string)' }),
    replace_all: Type.Optional(Type.Boolean({ description: 'Replace all occurrences of old_string (default false)' })),
  },
  // No `additionalProperties: false` (pi #6278): models occasionally add a stray extra field, and a
  // schema that forbids it turns an otherwise-valid edit into a rejection. `constrainedSampling` below
  // re-imposes the closed shape while decoding on providers with strict mode, so this relaxation
  // governs only the providers without it. Mirrors pi's own edit schema.
  {},
);

type EditParams = { file_path: string; old_string: string; new_string: string; replace_all?: boolean };

/** pi's `EditToolDetails`, with the patch bounded as a write's is. */
type EditDetails = Pick<EditToolDetails, 'diff' | 'firstChangedLine'> & FilePatch;

const toLF = (s: string): string => s.replace(/\r\n/g, '\n');

/** pi's `normalizeToLF`, `detectLineEnding` and `restoreLineEndings` (`edit-diff.js`), which its package does not export. */
const normalizeToLF = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlf = content.indexOf('\r\n');
  const lf = content.indexOf('\n');
  return lf !== -1 && crlf !== -1 && crlf < lf ? '\r\n' : '\n';
}

/** `replace_all` on LF text: every exact occurrence of `oldString` replaced, or null when there is none. The approval diff shows this same result. */
export function replaceEveryOccurrence(content: string, oldString: string, newString: string): string | null {
  const oldText = toLF(oldString);
  return content.includes(oldText) ? content.split(oldText).join(toLF(newString)) : null;
}

/**
 * `replace_all`, which pi's edit lacks (it requires each `oldText` to be unique). The read, the replacement and the write all
 * run in one mutation queue slot, so a write or edit queued on the file lands wholly before or after it. The bytes, result
 * text and errors are those of pi's edit given the whole file as one edit; `edit-tool.test.ts` holds them to it.
 * It matches exactly, where the single-edit path takes pi's whitespace-tolerant matching: a global replace must be exact.
 */
function replaceAll(pi: PiCodingAgentModule, cwd: string, params: EditParams, signal: AbortSignal | undefined): Promise<AgentToolResult<EditDetails>> {
  const path = params.file_path;
  const absolutePath = resolveToCwd(path, cwd);
  return pi.withFileMutationQueue(absolutePath, async () => {
    // As pi's edit: no rejection from an abort listener, which would release the slot while a write may still land.
    const throwIfAborted = (): void => {
      if (signal?.aborted) throw new Error('Operation aborted');
    };
    throwIfAborted();
    try {
      await access(absolutePath, constants.R_OK | constants.W_OK);
    } catch (error) {
      throwIfAborted();
      const reason = error instanceof Error && 'code' in error ? `Error code: ${String(error.code)}` : String(error);
      throw new Error(`Could not edit file: ${path}. ${reason}.`);
    }
    throwIfAborted();
    const raw = (await readFile(absolutePath)).toString('utf-8');
    throwIfAborted();
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
    const content = raw.slice(bom.length);
    const replaced = replaceEveryOccurrence(toLF(content), params.old_string, params.new_string);
    if (replaced === null) throw new Error(`String to replace not found in file: ${path}`);
    const baseContent = normalizeToLF(content);
    const newContent = normalizeToLF(replaced);
    if (baseContent === newContent) {
      throw new Error(`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`);
    }
    const ending = detectLineEnding(content);
    await writeFile(absolutePath, bom + (ending === '\r\n' ? newContent.replace(/\n/g, '\r\n') : newContent), 'utf-8');
    throwIfAborted();
    const { diff, firstChangedLine } = pi.generateDiffString(baseContent, newContent);
    return {
      content: [{ type: 'text', text: `Successfully replaced 1 block(s) in ${path}.` }],
      details: { diff, ...(firstChangedLine === undefined ? {} : { firstChangedLine }), ...filePatch(path, baseContent, newContent) },
    };
  });
}

/**
 * Build the custom `Edit` tool. A single replacement is delegated to pi's
 * `createEditToolDefinition(cwd).execute(...)` translated to pi's shape, which reuses pi's `details.diff/patch`
 * (FR-4: no bespoke file-editing logic); `replace_all` runs here (`replaceAll`). The central gate
 * (`canUseTool` → diff approval) runs before `execute`, so this just performs the approved write.
 * Sequential, so pi runs any batch holding an Edit one call at a time, in the model's order ("Tool overrides").
 */
export function createEditTool(pi: PiCodingAgentModule, cwd: string): ToolDefinition {
  const piEdit = pi.createEditToolDefinition(cwd);
  return pi.defineTool<typeof editSchema, EditToolDetails | EditDetails | undefined>({
    name: TOOL_EDIT,
    label: 'Edit',
    description: 'Performs exact string replacement in a file. The old_string must uniquely identify the text to replace, unless replace_all is set. To create a new file, use the Write tool instead — Edit cannot create files.',
    parameters: editSchema,
    // `prefer` degrades to unconstrained sampling on providers without strict mode, where `require` throws.
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    executionMode: 'sequential',
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // pi's edit rejects an empty `oldText`, and CC's empty-old_string "create file" idiom does not apply
      // here — Write is the only text-file creation path.
      if (params.old_string === '') {
        throw new Error('Edit cannot create a file: old_string is empty. Use the Write tool to create a new file.');
      }
      if (params.replace_all) return replaceAll(pi, ctx?.cwd || cwd, params, signal);
      const input: EditToolInput = { path: params.file_path, edits: [{ oldText: params.old_string, newText: params.new_string }] };
      return piEdit.execute(toolCallId, input, signal, onUpdate, ctx);
    },
  });
}
