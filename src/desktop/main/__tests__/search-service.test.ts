import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as v8 from 'node:v8';
import * as vm from 'node:vm';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRipgrepSearchOptions, resolveRgPath } from '../../../core/chat-panel/ripgrep';
import { MAX_SEARCH_RESULTS, type SearchQuery, type SearchRange } from '../../../shared/text-search';
import type { SearchDone, SearchFileUpdate, SearchResultsBatch } from '../../preload/shell-channels';
import { DEFAULT_FILES_EXCLUDE, DEFAULT_SEARCH_EXCLUDE } from '../desktop-configuration';
import { excludeSettingGlobs } from '../search/rg-args';
import { findBufferMatches, LIVE_UPDATE_MS, lstatMtime, MAX_RG_EVENT_BYTES, relativeResultPath, SearchService, type BufferDocument, type EditorRunResult, type RgProcess, type SearchServiceDeps, type SearchSettings } from '../search/search-service';

const SEARCH_DEBOUNCE_MS = 300;

class FakeRg extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  readonly args: readonly string[];
  readonly cwd: string;
  constructor(args: readonly string[], cwd: string) {
    super();
    this.args = args;
    this.cwd = cwd;
  }
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.close(null);
  }
  // A killed ripgrep prints nothing more.
  emitJson(event: unknown): void {
    if (!this.killed) this.stdout.write(`${JSON.stringify(event)}\n`);
  }
  close(code: number | null): void {
    this.stdout.end();
    this.stdout.once('close', () => this.emit('close', code));
    this.stdout.resume();
  }
}

const query = (overrides: Partial<SearchQuery> = {}): SearchQuery => ({
  pattern: 'x', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, ...overrides,
});

let spawned: FakeRg[];
let batches: SearchResultsBatch[];
let dones: SearchDone[];
let updates: SearchFileUpdate[];
let buffers: BufferDocument[];
let settings: SearchSettings;

function service(overrides: Partial<SearchServiceDeps> = {}): SearchService {
  return new SearchService({
    folder: () => ({ projectKey: 'p', fsPath: '/proj' }),
    rgPath: async () => 'rg',
    ignoreArgs: () => [],
    excludeSettings: () => ['**/node_modules'],
    settings: () => settings,
    buffers: () => buffers,
    sendResults: (batch) => batches.push(batch),
    sendFileUpdate: (update) => updates.push(update),
    sendDone: (done) => dones.push(done),
    log: () => undefined,
    spawnRg: (_rgPath, args, cwd) => {
      const rg = new FakeRg(args, cwd);
      spawned.push(rg);
      return rg as unknown as RgProcess;
    },
    ...overrides,
  });
}

const begin = (file: string) => ({ type: 'begin', data: { path: { text: file } } });
const end = (file: string) => ({ type: 'end', data: { path: { text: file } } });
const match = (file: string, lineNumber: number, lines: { text: string } | { bytes: string }, submatches: Array<[number, number]>) => ({
  type: 'match',
  data: { path: { text: file }, lines, line_number: lineNumber, absolute_offset: 0, submatches: submatches.map(([start, end]) => ({ match: { text: '' }, start, end })) },
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  spawned = [];
  batches = [];
  dones = [];
  updates = [];
  buffers = [];
  settings = { smartCase: false, maxResults: MAX_SEARCH_RESULTS, debounceMs: SEARCH_DEBOUNCE_MS, sortOrder: 'default' };
});

const paths = (results: ReadonlyArray<{ files: SearchResultsBatch['files'] }>): string[] =>
  results.flatMap((batch) => batch.files.map((result) => (result.kind === 'file' ? result.relativePath : `untitled:${result.title}`)));

describe('search service', () => {
  it('converts UTF-8 byte offsets on a non-ASCII line to 1-based UTF-16 columns, and previews the line', async () => {
    const search = service();
    search.start(1, query({ pattern: 'needle' }), true);
    await settle();
    const rg = spawned[0]!;
    expect(rg.cwd).toBe('/proj');
    const line = 'αβγ 😀 needle é needle\n';
    const first = Buffer.byteLength('αβγ 😀 ');
    const second = Buffer.byteLength('αβγ 😀 needle é ');
    rg.emitJson(begin('./src/a.ts'));
    rg.emitJson(match('./src/a.ts', 7, { text: line }, [[first, first + 6], [second, second + 6]]));
    rg.emitJson(end('./src/a.ts'));
    rg.close(0);
    await settle();
    const [file] = batches[0]!.files;
    expect(file).toMatchObject({ kind: 'file', relativePath: 'src/a.ts' });
    expect(file!.matches.map((m) => m.range)).toEqual([
      { startLine: 7, startColumn: 8, endLine: 7, endColumn: 14 },
      { startLine: 7, startColumn: 17, endLine: 7, endColumn: 23 },
    ]);
    expect(file!.matches[1]!.preview).toEqual({ text: 'αβγ 😀 needle é needle', matchStart: 16, matchEnd: 22 });
    expect(search.recorded(1)?.matches.get(file!.matches[0]!.id)).toMatchObject({ text: 'needle' });
    expect(dones).toEqual([{ searchId: 1, resultCount: 2, fileCount: 1, limitHit: false }]);
  });

  it('decodes base64 lines that are not UTF-8 as the editor does, and places a match across lines', async () => {
    const search = service();
    search.start(1, query({ pattern: 'a\\nb', isRegex: true }), true);
    await settle();
    const rg = spawned[0]!;
    const bytes = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' xa\r\nby\r\n')]);
    rg.emitJson(begin('l.txt'));
    rg.emitJson(match('l.txt', 3, { bytes: bytes.toString('base64') }, [[6, 10]]));
    rg.emitJson(end('l.txt'));
    rg.close(0);
    await settle();
    const found = batches[0]!.files[0]!.matches[0]!;
    expect(found.range).toEqual({ startLine: 3, startColumn: 7, endLine: 4, endColumn: 2 });
    expect(found.preview).toEqual({ text: 'caf\uFFFD xa', matchStart: 6, matchEnd: 7 });
    expect(search.recorded(1)?.matches.get(found.id)?.text).toBe('a\r\nb');
  });

  it('stops ripgrep at the result cap and reports the limit', async () => {
    const search = service();
    search.start(1, query(), true);
    await settle();
    const rg = spawned[0]!;
    const perFile = 1000;
    const submatches = Array.from({ length: perFile }, (_, i): [number, number] => [i, i + 1]);
    for (let fileIndex = 0; fileIndex < MAX_SEARCH_RESULTS / perFile + 2; fileIndex++) {
      rg.emitJson(begin(`f${fileIndex}.txt`));
      rg.emitJson(match(`f${fileIndex}.txt`, 1, { text: `${'x'.repeat(perFile)}\n` }, submatches));
      rg.emitJson(end(`f${fileIndex}.txt`));
    }
    await settle();
    expect(rg.killed).toBe(true);
    expect(dones).toEqual([{ searchId: 1, resultCount: MAX_SEARCH_RESULTS, fileCount: MAX_SEARCH_RESULTS / perFile, limitHit: true }]);
    expect(batches.flatMap((batch) => batch.files).reduce((sum, file) => sum + file.matches.length, 0)).toBe(MAX_SEARCH_RESULTS);
  });

  it('kills the running ripgrep on a new search and on Clear, and reports nothing for a killed one', async () => {
    const search = service();
    search.start(1, query(), true);
    await settle();
    spawned[0]!.emitJson(begin('a.txt'));
    search.start(2, query({ pattern: 'y' }), true);
    await settle();
    expect(spawned[0]!.killed).toBe(true);
    expect(search.recorded(1)).toBeUndefined();
    search.clear();
    await settle();
    expect(spawned[1]!.killed).toBe(true);
    expect(dones).toEqual([]);
    expect(batches).toEqual([]);
    expect(search.recorded(2)).toBeUndefined();
  });

  it('starts ripgrep 300 ms after the last query unless the query asks for now', async () => {
    vi.useFakeTimers();
    try {
      const search = service();
      search.start(1, query({ pattern: 'a' }), false);
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
      search.start(2, query({ pattern: 'ab' }), false);
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
      await vi.runAllTicks();
      expect(spawned).toHaveLength(0);
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      expect(spawned[0]!.args).toContain('ab');
      search.start(3, query({ pattern: 'abc' }), true);
      await vi.waitFor(() => expect(spawned).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a glob outside the folder and a window without a project, and admits open buffers by the globs', async () => {
    const search = service();
    expect(search.start(1, query({ include: 'src/**, ../x' }), true)).toEqual({ ok: false, error: 'invalidGlob', glob: '../x' });
    expect(service({ folder: () => undefined }).start(1, query(), true)).toEqual({ ok: false, error: 'noProject' });
    buffers = ['src/a.ts', 'src/gen/b.ts', 'node_modules/x/c.ts', 'lib/d.ts'].map((relativePath, index) => ({ documentId: `d${index}`, target: { kind: 'file', relativePath }, text: 'x' }));
    const admitted = async (searchId: number, overrides: Partial<SearchQuery>): Promise<string[]> => {
      batches = [];
      search.start(searchId, query({ ...overrides, onlyOpenEditors: true }), true);
      await settle();
      return paths(batches).sort();
    };
    expect(await admitted(2, { include: 'src', exclude: 'gen' })).toEqual(['src/a.ts']);
    expect(await admitted(3, {})).toEqual(['lib/d.ts', 'src/a.ts', 'src/gen/b.ts']);
    expect(await admitted(4, { useExcludeSettingsAndIgnoreFiles: false })).toEqual(['lib/d.ts', 'node_modules/x/c.ts', 'src/a.ts', 'src/gen/b.ts']);
    expect(spawned).toHaveLength(0);
    search.dispose();
  });

  it('refuses a glob whose matching against the open buffers\' paths backtracks for too long, instead of freezing main', () => {
    const started = Date.now();
    buffers = [{ documentId: 'd', target: { kind: 'file', relativePath: 'a'.repeat(40) }, text: '' }];
    const result = service().start(1, query({ include: '*a*a*a*a*a*a*a*a*a*a*a*a*b' }), false);
    expect(result).toEqual({ ok: false, error: 'invalidGlob', glob: '*a*a*a*a*a*a*a*a*a*a*a*a*b' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports a regex parse error from ripgrep', async () => {
    const search = service();
    search.start(1, query({ pattern: '(', isRegex: true }), true);
    await settle();
    spawned[0]!.stderr.write('regex parse error:\n    (\n    ^\nerror: unclosed group\n');
    spawned[0]!.close(2);
    await settle();
    expect(dones[0]).toMatchObject({ searchId: 1, resultCount: 0, error: expect.stringContaining('unclosed group') });
  });

  it('drops a path ripgrep prints outside its working directory', () => {
    expect(relativeResultPath('./src/a.ts', 'linux')).toBe('src/a.ts');
    expect(relativeResultPath('.\\src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(relativeResultPath('../outside.txt', 'linux')).toBeUndefined();
    expect(relativeResultPath('/etc/passwd', 'linux')).toBeUndefined();
    expect(relativeResultPath('C:\\x.txt', 'win32')).toBeUndefined();
  });
});

describe('search service with the bundled ripgrep', () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-search-')));
    project = path.join(root, 'proj');
    const files: Record<string, string> = {
      'src/a.ts': 'const value = 1;\n-flag here\n',
      'src/gen/b.ts': 'const value = 2;\n',
      'lib/c.ts': 'const value = 3;\n',
      'node_modules/pkg/d.js': 'const value = 4;\n',
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      fs.writeFileSync(path.join(project, file), text);
    }
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'secret.ts'), 'const value = 5;\n');
    fs.symlinkSync(path.join(root, 'outside'), path.join(project, 'linked'), 'junction');
    fs.symlinkSync(path.join(root, 'outside', 'secret.ts'), path.join(project, 'link.ts'), 'file');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(overrides: Partial<SearchQuery>): Promise<string[]> {
    return paths([{ files: await runFiles(overrides) }]).sort();
  }

  async function runFiles(overrides: Partial<SearchQuery>): Promise<SearchResultsBatch['files']> {
    const done = new Promise<void>((resolve) => {
      const search = new SearchService({
        folder: () => ({ projectKey: 'p', fsPath: project }),
        rgPath: () => resolveRgPath({ resourceRoot: process.cwd(), unpackedRoot: process.cwd() }),
        ignoreArgs: () => getRipgrepSearchOptions({ get: () => undefined } as never),
        excludeSettings: () => [...excludeSettingGlobs(DEFAULT_FILES_EXCLUDE), ...excludeSettingGlobs(DEFAULT_SEARCH_EXCLUDE)],
        settings: () => settings,
        buffers: () => buffers,
        sendResults: (batch) => batches.push(batch),
        sendFileUpdate: () => undefined,
        sendDone: (result) => {
          dones.push(result);
          resolve();
        },
        log: () => undefined,
      });
      search.start(1, query(overrides), true);
    });
    await done;
    expect(dones.at(-1)?.error).toBeUndefined();
    return batches.splice(0).flatMap((batch) => batch.files);
  }

  it('searches a pattern starting with - as text, skips node_modules unless the toggle is off, and never reads through links', async () => {
    expect(await run({ pattern: '-flag' })).toEqual(['src/a.ts']);
    expect(await run({ pattern: 'value' })).toEqual(['lib/c.ts', 'src/a.ts', 'src/gen/b.ts']);
    expect(await run({ pattern: 'value', useExcludeSettingsAndIgnoreFiles: false })).toEqual(['lib/c.ts', 'node_modules/pkg/d.js', 'src/a.ts', 'src/gen/b.ts']);
  });

  it('limits results by include and exclude globs', async () => {
    expect(await run({ pattern: 'value', include: 'src/**' })).toEqual(['src/a.ts', 'src/gen/b.ts']);
    expect(await run({ pattern: 'value', include: 'src', exclude: 'gen' })).toEqual(['src/a.ts']);
    expect(await run({ pattern: 'VALUE = \\d', isRegex: true, matchCase: false, include: '*.ts' })).toEqual(['lib/c.ts', 'src/a.ts', 'src/gen/b.ts']);
    expect(await run({ pattern: 'VALUE', matchCase: true })).toEqual([]);
  });

  it('matches a regex line break at CRLF and LF line endings alike, at the same ranges', async () => {
    fs.writeFileSync(path.join(project, 'crlf.txt'), 'foo\r\nbar\r\n\r\nend\r\n');
    fs.writeFileSync(path.join(project, 'lf.txt'), 'foo\nbar\n\nend\n');
    const ranges = async (pattern: string): Promise<Record<string, SearchRange[]>> => {
      const files = await runFiles({ pattern, isRegex: true, include: '*.txt' });
      return Object.fromEntries(files.map((file) => [file.kind === 'file' ? file.relativePath : file.title, file.matches.map((found) => found.range)]));
    };
    expect(await ranges('o\\nbar')).toEqual({
      'crlf.txt': [{ startLine: 1, startColumn: 3, endLine: 2, endColumn: 4 }],
      'lf.txt': [{ startLine: 1, startColumn: 3, endLine: 2, endColumn: 4 }],
    });
    expect(await ranges('^\\s*\\n')).toEqual({
      'crlf.txt': [{ startLine: 3, startColumn: 1, endLine: 4, endColumn: 1 }],
      'lf.txt': [{ startLine: 3, startColumn: 1, endLine: 4, endColumn: 1 }],
    });
    expect(await ranges('end[^\\n]')).toEqual({});
    expect(Object.keys(await ranges('(?<=o\\n)bar')).sort()).toEqual(['crlf.txt', 'lf.txt']);
  });
});

describe('search service over open buffers', () => {
  const buffer = (documentId: string, relativePath: string, text: string, mtimeMs?: number): BufferDocument => ({
    documentId,
    target: { kind: 'file', relativePath },
    text,
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
  });

  it('searches an open buffer instead of the disk and drops ripgrep\'s result for that file', async () => {
    buffers = [buffer('d1', 'src/a.ts', 'one needle\r\ntwo needle\r\n'), { documentId: 'u1', target: { kind: 'untitled', title: 'Untitled-1' }, text: 'needle' }];
    const search = service();
    search.start(1, query({ pattern: 'needle' }), true);
    await settle();
    const rg = spawned[0]!;
    rg.emitJson(begin('src/a.ts'));
    rg.emitJson(match('src/a.ts', 9, { text: 'disk needle\n' }, [[5, 11]]));
    rg.emitJson(end('src/a.ts'));
    rg.emitJson(begin('src/b.ts'));
    rg.emitJson(match('src/b.ts', 1, { text: 'needle\n' }, [[0, 6]]));
    rg.emitJson(end('src/b.ts'));
    rg.close(0);
    await settle();
    const files = batches.flatMap((batch) => batch.files);
    expect(files.map((file) => [file.kind, file.kind === 'file' ? file.relativePath : file.title, file.matches.map((m) => m.range.startLine)])).toEqual([
      ['file', 'src/a.ts', [1, 2]],
      ['untitled', 'Untitled-1', [1]],
      ['file', 'src/b.ts', [1]],
    ]);
    expect(files[0]).toMatchObject({ documentId: 'd1' });
    expect(files[1]).toEqual(expect.objectContaining({ kind: 'untitled', documentId: 'u1', title: 'Untitled-1' }));
    expect(files[1]).not.toHaveProperty('relativePath');
    expect(search.recorded(1)?.matches.get(files[0]!.matches[0]!.id)).toMatchObject({ documentId: 'd1', file: { kind: 'file', relativePath: 'src/a.ts' }, text: 'needle' });
    expect(dones).toEqual([{ searchId: 1, resultCount: 4, fileCount: 3, limitHit: false }]);
  });

  it('searches only the open buffers for Search only in Open Editors, and never starts ripgrep', async () => {
    buffers = [buffer('d1', 'src/a.ts', 'needle')];
    const search = service();
    search.start(1, query({ pattern: 'needle', onlyOpenEditors: true }), true);
    await settle();
    expect(spawned).toHaveLength(0);
    expect(paths(batches)).toEqual(['src/a.ts']);
    expect(dones).toEqual([{ searchId: 1, resultCount: 1, fileCount: 1, limitHit: false }]);
  });

  it('applies smart case to ripgrep and the buffers alike', async () => {
    settings = { ...settings, smartCase: true };
    buffers = [buffer('d1', 'a.ts', 'Needle needle')];
    const search = service();
    search.start(1, query({ pattern: 'Needle' }), true);
    await settle();
    expect(spawned[0]!.args).toContain('--case-sensitive');
    spawned[0]!.close(1);
    await settle();
    expect(batches[0]!.files[0]!.matches).toHaveLength(1);
    expect(batches[0]!.matchCase).toBe(true);
    search.start(2, query({ pattern: 'needle' }), true);
    await settle();
    expect(spawned[1]!.args).toContain('--ignore-case');
    spawned[1]!.close(1);
    await settle();
    expect(batches[1]!.matchCase).toBe(false);
  });

  it('reports a regex JavaScript cannot compile, searching no buffer, and one that runs out of time', async () => {
    buffers = [buffer('d1', 'a.ts', `${'a'.repeat(40)}b`)];
    const search = service();
    search.start(1, query({ pattern: '(?<x', isRegex: true, onlyOpenEditors: true }), true);
    await settle();
    expect(dones.at(-1)).toMatchObject({ resultCount: 0, bufferWarning: 'unsupportedRegex' });
    const started = Date.now();
    search.start(2, query({ pattern: '(a|aa)*c', isRegex: true, onlyOpenEditors: true }), true);
    await settle();
    expect(dones.at(-1)).toMatchObject({ searchId: 2, resultCount: 0, bufferWarning: 'timedOut' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('matches a multi-line regex in an unsaved CRLF buffer where it matches in the LF one, recording the CRLF text', async () => {
    const lf = 'foo\nbar\n\nend\n';
    buffers = [buffer('d1', 'crlf.ts', lf.replace(/\n/g, '\r\n')), buffer('d2', 'lf.ts', lf)];
    const search = service();
    let searchId = 0;
    const found = async (pattern: string) => {
      search.start(++searchId, query({ pattern, isRegex: true, onlyOpenEditors: true }), true);
      await settle();
      const files = batches.splice(0).flatMap((batch) => batch.files);
      const recorded = search.recorded(searchId)!.matches;
      return Object.fromEntries(files.map((file) => [file.kind === 'file' ? file.relativePath : file.title, file.matches.map((match) => ({ range: match.range, text: recorded.get(match.id)!.text }))]));
    };
    expect(await found('o\\nbar')).toEqual({
      'crlf.ts': [{ range: { startLine: 1, startColumn: 3, endLine: 2, endColumn: 4 }, text: 'o\r\nbar' }],
      'lf.ts': [{ range: { startLine: 1, startColumn: 3, endLine: 2, endColumn: 4 }, text: 'o\nbar' }],
    });
    expect(await found('^\\s*\\n')).toEqual({
      'crlf.ts': [{ range: { startLine: 3, startColumn: 1, endLine: 4, endColumn: 1 }, text: '\r\n' }],
      'lf.ts': [{ range: { startLine: 3, startColumn: 1, endLine: 4, endColumn: 1 }, text: '\n' }],
    });
    expect(await found('d[^\\n]')).toEqual({});
  });

  it('finds a buffer\'s matches per line, across lines only for a multi-line pattern, empty ones advancing', () => {
    const global = (pattern: string): RegExp => new RegExp(pattern, 'gmu');
    expect(findBufferMatches('ab\r\nab', { pattern: 'b$', isRegex: true }, global('b$'), 10).map((m) => m.range)).toEqual([
      { startLine: 1, startColumn: 2, endLine: 1, endColumn: 3 },
      { startLine: 2, startColumn: 2, endLine: 2, endColumn: 3 },
    ]);
    expect(findBufferMatches('a\nb', { pattern: 'a\\nb', isRegex: true }, global('a\\nb'), 10).map((m) => m.range)).toEqual([{ startLine: 1, startColumn: 1, endLine: 2, endColumn: 2 }]);
    expect(findBufferMatches('😀x', { pattern: 'y*', isRegex: true }, global('y*'), 10)).toHaveLength(3);
    expect(findBufferMatches('aaaa', { pattern: 'a', isRegex: true }, global('a'), 2)).toHaveLength(2);
  });

  it('reads each result file\'s modification time only for the modified sort order', async () => {
    settings = { ...settings, sortOrder: 'modified' };
    buffers = [buffer('d1', 'open.ts', 'needle', 42)];
    const stats: string[] = [];
    const search = service({ mtime: async (fsPath) => { stats.push(fsPath); return 7; } });
    search.start(1, query({ pattern: 'needle' }), true);
    await settle();
    spawned[0]!.emitJson(begin('src/a.ts'));
    spawned[0]!.emitJson(match('src/a.ts', 1, { text: 'needle\n' }, [[0, 6]]));
    spawned[0]!.emitJson(end('src/a.ts'));
    spawned[0]!.close(0);
    await settle();
    expect(batches.flatMap((batch) => batch.files).map((file) => (file.kind === 'file' ? [file.relativePath, file.mtimeMs] : []))).toEqual([['open.ts', 42], ['src/a.ts', 7]]);
    expect(stats).toEqual([path.join('/proj', 'src', 'a.ts')]);
    settings = { ...settings, sortOrder: 'default' };
    batches = [];
    search.start(2, query({ pattern: 'needle', onlyOpenEditors: true }), true);
    await settle();
    expect(batches[0]!.files[0]).not.toHaveProperty('mtimeMs');
  });

  it('stops ripgrep on Cancel Search, keeps what it sent and says it was cancelled', async () => {
    const search = service();
    search.start(1, query({ pattern: 'needle' }), true);
    await settle();
    spawned[0]!.emitJson(begin('a.ts'));
    spawned[0]!.emitJson(match('a.ts', 1, { text: 'needle\n' }, [[0, 6]]));
    spawned[0]!.emitJson(end('a.ts'));
    await settle();
    search.cancel();
    await settle();
    expect(spawned[0]!.killed).toBe(true);
    expect(dones).toEqual([{ searchId: 1, resultCount: 1, fileCount: 1, limitHit: false, cancelled: true }]);
    expect(search.recorded(1)?.matches.size).toBe(1);
    expect(search.viewState()).toEqual({ hasSearch: true, hasResults: true, running: false });
  });

  it('refuses a search id that does not grow, so a stale request never replaces a newer search', () => {
    const search = service();
    search.start(5, query(), false);
    expect(() => search.start(5, query(), false)).toThrow('Stale search id');
    search.dispose();
  });
});

describe('live updates and dismissals', () => {
  const doc = (text: string): BufferDocument => ({ documentId: 'd1', target: { kind: 'file', relativePath: 'a.ts' }, text });

  async function started(text: string): Promise<SearchService> {
    buffers = [doc(text)];
    const search = service();
    search.start(1, query({ pattern: 'needle', onlyOpenEditors: true }), true);
    await settle();
    return search;
  }

  it('searches an open result file again 250 ms after its text changes, as VS Code\'s FileMatch does', async () => {
    const search = await started('needle');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      buffers = [doc('needle needle')];
      search.documentChanged('d1');
      vi.advanceTimersByTime(LIVE_UPDATE_MS - 1);
      expect(updates).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.key).toEqual({ kind: 'file', relativePath: 'a.ts' });
      expect(updates[0]!.file?.matches).toHaveLength(2);
      buffers = [doc('nothing')];
      search.documentChanged('d1');
      vi.advanceTimersByTime(LIVE_UPDATE_MS);
      expect(updates[1]!.file).toBeNull();
      buffers = [doc('needle')];
      search.documentChanged('d1');
      vi.advanceTimersByTime(LIVE_UPDATE_MS);
      expect(updates[2]!.file?.matches).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a dismissed match out of a live re-search, keyed by its range and text, and a dismissed file out entirely', async () => {
    const search = await started('needle needle');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const [first, second] = batches[0]!.files[0]!.matches;
      search.dismiss(1, [first!.id], []);
      expect(updates.at(-1)!.file?.matches.map((m) => m.id)).toEqual([second!.id]);
      expect(search.recorded(1)?.matches.has(first!.id)).toBe(false);
      buffers = [doc('needle needle!')];
      search.documentChanged('d1');
      vi.advanceTimersByTime(LIVE_UPDATE_MS);
      expect(updates.at(-1)!.file?.matches.map((m) => m.range.startColumn)).toEqual([8]);
      search.dismiss(1, [], [{ kind: 'file', relativePath: 'a.ts' }]);
      expect(updates.at(-1)!.file).toBeNull();
      const count = updates.length;
      search.documentChanged('d1');
      vi.advanceTimersByTime(LIVE_UPDATE_MS);
      expect(updates).toHaveLength(count);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes replaced matches out of the results and refuses an unknown match or file', async () => {
    const search = await started('needle needle');
    const [first] = batches[0]!.files[0]!.matches;
    search.replaced(1, [first!.id]);
    expect(updates.at(-1)!.file?.matches).toHaveLength(1);
    expect(() => search.dismiss(1, [999], [])).toThrow('Unknown match id');
    expect(() => search.dismiss(1, [], [{ kind: 'untitled', documentId: 'nope' }])).toThrow('Unknown result file');
    expect(() => search.dismiss(2, [], [])).toThrow('Unknown or superseded search');
  });

  it('copies matches, files and everything in VS Code\'s layout', async () => {
    buffers = [doc('a needle'), { documentId: 'u1', target: { kind: 'untitled', title: 'Untitled-1' }, text: 'needle' }];
    const search = service();
    search.start(1, query({ pattern: 'needle', onlyOpenEditors: true }), true);
    await settle();
    const pathOf = (key: { kind: string; relativePath?: string }, title: string | undefined): string => (key.kind === 'file' ? `/proj/${key.relativePath}` : title ?? '');
    const [file] = batches[0]!.files;
    expect(search.copyText(1, { kind: 'matches', matchIds: [file!.matches[0]!.id] }, pathOf as never, '\n')).toBe('1,3: a needle');
    expect(search.copyText(1, { kind: 'files', files: [{ kind: 'file', relativePath: 'a.ts' }] }, pathOf as never, '\n')).toBe('/proj/a.ts\n  1,3: a needle');
    expect(search.copyText(1, { kind: 'all' }, pathOf as never, '\r\n')).toBe('/proj/a.ts\r\n  1,3: a needle\r\n\r\nUntitled-1\r\n  1,1: needle');
  });
});

describe('Search Editor runs', () => {
  async function editorRun(contextLines: number, emit: (rg: FakeRg) => void): Promise<EditorRunResult> {
    const search = service();
    let result: EditorRunResult | undefined;
    search.startEditor('e1', { projectKey: 'p', fsPath: '/proj' }, query({ pattern: 'needle' }), contextLines, (done) => { result = done; });
    await settle();
    emit(spawned.at(-1)!);
    await settle();
    return result!;
  }

  it('asks ripgrep for the context lines and keeps its context events by line number', async () => {
    const result = await editorRun(1, (rg) => {
      rg.emitJson(begin('a.ts'));
      rg.emitJson({ type: 'context', data: { path: { text: 'a.ts' }, lines: { text: 'before\r\n' }, line_number: 4 } });
      rg.emitJson(match('a.ts', 5, { text: 'a needle\r\n' }, [[2, 8]]));
      rg.emitJson({ type: 'context', data: { path: { text: 'a.ts' }, lines: { text: 'after\n' }, line_number: 6 } });
      rg.emitJson(end('a.ts'));
      rg.close(0);
    });
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(['--before-context', '1', '--after-context', '1']));
    expect(result.files).toHaveLength(1);
    expect([...result.files[0]!.context]).toEqual([[4, 'before'], [6, 'after']]);
    expect(result.files[0]!.matches).toEqual([{ range: { startLine: 5, startColumn: 3, endLine: 5, endColumn: 9 }, previewLines: ['a needle'], previewStart: 3, previewEnd: 9 }]);
    expect(dones).toEqual([]);
  });

  it('takes the context of an open buffer from its lines, as VS Code\'s model context does', async () => {
    buffers = [{ documentId: 'd1', target: { kind: 'file', relativePath: 'a.ts' }, text: 'l1\nl2\nneedle\nl4\nl5\nl6\nneedle\n' }];
    const search = service();
    let result: EditorRunResult | undefined;
    search.startEditor('e1', { projectKey: 'p', fsPath: '/proj' }, query({ pattern: 'needle', onlyOpenEditors: true }), 1, (done) => { result = done; });
    await settle();
    expect([...result!.files[0]!.context].sort((a, b) => a[0] - b[0])).toEqual([[2, 'l2'], [4, 'l4'], [6, 'l6'], [8, '']]);
  });

  it('runs one search per owner: a Search Editor run leaves the view\'s running', async () => {
    const search = service();
    search.start(1, query(), true);
    search.startEditor('e1', { projectKey: 'p', fsPath: '/proj' }, query(), 0, () => undefined);
    await settle();
    expect(spawned).toHaveLength(2);
    search.startEditor('e1', { projectKey: 'p', fsPath: '/proj' }, query(), 0, () => undefined);
    await settle();
    expect(spawned.map((rg) => rg.killed)).toEqual([false, true, false]);
    search.discardEditor('e1');
    expect(spawned[2]!.killed).toBe(true);
    expect(spawned[0]!.killed).toBe(false);
  });
});

describe('memory a run keeps', () => {
  const collect = ((): (() => void) => {
    v8.setFlagsFromString('--expose-gc');
    return vm.runInNewContext('gc') as () => void;
  })();
  // Heap plus external memory, where Node keeps a string decoded from a large buffer and frees it one collection late.
  const used = (): number => {
    collect();
    collect();
    const usage = process.memoryUsage();
    return usage.heapUsed + usage.external;
  };
  const LINE_CHARS = 2_000_000;
  const FILES = 20;
  // A minified file's one line, with a short match in the middle and a different text per file.
  const minified = (index: number): string => `${'x'.repeat(LINE_CHARS / 2)}needle${index}${'y'.repeat(LINE_CHARS / 2)}\n`;

  async function emitMinified(rg: FakeRg, context: boolean): Promise<void> {
    for (let index = 0; index < FILES; index++) {
      const file = `dist/f${index}.js`;
      rg.emitJson(begin(file));
      if (context) rg.emitJson({ type: 'context', data: { path: { text: file }, lines: { text: minified(index + FILES) }, line_number: 1 } });
      rg.emitJson(match(file, 2, { text: minified(index) }, [[LINE_CHARS / 2, LINE_CHARS / 2 + 6]]));
      rg.emitJson(end(file));
      await settle();
    }
    rg.close(0);
    await settle();
  }

  it('holds a preview of a match on a long minified line, never the line', async () => {
    const search = service();
    search.start(1, query({ pattern: 'needle' }), true);
    await settle();
    const before = used();
    await emitMinified(spawned[0]!, false);
    expect(dones).toEqual([{ searchId: 1, resultCount: FILES, fileCount: FILES, limitHit: false }]);
    expect(search.recorded(1)!.matches.get(0)).toMatchObject({ text: 'needle', line: expect.stringMatching(/^x{50}needle0y{193}$/) });
    expect(used() - before).toBeLessThan((LINE_CHARS * FILES) / 8);
  });

  it('holds a long match as its length and hash for replace, never its text', async () => {
    const search = service();
    search.start(1, query({ pattern: 'x+', isRegex: true }), true);
    await settle();
    const before = used();
    const rg = spawned[0]!;
    for (let index = 0; index < FILES; index++) {
      const file = `dist/f${index}.js`;
      rg.emitJson(begin(file));
      rg.emitJson(match(file, 1, { text: minified(index) }, [[0, LINE_CHARS / 2]]));
      rg.emitJson(end(file));
      await settle();
    }
    rg.close(0);
    await settle();
    expect(dones).toEqual([{ searchId: 1, resultCount: FILES, fileCount: FILES, limitHit: false }]);
    expect(search.recorded(1)!.matches.get(0)!.text).toEqual({ length: LINE_CHARS / 2, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(used() - before).toBeLessThan((LINE_CHARS * FILES) / 8);
  });

  it('holds a Search Editor\'s previews and context lines, never the lines they were cut from', async () => {
    const search = service();
    let result: EditorRunResult | undefined;
    search.startEditor('e1', { projectKey: 'p', fsPath: '/proj' }, query({ pattern: 'needle' }), 1, (done) => { result = done; });
    await settle();
    const before = used();
    await emitMinified(spawned[0]!, true);
    expect(result!.files).toHaveLength(FILES);
    expect(used() - before).toBeLessThan((2 * LINE_CHARS * FILES) / 8);
  });
});

describe('what main takes from ripgrep', () => {
  it('drops an event line past the bound without throwing, says the results are a subset, and reads on', async () => {
    const search = service();
    search.start(1, query({ pattern: 'needle' }), true);
    await settle();
    const rg = spawned[0]!;
    rg.emitJson(begin('big.txt'));
    rg.emitJson(match('big.txt', 1, { text: `needle${'x'.repeat(MAX_RG_EVENT_BYTES)}\n` }, [[0, 6]]));
    rg.emitJson(end('big.txt'));
    rg.emitJson(begin('small.txt'));
    rg.emitJson(match('small.txt', 1, { text: 'needle\n' }, [[0, 6]]));
    rg.emitJson(end('small.txt'));
    rg.close(0);
    await settle();
    expect(paths(batches)).toEqual(['small.txt']);
    expect(dones).toEqual([{ searchId: 1, resultCount: 1, fileCount: 1, limitHit: true }]);
  });

  it('reads a file whose modification time cannot be read as having none', async () => {
    expect(await lstatMtime('a\0b')).toBeUndefined();
    expect(await lstatMtime(path.join(os.tmpdir(), 'dm-no-such-file'))).toBeUndefined();
  });
});

describe('Search Editor run budget', () => {
  it('stops a run whose previews and context lines pass the editor\'s text limit, as at the result limit', async () => {
    const search = service();
    let result: EditorRunResult | undefined;
    search.startEditor('e1', { projectKey: 'p', fsPath: '/proj' }, query({ pattern: 'needle' }), 100, (done) => { result = done; });
    await settle();
    const rg = spawned[0]!;
    const long = 'c'.repeat(5000);
    rg.emitJson(begin('a.ts'));
    for (let line = 1; line <= 30_000; line++) rg.emitJson({ type: 'context', data: { path: { text: 'a.ts' }, lines: { text: `${long}\n` }, line_number: line } });
    rg.emitJson(match('a.ts', 30_001, { text: 'needle\n' }, [[0, 6]]));
    rg.emitJson(end('a.ts'));
    rg.close(0);
    await settle();
    expect(result?.limitHit).toBe(true);
    expect(rg.killed).toBe(true);
    const held = result!.files.reduce((sum, file) => sum + [...file.context.values()].reduce((chars, line) => chars + line.length, 0), 0);
    expect(held).toBeLessThanOrEqual(10 * 1024 * 1024 + 1000);
  });
});
