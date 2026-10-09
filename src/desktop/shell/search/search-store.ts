import { computed, ref, shallowRef, watch } from 'vue';
import type {
  DamoclesShellApi,
  SearchDone,
  SearchFileKey,
  SearchFileResult,
  SearchFileUpdate,
  SearchMatch,
  SearchQuery,
  SearchResultsBatch,
  SearchSkipReason,
  SearchViewState,
  ShellSearchSettings,
} from '../../preload/shell-channels';
import type { BufferReplaceResult, BufferReplaceTarget, EditorStore } from '../editor/editor-store';
import { MAX_REPLACEMENT_LENGTH, MAX_SEARCH_GLOBS_LENGTH, MAX_SEARCH_PATTERN_LENGTH, replaceRegExp, replacementAt } from '../../../shared/text-search';
import { createInputHistory, type InputHistory } from './search-history';
import { allNodes, buildNodes, flattenRows, nodeCount, startsCollapsed, type ResultRow as TreeRow, type TreeFile } from './search-tree';

export type HistoryField = 'query' | 'replace' | 'include' | 'exclude';

export const DEFAULT_SEARCH_VIEW: SearchViewState = {
  pattern: '',
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  useExcludeSettingsAndIgnoreFiles: true,
  replaceOpen: false,
  include: '',
  exclude: '',
  onlyOpenEditors: false,
  preserveCase: false,
  detailsOpen: false,
  viewMode: 'list',
  history: { query: [], replace: [], include: [], exclude: [] },
  replaceText: '',
};

// Each history field's entries are bounded like its input.
const HISTORY_LIMITS: Readonly<Record<HistoryField, number>> = {
  query: MAX_SEARCH_PATTERN_LENGTH,
  replace: MAX_REPLACEMENT_LENGTH,
  include: MAX_SEARCH_GLOBS_LENGTH,
  exclude: MAX_SEARCH_GLOBS_LENGTH,
};
// ms before a run's query, include and exclude join their histories (VS Code's addToSearchHistoryDelayer), and the replace text
// after it stops changing (searchWidget.ts _replaceHistoryDelayer).
export const QUERY_HISTORY_DELAY_MS = 2000;
export const REPLACE_HISTORY_DELAY_MS = 500;

export type ResultMatch = SearchMatch;

export interface ResultFile extends TreeFile<ResultMatch> {
  readonly fileKey: SearchFileKey;
  // the matches came from this open document's buffer, so a replace edits the buffer
  readonly documentId?: string;
}

export type ResultRow = TreeRow<ResultFile>;

export type SearchStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching' }
  | { readonly kind: 'done'; readonly limitHit: boolean; readonly cancelled: boolean; readonly error?: string; readonly bufferWarning?: SearchDone['bufferWarning'] }
  | { readonly kind: 'invalidGlob'; readonly glob: string }
  | { readonly kind: 'noProject' };

type SearchApi = Pick<DamoclesShellApi,
  'startSearch' | 'cancelSearch' | 'clearSearch' | 'dismissSearch' | 'onSearchResults' | 'onSearchDone' | 'onSearchFileUpdate'
  | 'confirmReplace' | 'replaceInFiles' | 'previewReplace' | 'openEditor' | 'editorTab' | 'copySearchResults' | 'openSearchEditor'>;
type SearchEditor = Pick<EditorStore, 'flushAll' | 'tabOfDocument' | 'tabOfFile' | 'trackSearchRanges' | 'clearSearchTracking' | 'replaceInBuffer' | 'revealRange' | 'requestFocus' | 'selectRanges'>;

// A buffer the shell could not replace; main posts its own notice for closed files it skipped.
export interface BufferSkip {
  readonly name: string;
  readonly reason: Extract<BufferReplaceResult, { ok: false }>['reason'];
}

const keyOf = (key: SearchFileKey): string => (key.kind === 'file' ? key.relativePath : `untitled:${key.documentId}`);

function toResultFile(file: SearchFileResult): ResultFile {
  if (file.kind === 'untitled') {
    const fileKey: SearchFileKey = { kind: 'untitled', documentId: file.documentId };
    return { key: keyOf(fileKey), fileKey, relativePath: file.title, untitled: true, documentId: file.documentId, matches: file.matches };
  }
  const fileKey: SearchFileKey = { kind: 'file', relativePath: file.relativePath };
  return {
    key: keyOf(fileKey),
    fileKey,
    relativePath: file.relativePath,
    untitled: false,
    matches: file.matches,
    ...(file.documentId === undefined ? {} : { documentId: file.documentId }),
    ...(file.mtimeMs === undefined ? {} : { mtimeMs: file.mtimeMs }),
  };
}

const queryOf = (view: SearchViewState): SearchQuery => ({
  pattern: view.pattern,
  isRegex: view.isRegex,
  matchCase: view.matchCase,
  wholeWord: view.wholeWord,
  include: view.include,
  exclude: view.exclude,
  useExcludeSettingsAndIgnoreFiles: view.useExcludeSettingsAndIgnoreFiles,
  onlyOpenEditors: view.onlyOpenEditors,
});

/** The text a replace puts in place of `match`, as the row's preview shows it; regExp is replaceRegExp(query). */
export function insertedText(query: SearchQuery, match: ResultMatch, replacement: string, preserveCase: boolean, regExp = replaceRegExp(query)): string {
  // The preview is a window of the line, so a lookbehind past its start may not match there; the row then shows the
  // replacement as typed, while the real replace expands it against the whole line.
  const { text, matchStart, matchEnd } = match.preview;
  return (regExp && replacementAt(regExp, query.isRegex, text, matchStart, matchEnd, replacement, preserveCase)) ?? replacement;
}

// A match's text when its row's preview holds all of it: a single-line match the preview did not cut.
function recordedText(match: ResultMatch): string | undefined {
  const { range, preview } = match;
  const whole = range.startLine === range.endLine && preview.matchEnd - preview.matchStart === range.endColumn - range.startColumn;
  return whole ? preview.text.slice(preview.matchStart, preview.matchEnd) : undefined;
}

/**
 * The Search section's state for the selected project: the query and its histories, main's streamed results and live
 * updates, and the view over them (grouping, sort, collapse). Main owns the results, dismissals and closed-file replaces;
 * the store renders them, replaces open buffers in the editor, and never reads a file.
 */
export function createSearchStore(api: SearchApi, editor: SearchEditor, settings: () => ShellSearchSettings) {
  // Shallow: every change replaces the whole state, and the layout report crosses the context bridge, which cannot clone a proxy.
  const view = shallowRef<SearchViewState>({ ...DEFAULT_SEARCH_VIEW });
  const replacement = ref('');
  const projectKey = ref<string | undefined>(undefined);
  const status = shallowRef<SearchStatus>({ kind: 'idle' });
  const files = shallowRef(new Map<string, ResultFile>());
  const collapsed = shallowRef(new Set<string>());
  // row keys whose collapse state was decided, so a row keeps the state it first got (VS Code's PreserveOr*)
  const decided = new Set<string>();
  // the match last opened, the tree's selection
  const openedKey = ref<string | null>(null);
  // the decoration tracking each match of a buffer result, by match id
  const decorations = new Map<number, string>();
  const histories = new Map<HistoryField, InputHistory>();
  let nextSearchId = 0;
  let activeSearchId = 0;
  const activeQuery = shallowRef<SearchQuery | undefined>(undefined);
  // Match Case as main searched with it (smart case), from its results
  const searchedCase = ref<boolean | undefined>(undefined);
  // the query a buffer replace and the row preview match with
  const replaceQuery = computed(() => {
    const query = activeQuery.value;
    return query && searchedCase.value !== undefined ? { ...query, matchCase: searchedCase.value } : query;
  });
  const previewRegExp = computed(() => (replaceQuery.value ? replaceRegExp(replaceQuery.value) : undefined));
  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  let replaceHistoryTimer: ReturnType<typeof setTimeout> | undefined;

  const fileList = computed(() => [...files.value.values()]);
  const resultCount = computed(() => fileList.value.reduce((sum, file) => sum + file.matches.length, 0));
  const fileCount = computed(() => files.value.size);
  const nodes = computed(() => buildNodes(fileList.value, view.value.viewMode, settings().sortOrder));
  const rows = computed<ResultRow[]>(() => flattenRows(nodes.value, collapsed.value));
  // Collapse All while any row is expanded, else Expand All (VS Code's ViewHasSomeCollapsibleKey).
  const anyExpanded = computed(() => rows.value.some((row) => row.kind !== 'match' && row.expanded));

  watch(nodes, (current) => {
    const setting = settings().collapseResults;
    let next: Set<string> | undefined;
    for (const node of allNodes(current)) {
      if (decided.has(node.key)) continue;
      decided.add(node.key);
      if (startsCollapsed(nodeCount(node), setting)) (next ??= new Set(collapsed.value)).add(node.key);
    }
    if (next) collapsed.value = next;
  });

  // --- histories -----------------------------------------------------------------------------------------------------

  function loadHistories(state: SearchViewState): void {
    for (const field of ['query', 'replace', 'include', 'exclude'] as const) histories.set(field, createInputHistory(state.history[field]));
  }

  function storeHistories(): void {
    const entries = (field: HistoryField): string[] => [...histories.get(field)!.entries()];
    view.value = { ...view.value, history: { query: entries('query'), replace: entries('replace'), include: entries('include'), exclude: entries('exclude') } };
  }

  function addToHistory(field: HistoryField, value: string): void {
    if (value.length > HISTORY_LIMITS[field]) return;
    histories.get(field)!.add(value);
    storeHistories();
  }

  /** Up in an input: the older value to show, or undefined to keep the current one. */
  function historyPrevious(field: HistoryField, value: string): string | undefined {
    const shown = histories.get(field)!.previous(value);
    storeHistories();
    return shown;
  }

  /** Down in an input: the newer value to show, '' past the newest. */
  function historyNext(field: HistoryField, value: string): string {
    const shown = histories.get(field)!.next(value);
    storeHistories();
    return shown;
  }

  const hasHistory = (field: HistoryField): boolean => view.value.history[field].length > 0;

  function scheduleQueryHistory(): void {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      addToHistory('query', view.value.pattern);
      addToHistory('include', view.value.include);
      addToHistory('exclude', view.value.exclude);
    }, QUERY_HISTORY_DELAY_MS);
  }

  watch(replacement, () => {
    clearTimeout(replaceHistoryTimer);
    replaceHistoryTimer = setTimeout(() => addToHistory('replace', replacement.value), REPLACE_HISTORY_DELAY_MS);
  });

  // --- results -------------------------------------------------------------------------------------------------------

  // One copy of the results per batch of changes.
  function put(changes: ReadonlyArray<{ readonly key: string; readonly file: ResultFile | null }>): void {
    const next = new Map(files.value);
    for (const { key, file } of changes) {
      for (const match of next.get(key)?.matches ?? []) decorations.delete(match.id);
      if (file && file.matches.length > 0) next.set(key, file);
      else next.delete(key);
    }
    files.value = next;
    for (const { file } of changes) if (file) void track(file);
  }

  // Matches in an open buffer follow the user's edits there, so a later replace hits the text they now cover.
  async function track(file: ResultFile): Promise<void> {
    const searchId = activeSearchId;
    if (file.documentId === undefined) return;
    const ids = await editor.trackSearchRanges(file.documentId, file.matches.map((match) => match.range));
    if (!ids || searchId !== activeSearchId) return;
    file.matches.forEach((match, index) => {
      const id = ids[index];
      if (id !== undefined) decorations.set(match.id, id);
    });
  }

  function reset(): void {
    activeSearchId = ++nextSearchId;
    activeQuery.value = undefined;
    searchedCase.value = undefined;
    decorations.clear();
    editor.clearSearchTracking();
    files.value = new Map();
    collapsed.value = new Set();
    decided.clear();
    openedKey.value = null;
  }

  /** Runs the current query; main debounces it unless `immediate`. An empty pattern clears instead. */
  async function run(immediate: boolean): Promise<void> {
    const key = projectKey.value;
    if (view.value.pattern === '') {
      await clear();
      return;
    }
    reset();
    const searchId = activeSearchId;
    const query = queryOf(view.value);
    activeQuery.value = query;
    scheduleQueryHistory();
    if (key === undefined) {
      status.value = { kind: 'noProject' };
      return;
    }
    status.value = { kind: 'searching' };
    // Main searches the open buffers from the text it holds, so every pending keystroke goes first (IPC keeps the order).
    editor.flushAll();
    const result = await api.startSearch({ searchId, query, immediate });
    if (searchId !== activeSearchId || result.ok) return;
    status.value = result.error === 'invalidGlob' ? { kind: 'invalidGlob', glob: result.glob } : { kind: 'noProject' };
  }

  function onResults(batch: SearchResultsBatch): void {
    if (batch.searchId !== activeSearchId) return;
    searchedCase.value = batch.matchCase;
    put(batch.files.map((file) => {
      const result = toResultFile(file);
      return { key: result.key, file: result };
    }));
  }

  function onFileUpdate(update: SearchFileUpdate): void {
    if (update.searchId !== activeSearchId) return;
    searchedCase.value = update.matchCase;
    put([{ key: keyOf(update.key), file: update.file && toResultFile(update.file) }]);
  }

  function onDone(done: SearchDone): void {
    if (done.searchId !== activeSearchId) return;
    status.value = {
      kind: 'done',
      limitHit: done.limitHit,
      cancelled: done.cancelled === true,
      ...(done.error === undefined ? {} : { error: done.error }),
      ...(done.bufferWarning === undefined ? {} : { bufferWarning: done.bufferWarning }),
    };
    // VS Code's expandIfSingularResult: a lone file under 50 matches opens.
    const only = fileList.value.length === 1 ? fileList.value[0] : undefined;
    if (only && settings().collapseResults !== 'alwaysCollapse' && only.matches.length < 50) {
      const next = new Set(collapsed.value);
      for (const row of rows.value) if (row.kind !== 'match') next.delete(row.key);
      collapsed.value = next;
    }
  }

  /** Cancel Search: main stops ripgrep and answers done with cancelled; the results already shown stay. */
  async function cancel(): Promise<void> {
    if (status.value.kind === 'searching') await api.cancelSearch();
  }

  /** Clear Search Results: kills main's search and forgets its matches; the query stays unless the caller clears it. */
  async function clear(): Promise<void> {
    reset();
    status.value = { kind: 'idle' };
    await api.clearSearch();
  }

  /** A project's saved query, toggles and histories, no results until the user runs it, as VS Code restores a query. */
  function setProject(key: string | undefined, saved: SearchViewState | undefined): void {
    projectKey.value = key;
    view.value = { ...(saved ?? { ...DEFAULT_SEARCH_VIEW, viewMode: settings().defaultViewMode }) };
    replacement.value = view.value.replaceText;
    loadHistories(view.value);
    reset();
    status.value = { kind: 'idle' };
  }

  /** The state the layout keeps; the replace text only while the Replace row shows (searchView.ts saveState). */
  function persistedView(): SearchViewState {
    return { ...view.value, replaceText: view.value.replaceOpen ? replacement.value : '' };
  }

  /** Main's saved state changed under the same project (Clear Search History empties every history). */
  function syncHistories(saved: SearchViewState): void {
    const now = view.value.history;
    if (JSON.stringify(now) === JSON.stringify(saved.history)) return;
    view.value = { ...view.value, history: saved.history };
    loadHistories(view.value);
  }

  function toggleCollapsed(key: string): void {
    const next = new Set(collapsed.value);
    if (!next.delete(key)) next.add(key);
    collapsed.value = next;
  }

  /** VS Code's CollapseDeepestExpandedLevel: while matches show, files collapse first; then everything. */
  function collapseAll(): void {
    const showsMatches = rows.value.some((row) => row.kind === 'match');
    const keys = allNodes(nodes.value).filter((node) => !showsMatches || node.kind === 'file').map((node) => node.key);
    collapsed.value = new Set([...collapsed.value, ...keys]);
  }

  function expandAll(): void {
    collapsed.value = new Set();
  }

  /** Expand Recursively on a folder row: the folder and everything under it. */
  function expandRecursively(row: Extract<ResultRow, { kind: 'folder' }>): void {
    const inside = new Set(allNodes([row.node]).map((node) => node.key));
    collapsed.value = new Set([...collapsed.value].filter((key) => !inside.has(key)));
  }

  // --- the row's files and matches -----------------------------------------------------------------------------------

  /** The files a row stands for: a folder's files, a file, or a match's file with only that match. */
  function targetsOf(row: ResultRow): Array<{ file: ResultFile; matches: readonly ResultMatch[] }> {
    if (row.kind === 'folder') return row.node.files.map((file) => ({ file, matches: file.matches }));
    if (row.kind === 'file') return [{ file: row.file, matches: row.file.matches }];
    return [{ file: row.file, matches: [row.match] }];
  }

  /** Dismiss: main drops the match, file or folder from this run's results and pushes the change. */
  async function dismiss(row: ResultRow): Promise<void> {
    const targets = targetsOf(row);
    const whole = row.kind !== 'match';
    await api.dismissSearch({
      searchId: activeSearchId,
      matchIds: whole ? [] : targets.flatMap((target) => target.matches.map((match) => match.id)),
      files: whole ? targets.map((target) => target.file.fileKey) : [],
    });
  }

  /**
   * Replaces the targets' matches: open buffers in the editor (one undoable edit each), closed files through main, which
   * verifies every match, writes through the document service, reports what it skipped and pushes the changed files.
   * Returns the buffers the shell skipped.
   */
  async function replace(targets: ReadonlyArray<{ file: ResultFile; matches: readonly ResultMatch[] }>): Promise<{ bufferSkipped: BufferSkip[] }> {
    const query = replaceQuery.value;
    const key = projectKey.value;
    const searchId = activeSearchId;
    const text = replacement.value;
    const preserveCase = view.value.preserveCase;
    if (query === undefined || key === undefined) return { bufferSkipped: [] };
    const skipped: BufferSkip[] = [];
    const closedIds: number[] = [];
    for (const target of targets) {
      // A file ripgrep found closed and the user opened since is replaced in its buffer, as VS Code replaces in an open model,
      // where the text ripgrep recorded must still be at the match's range.
      const openedSince = target.file.documentId === undefined;
      const documentId = target.file.documentId ?? (target.file.untitled ? undefined : editor.tabOfFile(key, target.file.relativePath)?.documentId);
      if (documentId === undefined) {
        closedIds.push(...target.matches.map((match) => match.id));
        continue;
      }
      const result = await editor.replaceInBuffer(documentId, target.matches.map((match): BufferReplaceTarget => {
        const decorationId = decorations.get(match.id);
        const recorded = openedSince ? recordedText(match) : undefined;
        return { range: match.range, ...(decorationId === undefined ? {} : { decorationId }), ...(recorded === undefined ? {} : { text: recorded }) };
      }), text, query, preserveCase);
      if (searchId !== activeSearchId) return { bufferSkipped: skipped };
      if (!result.ok) skipped.push({ name: target.file.relativePath, reason: result.reason });
    }
    if (closedIds.length > 0) await api.replaceInFiles({ searchId, replacement: text, preserveCase, matchIds: closedIds });
    return { bufferSkipped: skipped };
  }

  /** Replace All asks first, with the totals; a declined question changes nothing. */
  async function replaceAll(): Promise<{ bufferSkipped: BufferSkip[] } | undefined> {
    if (resultCount.value === 0) return undefined;
    const confirmed = await api.confirmReplace({ occurrences: resultCount.value, files: fileCount.value, replacement: replacement.value });
    if (!confirmed) return undefined;
    return replace(fileList.value.map((file) => ({ file, matches: file.matches })));
  }

  const replaceRow = (row: ResultRow): Promise<{ bufferSkipped: BufferSkip[] }> => replace(targetsOf(row));

  /**
   * Shows a match (or a file's first): in replace mode with the replace preview on, the file's read-only before/after diff;
   * else the file with the match selected. `focus` moves focus to the editor (Enter, double-click); `toSide` also shows a
   * hidden editor pane. Returns why main could not preview the file.
   */
  async function open(row: Extract<ResultRow, { kind: 'file' | 'match' }>, options: { focus: boolean; toSide: boolean }): Promise<SearchSkipReason | undefined> {
    const key = projectKey.value;
    const file = row.file;
    const match = row.kind === 'match' ? row.match : file.matches[0];
    if (key === undefined || !match) return undefined;
    openedKey.value = `m:${match.id}`;
    if (view.value.replaceOpen && settings().useReplacePreview && !options.toSide) {
      const preview = await api.previewReplace({ searchId: activeSearchId, replacement: replacement.value, preserveCase: view.value.preserveCase, matchIds: file.matches.map((candidate) => candidate.id) });
      return preview.ok ? undefined : preview.reason;
    }
    const tabId = await tabFor(key, file, options);
    if (tabId !== undefined) editor.revealRange(tabId, match.range, decorations.get(match.id));
    return undefined;
  }

  // An untitled buffer has no path: its own tab shows it. A markdown file opens its source, where a match can be selected.
  async function tabFor(key: string, file: ResultFile, options: { focus: boolean; toSide: boolean }): Promise<string | undefined> {
    if (file.untitled) {
      const tab = file.documentId === undefined ? undefined : editor.tabOfDocument(file.documentId);
      if (!tab) return undefined;
      await api.editorTab({ action: 'activate', tabId: tab.id });
      if (options.focus) editor.requestFocus(tab.id);
      return tab.id;
    }
    const result = await api.openEditor({
      projectKey: key,
      relativePath: file.relativePath,
      ...(/\.md$/i.test(file.relativePath) ? { as: 'source' as const } : {}),
      preserveFocus: !options.focus,
      toSide: options.toSide,
    });
    return result.ok ? result.tabId : undefined;
  }

  /** Add Cursors at Search Results: the row's file opens with every match of the row selected. */
  async function addCursors(row: Extract<ResultRow, { kind: 'file' | 'match' }>): Promise<void> {
    const key = projectKey.value;
    if (key === undefined) return;
    const tabId = await tabFor(key, row.file, { focus: true, toSide: false });
    if (tabId !== undefined) editor.selectRanges(tabId, row.file.matches.map((match) => match.range));
  }

  /** Copy and Copy All: main writes VS Code's text, since only main has the whole lines and absolute paths. */
  async function copy(row: ResultRow | 'all'): Promise<void> {
    const searchId = activeSearchId;
    if (row === 'all') await api.copySearchResults({ searchId, target: { kind: 'all' } });
    else if (row.kind === 'match') await api.copySearchResults({ searchId, target: { kind: 'matches', matchIds: [row.match.id] } });
    else await api.copySearchResults({ searchId, target: { kind: 'files', files: targetsOf(row).map((target) => target.file.fileKey) } });
  }

  /** Open in editor (Open Results in Editor): main serializes this run's results into a new Search Editor. */
  async function openInEditor(): Promise<void> {
    if (fileCount.value > 0) await api.openSearchEditor({ from: 'viewResults', searchId: activeSearchId });
  }

  /** Open New Search Editor: a blank Search Editor seeded with the view's inputs. */
  async function openNewEditor(): Promise<void> {
    const { pattern, isRegex, matchCase, wholeWord, include, exclude, useExcludeSettingsAndIgnoreFiles, onlyOpenEditors } = view.value;
    await api.openSearchEditor({ from: 'blank', config: { query: pattern, isRegex, matchCase, wholeWord, include, exclude, useExcludeSettingsAndIgnoreFiles, onlyOpenEditors } });
  }

  /** F4 / Shift+F4: the next or previous match after `fromKey` in the whole tree, wrapping, with its file and folders expanded. */
  function stepMatch(fromKey: string | null, step: 1 | -1): Extract<ResultRow, { kind: 'match' }> | undefined {
    const list = flattenRows(nodes.value, new Set());
    const matches = list.filter((row): row is Extract<ResultRow, { kind: 'match' }> => row.kind === 'match');
    const wrap = step === 1 ? matches[0] : matches[matches.length - 1];
    const from = list.findIndex((row) => row.key === fromKey);
    const ahead = from < 0 ? undefined : (step === 1 ? list.slice(from + 1) : list.slice(0, from).reverse()).find((row) => row.kind === 'match');
    const target = (ahead as Extract<ResultRow, { kind: 'match' }> | undefined) ?? wrap;
    if (!target) return undefined;
    const holders = new Set(allNodes(nodes.value).filter((node) => (node.kind === 'folder' ? node.files.includes(target.file) : node.file === target.file)).map((node) => node.key));
    collapsed.value = new Set([...collapsed.value].filter((key) => !holders.has(key)));
    return target;
  }

  const stops: Array<() => void> = [];
  function start(): void {
    stops.push(api.onSearchResults(onResults));
    stops.push(api.onSearchFileUpdate(onFileUpdate));
    stops.push(api.onSearchDone(onDone));
  }

  function stop(): void {
    for (const unsubscribe of stops) unsubscribe();
    stops.length = 0;
    clearTimeout(historyTimer);
    clearTimeout(replaceHistoryTimer);
  }

  return {
    view,
    replacement,
    projectKey,
    status,
    files: fileList,
    rows,
    resultCount,
    fileCount,
    collapsed,
    anyExpanded,
    openedKey,
    activeQuery,
    replaceQuery,
    previewRegExp,
    run,
    cancel,
    clear,
    setProject,
    persistedView,
    syncHistories,
    addToHistory,
    historyPrevious,
    historyNext,
    hasHistory,
    toggleCollapsed,
    collapseAll,
    expandAll,
    expandRecursively,
    dismiss,
    replaceAll,
    replaceRow,
    open,
    addCursors,
    copy,
    openInEditor,
    openNewEditor,
    stepMatch,
    start,
    stop,
  };
}

export type SearchStore = ReturnType<typeof createSearchStore>;
