import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import picomatch from 'picomatch';
import { isRelativeFilePath } from '../../../shared/relative-path';
import {
  compareSearchFiles,
  isMultilineRegexSource,
  matchingPattern,
  searchPreview,
  searchRegExp,
  withSmartCase,
  type SearchFileKey,
  type SearchFileResult,
  type SearchMatch,
  type SearchQuery,
  type SearchRange,
  type SearchSortOrder,
} from '../../../shared/text-search';
import { MAX_EDITOR_TEXT_CHARS, type SearchBufferWarning, type SearchCopyTarget, type SearchDone, type SearchFileUpdate, type SearchResultsBatch, type SearchStartResult } from '../../preload/shell-channels';
import { keepMatchText, lineStarts, type KeptText } from './replace';
import { parseGlobList, rgSearchArgs } from './rg-args';
import { editorMatches, SEARCH_EDITOR_CHARS_PER_LINE, type EditorFileResult, type EditorMatch } from './search-editor-format';
import { runWithin } from './time-bound';

// A finished file waits at most this long, or until this many matches wait, before its batch goes to the shell.
export const SEARCH_BATCH_MS = 50;
export const SEARCH_BATCH_MATCHES = 1000;
// Wall-clock bound on matching the open documents' paths against one glob list: picomatch compiles a glob to a backtracking
// RegExp, and a glob such as *a*a*a*a*a*a*a*a*b takes minutes on a long path.
export const GLOB_TIMEOUT_MS = 250;
// Wall-clock bound on the user's JavaScript regex over every open buffer of one run, and again over one live re-search.
export const BUFFER_SEARCH_TIMEOUT_MS = 1000;
// VS Code's FileMatch re-finds an open model's matches this long after its last change (RunOnceScheduler).
export const LIVE_UPDATE_MS = 250;
// Characters of ripgrep's stderr kept for the error and the log.
const MAX_STDERR_CHARS = 4096;
// Bytes of one ripgrep JSON event main reads; a longer one is dropped unread. --json prints each matching line whole, and a
// multi-line match's lines can be a whole file, which main would hold several times over while it decodes them.
export const MAX_RG_EVENT_BYTES: number = 32 * 1024 * 1024;

export interface RgProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(): void;
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

// The shown folder of the window's selected project: ripgrep's working directory and only path.
export interface SearchFolder {
  readonly projectKey: string;
  readonly fsPath: string;
}

// An open text document Search may read: a file of the searched project, or an untitled buffer. The caller scopes them.
export interface BufferDocument {
  readonly documentId: string;
  readonly target: { readonly kind: 'file'; readonly relativePath: string } | { readonly kind: 'untitled'; readonly title: string };
  readonly text: string;
  // the file's modification time on disk, for the modified sort order
  readonly mtimeMs?: number;
}

export interface SearchSettings {
  readonly smartCase: boolean;
  readonly maxResults: number;
  readonly debounceMs: number;
  readonly sortOrder: SearchSortOrder;
}

export interface SearchServiceDeps {
  readonly folder: () => SearchFolder | undefined;
  readonly rgPath: () => Promise<string>;
  // getRipgrepSearchOptions: the search.use*IgnoreFiles switches
  readonly ignoreArgs: () => readonly string[];
  // the true entries of damocles.desktop.files.exclude and damocles.desktop.search.exclude
  readonly excludeSettings: () => readonly string[];
  readonly settings: () => SearchSettings;
  // the open documents of projectKey and the untitled ones, never a diff side, a settings file or a Search Editor
  readonly buffers: (projectKey: string) => readonly BufferDocument[];
  readonly sendResults: (batch: SearchResultsBatch) => void;
  readonly sendFileUpdate: (update: SearchFileUpdate) => void;
  readonly sendDone: (done: SearchDone) => void;
  readonly log: (line: string) => void;
  readonly spawnRg?: (rgPath: string, args: readonly string[], cwd: string) => RgProcess;
  // the modification time of a result file, undefined when it cannot be read
  readonly mtime?: (fsPath: string) => Promise<number | undefined>;
}

// A match main keeps for replace, dismiss and copy: its file, its text at its range as keepMatchText keeps it, and the
// buffer it came from.
export interface RecordedMatch {
  readonly file: SearchFileKey;
  readonly range: SearchRange;
  readonly text: KeptText;
  // the first line's preview, for Copy
  readonly line: string;
  readonly documentId?: string;
}

export interface RecordedSearch {
  readonly searchId: number;
  // as the user typed it, with smart case applied
  readonly query: SearchQuery;
  readonly folder: SearchFolder;
  readonly matches: ReadonlyMap<number, RecordedMatch>;
}

// What a Search Editor's run hands back: its files in sort order, for VS Code's serialization.
export interface EditorRunResult {
  readonly files: readonly EditorFileResult[];
  readonly limitHit: boolean;
  readonly error?: string;
  readonly bufferWarning?: SearchBufferWarning;
}

// A Search Editor searches its own project's folder; the view searches the selected project's.
export type SearchOwner =
  | { readonly kind: 'view'; readonly searchId: number; readonly immediate: boolean }
  | { readonly kind: 'editor'; readonly documentId: string; readonly folder: SearchFolder | undefined; readonly contextLines: number };

// One file of a run's results now: its key, label, current matches and where they came from.
interface RunFile {
  readonly key: SearchFileKey;
  matches: SearchMatch[];
  editor?: { matches: EditorMatch[]; context: Map<number, string> };
  documentId?: string;
  mtimeMs?: number;
  title?: string;
}

interface Run extends RecordedSearch {
  readonly owner: SearchOwner;
  readonly matches: Map<number, RecordedMatch>;
  readonly settings: SearchSettings;
  // matchingPattern of the query, as rg and the buffers match it
  readonly pattern: SearchQuery;
  readonly regExp: RegExp | undefined;
  readonly files: Map<string, RunFile>;
  // the open documents the run searched in their buffers, by file key; ripgrep's result for them is dropped
  readonly buffered: Set<string>;
  // VS Code's removed matches (path>range+text) and dismissed files, out until the next search
  readonly removed: Set<string>;
  readonly dismissedFiles: Set<string>;
  readonly liveTimers: Map<string, ReturnType<typeof setTimeout>>;
  debounce: ReturnType<typeof setTimeout> | undefined;
  process: RgProcess | undefined;
  // a newer search, Clear, a project switch or the window closing discarded it
  discarded: boolean;
  // ripgrep finished or was stopped; live updates go on for a view run
  done: boolean;
  file: RunFile | undefined;
  pending: Array<Promise<SearchFileResult>>;
  pendingMatches: number;
  batchTimer: ReturnType<typeof setTimeout> | undefined;
  sending: Promise<void>;
  nextId: number;
  resultCount: number;
  limitHit: boolean;
  stderr: string;
  // ripgrep events past MAX_RG_EVENT_BYTES, dropped unread
  dropped: number;
  // the buffers' regex ran out of its time once; no buffer is searched for this run again
  bufferWarning: SearchBufferWarning | undefined;
  // characters of preview and context lines a Search Editor run holds; past MAX_EDITOR_TEXT_CHARS it stops as at the limit
  editorChars: number;
  onEditorDone?: (result: EditorRunResult) => void;
}

type RgText = { readonly text: string } | { readonly bytes: string };

function spawnRipgrep(rgPath: string, args: readonly string[], cwd: string): RgProcess {
  return spawn(rgPath, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A result file's modification time, or undefined when it cannot be read for any reason. */
export async function lstatMtime(fsPath: string): Promise<number | undefined> {
  try {
    return (await fs.lstat(fsPath)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Calls onLine with each line of stream, and onDropped instead for a line longer than maxBytes, which is never held whole. */
function readLines(stream: Readable, maxBytes: number, onLine: (line: string) => void, onDropped: () => void): void {
  let chunks: Buffer[] = [];
  let size = 0;
  let dropping = false;
  const take = (piece: Buffer): void => {
    if (dropping || piece.length === 0) return;
    if (size + piece.length > maxBytes) {
      dropping = true;
      chunks = [];
      size = 0;
      return;
    }
    chunks.push(piece);
    size += piece.length;
  };
  const endLine = (): void => {
    if (dropping) onDropped();
    else if (size > 0) onLine(Buffer.concat(chunks, size).toString('utf8'));
    chunks = [];
    size = 0;
    dropping = false;
  };
  stream.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      take(chunk.subarray(start, index));
      endLine();
      start = index + 1;
    }
    take(chunk.subarray(start));
  });
  stream.on('end', endLine);
}

function textOf(value: RgText): Buffer {
  return 'text' in value ? Buffer.from(value.text, 'utf8') : Buffer.from(value.bytes, 'base64');
}

export function fileKeyId(key: SearchFileKey): string {
  return key.kind === 'file' ? `f:${key.relativePath}` : `u:${key.documentId}`;
}

// VS Code's match id: the resource, the range and the matched text, here as the search keeps it.
function removedId(key: SearchFileKey, range: SearchRange, text: KeptText): string {
  const kept = typeof text === 'string' ? `=${text}` : `#${text.length}:${text.sha256}`;
  return `${fileKeyId(key)}>${range.startLine},${range.startColumn},${range.endLine},${range.endColumn}>${kept}`;
}

/** ripgrep's path below its working directory as a '/'-separated relative path, or undefined for one outside it. */
export function relativeResultPath(printed: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const slashed = platform === 'win32' ? printed.replace(/\\/g, '/') : printed;
  const relative = slashed.replace(/^(\.\/)+/, '');
  return isRelativeFilePath(relative) ? relative : undefined;
}

/** The user-facing part of ripgrep's stderr, as VS Code shows it: a regex or glob error; other messages are only logged. */
export function rgErrorForDisplay(stderr: string): string | undefined {
  const lines = stderr.trim().split(/\r?\n/);
  if (lines.some((line) => line.startsWith('regex parse error'))) return lines.join('\n').trim();
  const first = lines[0]?.trim() ?? '';
  return /^(error parsing glob|the literal|PCRE2:|unsupported encoding)/i.test(first) ? first : undefined;
}

// A V8 substring keeps its whole parent string alive, and ripgrep's --json prints each matching line whole (--max-columns has
// no effect there), so text a run keeps is copied out of the line it was cut from.
function detached(text: string): string {
  return structuredClone(text);
}

/** A context line as the Search Editor shows it: without its line break, cut like a preview line. */
function contextLine(text: string): string {
  return text.replace(/\r?\n$/, '').replace(/\r$/, '').slice(0, SEARCH_EDITOR_CHARS_PER_LINE);
}

// A buffer's matches of a whole-text global regex, as Monaco's findMatches gives them: per line unless the pattern can span
// lines, an empty match advancing one code point. At most `max` matches; each one's text is the buffer's, line endings included.
export function findBufferMatches(text: string, pattern: Pick<SearchQuery, 'pattern' | 'isRegex'>, global: RegExp, max: number): Array<{ range: SearchRange; text: string }> {
  const found: Array<{ range: SearchRange; text: string }> = [];
  const multiline = pattern.isRegex && isMultilineRegexSource(pattern.pattern);
  // VS Code's TextModelSearch (src/vs/editor/common/model/textModelSearch.ts) runs a multi-line regex over the lines joined
  // with '\n', where `^` and `$` never match inside a '\r\n'; line and column are the same in both texts.
  const searched = multiline ? text.replace(/\r\n/g, '\n') : text;
  const starts = lineStarts(searched);
  const textStarts = multiline ? lineStarts(text) : starts;
  const positionAt = (offset: number): { line: number; column: number } => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - starts[low]! + 1 };
  };
  const textOffset = ({ line, column }: { line: number; column: number }): number => textStarts[line - 1]! + column - 1;
  const scan = (from: number, to: number): void => {
    const slice = searched.slice(from, to);
    global.lastIndex = 0;
    for (let match = global.exec(slice); match && found.length < max; match = global.exec(slice)) {
      if (match[0].length === 0) global.lastIndex += (slice.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1;
      const start = positionAt(from + match.index);
      const end = positionAt(from + match.index + match[0].length);
      found.push({ range: { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column }, text: text.slice(textOffset(start), textOffset(end)) });
    }
  };
  if (multiline) {
    scan(0, searched.length);
    return found;
  }
  for (let line = 0; line < starts.length && found.length < max; line++) {
    const next = starts[line + 1];
    let end = next === undefined ? text.length : next - 1;
    if (end > starts[line]! && text[end - 1] === '\r') end--;
    scan(starts[line]!, end);
  }
  return found;
}

// The query's regex for whole buffers: searchRegExp without the sticky flag, global.
function globalRegExp(pattern: SearchQuery): RegExp | undefined {
  try {
    const sticky = searchRegExp(pattern);
    return new RegExp(sticky.source, `${sticky.flags.replace('y', '')}g`);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

// picomatch over relative paths; ripgrep's anchored globs carry a leading '/'.
function globMatcher(globs: readonly string[]): (relativePath: string) => boolean {
  if (globs.length === 0) return () => false;
  return picomatch(globs.map((glob) => glob.replace(/^\//, '')), { dot: true });
}

// The exclude settings' entries name folders as ripgrep reads them; picomatch needs the `/**` form for their files.
function withContents(globs: readonly string[]): string[] {
  return globs.flatMap((glob) => (glob.endsWith('/**') ? [glob] : [glob, `${glob}/**`]));
}

/**
 * One window's content searches: one run per owner (the Search view, each Search Editor) over the selected project's shown
 * folder. ripgrep searches the disk; the open documents are searched in main's buffers, whose results replace ripgrep's for
 * their files, as VS Code's open-editor results do. The view's matches stream to the shell in batches and stay in main for
 * replace, dismiss, copy and live updates until the next search or Clear.
 */
export class SearchService {
  private readonly deps: SearchServiceDeps;
  private readonly runs = new Map<string, Run>();

  constructor(deps: SearchServiceDeps) {
    this.deps = deps;
  }

  /** The Search view's search; a newer one replaces it. */
  start(searchId: number, query: SearchQuery, immediate: boolean): SearchStartResult {
    const prepared = this.prepare({ kind: 'view', searchId, immediate }, query);
    if (!prepared.ok) return prepared;
    return { ok: true };
  }

  /** A Search Editor's search, reported once through onDone with its files in sort order. */
  startEditor(documentId: string, folder: SearchFolder | undefined, query: SearchQuery, contextLines: number, onDone: (result: EditorRunResult) => void): SearchStartResult {
    const prepared = this.prepare({ kind: 'editor', documentId, folder, contextLines }, query);
    if (prepared.ok) prepared.run.onEditorDone = onDone;
    return prepared.ok ? { ok: true } : prepared;
  }

  /** Cancel Search: the view's ripgrep stops, its done says cancelled, the results sent so far stay. */
  cancel(): void {
    const run = this.runs.get('view');
    if (run && !run.done) this.finish(run, undefined, true);
  }

  /** Kills the view's search and forgets its matches. */
  clear(): void {
    this.discard('view');
  }

  /** A closed Search Editor's or a project switch's end of its run. */
  discardEditor(documentId: string): void {
    this.discard(`editor:${documentId}`);
  }

  /** Every run, for a project switch. */
  clearAll(): void {
    for (const owner of [...this.runs.keys()]) this.discard(owner);
  }

  /** The view's matches of searchId while it is the view's search. */
  recorded(searchId: number): RecordedSearch | undefined {
    const run = this.runs.get('view');
    return run?.owner.kind === 'view' && run.owner.searchId === searchId ? run : undefined;
  }

  /** The view's search, for Open Results in Editor: its files now in sort order. */
  viewResults(searchId: number): { readonly query: SearchQuery; readonly files: readonly EditorFileResult[]; readonly limitHit: boolean } | undefined {
    const run = this.runs.get('view');
    if (run?.owner.kind !== 'view' || run.owner.searchId !== searchId) return undefined;
    const files = this.sortedFiles(run).map((file) => this.editorFileOf(run, file));
    return { query: run.query, files, limitHit: run.limitHit };
  }

  /** The view's search, for Open Results in Editor from the palette. */
  viewSearchId(): number | undefined {
    const run = this.runs.get('view');
    return run?.owner.kind === 'view' ? run.owner.searchId : undefined;
  }

  /** Whether the view has a search, and whether its ripgrep still runs (the Cancel Search and result commands' enablement). */
  viewState(): { readonly hasSearch: boolean; readonly hasResults: boolean; readonly running: boolean } {
    const run = this.runs.get('view');
    return { hasSearch: run !== undefined, hasResults: run !== undefined && filesWithMatches(run).length > 0, running: run !== undefined && !run.done };
  }

  /** Dismiss: the matches and files leave the view's results until the next search, and the shell gets each file as it is now. */
  dismiss(searchId: number, matchIds: readonly number[], files: readonly SearchFileKey[]): void {
    const run = this.recorded(searchId) as Run | undefined;
    if (!run) throw new Error('Unknown or superseded search');
    const touched = new Set<string>();
    for (const id of matchIds) {
      const match = run.matches.get(id);
      if (!match) throw new Error('Unknown match id');
      touched.add(this.removeMatch(run, id, match));
    }
    for (const key of files) {
      const id = fileKeyId(key);
      const file = run.files.get(id);
      if (!file) throw new Error('Unknown result file');
      for (const match of file.matches) run.matches.delete(match.id);
      file.matches = [];
      run.dismissedFiles.add(id);
      touched.add(id);
    }
    for (const id of touched) this.pushFile(run, id);
  }

  /**
   * VS Code's Copy and Copy All text (searchActionsCopy.ts): a match is `line,column: text`, a file its path then its matches
   * indented by two, files apart by a blank line. `pathOf` gives a file's absolute path; the text is each match's preview line.
   */
  copyText(searchId: number, target: SearchCopyTarget, pathOf: (key: SearchFileKey, title: string | undefined) => string, lineDelimiter: string): string {
    const run = this.recorded(searchId) as Run | undefined;
    if (!run) throw new Error('Unknown or superseded search');
    const matchText = (id: number, indent: number): string => {
      const match = run.matches.get(id);
      if (!match) throw new Error('Unknown match id');
      return `${' '.repeat(indent)}${match.range.startLine},${match.range.startColumn}: ${match.line}`;
    };
    const fileText = (file: RunFile): string => {
      const rows = [...file.matches].sort((a, b) => compareRanges(a.range, b.range)).map((match) => matchText(match.id, 2));
      return `${pathOf(file.key, file.title)}${lineDelimiter}${rows.join(lineDelimiter)}`;
    };
    if (target.kind === 'matches') return target.matchIds.map((id) => matchText(id, 0)).join(lineDelimiter);
    const files = target.kind === 'all'
      ? filesWithMatches(run).sort((a, b) => compareSearchFiles(this.resultOf(a), this.resultOf(b), 'default'))
      : target.files.map((key) => {
        const file = run.files.get(fileKeyId(key));
        if (!file) throw new Error('Unknown result file');
        return file;
      });
    return files.filter((file) => file.matches.length > 0).map(fileText).join(lineDelimiter + lineDelimiter);
  }

  /** A replace wrote these matches: they leave the results as VS Code's do. */
  replaced(searchId: number, matchIds: readonly number[]): void {
    const run = this.recorded(searchId) as Run | undefined;
    if (!run) return;
    const touched = new Set<string>();
    for (const id of matchIds) {
      const match = run.matches.get(id);
      if (match) touched.add(this.removeMatch(run, id, match));
    }
    for (const id of touched) this.pushFile(run, id);
  }

  /** An open document's text changed: a view result file it holds is searched again after LIVE_UPDATE_MS. */
  documentChanged(documentId: string): void {
    const run = this.runs.get('view');
    if (!run || run.bufferWarning !== undefined || !run.regExp) return;
    const buffer = this.deps.buffers(run.folder.projectKey).find((candidate) => candidate.documentId === documentId);
    if (!buffer) return;
    const id = fileKeyId(this.keyOf(buffer));
    if (!run.files.has(id) || run.dismissedFiles.has(id)) return;
    clearTimeout(run.liveTimers.get(id));
    run.liveTimers.set(id, setTimeout(() => {
      run.liveTimers.delete(id);
      if (!run.discarded) this.researchBuffer(run, documentId);
    }, LIVE_UPDATE_MS));
  }

  dispose(): void {
    this.clearAll();
  }

  private ownerId(owner: SearchOwner): string {
    return owner.kind === 'view' ? 'view' : `editor:${owner.documentId}`;
  }

  private discard(ownerId: string): void {
    const run = this.runs.get(ownerId);
    this.runs.delete(ownerId);
    if (!run) return;
    run.discarded = true;
    run.done = true;
    clearTimeout(run.debounce);
    clearTimeout(run.batchTimer);
    for (const timer of run.liveTimers.values()) clearTimeout(timer);
    run.process?.kill();
  }

  private prepare(owner: SearchOwner, raw: SearchQuery): { ok: true; run: Run } | Exclude<SearchStartResult, { ok: true }> {
    const ownerId = this.ownerId(owner);
    const previous = this.runs.get(ownerId);
    if (owner.kind === 'view' && previous?.owner.kind === 'view' && owner.searchId <= previous.owner.searchId) throw new Error('Stale search id');
    this.discard(ownerId);
    const folder = owner.kind === 'view' ? this.deps.folder() : owner.folder;
    if (!folder) return { ok: false, error: 'noProject' };
    const include = parseGlobList(raw.include);
    if (!include.ok) return { ok: false, error: 'invalidGlob', glob: include.glob };
    const exclude = parseGlobList(raw.exclude);
    if (!exclude.ok) return { ok: false, error: 'invalidGlob', glob: exclude.glob };
    const settings = this.deps.settings();
    const query = withSmartCase(raw, settings.smartCase);
    const pattern = matchingPattern(query);
    const excludeSettings = query.useExcludeSettingsAndIgnoreFiles ? this.deps.excludeSettings() : [];
    const admitted = runWithin(GLOB_TIMEOUT_MS, () => {
      const included = globMatcher(include.globs);
      const excluded = globMatcher(withContents([...exclude.globs, ...excludeSettings]));
      return this.deps.buffers(folder.projectKey).filter((buffer) => {
        const label = buffer.target.kind === 'file' ? buffer.target.relativePath : buffer.target.title;
        return (include.globs.length === 0 || included(label)) && !excluded(label);
      });
    });
    if (!admitted.ok) return { ok: false, error: 'invalidGlob', glob: raw.include || raw.exclude };
    const run: Run = {
      searchId: owner.kind === 'view' ? owner.searchId : 0,
      owner,
      query,
      pattern,
      regExp: globalRegExp(pattern),
      folder,
      settings,
      matches: new Map(),
      files: new Map(),
      buffered: new Set(admitted.value.map((buffer) => fileKeyId(this.keyOf(buffer)))),
      removed: new Set(),
      dismissedFiles: new Set(),
      liveTimers: new Map(),
      debounce: undefined,
      process: undefined,
      discarded: false,
      done: false,
      file: undefined,
      pending: [],
      pendingMatches: 0,
      batchTimer: undefined,
      sending: Promise.resolve(),
      nextId: 0,
      resultCount: 0,
      limitHit: false,
      stderr: '',
      dropped: 0,
      bufferWarning: undefined,
      editorChars: 0,
    };
    this.runs.set(ownerId, run);
    const args = query.onlyOpenEditors
      ? undefined
      : rgSearchArgs({
        query: pattern,
        include: include.globs,
        exclude: exclude.globs,
        excludeSettings,
        ignoreArgs: this.deps.ignoreArgs(),
        contextLines: owner.kind === 'editor' ? owner.contextLines : 0,
      });
    const begin = (): void => {
      run.debounce = undefined;
      this.searchBuffers(run, admitted.value);
      if (run.done) return;
      if (!args) {
        this.finish(run, undefined, false);
        return;
      }
      this.execute(run, args).catch((err: unknown) => this.finish(run, err instanceof Error ? err.message : String(err), false));
    };
    if (owner.kind === 'editor' || owner.immediate) begin();
    else run.debounce = setTimeout(begin, settings.debounceMs);
    return { ok: true, run };
  }

  private keyOf(buffer: BufferDocument): SearchFileKey {
    return buffer.target.kind === 'file' ? { kind: 'file', relativePath: buffer.target.relativePath } : { kind: 'untitled', documentId: buffer.documentId };
  }

  // Every admitted buffer under one time bound; a regex JavaScript cannot compile or that runs out of time searches none.
  private searchBuffers(run: Run, buffers: readonly BufferDocument[]): void {
    if (buffers.length === 0) return;
    const regExp = run.regExp;
    if (!regExp) {
      run.bufferWarning = 'unsupportedRegex';
      return;
    }
    const found = runWithin(BUFFER_SEARCH_TIMEOUT_MS, () => buffers.map((buffer) => ({ buffer, matches: findBufferMatches(buffer.text, run.pattern, regExp, run.settings.maxResults) })));
    if (!found.ok) {
      run.bufferWarning = 'timedOut';
      return;
    }
    for (const { buffer, matches } of found.value) {
      if (run.done) return;
      if (matches.length === 0) continue;
      this.addBufferFile(run, buffer, matches);
    }
  }

  private addBufferFile(run: Run, buffer: BufferDocument, found: ReadonlyArray<{ range: SearchRange; text: string }>): void {
    const key = this.keyOf(buffer);
    const file: RunFile = {
      key,
      matches: [],
      documentId: buffer.documentId,
      ...(buffer.target.kind === 'untitled' ? { title: buffer.target.title } : {}),
      ...(buffer.mtimeMs !== undefined && run.settings.sortOrder === 'modified' ? { mtimeMs: buffer.mtimeMs } : {}),
      ...(run.owner.kind === 'editor' ? { editor: { matches: [], context: new Map() } } : {}),
    };
    run.file = file;
    const lines = buffer.text.split('\n');
    for (const match of withLines(lines, found)) {
      if (run.done) return;
      this.record(run, file, match.range, match.text, match.line);
    }
    if (file.editor) this.bufferEditorMatches(run, file, lines, found);
    this.endFile(run);
  }

  // VS Code's editorMatchesToTextSearchResults and getTextSearchMatchWithModelContext for a Search Editor run.
  private bufferEditorMatches(run: Run, file: RunFile, lines: readonly string[], found: ReadonlyArray<{ range: SearchRange; text: string }>): void {
    const editor = file.editor!;
    const owner = run.owner;
    const contextLines = owner.kind === 'editor' ? owner.contextLines : 0;
    const groups: Array<Array<{ range: SearchRange }>> = [];
    let previousEnd = -1;
    for (const match of found) {
      if (match.range.startLine !== previousEnd) groups.push([]);
      groups.at(-1)!.push(match);
      previousEnd = match.range.endLine;
    }
    let previousLine = 0;
    groups.forEach((group, index) => {
      const first = group[0]!.range.startLine;
      const last = group.at(-1)!.range.endLine;
      const text = lines.slice(first - 1, last).map((line) => line.replace(/\r$/, '')).join('\n');
      if (run.done) return;
      this.addEditorMatches(run, editor, editorMatches(text, first, group.map((match) => match.range)));
      if (contextLines === 0) return;
      for (let line = Math.max(previousLine + 1, first - contextLines); line < first; line++) this.addContext(run, editor, line, lines[line - 1] ?? '');
      const nextStart = groups[index + 1]?.[0]!.range.startLine ?? Number.MAX_SAFE_INTEGER;
      const to = Math.min(nextStart - 1, last + contextLines, lines.length);
      for (let line = last + 1; line <= to; line++) this.addContext(run, editor, line, lines[line - 1] ?? '');
      previousLine = last;
    });
  }

  private record(run: Run, file: RunFile, range: SearchRange, text: string, line: string): void {
    const kept = keepMatchText(text);
    if (run.removed.has(removedId(file.key, range, kept))) return;
    const id = run.nextId++;
    const startInLine = range.startColumn - 1;
    const endInLine = range.endLine === range.startLine ? range.endColumn - 1 : line.length + 1;
    const cut = searchPreview(line, startInLine, endInLine);
    const preview = { ...cut, text: detached(cut.text) };
    run.matches.set(id, { file: file.key, range, text: kept, line: preview.text, ...(file.documentId !== undefined ? { documentId: file.documentId } : {}) });
    file.matches.push({ id, range, preview });
    run.resultCount++;
    if (run.resultCount >= run.settings.maxResults) {
      run.limitHit = true;
      this.endFile(run);
      this.finish(run, undefined, false);
    }
  }

  private async execute(run: Run, args: readonly string[]): Promise<void> {
    const rgPath = await this.deps.rgPath();
    if (run.done) return;
    const rg = (this.deps.spawnRg ?? spawnRipgrep)(rgPath, args, run.folder.fsPath);
    run.process = rg;
    readLines(rg.stdout, MAX_RG_EVENT_BYTES, (line) => {
      if (run.done) return;
      let event: { type: string; data: Record<string, unknown> };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        this.deps.log('[search] dropping a ripgrep line that is not JSON');
        return;
      }
      this.onEvent(run, event);
    }, () => {
      // A dropped match leaves the results a subset, which the limit says.
      run.dropped++;
      run.limitHit = true;
    });
    rg.stderr.setEncoding('utf8');
    rg.stderr.on('data', (chunk: string) => {
      if (run.stderr.length < MAX_STDERR_CHARS) run.stderr += chunk.slice(0, MAX_STDERR_CHARS - run.stderr.length);
    });
    rg.on('error', (err) => this.finish(run, err.message, false));
    // After readline has every line: 'close' follows the end of stdout.
    rg.on('close', (code) => {
      if (run.dropped > 0) this.deps.log(`[search] dropped ${run.dropped} ripgrep events over ${MAX_RG_EVENT_BYTES} bytes`);
      const stderr = run.stderr.trim();
      if (stderr !== '') this.deps.log(`[search] ripgrep: ${stderr.slice(0, 500)}`);
      // 1 is ripgrep's "nothing found"; 2 with results is an unreadable file among readable ones.
      this.finish(run, code === 0 || code === 1 ? undefined : rgErrorForDisplay(stderr), false);
    });
  }

  private onEvent(run: Run, event: { type: string; data: Record<string, unknown> }): void {
    if (event.type === 'begin') {
      const printed = event.data['path'] as RgText;
      const relativePath = 'text' in printed ? relativeResultPath(printed.text) : undefined;
      if (relativePath === undefined) this.deps.log('[search] dropping a result outside the shown folder or with a path that is not UTF-8');
      const key: SearchFileKey | undefined = relativePath === undefined ? undefined : { kind: 'file', relativePath };
      // An open document's buffer was searched instead.
      run.file = key === undefined || run.buffered.has(fileKeyId(key)) ? undefined : {
        key,
        matches: [],
        ...(run.owner.kind === 'editor' ? { editor: { matches: [], context: new Map() } } : {}),
      };
    } else if (event.type === 'match') {
      if (run.file) this.addMatches(run, run.file, event.data);
    } else if (event.type === 'context') {
      if (run.file?.editor) {
        const text = textOf(event.data['lines'] as RgText).toString('utf8');
        const first = event.data['line_number'] as number;
        const editor = run.file.editor;
        text.replace(/\r?\n$/, '').split('\n').forEach((line, index) => this.addContext(run, editor, first + index, line));
      }
    } else if (event.type === 'end') {
      this.endFile(run);
    }
  }

  private addMatches(run: Run, file: RunFile, data: Record<string, unknown>): void {
    const bytes = textOf(data['lines'] as RgText);
    const text = bytes.toString('utf8');
    // Cursors over the lines, which only move forward: ripgrep lists submatches in order and a line can hold thousands.
    let byteCursor = 0;
    let utf16Cursor = 0;
    // UTF-8 byte offsets into the lines; the decoded length up to one is its UTF-16 offset.
    const utf16At = (byte: number): number => {
      utf16Cursor += bytes.toString('utf8', byteCursor, byte).length;
      byteCursor = byte;
      return utf16Cursor;
    };
    const firstLine = data['line_number'] as number;
    let line = firstLine;
    let lineStart = 0;
    let nextNewline = text.indexOf('\n');
    const positionAt = (offset: number): { line: number; column: number } => {
      while (nextNewline !== -1 && nextNewline < offset) {
        line++;
        lineStart = nextNewline + 1;
        nextNewline = text.indexOf('\n', lineStart);
      }
      return { line, column: offset - lineStart + 1 };
    };
    const ranges: SearchRange[] = [];
    for (const submatch of data['submatches'] as Array<{ start: number; end: number }>) {
      const start = utf16At(submatch.start);
      const from = positionAt(start);
      const firstLineStart = lineStart;
      let firstLineEnd = nextNewline === -1 ? text.length : nextNewline;
      if (text[firstLineEnd - 1] === '\r') firstLineEnd--;
      const end = utf16At(submatch.end);
      const to = positionAt(end);
      const range: SearchRange = { startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column };
      ranges.push(range);
      this.record(run, file, range, text.slice(start, end), text.slice(firstLineStart, firstLineEnd));
      if (run.done) break;
    }
    if (file.editor && ranges.length > 0) this.addEditorMatches(run, file.editor, editorMatches(text.replace(/\r?\n$/, ''), firstLine, ranges));
  }

  private addEditorMatches(run: Run, editor: NonNullable<RunFile['editor']>, matches: readonly EditorMatch[]): void {
    editor.matches.push(...matches.map((match) => ({ ...match, previewLines: match.previewLines.map(detached) })));
    this.charge(run, matches.reduce((sum, match) => sum + match.previewLines.reduce((lines, line) => lines + line.length, 0), 0));
  }

  private addContext(run: Run, editor: NonNullable<RunFile['editor']>, line: number, text: string): void {
    if (run.done) return;
    const cut = detached(contextLine(text));
    editor.context.set(line, cut);
    this.charge(run, cut.length);
  }

  // A Search Editor run never holds more text than its editor can: past the bound it ends as a run at the result limit.
  private charge(run: Run, chars: number): void {
    run.editorChars += chars;
    if (run.editorChars <= MAX_EDITOR_TEXT_CHARS || run.done) return;
    run.limitHit = true;
    this.endFile(run);
    this.finish(run, undefined, false);
  }

  private endFile(run: Run): void {
    const file = run.file;
    run.file = undefined;
    if (!file || file.matches.length === 0) return;
    run.files.set(fileKeyId(file.key), file);
    if (run.owner.kind === 'editor') {
      if (run.settings.sortOrder === 'modified' && file.key.kind === 'file' && file.mtimeMs === undefined) run.pending.push(this.withMtime(run, file).then(() => this.resultOf(file)));
      return;
    }
    run.pending.push(run.settings.sortOrder === 'modified' && file.key.kind === 'file' && file.mtimeMs === undefined ? this.withMtime(run, file).then(() => this.resultOf(file)) : Promise.resolve(this.resultOf(file)));
    run.pendingMatches += file.matches.length;
    if (run.pendingMatches >= SEARCH_BATCH_MATCHES) this.flush(run);
    else run.batchTimer ??= setTimeout(() => this.flush(run), SEARCH_BATCH_MS);
  }

  private async withMtime(run: Run, file: RunFile): Promise<void> {
    if (file.key.kind !== 'file') return;
    const mtime = await (this.deps.mtime ?? lstatMtime)(path.join(run.folder.fsPath, ...file.key.relativePath.split('/')));
    if (mtime !== undefined) file.mtimeMs = mtime;
  }

  private resultOf(file: RunFile): SearchFileResult {
    if (file.key.kind === 'untitled') return { kind: 'untitled', documentId: file.key.documentId, title: file.title ?? '', matches: [...file.matches] };
    return {
      kind: 'file',
      relativePath: file.key.relativePath,
      matches: [...file.matches],
      ...(file.documentId !== undefined ? { documentId: file.documentId } : {}),
      ...(file.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
    };
  }

  // Batches go out in order, each once its files' modification times are read.
  private flush(run: Run): void {
    clearTimeout(run.batchTimer);
    run.batchTimer = undefined;
    if (run.pending.length === 0) return;
    const files = run.pending;
    run.pending = [];
    run.pendingMatches = 0;
    const searchId = run.searchId;
    run.sending = run.sending.then(async () => {
      const results = await Promise.all(files);
      if (!run.discarded) this.deps.sendResults({ searchId, matchCase: run.query.matchCase, files: results });
    });
  }

  // The view's done once its batches are out, or a Search Editor's files; once per run unless it was discarded.
  private finish(run: Run, error: string | undefined, cancelled: boolean): void {
    if (run.done) return;
    run.done = true;
    clearTimeout(run.debounce);
    run.process?.kill();
    if (run.owner.kind === 'view') {
      this.flush(run);
      const done: SearchDone = {
        searchId: run.searchId,
        resultCount: run.resultCount,
        fileCount: filesWithMatches(run).length,
        limitHit: run.limitHit,
        ...(error !== undefined ? { error } : {}),
        ...(cancelled ? { cancelled: true as const } : {}),
        ...(run.bufferWarning !== undefined ? { bufferWarning: run.bufferWarning } : {}),
      };
      run.sending = run.sending.then(() => {
        if (!run.discarded) this.deps.sendDone(done);
      });
      run.sending.catch((err: unknown) => this.deps.log(`[search] sending results failed: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const pending = run.pending;
    run.pending = [];
    void Promise.all(pending).then(() => {
      if (run.discarded) return;
      this.runs.delete(this.ownerId(run.owner));
      run.onEditorDone?.({
        files: this.sortedFiles(run).map((file) => this.editorFileOf(run, file)),
        limitHit: run.limitHit,
        ...(error !== undefined ? { error } : {}),
        ...(run.bufferWarning !== undefined ? { bufferWarning: run.bufferWarning } : {}),
      });
    }, (err: unknown) => this.deps.log(`[search] reading modification times failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private sortedFiles(run: Run): RunFile[] {
    const files = filesWithMatches(run);
    const results = new Map(files.map((file) => [file, this.resultOf(file)]));
    return files.sort((a, b) => compareSearchFiles(results.get(a)!, results.get(b)!, run.settings.sortOrder));
  }

  // A file in the Search Editor's terms; a view run's file (Open Results in Editor) has no context and one preview per match.
  private editorFileOf(run: Run, file: RunFile): EditorFileResult {
    const label = file.key.kind === 'file' ? file.key.relativePath.split('/').join(path.sep) : (file.title ?? '');
    if (file.editor) return { label, matches: file.editor.matches.filter((match) => file.matches.some((kept) => sameRange(kept.range, match.range))), context: file.editor.context };
    const matches = file.matches.flatMap((match) => {
      const recorded = run.matches.get(match.id);
      return recorded ? editorMatches(recorded.line, match.range.startLine, [{ ...match.range, endLine: match.range.startLine, endColumn: match.range.endLine === match.range.startLine ? match.range.endColumn : recorded.line.length + 1 }]) : [];
    });
    return { label, matches, context: new Map() };
  }

  private removeMatch(run: Run, id: number, match: RecordedMatch): string {
    run.matches.delete(id);
    run.removed.add(removedId(match.file, match.range, match.text));
    const fileId = fileKeyId(match.file);
    const file = run.files.get(fileId);
    if (file) file.matches = file.matches.filter((candidate) => candidate.id !== id);
    return fileId;
  }

  private pushFile(run: Run, fileId: string): void {
    const file = run.files.get(fileId);
    if (!file || run.owner.kind !== 'view') return;
    const result = file.matches.length > 0 ? this.resultOf(file) : null;
    this.deps.sendFileUpdate({ searchId: run.searchId, matchCase: run.query.matchCase, key: file.key, file: result });
  }

  // VS Code's FileMatch.updateMatchesForModel: the file's matches are found again in its buffer, removed ones left out.
  private researchBuffer(run: Run, documentId: string): void {
    const buffer = this.deps.buffers(run.folder.projectKey).find((candidate) => candidate.documentId === documentId);
    const regExp = run.regExp;
    if (!buffer || !regExp) return;
    const fileId = fileKeyId(this.keyOf(buffer));
    const file = run.files.get(fileId);
    if (!file || run.dismissedFiles.has(fileId)) return;
    const found = runWithin(BUFFER_SEARCH_TIMEOUT_MS, () => findBufferMatches(buffer.text, run.pattern, regExp, run.settings.maxResults));
    if (!found.ok) {
      run.bufferWarning = 'timedOut';
      this.deps.log('[search] the regular expression ran out of time on an open document; live updates stop for this search');
      return;
    }
    for (const match of file.matches) {
      run.matches.delete(match.id);
      run.resultCount--;
    }
    file.matches = [];
    file.documentId = documentId;
    const lines = buffer.text.split('\n');
    for (const match of withLines(lines, found.value)) {
      const kept = keepMatchText(match.text);
      if (run.removed.has(removedId(file.key, match.range, kept))) continue;
      const id = run.nextId++;
      const cut = searchPreview(match.line, match.range.startColumn - 1, match.range.endLine === match.range.startLine ? match.range.endColumn - 1 : match.line.length + 1);
      const preview = { ...cut, text: detached(cut.text) };
      run.matches.set(id, { file: file.key, range: match.range, text: kept, line: preview.text, documentId });
      file.matches.push({ id, range: match.range, preview });
      run.resultCount++;
    }
    this.pushFile(run, fileId);
  }
}

// Each match with its first line, for the preview.
function withLines(lines: readonly string[], found: ReadonlyArray<{ range: SearchRange; text: string }>): Array<{ range: SearchRange; text: string; line: string }> {
  return found.map((match) => ({ ...match, line: (lines[match.range.startLine - 1] ?? '').replace(/\r$/, '') }));
}

function filesWithMatches(run: Run): RunFile[] {
  return [...run.files.values()].filter((file) => file.matches.length > 0);
}

function compareRanges(a: SearchRange, b: SearchRange): number {
  return a.startLine - b.startLine || a.startColumn - b.startColumn || a.endLine - b.endLine || a.endColumn - b.endColumn;
}

function sameRange(a: SearchRange, b: SearchRange): boolean {
  return a.startLine === b.startLine && a.startColumn === b.startColumn && a.endLine === b.endLine && a.endColumn === b.endColumn;
}
