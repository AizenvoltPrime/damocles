import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { diffLines } from 'diff';
import type { Disposable } from '../../platform/disposable';
import type { ActiveEditorContext, DiffSide } from '../../platform/editor-service';
import type { SettingsStore } from '../../platform/settings-store';
import type { SettingsFileScope } from '../../shared/types/messages';
import { folderKey } from '../../core/workspace-folders/folder-key';
import {
  type EditorCommand,
  type EditorConflictResult,
  type EditorOpenResult,
  type EditorSaveResult,
  type EditorSelectionRange,
  type EditorTabAction,
  type EditorTabKind,
  EDITOR_FORMAT_TIMEOUT_MS,
  type FileRef,
  type FilesMutationResult,
  type SearchEditorConfig,
  type SearchEditorMessage,
  type SearchEditorOpenResult,
  type SearchRange,
  type ShellDocumentContent,
  type ShellEditorDocument,
  type ShellEditorSettings,
  type ShellEditorState,
  type ShellEditorTab,
} from '../preload/shell-channels';
import {
  EDITOR_AUTO_SAVES,
  EDITOR_AUTO_SAVE_SETTING,
  EDITOR_DETECT_INDENTATION_SETTING,
  EDITOR_FONT_SIZE_SETTING,
  EDITOR_FORMAT_ON_SAVE_SETTING,
  EDITOR_MINIMAP_SETTING,
  EDITOR_RENDER_WHITESPACES,
  EDITOR_RENDER_WHITESPACE_SETTING,
  EDITOR_TAB_SIZE_SETTING,
  EDITOR_WORD_WRAPS,
  EDITOR_WORD_WRAP_SETTING,
  isDesktopSettingValue,
} from './desktop-configuration';
import type { BackupRecord } from './documents/backups';
import { isDocumentDirty, movedPath, type Document, type DocumentService, type ShellEdit, type TextDocument } from './documents/document-service';
import type { FormatTarget } from './formatting/format-service';
import { DEFAULT_SEARCH_EDITOR_CONFIG, resultLocation } from './search/search-editor-format';
import { projectOfPath, type Project } from './documents/confine';
import type { BrowserTabsEditor } from './browser-tabs';
import type { AskMessage } from './message-dialog';

// Recent files Quick Open lists first, most recent first.
export const MAX_RECENT_FILES = 50;
// diff counts are skipped (shown as 0) past this many edited lines, so a huge diff never blocks main.
const MAX_DIFF_EDIT_LENGTH = 5000;
// The log tab re-reads its file at most this often while it grows.
const LOG_RELOAD_MS = 1000;
// The shell must answer editor:flush within this; a dead or hung page leaves main with its last mirrored text.
export const FLUSH_TIMEOUT_MS = 2000;
// A flush that formats first waits this much longer per document: Prettier's budgets to load and to format
// (formatter-hosts.ts) plus the round trips.
export const FORMAT_FLUSH_MS_PER_DOCUMENT: number = 2 * EDITOR_FORMAT_TIMEOUT_MS + 1000;

type FileTabKind = Exclude<EditorTabKind, 'browser'>;

// Where a file is: its native path, and its project place when it lies inside an open project.
interface Place {
  readonly path: string;
  readonly projectKey?: string;
  readonly relativePath?: string;
}

// The file a diff shows, which names its tab: a side's document when one is that file (it follows a rename itself), else
// the file's place, which a Files rename moves.
type DiffSubject = { readonly documentId: string } | { readonly place: Place };

// A file tab; page tabs belong to the browser tabs (BrowserTabSource).
interface Tab {
  readonly id: string;
  kind: FileTabKind;
  documentId?: string;
  // title: the tab title given the subject's current name (diffEditorInput.ts derives a diff's label from its resources)
  // conflictCompare: the conflict bar's Compare (on disk against the buffer); replacePreview: Search's replace preview
  diff?: {
    readonly originalId: string;
    readonly modifiedId: string;
    readonly added: number;
    readonly removed: number;
    readonly title: (fileName: string) => string;
    subject: DiffSubject;
    readonly conflictCompare?: true;
    readonly replacePreview?: true;
  };
}

// A persisted tab names its file; ids are issued again on restore.
export type PersistedTab =
  | { readonly kind: 'code' | 'markdownPreview' | 'image' | 'notDisplayed'; readonly file: FileRef; readonly backupId?: string }
  | { readonly kind: 'code' | 'markdownPreview' | 'image' | 'notDisplayed'; readonly path: string }
  | { readonly kind: 'settings'; readonly scope: SettingsFileScope; readonly backupId?: string }
  // a file of the logs directory, by name
  | { readonly kind: 'log'; readonly name: string }
  | { readonly kind: 'untitled'; readonly backupId: string }
  // a saved Search Editor reopens from its .code-search file; an untitled one from its backup, else from its header alone
  | { readonly kind: 'searchEditor'; readonly file: FileRef; readonly backupId?: string }
  | { readonly kind: 'searchEditor'; readonly projectKey?: string; readonly config: SearchEditorConfig; readonly backupId?: string };

export interface PersistedEditor {
  readonly tabs: readonly PersistedTab[];
  // index into tabs
  readonly active: number | null;
  readonly recent: readonly FileRef[];
}

// The selected chat's browser pages, which the pane shows as tabs after its file tabs (D14).
export interface BrowserTabSource {
  tabs(): readonly ShellEditorTab[];
  close(tabId: string): void;
  // the active tab changed; a page tab's page becomes the only page view shown
  activeChanged(tabId: string | null): void;
}

export interface EditorPaneDeps {
  readonly documents: DocumentService;
  readonly settings: SettingsStore;
  readonly ask: AskMessage;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly log: (line: string) => void;
  // damocles.desktop.restoreLayout: quit keeps dirty buffers as backups instead of asking
  readonly restoreLayout: () => boolean;
  readonly persist: (editor: PersistedEditor) => void;
  readonly flushBackups: () => Promise<void>;
  // the logs directory, whose files open as log tabs
  readonly logsDir: string;
  // to the shell page; no-ops while it is not loaded
  readonly sendState: (state: ShellEditorState) => void;
  readonly sendDocument: (documentId: string, content: ShellDocumentContent) => void;
  readonly sendCommand: (command: EditorCommand) => void;
  // format: documents the shell formats first, as Ctrl+S would
  readonly sendFlush: (requestId: string, format: readonly string[]) => boolean;
  // a user action opened tabId: main focuses the shell page and tells it to focus that tab
  readonly focusTab: (tabId: string) => void;
  // range: selected (a Search Editor result's position)
  readonly revealLine: (tabId: string, line: number, range?: SearchRange) => void;
  // shows the editor pane in the grid when it is hidden, without moving focus
  readonly showPane: () => void;
  // Open to the Side: the editor pane shows, and a maximized chat or terminal gives way to it
  readonly showPaneBeside: () => void;
  readonly projects: () => readonly Project[];
  readonly copy: (text: string) => Promise<void>;
  readonly reveal: (absolutePath: string) => Promise<void>;
  // Mention this file in chat: core's resolver for the selected chat
  readonly mention: (file: FileRef | { readonly path: string }) => Promise<void>;
  // the window's browser tabs; undefined while no window is open
  readonly browser: () => BrowserTabSource | undefined;
  // a warning toast
  readonly warn: (message: string) => void;
  // a Search Editor's document left with its last tab
  readonly searchEditorClosed: (documentId: string) => void;
}

function readSetting<T>(settings: SettingsStore, key: string, fallback: T): T {
  const value = settings.get<unknown>(key);
  return isDesktopSettingValue(key, value) ? (value as T) : fallback;
}

export function editorSettings(settings: SettingsStore): ShellEditorSettings {
  return {
    fontSize: readSetting(settings, EDITOR_FONT_SIZE_SETTING, 13),
    tabSize: readSetting(settings, EDITOR_TAB_SIZE_SETTING, 4),
    detectIndentation: readSetting(settings, EDITOR_DETECT_INDENTATION_SETTING, true),
    wordWrap: readSetting<(typeof EDITOR_WORD_WRAPS)[number]>(settings, EDITOR_WORD_WRAP_SETTING, 'off'),
    minimap: readSetting(settings, EDITOR_MINIMAP_SETTING, true),
    renderWhitespace: readSetting<(typeof EDITOR_RENDER_WHITESPACES)[number]>(settings, EDITOR_RENDER_WHITESPACE_SETTING, 'selection'),
    autoSave: readSetting<(typeof EDITOR_AUTO_SAVES)[number]>(settings, EDITOR_AUTO_SAVE_SETTING, 'off'),
    formatOnSave: readSetting(settings, EDITOR_FORMAT_ON_SAVE_SETTING, false),
  };
}

/** The text a 1-based Monaco selection covers, with the lines it spans; undefined for an empty selection. */
export function selectionText(text: string, range: EditorSelectionRange): { startLine: number; endLine: number; text: string } | undefined {
  const forward = range.startLine < range.endLine || (range.startLine === range.endLine && range.startColumn <= range.endColumn);
  const [startLine, startColumn, endLine, endColumn] = forward
    ? [range.startLine, range.startColumn, range.endLine, range.endColumn]
    : [range.endLine, range.endColumn, range.startLine, range.startColumn];
  const lines = text.split(/\r\n|\n/);
  if (startLine > lines.length) return undefined;
  const picked = lines.slice(startLine - 1, Math.min(endLine, lines.length));
  if (picked.length === 0) return undefined;
  // The end line is cut first, so on a one-line selection the start offset still counts from the line's start.
  picked[picked.length - 1] = picked[picked.length - 1]!.slice(0, endColumn - 1);
  picked[0] = picked[0]!.slice(startColumn - 1);
  const selected = picked.join('\n');
  return selected === '' ? undefined : { startLine, endLine, text: selected };
}

/** The 1-based line holding the setting key, else the line of the text's last closing brace (the end of its object). */
export function settingLine(text: string, key: string): number {
  const lines = text.split(/\r\n|\n/);
  const quoted = JSON.stringify(key);
  const found = lines.findIndex((line) => line.includes(quoted));
  if (found >= 0) return found + 1;
  for (let index = lines.length - 1; index >= 0; index--) if (lines[index]!.includes('}')) return index + 1;
  return Math.max(1, lines.length);
}

function diffCounts(original: string, modified: string): { added: number; removed: number } {
  const changes = diffLines(original, modified, { maxEditLength: MAX_DIFF_EDIT_LENGTH });
  if (!changes) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (change.added) added += change.count;
    else if (change.removed) removed += change.count;
  }
  return { added, removed };
}

function fileRefOf(document: Document): FileRef | undefined {
  const location = document.location;
  return location?.projectKey !== undefined && location.relativePath !== undefined ? { projectKey: location.projectKey, relativePath: location.relativePath } : undefined;
}

function sameSubject(a: DiffSubject, b: DiffSubject): boolean {
  if ('documentId' in a || 'documentId' in b) return 'documentId' in a && 'documentId' in b && a.documentId === b.documentId;
  return a.place.projectKey === b.place.projectKey && a.place.relativePath === b.place.relativePath && folderKey(a.place.path) === folderKey(b.place.path);
}

function placeFields(place: Place): Pick<ShellEditorTab, 'projectKey' | 'relativePath' | 'displayPath'> {
  return {
    ...(place.projectKey !== undefined ? { projectKey: place.projectKey } : {}),
    ...(place.relativePath !== undefined ? { relativePath: place.relativePath } : {}),
    displayPath: place.path,
  };
}

function isMarkdown(document: Document): boolean {
  return document.kind === 'text' && document.languageId === 'markdown';
}

/** The editor pane's tab list, recent files and active editor; the shell renders what it publishes. */
export class EditorPane implements Disposable, BrowserTabsEditor {
  private readonly deps: EditorPaneDeps;
  private tabs: Tab[] = [];
  private activeId: string | null = null;
  // the last file tab activated, which takes over when the active page tab goes or hides
  private lastFileTabId: string | null = null;
  private recent: FileRef[] = [];
  private selection: { readonly documentId: string; readonly range: EditorSelectionRange | null } | undefined;
  private readonly contextListeners = new Set<(context: ActiveEditorContext | undefined) => void>();
  private readonly flushes = new Map<string, () => void>();
  private readonly logReloads = new Map<string, NodeJS.Timeout>();
  private readonly subscriptions: Disposable[];
  private stateScheduled = false;
  private persistScheduled = false;
  // a quit or window close the user agreed to; later asks pass through
  private released = false;
  private disposed = false;

  constructor(deps: EditorPaneDeps) {
    this.deps = deps;
    this.subscriptions = [
      deps.documents.onDidChange((change) => {
        if (change.content) this.deps.sendDocument(change.documentId, this.deps.documents.content(change.documentId));
        this.stateChanged();
      }),
      deps.settings.onDidChange('damocles.desktop.editor', () => this.stateChanged()),
    ];
  }

  state(): ShellEditorState {
    return {
      tabs: [...this.tabs.map((tab) => this.shellTab(tab)), ...this.browserTabs()],
      activeTabId: this.activeId,
      settings: editorSettings(this.deps.settings),
      documents: this.shellDocuments(),
    };
  }

  activeTabId(): string | null {
    return this.activeId;
  }

  activateBrowserTab(tabId: string): void {
    this.setActive(tabId);
    this.deps.showPane();
  }

  leaveBrowserTab(): void {
    this.activateFallback();
  }

  // Page tabs carry nothing the layout file keeps, so they are only republished.
  browserTabsChanged(): void {
    this.stateChanged(false);
  }

  focusTab(tabId: string): void {
    this.deps.focusTab(tabId);
  }

  recentFiles(): readonly FileRef[] {
    return this.recent;
  }

  content(documentId: string): ShellDocumentContent {
    if (!this.tabs.some((tab) => tab.documentId === documentId || tab.diff?.originalId === documentId || tab.diff?.modifiedId === documentId)) {
      throw new Error('Unknown document');
    }
    return this.deps.documents.content(documentId);
  }

  /**
   * A user's open (Files, Quick Open, a Files drop, Search, a terminal link): confined, activated and focused, unless
   * preserveFocus (Search's single click); toSide shows the pane beside a maximized part too, since the editor pane is
   * Damocles' only side group. column places the caret on line, 1-based.
   */
  async openFromUser(
    projectKey: string,
    relativePath: string,
    opts: { readonly line?: number; readonly column?: number; readonly as?: 'preview' | 'source'; readonly preserveFocus?: boolean; readonly toSide?: boolean } = {},
  ): Promise<EditorOpenResult> {
    const opened = await this.deps.documents.openProjectFile(projectKey, relativePath);
    if (!opened.ok) return opened;
    const tab = this.showDocument(opened.document, opts.as === 'preview' && isMarkdown(opened.document) ? 'markdownPreview' : undefined);
    if (opts.toSide === true) this.deps.showPaneBeside();
    this.afterOpen(tab, {
      focus: opts.preserveFocus !== true,
      ...(opts.line !== undefined ? { line: opts.line } : {}),
      ...(opts.column !== undefined ? { column: opts.column } : {}),
    });
    return { ok: true, tabId: tab.id };
  }

  /** A new Search Editor tab of a document the caller made; a user action focuses it. */
  showSearchEditor(document: TextDocument, opts: { readonly focus: boolean }): string {
    const tab = this.addTab({ id: randomUUID(), kind: 'searchEditor', documentId: document.id });
    this.afterOpen(tab, { focus: opts.focus });
    return tab.id;
  }

  /** The Search Editor tabs' documents, most recently opened last. */
  searchEditorDocuments(): TextDocument[] {
    return this.tabs.flatMap((tab) => {
      const document = tab.kind === 'searchEditor' && tab.documentId !== undefined ? this.deps.documents.get(tab.documentId) : undefined;
      return document?.kind === 'text' && document.searchEditor ? [document] : [];
    });
  }

  /** The tab showing a Search Editor document. */
  searchEditorTab(documentId: string): string | undefined {
    return this.tabs.find((tab) => tab.kind === 'searchEditor' && tab.documentId === documentId)?.id;
  }

  /** The active tab's Search Editor document, when the active tab is one. */
  activeSearchEditor(): TextDocument | undefined {
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId);
    const document = tab?.kind === 'searchEditor' && tab.documentId !== undefined ? this.deps.documents.get(tab.documentId) : undefined;
    return document?.kind === 'text' && document.searchEditor ? document : undefined;
  }

  /**
   * Go to a Search Editor result (the search-result language's definition): main reads the body it holds, takes the file
   * label above the line as a path inside the editor's project only, and opens it there with the caret at the match.
   */
  async openSearchResult(documentId: string, line: number, column: number, toSide: boolean): Promise<SearchEditorOpenResult> {
    if (!this.tabs.some((tab) => tab.kind === 'searchEditor' && tab.documentId === documentId)) throw new Error('Unknown Search Editor');
    const document = this.deps.documents.get(documentId);
    if (document?.kind !== 'text' || !document.searchEditor) throw new Error('Unknown Search Editor');
    const projectKey = document.searchEditor.projectKey;
    const location = resultLocation(document.text, line, column);
    if (!location) return { ok: false, reason: 'notResult' };
    if (projectKey === undefined) return { ok: false, reason: 'outside' };
    const opened = await this.deps.documents.openProjectFile(projectKey, location.relativePath);
    if (!opened.ok) return opened;
    const tab = this.showDocument(opened.document);
    if (toSide) this.deps.showPaneBeside();
    this.afterOpen(tab, { focus: true });
    if (location.kind === 'match') {
      this.deps.revealLine(tab.id, location.line, { startLine: location.line, startColumn: location.column, endLine: location.line, endColumn: location.column });
    }
    return { ok: true, tabId: tab.id };
  }

  /** A path core named (a tool card click, the agent): shown in the pane, focused only for a user's click. */
  async openPath(filePath: string, opts: { readonly line?: number; readonly focus: boolean; readonly preview?: boolean }): Promise<void> {
    const document = await this.deps.documents.openPath(filePath);
    const tab = this.showDocument(document, opts.preview === true && isMarkdown(document) ? 'markdownPreview' : undefined);
    this.afterOpen(tab, { focus: opts.focus, ...(opts.line !== undefined ? { line: opts.line } : {}) });
  }

  openUntitled(content: string, name: string, languageId: string, opts: { readonly focus: boolean }): void {
    const document = this.deps.documents.openMemory(name, content, { untitled: true, languageId });
    const tab = this.addTab({ id: randomUUID(), kind: 'untitled', documentId: document.id });
    this.afterOpen(tab, { focus: opts.focus });
  }

  /**
   * A diff without an approval: two read-only sides, unless a side is a file inside a project, which stays editable. filePath
   * names the file it shows, and title its tab after that file's current name.
   */
  async showDiff(title: (fileName: string) => string, filePath: string, left: DiffSide, right: DiffSide, opts: { readonly focus: boolean }): Promise<{ close(): void }> {
    const [original, modified] = await Promise.all([this.sideDocument(left), this.sideDocument(right)]);
    const fileSide = 'path' in right ? modified : 'path' in left ? original : undefined;
    const subject: DiffSubject = fileSide ? { documentId: fileSide.id } : { place: await this.placeOfPath(filePath) };
    const tab = this.openDiffTab(title, original, modified, subject);
    this.afterOpen(tab, { focus: opts.focus });
    // Edits the user made to the file in this tab are asked about, as VS Code's tabGroups.close asks before closing a dirty editor.
    return { close: () => this.closeTabs([tab.id], { ask: true }) };
  }

  /** Search's replace preview of a project file or an untitled buffer: one read-only diff tab per file, which a later preview of that file takes over. */
  openReplacePreview(file: FileRef | { readonly documentId: string }, original: string, modified: string): void {
    const subject: DiffSubject = 'documentId' in file ? { documentId: file.documentId } : { place: this.placeOfFile(file) };
    const previous = this.tabs.find((tab) => tab.diff?.replacePreview === true && sameSubject(tab.diff.subject, subject));
    if (previous) void this.closeTabs([previous.id], { ask: false });
    const name = this.subjectName(subject);
    const sides = [original, modified].map((text) => this.deps.documents.openMemory(name, text, { untitled: false }));
    const tab = this.openDiffTab((fileName) => this.deps.t('{0} ↔ {1} (Replace Preview)', fileName, fileName), sides[0]!, sides[1]!, subject, { replacePreview: true });
    this.afterOpen(tab, { focus: false });
  }

  /** Edit settings.json: a settings tab, at key's line when the file holds it, else at the end of its object. */
  async openSettingsFile(scope: SettingsFileScope, key?: string): Promise<void> {
    const document = await this.deps.documents.openSettingsFile(scope);
    if (!document) throw new Error(this.deps.t('This settings file does not apply now.'));
    const existing = this.tabs.find((tab) => tab.documentId === document.id && tab.kind === 'settings');
    const tab = existing ?? this.addTab({ id: randomUUID(), kind: 'settings', documentId: document.id });
    const line = key !== undefined && document.kind === 'text' ? settingLine(document.text, key) : undefined;
    this.afterOpen(tab, { focus: true, ...(line !== undefined ? { line } : {}) });
  }

  /** D36: a log sink's file as a read-only tab that reloads in place while it grows. */
  async openLog(filePath: string, focus: boolean): Promise<void> {
    const document = await this.deps.documents.openPath(filePath, { readOnlyReason: 'log' });
    const existing = this.tabs.find((tab) => tab.documentId === document.id && tab.kind === 'log');
    const tab = existing ?? this.addTab({ id: randomUUID(), kind: 'log', documentId: document.id });
    this.afterOpen(tab, { focus });
  }

  async tabAction(action: EditorTabAction, tabId: string): Promise<void> {
    if (this.browserTabs().some((candidate) => candidate.id === tabId)) {
      await this.browserTabAction(action, tabId);
      return;
    }
    const tab = this.tab(tabId);
    const document = tab.documentId !== undefined ? this.deps.documents.get(tab.documentId) : tab.diff ? this.deps.documents.get(tab.diff.modifiedId) : undefined;
    switch (action) {
      case 'activate':
        this.activate(tab.id);
        return;
      case 'close':
        await this.closeTabs([tab.id], { ask: true });
        return;
      case 'closeOthers':
      case 'closeRight':
      case 'closeAll':
        await this.closeAround(action, tab.id);
        return;
      case 'openPreview':
      case 'openSource':
        if (!document || !isMarkdown(document)) return;
        this.afterOpen(this.showDocument(document, action === 'openPreview' ? 'markdownPreview' : 'code'), { focus: true });
        return;
      case 'openFile':
        if (!document) return;
        this.afterOpen(this.showDocument(document, document.kind === 'text' ? 'code' : undefined), { focus: true });
        return;
      case 'openChanges':
        throw new Error('Open changes needs source control, which this version does not have');
      case 'copyPath':
      case 'copyRelativePath': {
        const location = document?.location;
        if (!location) return;
        const relative = action === 'copyRelativePath' && location.relativePath !== undefined;
        await this.deps.copy(relative ? location.relativePath!.split('/').join(path.sep) : location.path);
        return;
      }
      case 'revealInExplorer':
        if (document?.location) await this.deps.reveal(document.location.path);
        return;
    }
  }

  edit(documentId: string, edit: ShellEdit): void {
    if (!this.holds(documentId)) return;
    this.deps.documents.edit(documentId, edit);
  }

  async save(documentId: string, version: number, text: string, as: boolean): Promise<EditorSaveResult> {
    if (!this.holds(documentId)) return { ok: false, reason: 'failed' };
    const result = as ? await this.deps.documents.saveAs(documentId, version, text) : await this.deps.documents.save(documentId, version, text);
    if (result.ok) this.noteRecent(documentId);
    return result;
  }

  async conflict(documentId: string, action: 'compare' | 'overwrite' | 'revert'): Promise<EditorConflictResult> {
    if (!this.holds(documentId)) return { ok: false, reason: 'failed' };
    if (action === 'overwrite') {
      const result = await this.deps.documents.overwrite(documentId);
      if (result.ok) await this.showResolved(documentId);
      return result;
    }
    if (action === 'revert') {
      const result = await this.deps.documents.revert(documentId);
      if (result.ok) await this.showResolved(documentId);
      return result;
    }
    const document = this.deps.documents.get(documentId);
    if (document?.kind !== 'text') return { ok: false, reason: 'failed' };
    const disk = this.deps.documents.openMemory(document.name, await this.deps.documents.diskText(documentId), { untitled: false, languageId: document.languageId });
    const tab = this.openDiffTab((fileName) => this.deps.t('{0} (On disk ↔ Yours)', fileName), disk, document, { documentId: document.id }, { conflictCompare: true });
    this.afterOpen(tab, { focus: true });
    return { ok: true };
  }

  /**
   * A Files rename of `from` that `renameOnDisk` makes: the tabs of every document at or under it show it under its new path
   * in place, keeping their order, buffer and undo, and focus stays where it is (editorService.ts handleMovedFile).
   */
  async fileRenamed(projectKey: string, from: string, renameOnDisk: () => Promise<FilesMutationResult>): Promise<FilesMutationResult> {
    const result = await this.deps.documents.rename(projectKey, from, renameOnDisk);
    if (result.ok && result.relativePath !== from) this.filesMoved(projectKey, from, result.relativePath);
    return result;
  }

  private filesMoved(projectKey: string, from: string, to: string): void {
    for (const tab of this.tabs) {
      const place = tab.diff && 'place' in tab.diff.subject ? tab.diff.subject.place : undefined;
      const relativePath = place?.projectKey === projectKey && place.relativePath !== undefined ? movedPath(place.relativePath, from, to) : undefined;
      if (tab.diff && relativePath !== undefined) tab.diff.subject = { place: this.placeOfFile({ projectKey, relativePath }) };
    }
    this.recent = this.recent.map((file) => {
      const relativePath = file.projectKey === projectKey ? movedPath(file.relativePath, from, to) : undefined;
      return relativePath === undefined ? file : { projectKey, relativePath };
    });
    this.stateChanged();
    this.contextChanged();
  }

  select(documentId: string, range: EditorSelectionRange | null): void {
    if (!this.holds(documentId)) return;
    this.selection = { documentId, range };
    this.contextChanged();
  }

  async mention(tabId: string): Promise<void> {
    const tab = this.tab(tabId);
    const documentId = tab.documentId ?? tab.diff?.modifiedId;
    const document = documentId === undefined ? undefined : this.deps.documents.get(documentId);
    if (!document?.location) return;
    await this.deps.mention(fileRefOf(document) ?? { path: document.location.path });
  }

  command(command: EditorCommand): void {
    if (this.activeId === null) return;
    this.deps.sendCommand(command);
  }

  /** Activates the next or previous tab, wrapping, as Ctrl+Tab in an editor group does. */
  cycle(delta: 1 | -1): void {
    const ids = this.visibleIds();
    if (ids.length === 0) return;
    const index = ids.indexOf(this.activeId ?? '');
    const next = ids[(index + delta + ids.length) % ids.length]!;
    this.activate(next);
    this.deps.focusTab(next);
  }

  /** An open editable text document of a project file, which format on save and Format Document may format. */
  formatTarget(documentId: string): FormatTarget | undefined {
    if (!this.holds(documentId)) return undefined;
    const document = this.deps.documents.get(documentId);
    if (document?.kind !== 'text' || document.readOnlyReason !== undefined || document.settingsScope !== undefined || document.untitled || document.searchEditor) return undefined;
    const location = document.location;
    if (location?.projectKey === undefined || location.relativePath === undefined) return undefined;
    return { path: location.path, projectKey: location.projectKey, relativePath: location.relativePath, name: document.name, languageId: document.languageId };
  }

  hasTabs(): boolean {
    return this.visibleIds().length > 0;
  }

  activeContext(): ActiveEditorContext | undefined {
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId);
    const document = tab?.documentId !== undefined ? this.deps.documents.get(tab.documentId) : undefined;
    if (!tab || !document || (tab.kind !== 'code' && tab.kind !== 'markdownPreview')) return { filePath: undefined, selection: undefined };
    const range = this.selection?.documentId === document.id ? this.selection.range : null;
    const selection = range && document.kind === 'text' ? selectionText(document.text, range) : undefined;
    return { filePath: document.location?.path, selection };
  }

  onDidChangeActiveContext(listener: (context: ActiveEditorContext | undefined) => void): Disposable {
    this.contextListeners.add(listener);
    return { dispose: () => this.contextListeners.delete(listener) };
  }

  flushed(requestId: string): void {
    this.flushes.get(requestId)?.();
  }

  /**
   * Quit or window close: the shell's last edits arrive first; then with "Reopen where I left off" the dirty
   * buffers stay as backups, and without it the user chooses Save, Don't Save or Cancel. False cancels the close.
   */
  async release(): Promise<boolean> {
    if (this.released) return true;
    await this.flush();
    const dirty = this.dirtyDocuments();
    if (this.deps.restoreLayout() || dirty.length === 0) {
      await this.deps.flushBackups();
      this.persist();
      this.released = true;
      return true;
    }
    const choice = await this.deps.ask({
      severity: 'warning',
      message: dirty.length === 1
        ? this.deps.t('Do you want to save the changes you made to {0}?', dirty[0]!.name)
        : this.deps.t('Do you want to save the changes to the following {0} files?', dirty.length),
      detail: [...(dirty.length > 1 ? [dirty.map((document) => document.name).join('\n')] : []), this.deps.t('Your changes will be lost if you don\'t save them.')].join('\n\n'),
      // Save and Don't Save only; Escape or dismissing the dialog answers undefined, which keeps the app open.
      actions: [dirty.length === 1 ? this.deps.t('Save') : this.deps.t('Save All'), this.deps.t('Don\'t Save')],
      defaultAction: 0,
    });
    if (choice === undefined) return false;
    if (choice === 0) {
      await this.flush(this.formatsOnSave(dirty));
      for (const document of dirty) {
        const result = await this.deps.documents.save(document.id, document.version, document.text);
        if (!result.ok) return false;
      }
    } else {
      for (const document of dirty) this.deps.documents.release(document.id, true);
      this.tabs = this.tabs.filter((tab) => !dirty.some((document) => tab.documentId === document.id || tab.diff?.modifiedId === document.id));
    }
    this.persist();
    this.released = true;
    return true;
  }

  get isReleased(): boolean {
    return this.released;
  }

  /** A window opened again after a close the user agreed to (macOS keeps the app running). */
  reopened(): void {
    this.released = false;
  }

  /**
   * Reopens the persisted tabs and every hot-exit backup. A tab without a backup whose file is gone or no longer confined is
   * dropped and logged; a backup's text always comes back (restoreBackup).
   */
  async restore(saved: PersistedEditor, backups: readonly BackupRecord[]): Promise<void> {
    const byId = new Map(backups.map((record) => [record.backupId, record]));
    const restored: Array<Tab | undefined> = [];
    for (const persisted of saved.tabs) {
      const backupId = 'backupId' in persisted ? persisted.backupId : undefined;
      const backup = backupId === undefined ? undefined : byId.get(backupId);
      if (backupId !== undefined) byId.delete(backupId);
      if (backup) {
        restored.push(await this.restoreBackup(backup, persisted.kind));
        continue;
      }
      restored.push(await this.restoreTab(persisted).catch((err: unknown) => {
        this.deps.log(`[editor] dropping a saved ${persisted.kind} tab: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }));
    }
    for (const backup of byId.values()) {
      const tab = await this.restoreBackup(backup);
      if (tab) restored.push(tab);
    }
    const active = saved.active === null ? undefined : restored[saved.active];
    this.recent = [...saved.recent];
    this.setActive(active?.id ?? this.tabs.at(-1)?.id ?? null);
    this.stateChanged();
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const timer of this.logReloads.values()) clearTimeout(timer);
    this.contextListeners.clear();
  }

  // A saved tab that names no backup: the file as it is on disk.
  private async restoreTab(persisted: PersistedTab): Promise<Tab | undefined> {
    if (persisted.kind === 'untitled') return undefined;
    if (persisted.kind === 'searchEditor' && !('file' in persisted)) {
      const projectKey = this.liveProjectKey(persisted.projectKey);
      const message: SearchEditorMessage | undefined = persisted.config.query !== '' ? { kind: 'stale' } : undefined;
      const document = this.deps.documents.openSearchEditor(projectKey, persisted.config, '', { dirty: false, ...(message ? { message } : {}) });
      return this.addTab({ id: randomUUID(), kind: 'searchEditor', documentId: document.id }, false);
    }
    if (persisted.kind === 'log') {
      const document = await this.deps.documents.openPath(path.join(this.deps.logsDir, persisted.name), { readOnlyReason: 'log' });
      return this.addTab({ id: randomUUID(), kind: 'log', documentId: document.id }, false);
    }
    let document: Document | undefined;
    if (persisted.kind === 'settings') {
      document = await this.deps.documents.openSettingsFile(persisted.scope);
    } else if ('file' in persisted) {
      const opened = await this.deps.documents.openProjectFile(persisted.file.projectKey, persisted.file.relativePath);
      if (!opened.ok) throw new Error(`${persisted.file.relativePath} is ${opened.reason}`);
      document = opened.document;
    } else {
      document = await this.deps.documents.openPath(persisted.path);
    }
    if (!document) return undefined;
    return this.addTab({ id: randomUUID(), kind: persisted.kind === 'settings' ? 'settings' : this.kindFor(document, persisted.kind), documentId: document.id }, false);
  }

  /**
   * A backup's text always comes back, as VS Code opens an editor for every backup (workingCopyBackupTracker.ts
   * restoreBackups): in its file's document, a file deleted on disk included, else as an untitled buffer keeping the backup,
   * and the user is told why. preferred: the kind of the saved tab that named it.
   */
  private async restoreBackup(backup: BackupRecord, preferred?: PersistedTab['kind']): Promise<Tab | undefined> {
    let placed: Tab | string;
    try {
      placed = await this.placeBackup(backup, preferred);
    } catch (err) {
      this.deps.log(`[editor] backup ${backup.backupId} could not be reopened in place: ${err instanceof Error ? err.message : String(err)}`);
      placed = this.deps.t('It could not be reopened.');
    }
    if (typeof placed !== 'string') return placed;
    this.deps.warn(this.deps.t('The unsaved changes to {0} are in an untitled editor: {1}', backup.name, placed));
    return this.restoreUntitled(backup);
  }

  // The backup's tab, or why its document cannot take its text.
  private async placeBackup(backup: BackupRecord, preferred?: PersistedTab['kind']): Promise<Tab | string> {
    const target = backup.target;
    if (target.kind === 'untitled') return this.restoreUntitled(backup);
    if (target.kind === 'searchEditor') {
      const searchEditor = this.deps.documents.openSearchEditor(this.liveProjectKey(target.projectKey), DEFAULT_SEARCH_EDITOR_CONFIG, '', { dirty: false });
      this.deps.documents.restoreBuffer(searchEditor.id, backup.text, backup.backupId);
      return this.addTab({ id: randomUUID(), kind: 'searchEditor', documentId: searchEditor.id }, false);
    }
    let document: Document;
    if (target.kind === 'settings') {
      const located = await this.deps.documents.openSettingsFile(target.scope);
      if (!located) return this.deps.t('That settings file does not apply now.');
      document = located;
      // A settings buffer belongs to the file it was opened from; the scope names another once the default project moved.
      if (!document.location || folderKey(document.location.path) !== folderKey(target.path)) return this.refuseBackup(document, this.deps.t('That settings file does not apply now.'));
    } else {
      if (this.liveProjectKey(target.projectKey) === undefined) return this.deps.t('Its project is no longer open.');
      const opened = await this.deps.documents.openProjectFile(target.projectKey, target.relativePath, { missing: backup });
      if (!opened.ok) {
        if (opened.reason === 'outside') return this.deps.t('It is now outside its project.');
        return opened.reason === 'missing' ? this.deps.t('Its project folder is missing.') : this.deps.t('It cannot be read.');
      }
      document = opened.document;
    }
    if (document.kind !== 'text' || document.readOnlyReason !== undefined) return this.refuseBackup(document, this.deps.t('The editor cannot change it as it is on disk now.'));
    // A second backup of one file (a crash between two sessions) never overwrites the text the first restored.
    if (isDocumentDirty(document)) return this.refuseBackup(document, this.deps.t('Another backup of it was restored first.'));
    this.deps.documents.restoreBuffer(document.id, backup.text, backup.backupId);
    const kind = target.kind === 'settings' ? 'settings' : this.kindFor(document, preferred === 'markdownPreview' ? preferred : undefined);
    return this.tabs.find((tab) => tab.documentId === document.id && tab.kind === kind) ?? this.addTab({ id: randomUUID(), kind, documentId: document.id }, false);
  }

  // A document opened only to take a backup it cannot hold is released again unless a tab shows it.
  private refuseBackup(document: Document, reason: string): string {
    if (!this.holds(document.id)) this.deps.documents.release(document.id, false);
    return reason;
  }

  private restoreUntitled(backup: BackupRecord): Tab {
    const document = this.deps.documents.openMemory(backup.name, backup.text, { untitled: true, languageId: backup.languageId });
    this.deps.documents.restoreBuffer(document.id, backup.text, backup.backupId);
    return this.addTab({ id: randomUUID(), kind: 'untitled', documentId: document.id }, false);
  }

  // A saved project key, when that project is still open; a Search Editor of a removed project keeps its text and opens nothing.
  private liveProjectKey(projectKey: string | undefined): string | undefined {
    return projectKey !== undefined && this.deps.projects().some((project) => project.key === projectKey) ? projectKey : undefined;
  }

  private async sideDocument(side: DiffSide): Promise<Document> {
    if ('path' in side) return this.deps.documents.openPath(side.path);
    return this.deps.documents.openMemory(side.name, side.content, { untitled: false });
  }

  private openDiffTab(
    title: (fileName: string) => string,
    original: Document,
    modified: Document,
    subject: DiffSubject,
    flags: { readonly conflictCompare?: true; readonly replacePreview?: true } = {},
  ): Tab {
    const counts = original.kind === 'text' && modified.kind === 'text' ? diffCounts(original.text, modified.text) : { added: 0, removed: 0 };
    return this.addTab({ id: randomUUID(), kind: 'diff', diff: { originalId: original.id, modifiedId: modified.id, title, subject, ...counts, ...flags } });
  }

  // A file outside every project has a path only.
  private async placeOfPath(filePath: string): Promise<Place> {
    const absolute = path.resolve(filePath);
    const inProject = await projectOfPath(this.deps.projects(), absolute).catch(() => undefined);
    return inProject ? { path: inProject.path, projectKey: inProject.project.key, relativePath: inProject.relativePath } : { path: absolute };
  }

  private placeOfFile(file: FileRef): Place {
    const project = this.deps.projects().find((candidate) => candidate.key === file.projectKey);
    return { path: path.join(project?.fsPath ?? '', ...file.relativePath.split('/')), projectKey: file.projectKey, relativePath: file.relativePath };
  }

  private subjectName(subject: DiffSubject): string {
    if ('place' in subject) return path.basename(subject.place.path);
    return this.deps.documents.get(subject.documentId)?.name ?? '';
  }

  // Overwrite or Revert resolved the conflict: its compare tabs close and the file's own tab shows with focus, as VS Code's
  // resolve actions reopen the file's editor and close the compare editor (textFileSaveErrorHandler.ts).
  private async showResolved(documentId: string): Promise<void> {
    const compares = this.tabs.filter((tab) => tab.diff?.conflictCompare === true && tab.diff.modifiedId === documentId).map((tab) => tab.id);
    const document = this.deps.documents.get(documentId);
    if (compares.length === 0 || !document) return;
    // The file's tab holds the document before the compare tabs go, which would release it otherwise.
    const fileTab = this.tabs.find((tab) => tab.documentId === documentId) ?? this.showDocument(document);
    await this.closeTabs(compares, { ask: false });
    this.afterOpen(fileTab, { focus: true });
  }

  private kindFor(document: Document, preferred?: FileTabKind): FileTabKind {
    if (document.kind === 'image') return 'image';
    if (document.kind === 'notDisplayed') return 'notDisplayed';
    if (document.searchEditor) return 'searchEditor';
    return preferred === 'markdownPreview' && isMarkdown(document) ? 'markdownPreview' : 'code';
  }

  // The tab already showing the document in that kind, else a new one after the active tab.
  private showDocument(document: Document, preferred?: FileTabKind): Tab {
    const kind = this.kindFor(document, preferred);
    const existing = this.tabs.find((tab) => tab.documentId === document.id && tab.kind === kind);
    return existing ?? this.addTab({ id: randomUUID(), kind, documentId: document.id });
  }

  private addTab(tab: Tab, afterActive = true): Tab {
    const index = afterActive ? this.tabs.findIndex((candidate) => candidate.id === this.activeId) : -1;
    if (index < 0) this.tabs.push(tab);
    else this.tabs.splice(index + 1, 0, tab);
    if (tab.kind === 'log' && tab.documentId !== undefined) this.followLog(tab.documentId);
    return tab;
  }

  private afterOpen(tab: Tab, opts: { readonly focus: boolean; readonly line?: number; readonly column?: number }): void {
    this.activate(tab.id);
    if (tab.documentId !== undefined) this.noteRecent(tab.documentId);
    this.deps.showPane();
    if (opts.focus) this.deps.focusTab(tab.id);
    if (opts.line === undefined) return;
    if (opts.column === undefined) this.deps.revealLine(tab.id, opts.line);
    else this.deps.revealLine(tab.id, opts.line, { startLine: opts.line, startColumn: opts.column, endLine: opts.line, endColumn: opts.column });
  }

  private activate(tabId: string): void {
    this.setActive(tabId);
  }

  private setActive(tabId: string | null): void {
    if (this.activeId === tabId) return;
    this.activeId = tabId;
    if (tabId !== null && this.tabs.some((tab) => tab.id === tabId)) this.lastFileTabId = tabId;
    this.selection = undefined;
    this.stateChanged();
    this.contextChanged();
    this.deps.browser()?.activeChanged(tabId);
  }

  // The last file tab activated, else the last file tab, else the first page tab.
  private activateFallback(): void {
    const fallback = this.tabs.find((tab) => tab.id === this.lastFileTabId) ?? this.tabs.at(-1);
    this.setActive(fallback?.id ?? this.browserTabs()[0]?.id ?? null);
  }

  private browserTabs(): readonly ShellEditorTab[] {
    return this.deps.browser()?.tabs() ?? [];
  }

  // File tabs, then the selected chat's page tabs, as the shell shows them.
  private visibleIds(): string[] {
    return [...this.tabs.map((tab) => tab.id), ...this.browserTabs().map((tab) => tab.id)];
  }

  private async closeAround(action: 'closeOthers' | 'closeRight' | 'closeAll', tabId: string): Promise<void> {
    const ids = this.visibleIds();
    const targets = action === 'closeAll' ? ids : action === 'closeOthers' ? ids.filter((id) => id !== tabId) : ids.slice(ids.indexOf(tabId) + 1);
    await this.closeTabs(targets, { ask: true });
  }

  // A page tab has no file: Copy path, Reveal and the markdown views do nothing there.
  private async browserTabAction(action: EditorTabAction, tabId: string): Promise<void> {
    if (action === 'activate') this.activate(tabId);
    else if (action === 'close') this.deps.browser()?.close(tabId);
    else if (action === 'closeOthers' || action === 'closeRight' || action === 'closeAll') await this.closeAround(action, tabId);
  }

  // Closing the last tab of a dirty document asks Save, Don't Save or Cancel; Cancel keeps that tab and every later one.
  private async closeTabs(tabIds: readonly string[], opts: { readonly ask: boolean }): Promise<void> {
    for (const tabId of tabIds) {
      const tab = this.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        if (this.browserTabs().some((candidate) => candidate.id === tabId)) this.deps.browser()?.close(tabId);
        continue;
      }
      const documentIds = tab.diff ? [tab.diff.originalId, tab.diff.modifiedId] : tab.documentId !== undefined ? [tab.documentId] : [];
      const heldElsewhere = (id: string): boolean => this.tabs.some((other) => other !== tab && (other.documentId === id || other.diff?.originalId === id || other.diff?.modifiedId === id));
      for (const id of documentIds.filter((candidate) => !heldElsewhere(candidate))) {
        const document = this.deps.documents.get(id);
        if (!opts.ask || !document || !isDocumentDirty(document)) continue;
        if (!(await this.askToSave(document as TextDocument))) return;
      }
      this.tabs = this.tabs.filter((candidate) => candidate !== tab);
      // Asked again after the question: another tab may have opened the document meanwhile.
      for (const id of documentIds) if (!heldElsewhere(id)) this.releaseDocument(id);
      if (this.activeId === tab.id) this.activateFallback();
      this.stateChanged();
    }
  }

  private async askToSave(document: TextDocument): Promise<boolean> {
    const choice = await this.deps.ask({
      severity: 'warning',
      message: this.deps.t('Do you want to save the changes you made to {0}?', document.name),
      detail: this.deps.t('Your changes will be lost if you don\'t save them.'),
      // Save and Don't Save only; Escape or dismissing the dialog answers undefined, which keeps the tab open.
      actions: [this.deps.t('Save'), this.deps.t('Don\'t Save')],
      defaultAction: 0,
    });
    if (choice === undefined) return false;
    if (choice === 1) return true;
    await this.flush(this.formatsOnSave([document]));
    const result = await this.deps.documents.save(document.id, document.version, document.text);
    return result.ok;
  }

  private releaseDocument(documentId: string): void {
    const timer = this.logReloads.get(documentId);
    if (timer) clearTimeout(timer);
    this.logReloads.delete(documentId);
    const document = this.deps.documents.get(documentId);
    if (document?.kind === 'text' && document.searchEditor) this.deps.searchEditorClosed(documentId);
    this.deps.documents.release(documentId, true);
  }

  // The log's own watcher reloads it on every write; this tab re-reads it at most once per LOG_RELOAD_MS instead.
  private followLog(documentId: string): void {
    if (this.logReloads.has(documentId)) return;
    const tick = (): void => {
      void this.deps.documents.reloadLog(documentId).catch((err: unknown) => this.deps.log(`[editor] reloading the log failed: ${err instanceof Error ? err.message : String(err)}`));
      if (this.deps.documents.get(documentId)) this.logReloads.set(documentId, setTimeout(tick, LOG_RELOAD_MS));
    };
    this.logReloads.set(documentId, setTimeout(tick, LOG_RELOAD_MS));
  }

  // A save from the close and quit prompts formats first while format on save is on, as Ctrl+S does (D29).
  private formatsOnSave(documents: readonly TextDocument[]): string[] {
    return editorSettings(this.deps.settings).formatOnSave ? documents.map((document) => document.id) : [];
  }

  private async flush(format: readonly string[] = []): Promise<void> {
    const requestId = randomUUID();
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.flushes.delete(requestId);
        resolve();
      };
      const timer = setTimeout(() => {
        this.deps.log('[editor] the shell did not answer the flush; keeping the text main holds');
        done();
      }, FLUSH_TIMEOUT_MS + format.length * FORMAT_FLUSH_MS_PER_DOCUMENT);
      this.flushes.set(requestId, done);
      if (!this.deps.sendFlush(requestId, format)) done();
    });
  }

  private dirtyDocuments(): TextDocument[] {
    return this.deps.documents.all().filter((document): document is TextDocument => isDocumentDirty(document));
  }

  private noteRecent(documentId: string): void {
    const document = this.deps.documents.get(documentId);
    const file = document ? fileRefOf(document) : undefined;
    if (!file) return;
    this.recent = [file, ...this.recent.filter((entry) => entry.projectKey !== file.projectKey || entry.relativePath !== file.relativePath)].slice(0, MAX_RECENT_FILES);
  }

  private holds(documentId: string): boolean {
    return this.tabs.some((tab) => tab.documentId === documentId || tab.diff?.modifiedId === documentId);
  }

  private tab(tabId: string): Tab {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error('Unknown tab');
    return tab;
  }

  private shellTab(tab: Tab): ShellEditorTab {
    if (tab.diff) {
      const modified = this.deps.documents.get(tab.diff.modifiedId);
      const { originalId, modifiedId, added, removed, conflictCompare, subject } = tab.diff;
      return {
        id: tab.id,
        kind: 'diff',
        diff: { originalId, modifiedId, added, removed, ...(conflictCompare ? { conflictCompare } : {}) },
        title: tab.diff.title(this.subjectName(subject)),
        ...('place' in subject ? placeFields(subject.place) : this.placeOf(this.deps.documents.get(subject.documentId))),
        dirty: modified !== undefined && isDocumentDirty(modified),
        readOnly: modified?.kind !== 'text' || modified.readOnlyReason !== undefined,
        ...(modified?.kind === 'text' && modified.readOnlyReason !== undefined ? { readOnlyReason: modified.readOnlyReason } : {}),
        conflict: modified?.kind === 'text' && modified.conflict,
      };
    }
    const document = this.deps.documents.get(tab.documentId!)!;
    const readOnlyReason = document.kind === 'text' ? document.readOnlyReason : undefined;
    const settingsScope = tab.kind === 'settings' && document.kind === 'text' ? document.settingsScope : undefined;
    return {
      id: tab.id,
      kind: tab.kind,
      documentId: document.id,
      title: tab.kind === 'settings' ? this.settingsTitle(document) : document.kind === 'text' && document.searchEditor ? this.searchEditorTitle(document) : document.name,
      ...this.placeOf(document),
      dirty: isDocumentDirty(document),
      readOnly: document.kind !== 'text' || readOnlyReason !== undefined,
      ...(readOnlyReason !== undefined ? { readOnlyReason } : {}),
      conflict: document.kind === 'text' && document.conflict,
      ...(document.kind === 'text' && document.orphaned ? { deleted: true as const } : {}),
      ...(settingsScope !== undefined ? { settingsScope } : {}),
      ...(document.kind === 'text' && document.searchEditor ? { searchEditor: this.searchEditorOf(document) } : {}),
    };
  }

  private shellDocuments(): Record<string, ShellEditorDocument> {
    const documents: Record<string, ShellEditorDocument> = {};
    for (const id of this.tabs.flatMap((tab) => (tab.diff ? [tab.diff.originalId, tab.diff.modifiedId] : tab.documentId !== undefined ? [tab.documentId] : []))) {
      const document = this.deps.documents.get(id);
      if (!document) continue;
      documents[id] = {
        name: document.name,
        ...(document.location ? { path: document.location.path } : {}),
        ...(document.kind === 'text' ? { languageId: document.languageId } : {}),
      };
    }
    return documents;
  }

  private searchEditorOf(document: TextDocument): NonNullable<ShellEditorTab['searchEditor']> {
    const state = document.searchEditor!;
    return { config: state.config, running: state.running, untitled: document.untitled, ...(state.message ? { message: state.message } : {}) };
  }

  // VS Code's SearchEditorInput.getName: "Search: <query>" cut to 12 characters while untitled, "Search: <file name>" once saved.
  private searchEditorTitle(document: TextDocument): string {
    if (!document.untitled) return this.deps.t('Search: {0}', path.basename(document.name, path.extname(document.name)));
    const query = document.searchEditor!.config.query.trim();
    if (query === '') return this.deps.t('Search');
    return this.deps.t('Search: {0}', query.length < 12 ? query : `${query.slice(0, 9)}...`);
  }

  private settingsTitle(document: Document): string {
    const scope = document.kind === 'text' ? document.settingsScope : undefined;
    return scope === 'local' ? 'settings.local.json' : 'settings.json';
  }

  private placeOf(document: Document | undefined): Pick<ShellEditorTab, 'projectKey' | 'relativePath' | 'displayPath'> {
    const location = document?.location;
    const projectKey = document?.kind === 'text' && document.searchEditor ? document.searchEditor.projectKey : location?.projectKey;
    return {
      ...(projectKey !== undefined ? { projectKey } : {}),
      ...(location?.relativePath !== undefined ? { relativePath: location.relativePath } : {}),
      displayPath: location?.path ?? document?.name ?? '',
    };
  }

  private persisted(): PersistedEditor {
    const tabs: PersistedTab[] = [];
    let active: number | null = null;
    for (const tab of this.tabs) {
      const entry = this.persistedTab(tab);
      if (!entry) continue;
      if (tab.id === this.activeId) active = tabs.length;
      tabs.push(entry);
    }
    return { tabs, active, recent: this.recent };
  }

  // Diff tabs are not kept: a dirty side's buffer comes back from its backup as its own tab.
  private persistedTab(tab: Tab): PersistedTab | undefined {
    if (tab.diff || tab.documentId === undefined) return undefined;
    const document = this.deps.documents.get(tab.documentId);
    if (!document) return undefined;
    const backupId = document.kind === 'text' && isDocumentDirty(document) ? document.backupId : undefined;
    const withBackup = backupId !== undefined ? { backupId } : {};
    if (tab.kind === 'log') return document.location ? { kind: 'log', name: path.basename(document.location.path) } : undefined;
    if (tab.kind === 'untitled') return backupId !== undefined ? { kind: 'untitled', backupId } : undefined;
    if (tab.kind === 'searchEditor') {
      if (document.kind !== 'text' || !document.searchEditor) return undefined;
      const file = fileRefOf(document);
      if (file && !document.untitled) return { kind: 'searchEditor', file, ...withBackup };
      const projectKey = document.searchEditor.projectKey;
      return { kind: 'searchEditor', ...(projectKey !== undefined ? { projectKey } : {}), config: document.searchEditor.config, ...withBackup };
    }
    if (tab.kind === 'settings') return document.kind === 'text' && document.settingsScope !== undefined ? { kind: 'settings', scope: document.settingsScope, ...withBackup } : undefined;
    if (tab.kind === 'diff') return undefined;
    const file = fileRefOf(document);
    if (file) return { kind: tab.kind, file, ...withBackup };
    return document.location ? { kind: tab.kind, path: document.location.path } : undefined;
  }

  private persist(): void {
    this.deps.persist(this.persisted());
  }

  private stateChanged(persist = true): void {
    this.persistScheduled ||= persist;
    if (this.stateScheduled) return;
    this.stateScheduled = true;
    setImmediate(() => {
      this.stateScheduled = false;
      if (this.disposed) return;
      this.deps.sendState(this.state());
      if (!this.persistScheduled) return;
      this.persistScheduled = false;
      this.persist();
    });
  }

  private contextChanged(): void {
    const context = this.activeContext();
    for (const listener of [...this.contextListeners]) listener(context);
  }
}
