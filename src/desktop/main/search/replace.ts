import { createHash } from 'node:crypto';
import { matchingPattern, replacementAt, replaceRegExp, type SearchPattern, type SearchRange } from '../../../shared/text-search';
import type { SearchReplaceResult, SearchReplaceSkip, SearchSkipReason } from '../../preload/shell-channels';
import type { ClosedFileRead, ClosedFileWrite } from '../documents/document-service';
import type { RecordedMatch, RecordedSearch } from './search-service';
import { runWithin } from './time-bound';

// Wall-clock bound on the JavaScript regex over one file's matches: a backtracking pattern ripgrep ran in linear time can
// take exponential time here, and it would block main.
export const REPLACE_REGEX_TIMEOUT_MS = 2000;
// Skipped files a replace notice names; the rest are counted.
const MAX_NOTICE_FILES = 10;

// Characters of a match's text a search keeps whole; a longer one is kept as its length and SHA-256.
export const MAX_KEPT_MATCH_CHARS = 1024;

// What a search keeps of a match's text to verify a replace against.
export type KeptText = string | { readonly length: number; readonly sha256: string };

/**
 * A match's text as a search keeps it. A short one is copied out of the line it was cut from, because a V8 substring keeps
 * its whole parent alive and ripgrep's --json prints each matching line whole.
 */
export function keepMatchText(text: string): KeptText {
  return text.length <= MAX_KEPT_MATCH_CHARS ? structuredClone(text) : { length: text.length, sha256: sha256(text) };
}

/** Whether text is the text a search kept. */
export function isKeptText(kept: KeptText, text: string): boolean {
  return typeof kept === 'string' ? kept === text : kept.length === text.length && kept.sha256 === sha256(text);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Offsets where each 1-based line of text starts; ripgrep and Monaco both break lines at '\n'. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts;
}

// The UTF-16 offset of a 1-based line and column, or undefined when the line is shorter or missing.
function offsetOf(text: string, starts: readonly number[], line: number, column: number): number | undefined {
  const lineStart = starts[line - 1];
  if (lineStart === undefined) return undefined;
  const next = starts[line];
  const lineEnd = next === undefined ? text.length : next - 1;
  const offset = lineStart + column - 1;
  return column >= 1 && offset <= lineEnd ? offset : undefined;
}

// The lines a range spans, without the last line's break, which is what ripgrep's --crlf matched against.
function contextOf(text: string, starts: readonly number[], range: SearchRange): { readonly from: number; readonly text: string } {
  const from = starts[range.startLine - 1]!;
  const next = starts[range.endLine];
  let to = next === undefined ? text.length : next - 1;
  if (to > from && text[to - 1] === '\r') to--;
  return { from, text: text.slice(from, Math.max(to, from)) };
}

export type PlanResult = { readonly ok: true; readonly edits: Edit[] } | { readonly ok: false; readonly reason: 'changed' | 'unsupportedRegex' };

/**
 * The edits that replace each match in text. A match whose recorded text is not at its range any more makes the file
 * changed; one the JavaScript regex, run sticky at the match start inside its lines, does not reproduce exactly makes it
 * unsupportedRegex. A '\n' the replacement brings takes the file's line ending. `pattern` is the query as typed (its isRegex
 * decides whether $1 expands); `regExp` is replaceRegExp of its matchingPattern.
 */
export function planReplacements(
  text: string,
  matches: ReadonlyArray<Pick<RecordedMatch, 'range'> & { readonly text?: KeptText }>,
  pattern: SearchPattern,
  regExp: RegExp,
  replacement: string,
  preserveCase: boolean,
  eol: '\n' | '\r\n',
): PlanResult {
  const starts = lineStarts(text);
  const edits: Edit[] = [];
  for (const match of matches) {
    const start = offsetOf(text, starts, match.range.startLine, match.range.startColumn);
    const end = offsetOf(text, starts, match.range.endLine, match.range.endColumn);
    if (start === undefined || end === undefined || end < start) return { ok: false, reason: 'changed' };
    if (match.text !== undefined && !isKeptText(match.text, text.slice(start, end))) return { ok: false, reason: 'changed' };
    const context = contextOf(text, starts, match.range);
    const replaced = replacementAt(regExp, pattern.isRegex, context.text, start - context.from, end - context.from, replacement, preserveCase);
    if (replaced === null) return { ok: false, reason: 'unsupportedRegex' };
    edits.push({ start, end, text: replaced.replace(/\r?\n/g, eol) });
  }
  edits.sort((a, b) => a.start - b.start);
  // Two edits at one place (overlapping, or the same empty match twice) would write the replacement more than once.
  for (let index = 1; index < edits.length; index++) {
    const previous = edits[index - 1]!;
    if (edits[index]!.start < previous.end || edits[index]!.start === previous.start) return { ok: false, reason: 'changed' };
  }
  return { ok: true, edits };
}

export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}

/** planReplacements under a time bound; a regex that takes longer leaves the file timedOut. */
export function planWithin(timeoutMs: number, plan: () => PlanResult): PlanResult | { readonly ok: false; readonly reason: 'timedOut' } {
  const run = runWithin(timeoutMs, plan);
  return run.ok ? run.value : { ok: false, reason: 'timedOut' };
}

export interface ReplaceDeps {
  readonly read: (projectKey: string, relativePath: string) => Promise<ClosedFileRead>;
  readonly write: (read: Extract<ClosedFileRead, { kind: 'text' }>, text: string) => Promise<ClosedFileWrite>;
  // one notice naming the skipped files
  readonly notifySkipped: (lines: readonly string[], more: number) => void;
  readonly reasonLabel: (skip: SearchReplaceSkip) => string;
  readonly timeoutMs?: number;
}

export interface ReplaceRequest {
  readonly replacement: string;
  readonly preserveCase: boolean;
  readonly matchIds: readonly number[];
}

// replaced: the ids of the matches written, which leave the results
export type Replacer = (search: RecordedSearch, request: ReplaceRequest) => Promise<SearchReplaceResult & { readonly replaced: readonly number[] }>;

/**
 * One window's replace, one request at a time: a request reads its files only after the previous one wrote, so two replaces
 * in one file never both pass the write's disk check with the same bytes and lose one of them.
 */
export function createReplacer(deps: ReplaceDeps): Replacer {
  let tail: Promise<unknown> = Promise.resolve();
  return (search, request) => {
    const run = tail.then(() => replaceInFiles(deps, search, request));
    // The caller sees a failure through run; the chain only waits for it to settle.
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Replace in closed files: every file is re-read through the document service, and written only when each of its
 * matches is still at its range with its recorded text. A file that changed, is read-only, has an editor buffer or changed
 * again before the write is skipped whole and named in one notice. An open buffer's match is the shell's to replace and an
 * untitled buffer has no file, so their ids are refused.
 */
async function replaceInFiles(deps: ReplaceDeps, search: RecordedSearch, request: ReplaceRequest): Promise<SearchReplaceResult & { readonly replaced: readonly number[] }> {
  const byFile = new Map<string, Array<RecordedMatch & { readonly id: number }>>();
  for (const id of request.matchIds) {
    const match = search.matches.get(id);
    if (!match) throw new Error('Unknown match id');
    if (match.file.kind !== 'file' || match.documentId !== undefined) throw new Error('An open buffer\'s match is replaced in its buffer');
    const list = byFile.get(match.file.relativePath) ?? [];
    list.push({ ...match, id });
    byFile.set(match.file.relativePath, list);
  }
  const regExp = replaceRegExp(matchingPattern(search.query));
  const skipped: SearchReplaceSkip[] = [];
  const replaced: number[] = [];
  let replacedFiles = 0;
  let replacedCount = 0;
  // A regex that ran out of time on one file would cost the bound again on every other file.
  let timedOut = false;
  for (const [relativePath, matches] of byFile) {
    const skip = !regExp ? 'unsupportedRegex' : timedOut ? 'timedOut' : await replaceFile(deps, search, relativePath, matches, regExp, request);
    if (skip === 'timedOut') timedOut = true;
    if (skip === undefined) {
      replacedFiles++;
      replacedCount += matches.length;
      replaced.push(...matches.map((match) => match.id));
    } else {
      skipped.push(typeof skip === 'string' ? { relativePath, reason: skip } : { relativePath, ...skip });
    }
  }
  if (skipped.length > 0) {
    const lines = skipped.slice(0, MAX_NOTICE_FILES).map((skip) => `${skip.relativePath}: ${deps.reasonLabel(skip)}`);
    deps.notifySkipped(lines, skipped.length - lines.length);
  }
  return { replacedFiles, replacedCount, skipped, replaced };
}

async function replaceFile(
  deps: ReplaceDeps,
  search: RecordedSearch,
  relativePath: string,
  matches: readonly RecordedMatch[],
  regExp: RegExp,
  request: ReplaceRequest,
): Promise<SearchSkipReason | { readonly reason: 'failed'; readonly message: string } | undefined> {
  const read = await deps.read(search.folder.projectKey, relativePath);
  if (read.kind !== 'text') return read.kind === 'readOnly' ? 'readOnly' : 'changed';
  const plan = planWithin(deps.timeoutMs ?? REPLACE_REGEX_TIMEOUT_MS, () => planReplacements(read.text, matches, search.query, regExp, request.replacement, request.preserveCase, read.eol));
  if (!plan.ok) return plan.reason;
  const written = await deps.write(read, applyEdits(read.text, plan.edits));
  if (written.ok) return undefined;
  return written.reason === 'failed' ? { reason: 'failed', message: written.message ?? '' } : written.reason;
}
