import { diffLines } from 'diff';
import type { editor as MonacoEditor, Uri } from 'monaco-editor/editor/editor.api';
import type { EditorFormatOptions } from '../../preload/shell-channels';

export interface FormatRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

/** One Monaco edit operation of a format. */
export interface FormatEdit {
  readonly range: FormatRange;
  readonly text: string;
}

// The workers' formatting calls, as Monaco's own providers make them (typescript/languageFeatures.js FormatAdapter,
// common/lspLanguageFeatures.js DocumentFormattingEditProvider); the public typings omit the JSON worker's format.
interface TypeScriptFormatWorker {
  getFormattingEditsForRange(fileName: string, start: number, end: number, options: unknown): Promise<Array<{ span: { start: number; length: number }; newText: string }>>;
}
interface JsonFormatWorker {
  format(uri: string, range: null, options: EditorFormatOptions): Promise<Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>>;
}
type WorkerAccessor<T> = () => Promise<(...uris: Uri[]) => Promise<T>>;

export interface BuiltinWorkers {
  readonly typescript: WorkerAccessor<TypeScriptFormatWorker>;
  readonly javascript: WorkerAccessor<TypeScriptFormatWorker>;
  readonly json: WorkerAccessor<JsonFormatWorker>;
}

const lf = (text: string): string => text.replace(/\r\n?/g, '\n');
// Changed lines the diff looks for before it gives up and replaces the whole text, so a huge rewrite never blocks the page.
const MAX_DIFF_EDIT_LENGTH = 5000;

/**
 * The edits that turn oldText into newText, one per changed run of lines, so the caret and the view outside them stay.
 * Both are compared with '\n' line endings and the ranges are line and column positions, which hold in a CRLF model too;
 * Monaco writes inserted text with the model's own line ending.
 */
export function lineEdits(oldText: string, newText: string): FormatEdit[] {
  const before = lf(oldText);
  const starts = [0];
  for (let index = before.indexOf('\n'); index >= 0; index = before.indexOf('\n', index + 1)) starts.push(index + 1);
  const position = (offset: number): { lineNumber: number; column: number } => {
    let line = starts.length - 1;
    while (starts[line]! > offset) line--;
    return { lineNumber: line + 1, column: offset - starts[line]! + 1 };
  };
  const edits: FormatEdit[] = [];
  let offset = 0;
  let hunk: { start: number; end: number; text: string } | undefined;
  const close = (): void => {
    if (!hunk) return;
    const start = position(hunk.start);
    const end = position(hunk.end);
    edits.push({ range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: hunk.text });
    hunk = undefined;
  };
  const after = lf(newText);
  const parts = diffLines(before, after, { maxEditLength: MAX_DIFF_EDIT_LENGTH });
  if (!parts) {
    const end = position(before.length);
    return [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column }, text: after }];
  }
  for (const part of parts) {
    if (!part.added && !part.removed) {
      close();
      offset += part.value.length;
      continue;
    }
    hunk ??= { start: offset, end: offset, text: '' };
    if (part.removed) {
      offset += part.value.length;
      hunk.end = offset;
    } else {
      hunk.text += part.value;
    }
  }
  close();
  return edits;
}

// Monaco's FormatHelper._convertOptions: the TypeScript formatter's settings for the buffer's indentation.
function typescriptOptions({ tabSize, insertSpaces }: EditorFormatOptions): Record<string, unknown> {
  return {
    ConvertTabsToSpaces: insertSpaces,
    TabSize: tabSize,
    IndentSize: tabSize,
    IndentStyle: 2,
    NewLineCharacter: '\n',
    InsertSpaceAfterCommaDelimiter: true,
    InsertSpaceAfterSemicolonInForStatements: true,
    InsertSpaceBeforeAndAfterBinaryOperators: true,
    InsertSpaceAfterKeywordsInControlFlowStatements: true,
    InsertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
    InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
    InsertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
    InsertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
    PlaceOpenBraceOnNewLineForControlBlocks: false,
    PlaceOpenBraceOnNewLineForFunctions: false,
  };
}

/** Monaco's built-in Format Document for a TypeScript, JavaScript or JSON model: the TypeScript or JSON worker's edits. */
export async function builtinEdits(workers: BuiltinWorkers, model: MonacoEditor.ITextModel, options: EditorFormatOptions): Promise<FormatEdit[]> {
  const language = model.getLanguageId();
  if (language === 'json') {
    const worker = await (await workers.json())(model.uri);
    const edits = await worker.format(model.uri.toString(), null, options);
    return edits.map(({ range, newText }) => ({
      range: { startLineNumber: range.start.line + 1, startColumn: range.start.character + 1, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 },
      text: newText,
    }));
  }
  if (language !== 'typescript' && language !== 'javascript') throw new Error(`no built-in formatter for ${language}`);
  const worker = await (await workers[language]())(model.uri);
  const edits = await worker.getFormattingEditsForRange(model.uri.toString(), 0, model.getValueLength(), typescriptOptions(options));
  return edits.map(({ span, newText }) => {
    const start = model.getPositionAt(span.start);
    const end = model.getPositionAt(span.start + span.length);
    return { range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: newText };
  });
}
