import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { access, readFile, writeFile } from 'fs/promises';
import { Type } from 'typebox';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition, EditOperations, EditToolDetails, EditToolInput } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { FilePatch } from '../../../shared/types/file-patch';
import { TOOL_EDIT } from '../../../shared/tool-names';
import { applyReplacementsToOriginal, generateEditDiff, normalizeToLF, type TextReplacement } from './edit-diff';
import { filePatch } from './file-patch';
import { editOperations, onFileQueue } from './local-file-operations';
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

/** A `replace_all` Edit of a file's text. */
export interface ExactEdit {
  /** The text before and after, BOM split off and line endings LF, as pi's edit diffs them. */
  baseContent: string;
  newContent: string;
  replacements: TextReplacement[];
  /** The file's new text: its BOM and each untouched line's own ending kept, as pi's edit writes it. */
  written: string;
}

/**
 * Every occurrence of `oldString` replaced, matched exactly on pi's edit's normalization (BOM split off, CRLF and lone CR
 * as LF). Null when `oldString` is empty or absent. `replace_all` writes this result, and its approval diff shows it.
 */
export function exactEdit(raw: string, oldString: string, newString: string): ExactEdit | null {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = raw.slice(bom.length);
  const baseContent = normalizeToLF(content);
  const oldText = normalizeToLF(oldString);
  const newText = normalizeToLF(newString);
  if (oldText === '' || !baseContent.includes(oldText)) return null;
  const replacements = everyOccurrence(baseContent, oldText, newText);
  const newContent = baseContent.split(oldText).join(newText);
  // Spliced into the original text, so untouched lines keep their own line endings.
  const written = bom + (content === baseContent ? newContent : applyReplacementsToOriginal(content, replacements));
  return { baseContent, newContent, replacements, written };
}

/** The non-overlapping occurrences of a non-empty `oldText` in `content`, left to right, as `split` finds them. */
function everyOccurrence(content: string, oldText: string, newText: string): TextReplacement[] {
  const replacements: TextReplacement[] = [];
  for (let index = content.indexOf(oldText); index !== -1; index = content.indexOf(oldText, index + oldText.length)) {
    replacements.push({ matchIndex: index, matchLength: oldText.length, newText });
  }
  return replacements;
}

/**
 * `replace_all`, which pi's edit lacks (it requires each `oldText` to be unique). The read, the replacement and the write all
 * run in one mutation queue slot, so a write or edit queued on the file lands wholly before or after it. The bytes and diff
 * are those of pi's edit given every occurrence as its own edit, the result text and errors those of pi's edit given the
 * whole file as one edit; `edit-tool.test.ts` holds them to both.
 * It matches exactly, where the single-edit path takes pi's whitespace-tolerant matching: a global replace must be exact.
 */
function replaceAll(pi: PiCodingAgentModule, cwd: string, params: EditParams, signal: AbortSignal | undefined): Promise<AgentToolResult<EditDetails>> {
  const path = params.file_path;
  const absolutePath = resolveToCwd(path, cwd);
  return onFileQueue(pi, absolutePath, async () => {
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
    const edit = exactEdit(raw, params.old_string, params.new_string);
    if (!edit) throw new Error(`String to replace not found in file: ${path}`);
    const { baseContent, newContent, replacements, written } = edit;
    if (baseContent === newContent) {
      throw new Error(`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`);
    }
    // Before the write, so neither can fail after it.
    const { diff, firstChangedLine } = generateEditDiff(path, baseContent, newContent, replacements);
    const patch = filePatch(path, baseContent, newContent);
    throwIfAborted();
    await writeFile(absolutePath, written, 'utf-8');
    throwIfAborted();
    return {
      content: [{ type: 'text', text: `Successfully replaced 1 block(s) in ${path}.` }],
      details: { diff, ...(firstChangedLine === undefined ? {} : { firstChangedLine }), ...patch },
    };
  });
}

/** A single replacement in pi's edit's input shape. */
function piEditInput(filePath: string, oldString: string, newString: string): EditToolInput {
  return { path: filePath, edits: [{ oldText: oldString, newText: newString }] };
}

/** What pi's edit writes for a single replacement, and the first line it changes in the new text. */
export interface EditPreview {
  written: string;
  firstChangedLine: number | undefined;
}

/**
 * pi's edit of a file holding `original`, run on an in-memory copy: the text it would write, or pi's own message where it refuses
 * the edit (old_string empty, absent or found more than once, or a change that changes nothing).
 */
export async function previewEdit(pi: PiCodingAgentModule, filePath: string, original: string, oldString: string, newString: string): Promise<EditPreview | { refused: string }> {
  let written: string | undefined;
  const queueKey = `damocles-edit-preview:${randomUUID()}`;
  const operations: EditOperations = {
    access: () => Promise.resolve(),
    readFile: () => Promise.resolve(Buffer.from(original, 'utf-8')),
    writeFile: (_path, content) => {
      written = content;
      return Promise.resolve();
    },
    // No file's key, so the preview neither waits behind nor holds up a write queued on the file.
    realpath: () => Promise.resolve(queueKey),
  };
  const piEdit = pi.createEditTool(dirname(filePath), { operations });
  // pi's edit rejects exactly where it refuses the edit; its message goes to the model unread.
  const result: AgentToolResult<EditToolDetails | undefined> | { refused: string } = await piEdit
    .execute('edit-preview', piEditInput(filePath, oldString, newString))
    .then((value: AgentToolResult<EditToolDetails | undefined>) => value, (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }));
  if ('refused' in result) return result;
  if (written === undefined) throw new Error('pi\'s edit returned without writing');
  return { written, firstChangedLine: result.details?.firstChangedLine };
}

/**
 * Build the custom `Edit` tool. A single replacement is delegated to pi's
 * `createEditToolDefinition` on pi's default operations written here (`editOperations`), translated to pi's shape, which reuses pi's `details.diff/patch`
 * (FR-4: no bespoke file-editing logic); `replace_all` runs here (`replaceAll`). The central gate
 * (`canUseTool` → diff approval) runs before `execute`, so this just performs the approved write.
 * Sequential, so pi runs any batch holding an Edit one call at a time, in the model's order ("Tool overrides").
 */
export function createEditTool(pi: PiCodingAgentModule, cwd: string): ToolDefinition {
  const piEdit = pi.createEditToolDefinition(cwd, { operations: editOperations });
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
      return piEdit.execute(toolCallId, piEditInput(params.file_path, params.old_string, params.new_string), signal, onUpdate, ctx);
    },
  });
}
