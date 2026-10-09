import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { SearchQuery, SearchRange } from '../../../shared/text-search';
import type { Project } from '../documents/confine';
import { DocumentService } from '../documents/document-service';
import { createReplacer, keepMatchText, MAX_KEPT_MATCH_CHARS, planReplacements, planWithin, type ReplaceDeps } from '../search/replace';
import { searchRegExp } from '../../../shared/text-search';
import { resolveRgPath } from '../../../core/chat-panel/ripgrep';
import { SearchService, type RecordedMatch, type RecordedSearch } from '../search/search-service';

let root: string;
let project: Project;
let documents: DocumentService;
let notices: Array<{ lines: readonly string[]; more: number }>;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-replace-')));
  project = { key: folderKey(root), fsPath: root, name: 'proj' };
  notices = [];
  documents = new DocumentService({
    projects: () => [project],
    watchers: createFakePlatform().fileWatchers,
    ask: async () => undefined,
    t: (message) => message,
    log: () => undefined,
    pickSavePath: async () => undefined,
    backups: { changed: () => undefined, writeNow: async () => undefined, remove: () => undefined },
    settings: { locate: () => undefined, save: async () => ({ ok: false, error: 'unused' }) as never },
  });
});

afterEach(() => {
  documents.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

const query = (pattern: string, overrides: Partial<SearchQuery> = {}): SearchQuery => ({
  pattern, isRegex: true, matchCase: true, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, ...overrides,
});

function write(relativePath: string, content: string | Buffer): string {
  const file = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// What ripgrep would record: every match of the query in each file's decoded text, by line and UTF-16 column.
function recorded(search: SearchQuery, files: Record<string, string>): RecordedSearch {
  const matches = new Map<number, RecordedMatch>();
  const regExp = new RegExp(searchRegExp(search).source, `g${search.matchCase ? '' : 'i'}mu`);
  for (const [relativePath, text] of Object.entries(files)) {
    text.split('\n').forEach((line, index) => {
      for (const found of line.replace(/\r$/, '').matchAll(regExp)) {
        const range: SearchRange = { startLine: index + 1, startColumn: found.index + 1, endLine: index + 1, endColumn: found.index + found[0].length + 1 };
        matches.set(matches.size, { file: { kind: 'file', relativePath }, range, text: found[0], line });
      }
    });
  }
  return { searchId: 1, query: search, folder: { projectKey: project.key, fsPath: root }, matches };
}

const deps = (overrides: Partial<ReplaceDeps> = {}): ReplaceDeps => ({
  read: (projectKey, relativePath) => documents.readClosedFile(projectKey, relativePath),
  write: (read, text) => documents.writeClosedFile(read, text),
  notifySkipped: (lines, more) => notices.push({ lines, more }),
  reasonLabel: (skip) => (skip.reason === 'failed' ? `failed ${skip.message}` : skip.reason),
  ...overrides,
});

const all = (search: RecordedSearch): number[] => [...search.matches.keys()];
const replaceInFiles = (replaceDeps: ReplaceDeps, search: RecordedSearch, replacement: string, ids: readonly number[], preserveCase = false) =>
  createReplacer(replaceDeps)(search, { replacement, preserveCase, matchIds: ids });
const fileMatch = (relativePath: string, range: SearchRange, text: string): RecordedMatch => ({ file: { kind: 'file', relativePath }, range, text, line: text });

// What the bundled ripgrep records for a query over the project.
async function ripgrepSearch(search: SearchQuery): Promise<RecordedSearch> {
  let recordedSearch: RecordedSearch | undefined;
  await new Promise<void>((resolve) => {
    const service: SearchService = new SearchService({
      folder: () => ({ projectKey: project.key, fsPath: root }),
      rgPath: () => resolveRgPath({ resourceRoot: process.cwd(), unpackedRoot: process.cwd() }),
      ignoreArgs: () => [],
      excludeSettings: () => [],
      settings: () => ({ smartCase: false, maxResults: 20_000, debounceMs: 0, sortOrder: 'default' }),
      buffers: () => [],
      sendResults: () => undefined,
      sendFileUpdate: () => undefined,
      sendDone: () => {
        recordedSearch = service.recorded(1);
        resolve();
      },
      log: () => undefined,
    });
    service.start(1, search, true);
  });
  return recordedSearch!;
}

describe('replace in closed files', () => {
  it('expands groups of a regex with a lookbehind that needs the text before the match', async () => {
    const text = 'const width = 10;\r\nlet width = 20;\r\n';
    const file = write('src/a.ts', text);
    const search = recorded(query('(?<=const )(\\w+) = (\\d+)'), { 'src/a.ts': text });
    expect(search.matches.size).toBe(1);
    const result = await replaceInFiles(deps(), search, '$1 = $2 * 2 /* $$ */', all(search));
    expect(result).toEqual({ replacedFiles: 1, replacedCount: 1, skipped: [], replaced: [0] });
    expect(fs.readFileSync(file, 'utf8')).toBe('const width = 10 * 2 /* $ */;\r\nlet width = 20;\r\n');
  });

  it('keeps the encoding, the byte order mark and every line ending, and gives an inserted line the file ending', async () => {
    const utf16 = 'αβ one\r\ntwo one\r\n';
    const utf16File = write('u16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf16, 'utf16le')]));
    const bom = 'x one\ny\r\none\n';
    const bomFile = write('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(bom)]));
    const search = recorded(query('one'), { 'u16.txt': utf16, 'bom.txt': bom });
    const result = await replaceInFiles(deps(), search, 'ένα\\ntwo', all(search));
    expect(result).toMatchObject({ replacedFiles: 2, replacedCount: 4, skipped: [] });
    expect(fs.readFileSync(utf16File)).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('αβ ένα\r\ntwo\r\ntwo ένα\r\ntwo\r\n', 'utf16le')]));
    expect(fs.readFileSync(bomFile)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x ένα\ntwo\ny\r\nένα\ntwo\n')]));
  });

  it('replaces a regex match across a line break in a CRLF file and an LF file, each keeping its line endings', async () => {
    const crlf = write('crlf.txt', 'foo\r\nbar\r\n');
    const lf = write('lf.txt', 'foo\nbar\n');
    const search = await ripgrepSearch(query('(\\w+)\\nbar'));
    expect([...search.matches.values()].map((match) => match.text).sort()).toEqual(['foo\nbar', 'foo\r\nbar']);
    expect(await replaceInFiles(deps(), search, '$1\\nbaz\\nqux', all(search))).toMatchObject({ replacedFiles: 2, replacedCount: 2, skipped: [] });
    expect(fs.readFileSync(crlf, 'utf8')).toBe('foo\r\nbaz\r\nqux\r\n');
    expect(fs.readFileSync(lf, 'utf8')).toBe('foo\nbaz\nqux\n');
  });

  it('is literal for a text query', async () => {
    const file = write('t.txt', 'a.b $1\n');
    const search = recorded(query('a.b', { isRegex: false }), { 't.txt': 'a.b $1\n' });
    await replaceInFiles(deps(), search, '$1$&', all(search));
    expect(fs.readFileSync(file, 'utf8')).toBe('$1$& $1\n');
  });

  it('skips a whole file changed after the search, even to the same size and time, and names it in one notice', async () => {
    const changed = write('changed.ts', 'let foo = 1;\nlet foo = 2;\n');
    const kept = write('kept.ts', 'foo\n');
    const search = recorded(query('foo'), { 'changed.ts': 'let foo = 1;\nlet foo = 2;\n', 'kept.ts': 'foo\n' });
    const stat = fs.statSync(changed);
    fs.writeFileSync(changed, 'let foo = 1;\nlet bar = 2;\n');
    fs.utimesSync(changed, stat.atime, stat.mtime);
    const result = await replaceInFiles(deps(), search, 'baz', all(search));
    expect(result).toEqual({ replacedFiles: 1, replacedCount: 1, skipped: [{ relativePath: 'changed.ts', reason: 'changed' }], replaced: [2] });
    expect(fs.readFileSync(changed, 'utf8')).toBe('let foo = 1;\nlet bar = 2;\n');
    expect(fs.readFileSync(kept, 'utf8')).toBe('baz\n');
    expect(notices).toEqual([{ lines: ['changed.ts: changed'], more: 0 }]);
  });

  it('skips a Latin-1 file and never rewrites it', async () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x66, 0x6f, 0x6f, 0x0a]);
    const file = write('latin1.txt', bytes);
    const search = recorded(query('foo'), { 'latin1.txt': bytes.toString('utf8') });
    const result = await replaceInFiles(deps(), search, 'bar', all(search));
    expect(result.skipped).toEqual([{ relativePath: 'latin1.txt', reason: 'readOnly' }]);
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it('skips a file a document holds, whose buffer the shell replaces', async () => {
    const file = write('open.ts', 'foo\n');
    const search = recorded(query('foo'), { 'open.ts': 'foo\n' });
    await documents.openProjectFile(project.key, 'open.ts');
    const result = await replaceInFiles(deps(), search, 'bar', all(search));
    expect(result.skipped).toEqual([{ relativePath: 'open.ts', reason: 'openInEditor' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe('foo\n');
  });

  it('skips a file whose bytes change between the read and the write', async () => {
    const file = write('race.ts', 'foo\n');
    const search = recorded(query('foo'), { 'race.ts': 'foo\n' });
    const result = await replaceInFiles(deps({
      write: async (read, text) => {
        fs.writeFileSync(file, 'foo!\n');
        return documents.writeClosedFile(read, text);
      },
    }), search, 'bar', all(search));
    expect(result.skipped).toEqual([{ relativePath: 'race.ts', reason: 'conflict' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe('foo!\n');
  });

  it('skips a file when the JavaScript regex does not reproduce the match ripgrep recorded', async () => {
    // ripgrep's \d is Unicode and matches ARABIC-INDIC DIGIT THREE; JavaScript's \d is ASCII only.
    const file = write('digits.txt', 'n = ٣\n');
    const match = fileMatch('digits.txt', { startLine: 1, startColumn: 5, endLine: 1, endColumn: 6 }, '٣');
    const search: RecordedSearch = { searchId: 1, query: query('\\d'), folder: { projectKey: project.key, fsPath: root }, matches: new Map([[0, match]]) };
    const result = await replaceInFiles(deps(), search, '3', [0]);
    expect(result.skipped).toEqual([{ relativePath: 'digits.txt', reason: 'unsupportedRegex' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe('n = ٣\n');
  });

  it('skips every file for a pattern JavaScript cannot compile', async () => {
    write('a.txt', 'aaa\n');
    const match = fileMatch('a.txt', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 }, 'aaa');
    const search: RecordedSearch = { searchId: 1, query: query('a++'), folder: { projectKey: project.key, fsPath: root }, matches: new Map([[0, match]]) };
    expect((await replaceInFiles(deps(), search, 'b', [0])).skipped).toEqual([{ relativePath: 'a.txt', reason: 'unsupportedRegex' }]);
  });

  it('replaces every whole-word match ripgrep records, Unicode word characters around them included', async () => {
    const text = 'id ida αid id_x éid id- -id\n';
    const file = write('words.txt', text);
    const search = await ripgrepSearch(query('id', { isRegex: false, wholeWord: true }));
    expect([...search.matches.values()].map((match) => match.range.startColumn)).toEqual([1, 21, 26]);
    expect(await replaceInFiles(deps(), search, 'ID', all(search))).toMatchObject({ replacedFiles: 1, replacedCount: 3, skipped: [] });
    expect(fs.readFileSync(file, 'utf8')).toBe('ID ida αid id_x éid ID- -ID\n');
  });

  it('runs one replace at a time, so two replaces in one file never both pass the disk check and lose one', async () => {
    const file = write('two.ts', 'one foo\ntwo foo\n');
    const search = recorded(query('foo'), { 'two.ts': 'one foo\ntwo foo\n' });
    const replacer = createReplacer(deps());
    const [first, second] = await Promise.all([replacer(search, { replacement: 'bar', preserveCase: false, matchIds: [0] }), replacer(search, { replacement: 'baz', preserveCase: false, matchIds: [1] })]);
    expect(first).toMatchObject({ replacedCount: 1 });
    expect(second).toMatchObject({ replacedCount: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe('one bar\ntwo baz\n');
    const [again] = await Promise.all([replacer(search, { replacement: 'qux', preserveCase: false, matchIds: [0] }), replacer(search, { replacement: 'qux', preserveCase: false, matchIds: [1] })]);
    expect(again.skipped).toEqual([{ relativePath: 'two.ts', reason: 'changed' }]);
  });

  it('never writes the replacement twice for the same empty match', () => {
    const pattern = query('^');
    const empty = { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, text: '' };
    expect(planReplacements('abc', [empty, empty], pattern, searchRegExp(pattern), '> ', false, '\n')).toEqual({ ok: false, reason: 'changed' });
    expect(planReplacements('abc', [empty], pattern, searchRegExp(pattern), '> ', false, '\n')).toMatchObject({ ok: true });
  });

  it('reports a file that cannot be read at write time as a conflict, not a failure of the whole replace', async () => {
    const file = write('gone.ts', 'foo\n');
    const search = recorded(query('foo'), { 'gone.ts': 'foo\n' });
    const result = await replaceInFiles(deps({
      write: async (read, text) => {
        fs.rmSync(file);
        fs.mkdirSync(file);
        return documents.writeClosedFile(read, text);
      },
    }), search, 'bar', all(search));
    expect(result.skipped).toEqual([{ relativePath: 'gone.ts', reason: 'conflict' }]);
  });

  it('reports a write the file system refused as failed, with its message, never as read-only', async () => {
    write('locked.ts', 'foo\n');
    const search = recorded(query('foo'), { 'locked.ts': 'foo\n' });
    const result = await replaceInFiles(deps({ write: async () => ({ ok: false, reason: 'failed', message: 'EBUSY: resource busy or locked' }) }), search, 'bar', all(search));
    expect(result.skipped).toEqual([{ relativePath: 'locked.ts', reason: 'failed', message: 'EBUSY: resource busy or locked' }]);
    expect(notices).toEqual([{ lines: ['locked.ts: failed EBUSY: resource busy or locked'], more: 0 }]);
  });

  it('verifies a long match against the bounded form the search kept, never its text', () => {
    const pattern = query('a+');
    const long = 'a'.repeat(MAX_KEPT_MATCH_CHARS + 1);
    const kept = keepMatchText(long);
    expect(typeof kept).not.toBe('string');
    const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: long.length + 1 };
    expect(planReplacements(long, [{ range, text: kept }], pattern, searchRegExp(pattern), 'b', false, '\n')).toEqual({ ok: true, edits: [{ start: 0, end: long.length, text: 'b' }] });
    const changed = `${'a'.repeat(MAX_KEPT_MATCH_CHARS)}b`;
    expect(planReplacements(changed, [{ range, text: kept }], query('[ab]+'), searchRegExp(query('[ab]+')), 'b', false, '\n')).toEqual({ ok: false, reason: 'changed' });
    expect(keepMatchText('short')).toBe('short');
  });

  it('stops running a regex that timed out on one file and reports the rest timed out too', async () => {
    const slow = `${'a'.repeat(40)}b\n`;
    write('one.txt', slow);
    write('two.txt', slow);
    const match = (relativePath: string): RecordedMatch => fileMatch(relativePath, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }, 'a');
    const search: RecordedSearch = { searchId: 1, query: query('(a|aa)*c|a'), folder: { projectKey: project.key, fsPath: root }, matches: new Map([[0, match('one.txt')], [1, match('two.txt')]]) };
    const reads: string[] = [];
    const result = await replaceInFiles(deps({
      timeoutMs: 100,
      read: (projectKey, relativePath) => {
        reads.push(relativePath);
        return documents.readClosedFile(projectKey, relativePath);
      },
    }), search, 'x', [0, 1]);
    expect(result.skipped).toEqual([{ relativePath: 'one.txt', reason: 'timedOut' }, { relativePath: 'two.txt', reason: 'timedOut' }]);
    expect(reads).toEqual(['one.txt']);
  });

  it('keeps each match\'s case with Preserve Case, through the one replacement function', async () => {
    const text = 'foo Foo FOO foo-bar Foo_Bar\n';
    const file = write('case.txt', text);
    const search = recorded(query('foo(-bar|_bar)?', { matchCase: false }), { 'case.txt': text });
    await replaceInFiles(deps(), search, 'baz$1', all(search), true);
    expect(fs.readFileSync(file, 'utf8')).toBe('baz Baz BAZ baz-bar Baz_Bar\n');
  });

  it('refuses the match of an open buffer or an untitled tab, which the shell replaces in the buffer', async () => {
    write('open.ts', 'foo\n');
    const buffered: RecordedMatch = { ...fileMatch('open.ts', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 }, 'foo'), documentId: 'doc-1' };
    const untitled: RecordedMatch = { file: { kind: 'untitled', documentId: 'doc-2' }, range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 }, text: 'foo', line: 'foo', documentId: 'doc-2' };
    const search: RecordedSearch = { searchId: 1, query: query('foo'), folder: { projectKey: project.key, fsPath: root }, matches: new Map([[0, buffered], [1, untitled]]) };
    await expect(replaceInFiles(deps(), search, 'bar', [0])).rejects.toThrow('replaced in its buffer');
    await expect(replaceInFiles(deps(), search, 'bar', [1])).rejects.toThrow('replaced in its buffer');
    expect(fs.readFileSync(path.join(root, 'open.ts'), 'utf8')).toBe('foo\n');
  });

  it('replaces only a folder\'s matches when asked with its ids (Replace All in Folder)', async () => {
    const inside = write('src/a.ts', 'foo\n');
    const outside = write('lib/b.ts', 'foo\n');
    const search = recorded(query('foo'), { 'src/a.ts': 'foo\n', 'lib/b.ts': 'foo\n' });
    const folderIds = [...search.matches].flatMap(([id, match]) => (match.file.kind === 'file' && match.file.relativePath.startsWith('src/') ? [id] : []));
    expect(await replaceInFiles(deps(), search, 'bar', folderIds)).toEqual({ replacedFiles: 1, replacedCount: 1, skipped: [], replaced: folderIds });
    expect(fs.readFileSync(inside, 'utf8')).toBe('bar\n');
    expect(fs.readFileSync(outside, 'utf8')).toBe('foo\n');
  });

  it('refuses a match id the search never issued', async () => {
    const search = recorded(query('foo'), {});
    await expect(replaceInFiles(deps(), search, 'bar', [7])).rejects.toThrow('Unknown match id');
  });

  it('times a backtracking regex out instead of blocking main', () => {
    const line = `${'a'.repeat(40)}b`;
    // ripgrep's engine finds the 'a' at the start in linear time; a backtracking engine tries (a|aa)*c first.
    const pattern = query('(a|aa)*c|a');
    const started = Date.now();
    const result = planWithin(100, () => planReplacements(line, [{ range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }, text: 'a' }], pattern, searchRegExp(pattern), 'x', false, '\n'));
    expect(result).toEqual({ ok: false, reason: 'timedOut' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
