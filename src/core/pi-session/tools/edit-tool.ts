import { stat } from 'fs/promises';
import { Type } from 'typebox';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition, EditToolDetails } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { FilePatch } from '../../../shared/types/file-patch';
import { TOOL_EDIT } from '../../../shared/tool-names';
import type { DiffService } from '../../diff';
import { log } from '../../logger';
import { applyReplacementsToOriginal, firstChangedLine, normalizeToLF, type TextReplacement } from './edit-diff';
import { couldNotEdit, editOperations, notARegularFile, onFileQueue } from './local-file-operations';
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
type EditChange = Omit<EditParams, 'file_path'>;

/** pi's `EditToolDetails` without the display diff, which nothing reads; no patch field when the patch job failed. */
type EditDetails = Pick<EditToolDetails, 'firstChangedLine'> & Partial<FilePatch>;

/** The Edit tool's refusal of an empty old_string, for either path, before anything else; its approval refuses with it too. */
export const EDIT_EMPTY_OLD_STRING = 'Edit cannot create a file: old_string is empty. Use the Write tool to create a new file.';

/** `replace_all`'s refusals, which its approval gives too. */
export function replaceAllNotFound(path: string): string {
  return `String to replace not found in file: ${path}`;
}

export function replaceAllUnchanged(path: string): string {
  return `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`;
}

/** An Edit of a file's text. */
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
function exactEdit(raw: string, oldString: string, newString: string): ExactEdit | null {
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

/** The single replacement pi's edit makes: pi's own computation, its fuzzy matching, BOM and line-ending rules and refusals. */
function piEdit(pi: PiCodingAgentModule, raw: string, filePath: string, oldString: string, newString: string): ExactEdit {
  const { finalContent, baseContent, newContent, replacements } = pi.computeEditResult(raw, [{ oldText: oldString, newText: newString }], filePath);
  return { baseContent, newContent, replacements, written: finalContent };
}

/** `replace_all`'s edit: Damocles' own message where nothing is found, pi's edit's refusal where nothing changes. */
function replaceAllEdit(raw: string, path: string, oldString: string, newString: string): ExactEdit {
  const edit = exactEdit(raw, oldString, newString);
  if (!edit) throw new Error(replaceAllNotFound(path));
  if (edit.baseContent === edit.newContent) throw new Error(replaceAllUnchanged(path));
  return edit;
}

/** The edit `params` makes of `raw`, or the run's refusal thrown with its message; `path` is the path as the call wrote it. */
function computeEdit(pi: PiCodingAgentModule, raw: string, path: string, params: EditChange): ExactEdit {
  return params.replace_all ? replaceAllEdit(raw, path, params.old_string, params.new_string) : piEdit(pi, raw, path, params.old_string, params.new_string);
}

/** The patch an Edit records, on the tool lane: `replace_all`'s from `filePatch`, a single replacement's from its windows. */
export function editPatchOf(diff: Pick<DiffService, 'filePatch' | 'editPatch'>, path: string, edit: ExactEdit, replaceAll: boolean | undefined, options: { signal?: AbortSignal }): Promise<FilePatch> {
  return replaceAll ? diff.filePatch(path, edit.baseContent, edit.newContent, options) : diff.editPatch(path, edit.baseContent, edit.newContent, edit.replacements, options);
}

/** pi's edit's access check (`couldNotEdit`), naming the path as the call wrote it, when the file cannot be read and written. */
export function editAccessRefusal(absolutePath: string, path: string): Promise<string | undefined> {
  return editOperations.access(absolutePath).then(() => undefined, (error: unknown) => couldNotEdit(path, error));
}

/**
 * Every Edit: access check, read, match, patch and write in one mutation queue slot, with pi's edit's abort checks and messages,
 * reading and writing through the checked handles of `editOperations` (docs/invariants.md "Every Edit runs in Damocles").
 */
function runEdit(pi: PiCodingAgentModule, diff: Pick<DiffService, 'filePatch' | 'editPatch'>, cwd: string, params: EditParams, signal: AbortSignal | undefined): Promise<AgentToolResult<EditDetails>> {
  const path = params.file_path;
  const absolutePath = resolveToCwd(path, cwd);
  return onFileQueue(pi, absolutePath, async () => {
    // As pi's edit: no rejection from an abort listener, which would release the slot while a write may still land.
    const throwIfAborted = (): void => {
      if (signal?.aborted) throw new Error('Operation aborted');
    };
    throwIfAborted();
    const refusal = await editAccessRefusal(absolutePath, path);
    throwIfAborted();
    if (refusal !== undefined) throw new Error(refusal);
    const raw = (await editOperations.readFile(absolutePath)).toString('utf-8');
    throwIfAborted();
    const edit = computeEdit(pi, raw, path, params);
    const { baseContent, newContent, written } = edit;
    // Before the write, so a Stop while the patch is queued leaves the file unchanged.
    const patch = await editPatchOf(diff, path, edit, params.replace_all, signal ? { signal } : {}).catch((error: unknown) => {
      log('[edit] no diff recorded for %s: %O', absolutePath, error);
      return undefined;
    });
    const firstLine = firstChangedLine(baseContent, newContent);
    throwIfAborted();
    await editOperations.writeFile(absolutePath, written);
    throwIfAborted();
    return {
      content: [{ type: 'text', text: `Successfully replaced 1 block(s) in ${path}.` }],
      details: { ...(firstLine === undefined ? {} : { firstChangedLine: firstLine }), ...patch },
    };
  });
}

/** An Edit's change, and the first line it changes in the new text. */
export interface EditPreview extends ExactEdit {
  firstChangedLine: number | undefined;
}

/**
 * The Edit `params` makes of a file holding `original`, computed as the run computes it but without a diff: the text it would
 * write, or the run's message where it refuses the change (absent, found more than once, or changing nothing).
 */
export function previewEdit(pi: PiCodingAgentModule, path: string, original: string, params: EditChange): EditPreview | { refused: string } {
  let edit: ExactEdit;
  try {
    edit = computeEdit(pi, original, path, params);
  } catch (error) {
    // the refusal goes to the model unread
    return { refused: error instanceof Error ? error.message : String(error) };
  }
  return { ...edit, firstChangedLine: firstChangedLine(edit.baseContent, edit.newContent) };
}

/**
 * The `Edit` tool, replacing pi's `edit` with a Claude-Code-shaped schema; the gate and its diff approval run before `execute`.
 * Sequential, so pi runs any batch holding an Edit one call at a time, in the model's order ("Tool overrides").
 */
export function createEditTool(pi: PiCodingAgentModule, cwd: string, diff: Pick<DiffService, 'filePatch' | 'editPatch'>): ToolDefinition {
  return pi.defineTool<typeof editSchema, EditDetails>({
    name: TOOL_EDIT,
    label: 'Edit',
    description: 'Performs exact string replacement in a file. The old_string must uniquely identify the text to replace, unless replace_all is set. To create a new file, use the Write tool instead — Edit cannot create files.',
    parameters: editSchema,
    // `prefer` degrades to unconstrained sampling on providers without strict mode, where `require` throws.
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      // Write is the only text-file creation path.
      if (params.old_string === '') throw new Error(EDIT_EMPTY_OLD_STRING);
      const editCwd = ctx?.cwd || cwd;
      // Refused here in the path's own spelling; the operations refuse one swapped in after this stat from their handles. A stat error is the access check's to report.
      const entry = await stat(resolveToCwd(params.file_path, editCwd)).catch(() => undefined);
      if (entry !== undefined && !entry.isFile()) throw new Error(notARegularFile(params.file_path));
      return runEdit(pi, diff, editCwd, params, signal);
    },
  });
}
