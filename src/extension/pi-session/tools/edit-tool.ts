import { readFile } from 'fs/promises';
import { resolve as resolvePath } from 'path';
import { Type } from 'typebox';
import type { ToolDefinition, EditToolDetails, EditToolInput } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import { TOOL_EDIT } from '../../../shared/tool-names';

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
  // No `additionalProperties: false` (pi #6278): models occasionally add stray extra fields and strict
  // mode rejected the otherwise-valid edit. Mirror pi's upstream relaxation of its native edit schema.
  {},
);

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const toLF = (s: string): string => s.replace(/\r\n/g, '\n');

/**
 * Translate the CC Edit input into pi's `{ path, edits }` shape.
 *
 * pi's edit requires every `oldText` to be UNIQUE in the file (it throws on >1 occurrence), so it has
 * no native replace-all. For `replace_all`, we collapse the global replacement into a single whole-file
 * edit: `oldText` = the file's normalized (BOM-stripped, LF) content (trivially unique) and `newText` =
 * the same content with every occurrence replaced. pi still performs the atomic write, BOM/line-ending
 * preservation, and the minimal structured diff (it diffs base vs. new content, not the edit span).
 *
 * Matching asymmetry: the single-edit path hands `old_string` to pi's (fuzzy/whitespace-tolerant)
 * matcher, while `replace_all` matches exactly here (`String.includes`/`split`). The same `old_string`
 * can therefore succeed single but report "not found" with `replace_all` on files whose bytes differ
 * from the literal (smart quotes/dashes, CRLF). This is intentional — a global replace must be exact.
 */
async function buildPiEditInput(
  params: { file_path: string; old_string: string; new_string: string; replace_all?: boolean },
  cwd: string,
): Promise<EditToolInput> {
  // pi's edit rejects an empty `oldText`, and CC's empty-old_string "create file" idiom does not apply
  // here — Write is the sole creation path. Fail with an actionable message instead of leaking pi's
  // internal error.
  if (params.old_string === '') {
    throw new Error('Edit cannot create a file: old_string is empty. Use the Write tool to create a new file.');
  }
  if (!params.replace_all) {
    return { path: params.file_path, edits: [{ oldText: params.old_string, newText: params.new_string }] };
  }
  const content = toLF(stripBom((await readFile(resolvePath(cwd, params.file_path))).toString('utf-8')));
  const oldText = toLF(params.old_string);
  if (!content.includes(oldText)) {
    throw new Error(`String to replace not found in file: ${params.file_path}`);
  }
  return { path: params.file_path, edits: [{ oldText: content, newText: content.split(oldText).join(toLF(params.new_string)) }] };
}

/**
 * Build the custom `Edit` tool. The actual file mutation is delegated to pi's robust
 * `createEditToolDefinition(cwd).execute(...)` — we only translate the CC input to pi's shape and
 * reuse pi's `details.diff/patch` (FR-4: no bespoke file-editing logic). The central gate
 * (`canUseTool` → diff approval) runs before `execute`, so this just performs the approved write.
 */
export function createEditTool(pi: PiCodingAgentModule, cwd: string): ToolDefinition {
  const piEdit = pi.createEditToolDefinition(cwd);
  return pi.defineTool<typeof editSchema, EditToolDetails | undefined>({
    name: TOOL_EDIT,
    label: 'Edit',
    description: 'Performs exact string replacement in a file. The old_string must uniquely identify the text to replace, unless replace_all is set. To create a new file, use the Write tool instead — Edit cannot create files.',
    parameters: editSchema,
    execute: async (toolCallId, params, signal, onUpdate, ctx) =>
      piEdit.execute(toolCallId, await buildPiEditInput(params, cwd), signal, onUpdate, ctx),
  });
}
