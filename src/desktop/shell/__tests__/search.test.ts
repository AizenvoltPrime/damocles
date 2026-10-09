// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SearchFileResult, SearchMatch, SearchQuery, SearchViewState, ShellDocumentContent, ShellEditorState, ShellEditorTab, ShellSearchSettings } from '../../preload/shell-channels';
import type { PaletteCommand } from '../../preload/overlay-channels';
import { createEditorStore, type BufferReplaceResult, type EditorStore, type ShellMonacoModule } from '../editor/editor-store';
import { DEFAULT_SEARCH_VIEW, QUERY_HISTORY_DELAY_MS, createSearchStore, insertedText, type ResultRow } from '../search/search-store';
import { createInputHistory } from '../search/search-history';
import { fileTypeGlob, mergeGlob } from '../search/search-globs';
import { buildNodes, flattenRows, startsCollapsed, type TreeFile } from '../search/search-tree';
import { comparePaths } from '../../../shared/text-search';
import { searchResultLanguage } from '../editor/search-result-language';
import { ariaKeyshortcuts, commandsModel, keycaps } from '../overlay/quick-pick';
import { EDITOR_STATE, SEARCH_SETTINGS, fakeShellApi } from './fakes';

const VIEW: SearchViewState = { ...DEFAULT_SEARCH_VIEW, pattern: 'foo' };
const QUERY: SearchQuery = { pattern: 'foo', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false };

const match = (id: number, line: number, text = 'a foo b'): SearchMatch => ({
  id,
  range: { startLine: line, startColumn: 3, endLine: line, endColumn: 6 },
  preview: { text, matchStart: 2, matchEnd: 5 },
});
const file = (relativePath: string, ...matches: SearchMatch[]): SearchFileResult => ({ kind: 'file', relativePath, matches });
const buffer = (relativePath: string, documentId: string, ...matches: SearchMatch[]): SearchFileResult => ({ kind: 'file', relativePath, documentId, matches });
const untitled = (documentId: string, title: string, ...matches: SearchMatch[]): SearchFileResult => ({ kind: 'untitled', documentId, title, matches });

// The editor store's search surface, so the search store's replace split and opening are tested on their own.
function fakeEditor() {
  return {
    flushAll: vi.fn(),
    tabOfDocument: vi.fn((documentId: string) => ({ id: `t-${documentId}` }) as ShellEditorTab),
    tabOfFile: vi.fn((_projectKey: string, relativePath: string) => (relativePath === 'opened-later.ts' ? ({ id: 't-later', documentId: 'd-later' }) as ShellEditorTab : undefined)),
    trackSearchRanges: vi.fn(async (_documentId: string, ranges: readonly unknown[]) => ranges.map((_range, index) => `dec-${index}`)),
    clearSearchTracking: vi.fn(),
    replaceInBuffer: vi.fn(async (): Promise<BufferReplaceResult> => ({ ok: true, replaced: 1 })),
    revealRange: vi.fn(),
    requestFocus: vi.fn(),
    selectRanges: vi.fn(),
  };
}

function searchSetup(settings: Partial<ShellSearchSettings> = {}) {
  const api = fakeShellApi();
  const editor = fakeEditor();
  const current = { ...SEARCH_SETTINGS, ...settings };
  const store = createSearchStore(api, editor, () => current);
  store.start();
  store.setProject('p1', VIEW);
  return { api, editor, store, settings: current };
}

const paths = (store: ReturnType<typeof createSearchStore>): string[] => store.files.value.map((entry) => entry.relativePath);
const keys = (store: ReturnType<typeof createSearchStore>): string[] => store.rows.value.map((row) => row.key);
// The searchId the shell issued for its latest search:start.
const sid = (api: ReturnType<typeof fakeShellApi>): number => vi.mocked(api.startSearch).mock.calls.at(-1)![0].searchId;
const rowOf = (store: ReturnType<typeof createSearchStore>, key: string): ResultRow => store.rows.value.find((row) => row.key === key)!;

describe('search store', () => {
  it('flushes pending edits, streams batches of the current search and drops a stale search\'s', async () => {
    const { api, editor, store } = searchSetup();
    await store.run(false);
    const first = sid(api);
    expect(editor.flushAll).toHaveBeenCalledBefore(vi.mocked(api.startSearch));
    expect(api.startSearch).toHaveBeenCalledWith({ searchId: first, query: QUERY, immediate: false });
    api.searchResults({ searchId: first, matchCase: false, files: [file('a.ts', match(1, 1), match(2, 4))] });
    api.searchResults({ searchId: first - 1, matchCase: false, files: [file('stale.ts', match(9, 1))] });
    api.searchResults({ searchId: first, matchCase: false, files: [file('src/b.ts', match(3, 2))] });
    expect(paths(store)).toEqual(['a.ts', 'src/b.ts']);
    expect([store.resultCount.value, store.fileCount.value]).toEqual([3, 2]);
    expect(keys(store)).toEqual(['f:a.ts', 'm:1', 'm:2', 'f:src/b.ts', 'm:3']);
    api.searchDone({ searchId: first, resultCount: 3, fileCount: 2, limitHit: true });
    expect(store.status.value).toEqual({ kind: 'done', limitHit: true, cancelled: false });

    await store.run(true);
    expect(api.startSearch).toHaveBeenLastCalledWith(expect.objectContaining({ immediate: true }));
    expect(sid(api)).toBeGreaterThan(first);
    api.searchResults({ searchId: first, matchCase: false, files: [file('late.ts', match(4, 1))] });
    expect(paths(store)).toEqual([]);
  });

  it('applies main\'s live file updates and dismissals, and Cancel keeps the results', async () => {
    const { api, store } = searchSetup();
    await store.run(false);
    api.searchResults({ searchId: sid(api), matchCase: false, files: [file('a.ts', match(1, 1), match(2, 2)), untitled('u1', 'Untitled-1', match(3, 1))] });
    await store.dismiss(rowOf(store, 'm:1'));
    expect(api.dismissSearch).toHaveBeenLastCalledWith({ searchId: sid(api), matchIds: [1], files: [] });
    // The shell removes nothing itself: main's update is what changes the rows.
    expect(store.resultCount.value).toBe(3);
    api.searchFileUpdate({ searchId: sid(api), matchCase: false, key: { kind: 'file', relativePath: 'a.ts' }, file: file('a.ts', match(2, 2)) });
    expect(keys(store)).toEqual(['f:a.ts', 'm:2', 'f:untitled:u1', 'm:3']);
    await store.dismiss(rowOf(store, 'f:untitled:u1'));
    expect(api.dismissSearch).toHaveBeenLastCalledWith({ searchId: sid(api), matchIds: [], files: [{ kind: 'untitled', documentId: 'u1' }] });
    api.searchFileUpdate({ searchId: sid(api), matchCase: false, key: { kind: 'untitled', documentId: 'u1' }, file: null });
    expect(paths(store)).toEqual(['a.ts']);
    await store.cancel();
    expect(api.cancelSearch).toHaveBeenCalledTimes(1);
    api.searchDone({ searchId: sid(api), resultCount: 1, fileCount: 1, limitHit: false, cancelled: true });
    expect(store.status.value).toMatchObject({ kind: 'done', cancelled: true });
    expect(paths(store)).toEqual(['a.ts']);
    await store.cancel();
    expect(api.cancelSearch).toHaveBeenCalledTimes(1);
  });

  it('Replace All asks with the totals and, declined, changes nothing', async () => {
    const { api, editor, store } = searchSetup();
    vi.mocked(api.confirmReplace).mockResolvedValueOnce(false);
    await store.run(false);
    api.searchResults({ searchId: sid(api), matchCase: false, files: [buffer('open.ts', 'd-open', match(1, 1)), file('closed.ts', match(2, 1), match(3, 2))] });
    store.replacement.value = 'bar';
    expect(await store.replaceAll()).toBeUndefined();
    expect(api.confirmReplace).toHaveBeenCalledWith({ occurrences: 3, files: 2, replacement: 'bar' });
    expect(editor.replaceInBuffer).not.toHaveBeenCalled();
    expect(api.replaceInFiles).not.toHaveBeenCalled();
  });

  it('replaces buffer results in their buffers with the tracked ranges and Preserve Case, and only closed files through main', async () => {
    const { api, editor, store } = searchSetup();
    await store.run(false);
    api.searchResults({ searchId: sid(api), matchCase: false, files: [buffer('open.ts', 'd-open', match(1, 1)), untitled('u1', 'Untitled-1', match(4, 1)), file('closed.ts', match(2, 1)), file('src/x.ts', match(3, 1)), file('opened-later.ts', match(5, 1))] });
    await vi.waitFor(() => expect(editor.trackSearchRanges).toHaveBeenCalledTimes(2));
    store.replacement.value = 'Bar';
    store.view.value = { ...store.view.value, preserveCase: true };
    await store.replaceAll();
    expect(editor.replaceInBuffer).toHaveBeenCalledWith('d-open', [{ range: match(1, 1).range, decorationId: 'dec-0' }], 'Bar', QUERY, true);
    expect(editor.replaceInBuffer).toHaveBeenCalledWith('u1', [{ range: match(4, 1).range, decorationId: 'dec-0' }], 'Bar', QUERY, true);
    // Found on disk, opened since: its buffer takes the replace, at the recorded range.
    expect(editor.replaceInBuffer).toHaveBeenCalledWith('d-later', [{ range: match(5, 1).range, text: 'foo' }], 'Bar', QUERY, true);
    expect(api.replaceInFiles).toHaveBeenCalledWith({ searchId: sid(api), replacement: 'Bar', preserveCase: true, matchIds: [2, 3] });
  });

  it('replaces in a file opened since the search with the case main searched with, against the text it recorded', async () => {
    const { api, editor, store } = searchSetup();
    store.view.value = { ...store.view.value, pattern: 'Foo' };
    await store.run(false);
    api.searchResults({ searchId: sid(api), matchCase: true, files: [file('opened-later.ts', match(5, 1))] });
    store.replacement.value = 'bar';
    await store.replaceAll();
    expect(editor.replaceInBuffer).toHaveBeenCalledWith('d-later', [{ range: match(5, 1).range, text: 'foo' }], 'bar', { ...QUERY, pattern: 'Foo', matchCase: true }, false);
  });

  it('takes a batch of many files with one copy of the results per batch', async () => {
    const { api, store } = searchSetup();
    await store.run(false);
    const files = Array.from({ length: 20_000 }, (_, index) => file(`f${index}.ts`, match(index, 1)));
    const started = performance.now();
    api.searchResults({ searchId: sid(api), matchCase: false, files });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(store.fileCount.value).toBe(20_000);
  });

  it('compiles the row preview\'s regular expression once per search, with the case main searched with', async () => {
    const { api, store } = searchSetup();
    store.view.value = { ...store.view.value, pattern: 'Foo' };
    await store.run(false);
    const first = store.previewRegExp.value;
    expect(first?.flags).toContain('i');
    expect(store.previewRegExp.value).toBe(first);
    api.searchResults({ searchId: sid(api), matchCase: true, files: [file('a.ts', match(1, 1))] });
    expect(store.previewRegExp.value?.flags).not.toContain('i');
  });

  it('Replace All in Folder sends the folder\'s match ids only, and a skipped buffer is reported', async () => {
    const { api, editor, store } = searchSetup();
    store.view.value = { ...store.view.value, viewMode: 'tree' };
    await store.run(false);
    api.searchResults({ searchId: sid(api), matchCase: false, files: [file('src/a.ts', match(1, 1)), file('src/deep/b.ts', match(2, 1), match(3, 2)), file('top.ts', match(4, 1)), buffer('src/open.ts', 'd-open', match(5, 1))] });
    editor.replaceInBuffer.mockResolvedValueOnce({ ok: false, reason: 'changed' });
    const result = await store.replaceRow(rowOf(store, 'd:src'));
    // The folder's files in tree order (its subfolder first); top.ts is outside it and the buffer goes to the editor.
    expect(api.replaceInFiles).toHaveBeenCalledWith(expect.objectContaining({ matchIds: [2, 3, 1] }));
    expect(result).toEqual({ bufferSkipped: [{ name: 'src/open.ts', reason: 'changed' }] });
  });

  it('opens a match shown with focus kept, Enter with focus, to the side, an untitled buffer by its tab, and in replace mode the preview by ids', async () => {
    const { api, editor, store, settings } = searchSetup();
    await store.run(false);
    api.searchResults({ searchId: sid(api), matchCase: false, files: [file('a.ts', match(1, 4), match(7, 9)), file('notes.md', match(2, 1)), untitled('u1', 'Untitled-1', match(3, 1))] });
    const matchRow = rowOf(store, 'm:1') as Extract<ResultRow, { kind: 'match' }>;
    await store.open(matchRow, { focus: false, toSide: false });
    expect(api.openEditor).toHaveBeenLastCalledWith({ projectKey: 'p1', relativePath: 'a.ts', preserveFocus: true, toSide: false });
    expect(editor.revealRange).toHaveBeenCalledWith('t1', match(1, 4).range, undefined);
    await store.open(rowOf(store, 'm:2') as Extract<ResultRow, { kind: 'match' }>, { focus: true, toSide: true });
    expect(api.openEditor).toHaveBeenLastCalledWith({ projectKey: 'p1', relativePath: 'notes.md', as: 'source', preserveFocus: false, toSide: true });
    // An untitled buffer has no path: its tab is activated by document id and openEditor is never called with it.
    vi.mocked(api.openEditor).mockClear();
    await store.open(rowOf(store, 'm:3') as Extract<ResultRow, { kind: 'match' }>, { focus: true, toSide: false });
    expect(api.openEditor).not.toHaveBeenCalled();
    expect(api.editorTab).toHaveBeenLastCalledWith({ action: 'activate', tabId: 't-u1' });
    expect(editor.requestFocus).toHaveBeenCalledWith('t-u1');

    store.view.value = { ...store.view.value, replaceOpen: true, preserveCase: true };
    store.replacement.value = 'bar';
    await store.open(matchRow, { focus: false, toSide: false });
    expect(api.previewReplace).toHaveBeenLastCalledWith({ searchId: sid(api), replacement: 'bar', preserveCase: true, matchIds: [1, 7] });
    vi.mocked(api.previewReplace).mockResolvedValueOnce({ ok: false, reason: 'readOnly' });
    expect(await store.open(matchRow, { focus: false, toSide: false })).toBe('readOnly');
    // search.useReplacePreview off: replace mode opens the file itself.
    settings.useReplacePreview = false;
    vi.mocked(api.previewReplace).mockClear();
    await store.open(matchRow, { focus: false, toSide: false });
    expect(api.previewReplace).not.toHaveBeenCalled();
  });

  it('groups by folder in tree mode with compressed chains, folders first, and keeps list mode flat', async () => {
    const { api, store } = searchSetup();
    await store.run(false);
    api.searchResults({ searchId: sid(api), matchCase: false, files: [file('src/app/main.ts', match(1, 1)), file('src/app/util.ts', match(2, 1)), file('readme.md', match(3, 1)), file('lib/x/y/z.ts', match(4, 1))] });
    expect(keys(store)).toEqual(['f:readme.md', 'm:3', 'f:lib/x/y/z.ts', 'm:4', 'f:src/app/main.ts', 'm:1', 'f:src/app/util.ts', 'm:2']);
    store.view.value = { ...store.view.value, viewMode: 'tree' };
    expect(keys(store)).toEqual(['d:lib/x/y', 'f:lib/x/y/z.ts', 'm:4', 'd:src/app', 'f:src/app/main.ts', 'm:1', 'f:src/app/util.ts', 'm:2', 'f:readme.md', 'm:3']);
    const folder = rowOf(store, 'd:lib/x/y');
    expect(folder).toMatchObject({ kind: 'folder', level: 1, node: { label: 'lib/x/y', count: 1 } });
    expect(rowOf(store, 'm:4').level).toBe(3);
  });

  it('collapses per search.collapseResults when a row first appears, keeps the user\'s state, and expands a lone file on done', async () => {
    const { api, store } = searchSetup({ collapseResults: 'auto' });
    await store.run(false);
    const many = Array.from({ length: 11 }, (_, index) => match(10 + index, index + 1));
    api.searchResults({ searchId: sid(api), matchCase: false, files: [file('big.ts', ...many)] });
    await vi.waitFor(() => expect(store.collapsed.value.has('f:big.ts')).toBe(true));
    api.searchDone({ searchId: sid(api), resultCount: 11, fileCount: 1, limitHit: false });
    expect(store.collapsed.value.has('f:big.ts')).toBe(false);
    api.searchResults({ searchId: sid(api), matchCase: false, files: [file('small.ts', match(1, 1))] });
    store.toggleCollapsed('f:small.ts');
    api.searchFileUpdate({ searchId: sid(api), matchCase: false, key: { kind: 'file', relativePath: 'small.ts' }, file: file('small.ts', match(1, 1), match(2, 2)) });
    await vi.waitFor(() => expect(store.collapsed.value.has('f:small.ts')).toBe(true));
  });

  it('Collapse All folds files while matches show, then every node; Expand All opens everything', async () => {
    const { api, store } = searchSetup();
    store.view.value = { ...store.view.value, viewMode: 'tree' };
    await store.run(false);
    api.searchResults({ searchId: sid(api), matchCase: false, files: [file('src/a.ts', match(1, 1)), file('src/b.ts', match(2, 1))] });
    expect(store.anyExpanded.value).toBe(true);
    store.collapseAll();
    expect(keys(store)).toEqual(['d:src', 'f:src/a.ts', 'f:src/b.ts']);
    store.collapseAll();
    expect(keys(store)).toEqual(['d:src']);
    expect(store.anyExpanded.value).toBe(false);
    store.expandAll();
    expect(keys(store)).toHaveLength(5);
    store.collapseAll();
    store.collapseAll();
    store.expandRecursively(rowOf(store, 'd:src') as Extract<ResultRow, { kind: 'folder' }>);
    expect(keys(store)).toHaveLength(5);
  });

  it('F4 walks every match in tree order, wrapping, and opens the folders and file of the one it lands on', async () => {
    const { api, store } = searchSetup();
    store.view.value = { ...store.view.value, viewMode: 'tree' };
    await store.run(false);
    api.searchResults({ searchId: sid(api), matchCase: false, files: [file('src/a.ts', match(1, 1)), file('z.ts', match(2, 1))] });
    store.collapseAll();
    store.collapseAll();
    expect(store.stepMatch(null, 1)?.key).toBe('m:1');
    expect(keys(store)).toContain('m:1');
    expect(store.stepMatch('m:1', 1)?.key).toBe('m:2');
    expect(store.stepMatch('m:2', 1)?.key).toBe('m:1');
    expect(store.stepMatch('m:1', -1)?.key).toBe('m:2');
  });

  it('copies through main, which builds the text', async () => {
    const { api, store } = searchSetup();
    await store.run(false);
    api.searchResults({ searchId: sid(api), matchCase: false, files: [file('a.ts', match(1, 1))] });
    await store.copy(rowOf(store, 'm:1'));
    expect(api.copySearchResults).toHaveBeenLastCalledWith({ searchId: sid(api), target: { kind: 'matches', matchIds: [1] } });
    await store.copy(rowOf(store, 'f:a.ts'));
    expect(api.copySearchResults).toHaveBeenLastCalledWith({ searchId: sid(api), target: { kind: 'files', files: [{ kind: 'file', relativePath: 'a.ts' }] } });
    await store.copy('all');
    expect(api.copySearchResults).toHaveBeenLastCalledWith({ searchId: sid(api), target: { kind: 'all' } });
  });

  it('adds a run\'s query, include and exclude to their histories after VS Code\'s delay, and restores saved ones per project', async () => {
    vi.useFakeTimers();
    try {
      const { store } = searchSetup();
      store.view.value = { ...store.view.value, include: 'src/**' };
      await store.run(false);
      expect(store.view.value.history.query).toEqual([]);
      vi.advanceTimersByTime(QUERY_HISTORY_DELAY_MS);
      expect(store.view.value.history).toMatchObject({ query: ['foo'], include: ['src/**'], exclude: [] });
      expect(store.historyPrevious('query', 'typed')).toBe('foo');
      expect(store.view.value.history.query).toEqual(['foo', 'typed']);
      store.setProject('p2', { ...VIEW, history: { query: ['old'], replace: [], include: [], exclude: [] } });
      expect(store.historyPrevious('query', '')).toBe('old');
      store.syncHistories({ ...VIEW, history: { query: [], replace: [], include: [], exclude: [] } });
      expect(store.historyPrevious('query', 'x')).toBe('x');
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores a project's replace text with its Replace row, and saves the text only while the row shows, as VS Code saves query.replaceText", () => {
    const { store } = searchSetup();
    store.setProject('p2', { ...VIEW, replaceOpen: true, replaceText: 'bar' });
    expect(store.replacement.value).toBe('bar');
    expect(store.persistedView()).toMatchObject({ replaceOpen: true, replaceText: 'bar' });
    store.replacement.value = 'baz';
    expect(store.persistedView().replaceText).toBe('baz');
    store.view.value = { ...store.view.value, replaceOpen: false };
    expect(store.persistedView().replaceText).toBe('');
    store.setProject('p3', { ...VIEW, replaceText: '' });
    expect(store.replacement.value).toBe('');
    store.setProject('p4', undefined);
    expect(store.replacement.value).toBe('');
  });

  it('restores a project\'s saved query without running it, and an empty pattern clears instead of searching', async () => {
    const { api, store } = searchSetup();
    store.setProject('p2', { ...VIEW, pattern: 'saved', isRegex: true });
    expect(store.view.value).toMatchObject({ pattern: 'saved', isRegex: true });
    expect(api.startSearch).not.toHaveBeenCalled();
    store.view.value = { ...store.view.value, pattern: '' };
    await store.run(false);
    expect(api.startSearch).not.toHaveBeenCalled();
    expect(api.clearSearch).toHaveBeenCalled();
  });

  it('opens the results in a Search Editor and seeds a new one from the view\'s inputs', async () => {
    const { api, store } = searchSetup();
    await store.run(false);
    await store.openInEditor();
    expect(api.openSearchEditor).not.toHaveBeenCalled();
    api.searchResults({ searchId: sid(api), matchCase: false, files: [file('a.ts', match(1, 1))] });
    await store.openInEditor();
    expect(api.openSearchEditor).toHaveBeenLastCalledWith({ from: 'viewResults', searchId: sid(api) });
    store.view.value = { ...store.view.value, include: 'src', onlyOpenEditors: true };
    await store.openNewEditor();
    expect(api.openSearchEditor).toHaveBeenLastCalledWith({ from: 'blank', config: { query: 'foo', isRegex: false, matchCase: false, wholeWord: false, include: 'src', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: true } });
  });

  it('shows a regex replacement expanded in the row preview, with Preserve Case', () => {
    const lookbehind: SearchQuery = { ...QUERY, pattern: '(?<=let )(\\w+)', isRegex: true };
    const row: SearchMatch = { id: 1, range: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 8 }, preview: { text: 'let abc = 1', matchStart: 4, matchEnd: 7 } };
    expect(insertedText(lookbehind, row, 'my_$1', false)).toBe('my_abc');
    expect(insertedText(QUERY, row, '$1', false)).toBe('$1');
    const upper: SearchMatch = { ...row, preview: { text: 'let ABC = 1', matchStart: 4, matchEnd: 7 } };
    expect(insertedText({ ...QUERY, pattern: 'abc' }, upper, 'xyz', true)).toBe('XYZ');
  });
});

describe('search history (VS Code HistoryInputBox)', () => {
  it('Up shows older entries and stops at the oldest; Down shows newer ones and clears past the newest', () => {
    const history = createInputHistory(['one', 'two', 'three']);
    expect(history.previous('')).toBe('three');
    expect(history.previous('three')).toBe('two');
    expect(history.previous('two')).toBe('one');
    // At the oldest entry Up keeps it (HistoryNavigator.previous gives null, then first()).
    expect(history.previous('one')).toBe('one');
    expect(history.next('one')).toBe('two');
    expect(history.next('two')).toBe('three');
    expect(history.next('three')).toBe('');
  });

  it('keeps a typed value it has not seen, moves a repeated entry to the end, and keeps the newest 100', () => {
    const history = createInputHistory(['a', 'b']);
    expect(history.previous('typed')).toBe('b');
    expect(history.entries()).toEqual(['a', 'b', 'typed']);
    history.add('a');
    expect(history.entries()).toEqual(['b', 'typed', 'a']);
    history.add('');
    expect(history.entries()).toEqual(['b', 'typed', 'a']);
    const long = createInputHistory(Array.from({ length: 105 }, (_, index) => `q${index}`));
    expect(long.entries()).toHaveLength(100);
    expect(long.entries()[0]).toBe('q5');
    long.clear();
    expect(long.previous('x')).toBe('x');
  });
});

describe('search glob edits (VS Code searchActionsFind.ts)', () => {
  it('Include/Exclude File Type writes *.ext from the first dot and merges it once', () => {
    expect(fileTypeGlob('main.test.ts')).toBe('*.test.ts');
    expect(fileTypeGlob('Makefile')).toBe('Makefile');
    expect(fileTypeGlob('.gitignore')).toBe('*.gitignore');
    expect(fileTypeGlob('a,b.{x}')).toBe('*.[{]x[}]');
    expect(mergeGlob('', '*.ts')).toBe('*.ts');
    expect(mergeGlob('src/**', '*.ts')).toBe('src/**, *.ts');
    expect(mergeGlob('src/**, *.ts', '*.ts')).toBe('src/**, *.ts');
  });
});

describe('search tree order (VS Code searchCompare.ts)', () => {
  const treeFile = (relativePath: string, count: number, mtimeMs?: number): TreeFile => ({
    key: relativePath, relativePath, untitled: false, mtimeMs, matches: Array.from({ length: count }, (_, index) => ({ id: index, range: { startLine: index + 1, startColumn: 1, endLine: index + 1, endColumn: 2 } })),
  });
  const files = [treeFile('b/z.ts', 1, 30), treeFile('a.md', 3, 10), treeFile('b/a10.js', 2, 20), treeFile('b/a9.js', 5, 40)];
  const order = (sort: Parameters<typeof buildNodes>[2]): string[] => buildNodes(files, 'list', sort).map((node) => node.key);

  it('sorts files by each search.sortOrder', () => {
    expect(order('default')).toEqual(['f:a.md', 'f:b/a9.js', 'f:b/a10.js', 'f:b/z.ts']);
    expect(order('fileNames')).toEqual(['f:a.md', 'f:b/a9.js', 'f:b/a10.js', 'f:b/z.ts']);
    expect(order('type')).toEqual(['f:b/a9.js', 'f:b/a10.js', 'f:a.md', 'f:b/z.ts']);
    expect(order('modified')).toEqual(['f:b/a9.js', 'f:b/z.ts', 'f:b/a10.js', 'f:a.md']);
    expect(order('countDescending')).toEqual(['f:b/a9.js', 'f:a.md', 'f:b/a10.js', 'f:b/z.ts']);
    expect(order('countAscending')).toEqual(['f:b/z.ts', 'f:b/a10.js', 'f:a.md', 'f:b/a9.js']);
  });

  it('puts a folder\'s own files before deeper paths and folders before files in tree mode', () => {
    expect(comparePaths('b/z.ts', 'b/c/a.ts')).toBe(-1);
    const tree = flattenRows(buildNodes(files, 'tree', 'countDescending'), new Set());
    expect(tree.filter((row) => row.kind !== 'match').map((row) => row.key)).toEqual(['d:b', 'f:b/a9.js', 'f:b/a10.js', 'f:b/z.ts', 'f:a.md']);
  });

  it('collapses past 10 matches only in auto, always in alwaysCollapse, never in alwaysExpand', () => {
    expect([startsCollapsed(10, 'auto'), startsCollapsed(11, 'auto'), startsCollapsed(1, 'alwaysCollapse'), startsCollapsed(99, 'alwaysExpand')]).toEqual([false, true, true, false]);
  });
});

describe('search-result tokenizer (VS Code extensions/search-result)', () => {
  // Monarch tries a rule only at the current position (monarchCompile wraps it in ^(?:…)), so the tests anchor it too.
  const rules = (searchResultLanguage.tokenizer.root as Array<[RegExp, unknown]>).map(([regExp]) => new RegExp(`^(?:${regExp.source})`, regExp.flags));
  const fileLine = rules.find((regExp) => regExp.source.startsWith('^(?:(?=\\S)'))!;

  it('splits a file line into folder, name and colon, a root file with no folder, and leaves indented lines alone', () => {
    expect(fileLine.exec('src/app/main.ts:')?.slice(1)).toEqual(['src/app/', 'main.ts', ':']);
    expect(fileLine.exec('README.md:')?.slice(1)).toEqual(['', 'README.md', ':']);
    expect(fileLine.exec('  12: code:')).toBeNull();
  });

  it('rejects a 20,000-character line without a trailing colon in linear time, for every rule', () => {
    // No slash to cut the backtracking: the quadratic rule this replaced takes over 100 ms on it.
    const line = 'a'.repeat(20_000);
    const start = performance.now();
    for (const regExp of rules) regExp.exec(line);
    expect(performance.now() - start).toBeLessThan(20);
  });
});

// --- the editor store's buffer replace, on real Monaco models -------------------------------------------------------------

let monacoModule: ShellMonacoModule;
beforeAll(async () => {
  const monaco = await import('monaco-editor/editor/editor.api');
  monacoModule = { useMonaco: () => monaco, settingsModelUri: () => '' } as unknown as ShellMonacoModule;
}, 120_000);

const codeTab = (relativePath: string, overrides: Partial<ShellEditorTab> = {}): ShellEditorTab => ({
  id: `t-${relativePath}`, kind: 'code', title: relativePath, displayPath: relativePath, projectKey: 'p1', relativePath,
  documentId: `doc-${relativePath}`, dirty: false, readOnly: false, conflict: false, ...overrides,
});
const textContent = (documentId: string, text: string): ShellDocumentContent =>
  ({ kind: 'text', documentId, version: 1, editSeq: 0, text, languageId: 'plaintext', eol: '\n', encoding: 'utf8', bom: false });

async function editorSetup(tabs: ShellEditorTab[], texts: Record<string, string>): Promise<{ api: ReturnType<typeof fakeShellApi>; store: EditorStore }> {
  const editorState: ShellEditorState = { ...EDITOR_STATE, tabs, activeTabId: tabs[0]?.id ?? null };
  const api = fakeShellApi([], {
    getEditorState: vi.fn(async () => editorState),
    getDocument: vi.fn(async (documentId: string) => textContent(documentId, texts[documentId]!)),
  });
  const store = createEditorStore(api, async () => monacoModule);
  await store.start();
  editorStores.push(store);
  return { api, store };
}

// Monaco keeps models by URI, so each test's store disposes its models before the next one opens the same documents.
const editorStores: EditorStore[] = [];
afterEach(() => {
  for (const store of editorStores.splice(0)) store.stop();
});

describe('editor store search', () => {
  it('replaces in a buffer as one undoable edit that leaves it dirty, at ranges the decorations moved with the user\'s edits', async () => {
    const { api, store } = await editorSetup([codeTab('a.ts')], { 'doc-a.ts': 'let foo = 1;\nlet foo2 = foo;' });
    const model = await store.model('doc-a.ts');
    const lookbehind: SearchQuery = { ...QUERY, pattern: '(?<=let )(foo)', isRegex: true };
    const ranges = [{ startLine: 1, startColumn: 5, endLine: 1, endColumn: 8 }, { startLine: 2, startColumn: 5, endLine: 2, endColumn: 8 }];
    const ids = await store.trackSearchRanges('doc-a.ts', ranges);
    // The user types at the start of line 1 after the search; the tracked range moves with the text.
    model.pushEditOperations([], [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '  ' }], () => null);
    model.pushStackElement();
    const typed = model.getValue();
    const result = await store.replaceInBuffer('doc-a.ts', ranges.map((range, index) => ({ range, decorationId: ids![index]! })), 'bar_$1', lookbehind, false);
    expect(result).toEqual({ ok: true, replaced: 2 });
    expect(model.getValue()).toBe('  let bar_foo = 1;\nlet bar_foo2 = foo;');
    // The buffer reports the replace like a keystroke, so main marks it dirty.
    store.flush('doc-a.ts');
    expect(api.reportEdit).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'doc-a.ts', text: model.getValue() }));
    model.undo();
    expect(model.getValue()).toBe(typed);
  }, 60_000);

  it('replaces with Preserve Case through the shared expansion, as one edit', async () => {
    const { store } = await editorSetup([codeTab('a.ts')], { 'doc-a.ts': 'Foo FOO foo' });
    const model = await store.model('doc-a.ts');
    const ranges = [1, 5, 9].map((column) => ({ startLine: 1, startColumn: column, endLine: 1, endColumn: column + 3 }));
    const result = await store.replaceInBuffer('doc-a.ts', ranges.map((range) => ({ range })), 'bar', QUERY, true);
    expect(result).toEqual({ ok: true, replaced: 3 });
    expect(model.getValue()).toBe('Bar BAR bar');
    model.undo();
    expect(model.getValue()).toBe('Foo FOO foo');
  }, 60_000);

  it('replaces a regex match across a line break in a CRLF buffer, inserting the buffer\'s line ending', async () => {
    const { api, store } = await editorSetup([codeTab('a.ts')], {});
    vi.mocked(api.getDocument).mockImplementation(async (documentId: string) => ({ ...textContent(documentId, 'foo\r\nbar\r\n'), eol: '\r\n' }));
    const model = await store.model('doc-a.ts');
    const range = { startLine: 1, startColumn: 1, endLine: 2, endColumn: 4 };
    const result = await store.replaceInBuffer('doc-a.ts', [{ range }], '$1\\nbaz', { ...QUERY, pattern: '(\\w+)\\nbar', isRegex: true }, false);
    expect(result).toEqual({ ok: true, replaced: 1 });
    expect(model.getValue()).toBe('foo\r\nbaz\r\n');
  }, 60_000);

  it('leaves the buffer untouched when a target no longer matches, the regex cannot run in JavaScript, or the tab is read-only', async () => {
    const { store } = await editorSetup([codeTab('a.ts'), codeTab('ro.ts', { readOnly: true })], { 'doc-a.ts': 'foo bar', 'doc-ro.ts': 'foo' });
    const model = await store.model('doc-a.ts');
    const stale = await store.replaceInBuffer('doc-a.ts', [{ range: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 8 } }], 'x', QUERY, false);
    expect(stale).toEqual({ ok: false, reason: 'changed' });
    const possessive = await store.replaceInBuffer('doc-a.ts', [{ range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 } }], 'x', { ...QUERY, pattern: 'fo++', isRegex: true }, false);
    expect(possessive).toEqual({ ok: false, reason: 'unsupportedRegex' });
    expect(model.getValue()).toBe('foo bar');
    expect(await store.replaceInBuffer('doc-ro.ts', [{ range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 } }], 'x', QUERY, false)).toEqual({ ok: false, reason: 'readOnly' });
  }, 60_000);

  it('leaves the buffer untouched when the text recorded at an untracked range is not there any more', async () => {
    const { store } = await editorSetup([codeTab('a.ts')], { 'doc-a.ts': 'fox foo' });
    const model = await store.model('doc-a.ts');
    const word: SearchQuery = { ...QUERY, pattern: '\\w+', isRegex: true };
    const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 };
    expect(await store.replaceInBuffer('doc-a.ts', [{ range, text: 'foo' }], 'x', word, false)).toEqual({ ok: false, reason: 'changed' });
    expect(model.getValue()).toBe('fox foo');
    expect(await store.replaceInBuffer('doc-a.ts', [{ range, text: 'fox' }], 'x', word, false)).toEqual({ ok: true, replaced: 1 });
    expect(model.getValue()).toBe('x foo');
  }, 60_000);

  it('seeds Find in Files from a single-line selection, or the word at the caret with seedWithNearestWord', async () => {
    const { store } = await editorSetup([codeTab('a.ts')], { 'doc-a.ts': 'alpha beta\ngamma' });
    await store.model('doc-a.ts');
    const caret = { line: 1, column: 8 };
    store.noteSelection('doc-a.ts', { startLine: 1, startColumn: 11, endLine: 1, endColumn: 7 }, caret);
    expect(store.activeSelectionText(false)).toBe('beta');
    store.noteSelection('doc-a.ts', { startLine: 1, startColumn: 1, endLine: 2, endColumn: 3 }, caret);
    expect(store.activeSelectionText(true)).toBeUndefined();
    store.noteSelection('doc-a.ts', null, caret);
    expect(store.activeSelectionText(false)).toBeUndefined();
    expect(store.activeSelectionText(true)).toBe('beta');
  }, 60_000);
});


// --- the palette ---------------------------------------------------------------------------------------------------------

const command = (id: string, label: string, overrides: Partial<PaletteCommand> = {}): PaletteCommand => ({
  id, label, englishLabel: label, category: label.slice(0, label.indexOf(':')), accelerator: null, enabled: true, recent: false, ...overrides,
});
const ids = (model: ReturnType<typeof commandsModel>): string[] => model.rows.flatMap((row) => (row.kind === 'item' ? [row.item.id] : [`--${row.label}`]));
const LABELS = { recent: 'recently used', other: 'other commands' };

describe('command palette rows', () => {
  const commands = [
    command('damocles.toggleSidebar', 'View: Toggle Sidebar', { recent: true, accelerator: 'Ctrl+B' }),
    command('damocles.chat.contextUsage', 'Chat: Context usage'),
    command('damocles.chat.tools', 'Chat: Tools', { enabled: false }),
    command('damocles.search.findInFiles', 'Edit: Find in Files', { accelerator: 'Ctrl+Shift+F' }),
  ];

  it('groups recently used commands first, then the rest in main\'s order', () => {
    expect(ids(commandsModel(commands, '', false, LABELS))).toEqual([
      '--recently used', 'damocles.toggleSidebar', '--other commands', 'damocles.chat.contextUsage', 'damocles.chat.tools', 'damocles.search.findInFiles',
    ]);
  });

  it('keeps a matching recent command first and ranks the rest by score; "context" puts Context usage first otherwise', () => {
    const model = commandsModel(commands, 'context', false, LABELS);
    expect(ids(model)).toEqual(['damocles.chat.contextUsage']);
    const item = model.rows[0]!.kind === 'item' ? model.rows[0]!.item : undefined;
    expect(item).toMatchObject({ categoryLength: 6, disabled: false, labelMatches: [[6, 13]] });
    expect(ids(commandsModel(commands, 'toggle', false, LABELS))).toEqual(['--recently used', 'damocles.toggleSidebar']);
  });

  // VS Code's compareItemsByFuzzyScore puts an identity match first; each query word's score summed over a longer label
  // that holds every word must not outrank it.
  it('ranks the command whose label equals the query above a longer label holding the same words', () => {
    const terminal = [
      command('damocles.terminal.focusNextPane', 'Terminal: Focus Next Terminal in Terminal Group'),
      command('damocles.terminal.focusNext', 'Terminal: Focus Next Terminal'),
    ];
    expect(ids(commandsModel(terminal, 'Terminal: Focus Next Terminal', false, LABELS))).toEqual(['damocles.terminal.focusNext', 'damocles.terminal.focusNextPane']);
    expect(ids(commandsModel(terminal, ' terminal: focus next terminal ', false, LABELS))[0]).toBe('damocles.terminal.focusNext');
    const greek = terminal.map((entry) => ({ ...entry, label: `Τ ${entry.label}` }));
    expect(ids(commandsModel(greek, 'Terminal: Focus Next Terminal', true, LABELS))).toEqual(['damocles.terminal.focusNext', 'damocles.terminal.focusNextPane']);
  });

  it('marks a disabled command and carries its shortcut', () => {
    const model = commandsModel(commands, 'files', false, LABELS);
    expect(model.rows[0]).toMatchObject({ kind: 'item', item: { id: 'damocles.search.findInFiles', shortcut: 'Ctrl+Shift+F', disabled: false } });
    expect(commandsModel(commands, 'tools', false, LABELS).rows[0]).toMatchObject({ item: { disabled: true } });
  });

  it('in Greek matches the English label too, and shows it when only it matched', () => {
    const greek = [command('damocles.chat.contextUsage', 'Συνομιλία: Χρήση περιβάλλοντος', { englishLabel: 'Chat: Context usage', category: 'Συνομιλία' })];
    expect(ids(commandsModel(greek, 'context usage', false, LABELS))).toEqual([]);
    const model = commandsModel(greek, 'context usage', true, LABELS);
    expect(model.rows[0]).toMatchObject({ item: { id: 'damocles.chat.contextUsage', description: 'Chat: Context usage', labelMatches: [] } });
    expect(commandsModel(greek, 'χρήση', true, LABELS).rows[0]).toMatchObject({ item: { descriptionMatches: [] } });
  });

  it('splits shortcuts into keycaps and names them for aria-keyshortcuts', () => {
    expect(keycaps('Ctrl+Shift+F')).toEqual(['Ctrl', 'Shift', 'F']);
    expect(keycaps('⇧⌘F')).toEqual(['⇧', '⌘', 'F']);
    expect(keycaps('Ctrl++')).toEqual(['Ctrl', '+']);
    expect(ariaKeyshortcuts('Ctrl+Shift+P')).toBe('Control+Shift+P');
    expect(ariaKeyshortcuts('⇧⌘P')).toBe('Shift+Meta+P');
  });
});
