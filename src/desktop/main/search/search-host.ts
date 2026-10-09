import * as path from 'node:path';
import type { SettingsStore } from '../../../platform/settings-store';
import { MAX_EDITOR_TEXT_CHARS } from '../../preload/shell-channels';
import { folderGlob, matchingPattern, MAX_SEARCH_RESULTS, replaceRegExp, type SearchQuery } from '../../../shared/text-search';
import type {
  FileRef,
  SearchCommandMessage,
  SearchConfirmReplaceRequest,
  SearchCopyRequest,
  SearchDismissRequest,
  SearchDone,
  SearchEditorCommand,
  SearchEditorConfig,
  SearchEditorHighlights,
  SearchEditorMessage,
  SearchEditorOpenRequest,
  SearchEditorOpenResult,
  SearchEditorOpenResultRequest,
  SearchFileUpdate,
  SearchFocus,
  SearchPreviewRequest,
  SearchPreviewResult,
  SearchReplaceRequest,
  SearchReplaceResult,
  SearchReplaceSkip,
  SearchResultsBatch,
  SearchStartRequest,
  SearchStartResult,
  SearchViewCommand,
  ShellSearchSettings,
} from '../../preload/shell-channels';
import {
  isDesktopSettingValue,
  SEARCH_ACTIONS_POSITION_SETTING,
  SEARCH_COLLAPSE_RESULTS_SETTING,
  SEARCH_DEFAULT_VIEW_MODE_SETTING,
  SEARCH_EDITOR_CONTEXT_LINES_SETTING,
  SEARCH_EDITOR_DOUBLE_CLICK_SETTING,
  SEARCH_EDITOR_FOCUS_RESULTS_SETTING,
  SEARCH_EDITOR_REUSE_PRIOR_SETTING,
  SEARCH_MAX_RESULTS_SETTING,
  SEARCH_MODE_SETTING,
  SEARCH_ON_TYPE_DEBOUNCE_SETTING,
  SEARCH_ON_TYPE_SETTING,
  SEARCH_SEED_ON_FOCUS_SETTING,
  SEARCH_SEED_WITH_NEAREST_WORD_SETTING,
  SEARCH_SHOW_LINE_NUMBERS_SETTING,
  SEARCH_SMART_CASE_SETTING,
  SEARCH_SORT_ORDER_SETTING,
  SEARCH_USE_REPLACE_PREVIEW_SETTING,
} from '../desktop-configuration';
import type { Project } from '../documents/confine';
import type { DocumentService, TextDocument } from '../documents/document-service';
import type { EditorPane } from '../editor-pane';
import type { SearchMenuState } from '../menu';
import type { AskMessage } from '../message-dialog';
import { applyEdits, createReplacer, planReplacements, planWithin, REPLACE_REGEX_TIMEOUT_MS, type Replacer } from './replace';
import { DEFAULT_SEARCH_EDITOR_CONFIG, serializeSearchResults, type EditorFileResult, type ResultSummaryLabels } from './search-editor-format';
import { SearchService, type BufferDocument, type EditorRunResult, type SearchFolder, type SearchSettings } from './search-service';

export interface SearchHostDeps {
  readonly settings: SettingsStore;
  readonly documents: DocumentService;
  readonly editorPane: EditorPane;
  readonly projects: () => readonly Project[];
  // the selected project's shown folder
  readonly selectedFolder: () => SearchFolder | undefined;
  readonly rgPath: () => Promise<string>;
  readonly ignoreArgs: () => readonly string[];
  readonly excludeSettings: () => readonly string[];
  readonly ask: AskMessage;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly warn: (message: string) => void;
  readonly copy: (text: string) => Promise<void>;
  // the active editor's selected text, for seeding a query
  readonly selectedText: () => string | undefined;
  // the sidebar shows (main's layout); the shell then opens and focuses its Search section
  readonly showSidebar: () => void;
  readonly clearSearchHistory: () => void;
  readonly sendResults: (batch: SearchResultsBatch) => void;
  readonly sendFileUpdate: (update: SearchFileUpdate) => void;
  readonly sendDone: (done: SearchDone) => void;
  readonly sendHighlights: (highlights: SearchEditorHighlights) => void;
  readonly sendCommand: (message: SearchCommandMessage) => void;
  readonly focusSearch: (focus: SearchFocus) => void;
  // the menu's enablement follows Search's state
  readonly stateChanged: () => void;
  readonly log: (line: string) => void;
  readonly lineDelimiter: string;
}

function setting<T>(settings: SettingsStore, key: string, fallback: T): T {
  const value = settings.get<unknown>(key);
  return isDesktopSettingValue(key, value) ? (value as T) : fallback;
}

/** The Search settings the shell applies. */
export function shellSearchSettings(settings: SettingsStore): ShellSearchSettings {
  return {
    mode: setting(settings, SEARCH_MODE_SETTING, 'view'),
    searchOnType: setting(settings, SEARCH_ON_TYPE_SETTING, true),
    searchOnTypeDebouncePeriod: setting(settings, SEARCH_ON_TYPE_DEBOUNCE_SETTING, 300),
    sortOrder: setting(settings, SEARCH_SORT_ORDER_SETTING, 'default'),
    collapseResults: setting(settings, SEARCH_COLLAPSE_RESULTS_SETTING, 'alwaysExpand'),
    showLineNumbers: setting(settings, SEARCH_SHOW_LINE_NUMBERS_SETTING, false),
    seedOnFocus: setting(settings, SEARCH_SEED_ON_FOCUS_SETTING, false),
    seedWithNearestWord: setting(settings, SEARCH_SEED_WITH_NEAREST_WORD_SETTING, false),
    useReplacePreview: setting(settings, SEARCH_USE_REPLACE_PREVIEW_SETTING, true),
    defaultViewMode: setting(settings, SEARCH_DEFAULT_VIEW_MODE_SETTING, 'list'),
    actionsPosition: setting(settings, SEARCH_ACTIONS_POSITION_SETTING, 'right'),
    searchEditor: {
      doubleClickBehaviour: setting(settings, SEARCH_EDITOR_DOUBLE_CLICK_SETTING, 'goToLocation'),
      focusResultsOnSearch: setting(settings, SEARCH_EDITOR_FOCUS_RESULTS_SETTING, false),
    },
  };
}

/**
 * The open documents Search reads in their buffers: projectKey's text files outside the settings files and the untitled
 * buffers; never a diff side, a file outside every project, another project's file or a Search Editor.
 */
export function searchBuffers(documents: DocumentService, projectKey: string): BufferDocument[] {
  return documents.all().flatMap((document): BufferDocument[] => {
    if (document.kind !== 'text' || document.searchEditor || document.settingsScope !== undefined) return [];
    if (document.untitled) return [{ documentId: document.id, target: { kind: 'untitled', title: document.name }, text: document.text }];
    const location = document.location;
    if (location?.projectKey !== projectKey || location.relativePath === undefined || document.readOnlyReason === 'outsideProject') return [];
    return [{
      documentId: document.id,
      target: { kind: 'file', relativePath: location.relativePath },
      text: document.text,
      ...(document.disk.exists ? { mtimeMs: document.disk.mtimeMs } : {}),
    }];
  });
}

// Whether two configs search alike: every field but showIncludesExcludes.
function sameSearch(a: SearchEditorConfig, b: SearchEditorConfig): boolean {
  return JSON.stringify(queryOf(a)) === JSON.stringify(queryOf(b)) && a.contextLines === b.contextLines;
}

function queryOf(config: SearchEditorConfig): SearchQuery {
  return {
    pattern: config.query,
    isRegex: config.isRegex,
    matchCase: config.matchCase,
    wholeWord: config.wholeWord,
    include: config.include,
    exclude: config.exclude,
    useExcludeSettingsAndIgnoreFiles: config.useExcludeSettingsAndIgnoreFiles,
    onlyOpenEditors: config.onlyOpenEditors,
  };
}

/**
 * Search in main: the Search view's and every Search Editor's runs, replace, preview, copy and the Search commands. The
 * renderer sends queries and main's ids; every path Search acts on is main's or confined by the document service.
 */
export class SearchHost {
  private readonly deps: SearchHostDeps;
  readonly service: SearchService;
  private readonly replacer: Replacer;
  // VS Code's memento of the last Search Editor config, for reusePriorSearchConfiguration
  private priorConfig: SearchEditorConfig | undefined;

  constructor(deps: SearchHostDeps) {
    this.deps = deps;
    this.service = new SearchService({
      folder: () => deps.selectedFolder(),
      rgPath: () => deps.rgPath(),
      ignoreArgs: () => deps.ignoreArgs(),
      excludeSettings: () => deps.excludeSettings(),
      settings: () => this.searchSettings(),
      buffers: (projectKey) => searchBuffers(deps.documents, projectKey),
      sendResults: (batch) => deps.sendResults(batch),
      sendFileUpdate: (update) => deps.sendFileUpdate(update),
      sendDone: (done) => {
        deps.sendDone(done);
        deps.stateChanged();
      },
      log: deps.log,
    });
    this.replacer = createReplacer({
      read: (projectKey, relativePath) => deps.documents.readClosedFile(projectKey, relativePath),
      write: (read, text) => deps.documents.writeClosedFile(read, text),
      reasonLabel: (skip) => this.reasonLabel(skip),
      notifySkipped: (lines, more) => {
        const tail = more > 0 ? `\n${deps.t('and {0} more', more)}` : '';
        deps.warn(`${deps.t('Some files were not replaced:')}\n${lines.join('\n')}${tail}`);
      },
    });
  }

  searchSettings(): SearchSettings {
    const settings = this.deps.settings;
    return {
      smartCase: setting(settings, SEARCH_SMART_CASE_SETTING, false),
      maxResults: Math.min(setting(settings, SEARCH_MAX_RESULTS_SETTING, MAX_SEARCH_RESULTS), MAX_SEARCH_RESULTS),
      debounceMs: setting(settings, SEARCH_ON_TYPE_DEBOUNCE_SETTING, 300),
      sortOrder: setting(settings, SEARCH_SORT_ORDER_SETTING, 'default'),
    };
  }

  start(request: SearchStartRequest): SearchStartResult {
    const result = this.service.start(request.searchId, request.query, request.immediate);
    this.deps.stateChanged();
    return result;
  }

  cancel(): void {
    this.service.cancel();
  }

  clear(): void {
    this.service.clear();
    this.deps.stateChanged();
  }

  /** A project switch or the window closing: every run ends, the Search Editors' included. */
  stopAll(): void {
    this.service.clearAll();
    for (const document of this.deps.editorPane.searchEditorDocuments()) {
      if (document.searchEditor?.running) this.deps.documents.setSearchEditorStatus(document.id, false, undefined);
    }
    this.deps.stateChanged();
  }

  documentChanged(documentId: string): void {
    this.service.documentChanged(documentId);
  }

  dismiss(request: SearchDismissRequest): void {
    this.service.dismiss(request.searchId, request.matchIds, request.files);
    this.deps.stateChanged();
  }

  async copy(request: SearchCopyRequest): Promise<void> {
    const search = this.service.recorded(request.searchId);
    if (!search) throw new Error('Unknown or superseded search');
    const pathOf = (key: { kind: 'file'; relativePath: string } | { kind: 'untitled'; documentId: string }, title: string | undefined): string =>
      key.kind === 'file' ? path.join(search.folder.fsPath, ...key.relativePath.split('/')) : (title ?? '');
    await this.deps.copy(this.service.copyText(request.searchId, request.target, pathOf, this.deps.lineDelimiter));
  }

  // Replace All asks first (D41), in VS Code's words.
  async confirmReplace(request: SearchConfirmReplaceRequest): Promise<boolean> {
    const t = this.deps.t;
    const { occurrences, files, replacement } = request;
    const message = occurrences === 1
      ? t('Replace {0} occurrence across {1} file with "{2}"?', occurrences, files, replacement)
      : files === 1
        ? t('Replace {0} occurrences across {1} file with "{2}"?', occurrences, files, replacement)
        : t('Replace {0} occurrences across {1} files with "{2}"?', occurrences, files, replacement);
    const choice = await this.deps.ask({ severity: 'warning', message, actions: [t('Replace')], cancelLabel: t('Cancel'), defaultAction: 0 });
    return choice === 0;
  }

  async replace(request: SearchReplaceRequest): Promise<SearchReplaceResult> {
    const search = this.service.recorded(request.searchId);
    if (!search) throw new Error('Unknown or superseded search');
    const result = await this.replacer(search, request);
    this.service.replaced(request.searchId, result.replaced);
    this.deps.stateChanged();
    return { replacedFiles: result.replacedFiles, replacedCount: result.replacedCount, skipped: result.skipped };
  }

  // A read-only diff tab of the file before and after the replacement; the left side is the document's text now, which
  // mirrors an open buffer. A file Replace would skip is not previewed, for the same reason.
  async preview(request: SearchPreviewRequest): Promise<SearchPreviewResult> {
    const search = this.service.recorded(request.searchId);
    if (!search) throw new Error('Unknown or superseded search');
    const matches = request.matchIds.map((id) => {
      const match = search.matches.get(id);
      if (!match) throw new Error('Unknown match id');
      return match;
    });
    const first = matches[0]!;
    const sameFile = (key: typeof first.file): boolean => (key.kind === 'file' && first.file.kind === 'file' ? key.relativePath === first.file.relativePath : key.kind === 'untitled' && first.file.kind === 'untitled' && key.documentId === first.file.documentId);
    if (!matches.every((match) => sameFile(match.file))) throw new Error('Preview matches of one file');
    const documents = this.deps.documents;
    let source: { readonly text: string; readonly eol: '\n' | '\r\n' } | undefined;
    if (first.file.kind === 'untitled') {
      const document = documents.get(first.file.documentId);
      if (document?.kind !== 'text') return { ok: false, reason: 'changed' };
      source = document;
    } else {
      source = documents.openText(search.folder.projectKey, first.file.relativePath);
      if (!source) {
        const read = await documents.readClosedFile(search.folder.projectKey, first.file.relativePath);
        if (read.kind !== 'text') return { ok: false, reason: read.kind === 'readOnly' ? 'readOnly' : 'changed' };
        source = read;
      }
    }
    const regExp = replaceRegExp(matchingPattern(search.query));
    if (!regExp) return { ok: false, reason: 'unsupportedRegex' };
    const text = source.text;
    const plan = planWithin(REPLACE_REGEX_TIMEOUT_MS, () => planReplacements(text, matches, search.query, regExp, request.replacement, request.preserveCase, source.eol));
    if (!plan.ok) return { ok: false, reason: plan.reason };
    const modified = applyEdits(text, plan.edits);
    const file = first.file.kind === 'file' ? { projectKey: search.folder.projectKey, relativePath: first.file.relativePath } : { documentId: first.file.documentId };
    this.deps.editorPane.openReplacePreview(file, text, modified);
    return { ok: true };
  }

  /** Find in Files (Replace in Files always shows the view): the view, or a Search Editor by damocles.desktop.search.mode. */
  searchInFiles(replace: boolean): void {
    const mode = setting(this.deps.settings, SEARCH_MODE_SETTING, 'view');
    if (replace || mode === 'view') {
      this.deps.showSidebar();
      this.deps.focusSearch({ replace });
      return;
    }
    const query = this.seed();
    this.openInMode(mode, query === undefined ? {} : { query }, this.deps.selectedFolder()?.projectKey);
  }

  /** Find in Folder...: the folder as VS Code's `./folder` include entry, never as a path ripgrep reads. */
  async findInFolder(folder: FileRef): Promise<void> {
    const project = this.deps.projects().find((candidate) => candidate.key === folder.projectKey);
    if (!project) throw new Error('Unknown project');
    const include = folderGlob(folder.relativePath);
    const mode = setting(this.deps.settings, SEARCH_MODE_SETTING, 'view');
    if (mode === 'view') {
      this.deps.showSidebar();
      this.deps.focusSearch({ replace: false, include });
      return;
    }
    this.openInMode(mode, { include, showIncludesExcludes: true }, project.key);
  }

  async openNew(request: SearchEditorOpenRequest): Promise<{ readonly tabId: string }> {
    if (request.from === 'viewResults') return this.openViewResults(request.searchId);
    const seed = request.config?.query === undefined ? this.seed() : undefined;
    return { tabId: this.openBlank({ ...request.config, ...(seed !== undefined ? { query: seed } : {}) }, this.deps.selectedFolder()?.projectKey) };
  }

  setConfig(documentId: string, config: SearchEditorConfig): void {
    this.requireTab(documentId);
    this.deps.documents.setSearchEditorConfig(documentId, config);
    this.priorConfig = config;
  }

  /** Runs the Search Editor's config (VS Code's doRunSearch): its project's folder, its context lines; an empty query does nothing. */
  run(documentId: string): void {
    const document = this.requireTab(documentId);
    const state = document.searchEditor!;
    const config = state.config;
    if (config.query === '') return;
    const project = this.deps.projects().find((candidate) => candidate.key === state.projectKey);
    const folder = project ? { projectKey: project.key, fsPath: project.fsPath } : undefined;
    this.deps.documents.setSearchEditorStatus(documentId, true, undefined);
    const started = this.service.startEditor(documentId, folder, queryOf(config), config.contextLines, (result) => this.completeRun(documentId, config, result));
    if (started.ok) return;
    this.deps.documents.setSearchEditorStatus(documentId, false, started.error === 'noProject' ? { kind: 'noProject' } : { kind: 'invalidGlob', glob: started.glob });
  }

  openResult(request: SearchEditorOpenResultRequest): Promise<SearchEditorOpenResult> {
    return this.deps.editorPane.openSearchResult(request.documentId, request.line, request.column, request.toSide);
  }

  /** A command for the view; main focuses the shell page first. */
  viewCommand(command: SearchViewCommand): void {
    if (command !== 'openNewSearchEditor' && command !== 'toggleQueryDetails') this.deps.showSidebar();
    this.deps.sendCommand({ target: 'view', command });
  }

  /** A command for the active Search Editor tab. */
  editorCommand(command: SearchEditorCommand): void {
    const document = this.deps.editorPane.activeSearchEditor();
    const tabId = document ? this.deps.editorPane.searchEditorTab(document.id) : undefined;
    if (tabId !== undefined) this.deps.sendCommand({ target: 'editor', tabId, command });
  }

  newSearchEditor(): void {
    const seed = this.seed();
    this.openBlank(seed === undefined ? {} : { query: seed }, this.deps.selectedFolder()?.projectKey);
  }

  openSearchEditor(): void {
    const seed = this.seed();
    this.openInMode('reuseEditor', seed === undefined ? {} : { query: seed }, this.deps.selectedFolder()?.projectKey);
  }

  openResultsInEditor(): void {
    const searchId = this.viewSearchId();
    if (searchId !== undefined) void this.openViewResults(searchId).catch((err: unknown) => this.deps.log(`[search] Open Results in Editor failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  async toggleSearchOnType(): Promise<void> {
    await this.deps.settings.update(SEARCH_ON_TYPE_SETTING, !setting(this.deps.settings, SEARCH_ON_TYPE_SETTING, true), 'user');
  }

  clearSearchHistory(): void {
    this.deps.clearSearchHistory();
  }

  menuState(sidebarSearchVisible: boolean): SearchMenuState {
    const view = this.service.viewState();
    return {
      editorActive: this.deps.editorPane.activeSearchEditor() !== undefined,
      viewHasSearch: view.hasSearch,
      viewHasResults: view.hasResults,
      viewRunning: view.running,
      viewVisible: sidebarSearchVisible,
    };
  }

  dispose(): void {
    this.service.dispose();
  }

  private viewSearchId(): number | undefined {
    return this.service.viewSearchId();
  }

  /** A closed Search Editor's run stops with its tab. */
  searchEditorClosed(documentId: string): void {
    this.service.discardEditor(documentId);
  }

  private reasonLabel(skip: SearchReplaceSkip): string {
    const t = this.deps.t;
    switch (skip.reason) {
      case 'failed': return skip.message === '' ? t('could not be written') : t('could not be written: {0}', skip.message);
      case 'changed': return t('changed since the search');
      case 'readOnly': return t('read-only');
      case 'openInEditor': return t('open in an editor');
      case 'conflict': return t('changed while it was being replaced');
      case 'timedOut': return t('the regular expression took too long');
      case 'unsupportedRegex': return t('the regular expression cannot be replaced here');
    }
  }

  // The active editor's selected text on one line, VS Code's seedSearchStringFromSelection.
  private seed(): string | undefined {
    const selected = this.deps.selectedText();
    return selected !== undefined && selected !== '' && !selected.includes('\n') ? selected : undefined;
  }

  private requireTab(documentId: string): TextDocument {
    if (this.deps.editorPane.searchEditorTab(documentId) === undefined) throw new Error('Unknown Search Editor');
    const document = this.deps.documents.get(documentId);
    if (document?.kind !== 'text' || !document.searchEditor) throw new Error('Unknown Search Editor');
    return document;
  }

  // reuseEditor takes the most recent Search Editor tab, as VS Code takes the most recently active one.
  private openInMode(mode: 'reuseEditor' | 'newEditor', config: Partial<SearchEditorConfig>, projectKey: string | undefined): void {
    const existing = mode === 'reuseEditor' ? this.deps.editorPane.searchEditorDocuments().at(-1) : undefined;
    if (!existing) {
      this.openBlank(config, projectKey);
      return;
    }
    const merged = { ...existing.searchEditor!.config, ...config };
    this.deps.documents.setSearchEditorConfig(existing.id, merged);
    const tabId = this.deps.editorPane.searchEditorTab(existing.id)!;
    void this.deps.editorPane.tabAction('activate', tabId).then(() => {
      this.deps.editorPane.focusTab(tabId);
      if (merged.query !== '' && setting(this.deps.settings, SEARCH_ON_TYPE_SETTING, true)) this.run(existing.id);
    }, (err: unknown) => this.deps.log(`[search] reusing the Search Editor failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // VS Code's getOrMakeSearchEditorInput: defaults, then the prior editor's config when reused, then the caller's; the context
  // lines come from the setting unless the caller set them. With a query and searchOnType it runs at once.
  private openBlank(config: Partial<SearchEditorConfig>, projectKey: string | undefined): string {
    const reuse = setting(this.deps.settings, SEARCH_EDITOR_REUSE_PRIOR_SETTING, false);
    const contextLines = config.contextLines ?? setting(this.deps.settings, SEARCH_EDITOR_CONTEXT_LINES_SETTING, 1);
    const merged: SearchEditorConfig = { ...DEFAULT_SEARCH_EDITOR_CONFIG, ...(reuse && this.priorConfig ? this.priorConfig : {}), ...config, contextLines };
    const document = this.deps.documents.openSearchEditor(projectKey, merged, '', { dirty: false });
    this.priorConfig = merged;
    const tabId = this.deps.editorPane.showSearchEditor(document, { focus: true });
    if (merged.query !== '' && setting(this.deps.settings, SEARCH_ON_TYPE_SETTING, true)) this.run(document.id);
    return tabId;
  }

  // VS Code's createEditorFromSearchResult: the view's results as they are, with no context; a default of context lines > 0
  // runs the query again in the new editor instead.
  private async openViewResults(searchId: number): Promise<{ readonly tabId: string }> {
    const results = this.service.viewResults(searchId);
    if (!results) throw new Error('Unknown or superseded search');
    const query = results.query;
    const config: SearchEditorConfig = {
      query: query.pattern,
      isRegex: query.isRegex,
      matchCase: query.matchCase,
      wholeWord: query.wholeWord,
      include: query.include,
      exclude: query.exclude,
      useExcludeSettingsAndIgnoreFiles: query.useExcludeSettingsAndIgnoreFiles,
      onlyOpenEditors: query.onlyOpenEditors,
      contextLines: 0,
      showIncludesExcludes: Boolean(query.include || query.exclude || !query.useExcludeSettingsAndIgnoreFiles),
    };
    const projectKey = this.deps.selectedFolder()?.projectKey;
    const contextLines = setting(this.deps.settings, SEARCH_EDITOR_CONTEXT_LINES_SETTING, 1);
    if (contextLines > 0) {
      const document = this.deps.documents.openSearchEditor(projectKey, { ...config, contextLines }, '', { dirty: false });
      const tabId = this.deps.editorPane.showSearchEditor(document, { focus: true });
      this.run(document.id);
      return { tabId };
    }
    const serialized = this.serialize(results.files, results.limitHit);
    const document = this.deps.documents.openSearchEditor(projectKey, config, serialized.text, { dirty: false });
    const tabId = this.deps.editorPane.showSearchEditor(document, { focus: true });
    this.deps.sendHighlights({ documentId: document.id, version: document.version, ranges: serialized.ranges });
    return { tabId };
  }

  private completeRun(documentId: string, config: SearchEditorConfig, result: EditorRunResult): void {
    const document = this.deps.documents.get(documentId);
    if (document?.kind !== 'text' || !document.searchEditor) return;
    // VS Code's onSearchComplete drops a run whose inputs changed since it started; showing the query details changes none.
    if (!sameSearch(document.searchEditor.config, config)) {
      this.deps.documents.setSearchEditorStatus(documentId, false, undefined);
      return;
    }
    const serialized = this.serialize(result.files, result.limitHit);
    this.deps.documents.setSearchEditorResults(documentId, serialized.text);
    this.deps.documents.setSearchEditorStatus(documentId, false, this.messageOf(result));
    this.deps.sendHighlights({ documentId, version: document.version, ranges: serialized.ranges });
  }

  private messageOf(result: EditorRunResult): SearchEditorMessage | undefined {
    if (result.error !== undefined) return { kind: 'error', text: result.error };
    if (result.bufferWarning === 'timedOut') return { kind: 'error', text: this.deps.t('The regular expression took too long on the open editors, so they were not searched.') };
    if (result.bufferWarning === 'unsupportedRegex') return { kind: 'error', text: this.deps.t('The open editors were not searched: this regular expression works only in ripgrep.') };
    return undefined;
  }

  // The results body, cut to whole files under the editor's text limit; a cut body says the result set is a subset.
  private serialize(files: readonly EditorFileResult[], limitHit: boolean): ReturnType<typeof serializeSearchResults> {
    const t = this.deps.t;
    const labels: ResultSummaryLabels = {
      results: (count) => (count > 1 ? t('{0} results', count) : t('1 result')),
      files: (count) => (count > 1 ? t('{0} files', count) : t('1 file')),
      noResults: t('No Results'),
      limitHit: t('The result set only contains a subset of all matches. Be more specific in your search to narrow down the results.'),
    };
    let kept = files;
    let serialized = serializeSearchResults(kept, limitHit, labels);
    while (serialized.text.length > MAX_EDITOR_TEXT_CHARS) {
      const last = kept.at(-1)!;
      kept = kept.length > 1 ? kept.slice(0, Math.ceil(kept.length / 2)) : [{ ...last, matches: last.matches.slice(0, Math.floor(last.matches.length / 2)) }];
      serialized = serializeSearchResults(kept, true, labels);
    }
    return serialized;
  }
}
