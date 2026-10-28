import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { diffLines } from 'diff';
import type { Disposable } from '../../platform/disposable';
import type { ActiveEditorContext, DiffSide } from '../../platform/editor-service';
import type { SettingsStore } from '../../platform/settings-store';
import type { SettingsFileScope } from '../../shared/types/messages';
import { folderKey, folderKeyOn } from '../../core/workspace-folders/folder-key';
import { visibleText } from '../../shared/visible-text';
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
  type NotDisplayedReason,
  type SearchEditorConfig,
  type SearchEditorMessage,
  type SearchEditorOpenResult,
  type SearchRange,
  type ShellDocumentContent,
  type ShellEditorDocument,
  type ShellEditorSettings,
  type ShellEditorState,
  type ShellDiffGit,
  type ShellDiffSide,
  type ShellEditorTab,
  type ShellFileGit,
  type ShellTimelineTab,
} from '../preload/shell-channels';
import type { ScmChangesTab, ScmMergeInputsResult } from '../preload/scm-channels';
import type { ChatReviewTab } from '../preload/review-channels';
import { parseRootKey } from '../preload/folder-root';
import { authorityKeyOfProject, pathFor } from '../../shared/project-location';
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
} from '../local-services/desktop-configuration';
import type { BackupRecord } from './documents/backups';
import { isDocumentDirty, movedPath, uploadMergeLabels, type Document, type DocumentService, type Location, type ShellEdit, type TextDocument } from './documents/document-service';
import type { FormatTarget } from './formatting/format-service';
import { DEFAULT_SEARCH_EDITOR_CONFIG, resultLocation } from './search/search-editor-format';
import { projectOfPath, type Project } from '../local-services/confine';
import { languageIdForName } from './platform/editor-document';
import type { BrowserTabsEditor } from './browser-tabs';
import type { AskMessage } from './message-dialog';

// A path a remote project's file has names the target's file, never one this computer's git or file manager may act on.
function isLocalLocation(location: { readonly projectKey?: string; readonly host?: string }): boolean {
  if (location.host !== undefined) return false;
  return location.projectKey === undefined || authorityKeyOfProject(location.projectKey) === 'local';
}

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

// A side main never sends as text (a git blob that is missing, too large or binary), shown as its reason only.
export interface NotShownSide {
  readonly name: string;
  readonly notDisplayed: NotDisplayedReason;
  readonly bytes?: number;
}

// A remote diff's side: a project file of that host by FileRef, a core-originated text, or a side not shown as text.
export type RemoteDiffSide = { readonly file: FileRef } | { readonly name: string; readonly content: string } | NotShownSide;

// The repository a source control diff shows a change of, and the change's file and group when its git side refreshes.
export interface ScmDiffOrigin {
  readonly repoId: string;
  readonly git?: Omit<ShellDiffGit, 'repoId'>;
}

function scmFlags(scm: ScmDiffOrigin | undefined): { readonly scmRepoId?: string; readonly scmGit?: Omit<ShellDiffGit, 'repoId'> } {
  return scm ? { scmRepoId: scm.repoId, ...(scm.git ? { scmGit: scm.git } : {}) } : {};
}

// A source control group's multi-file diff (ChangesTab.vue); its entries follow the repository's status while it is open.
export interface ChangesTabState {
  readonly title: string;
  readonly changes: ScmChangesTab;
}

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
    // the repository whose change source control opened here (Close All Diff Editors, a disposed repository)
    readonly scmRepoId?: string;
    // the change's file and group, whose index side main refreshes after each status (ShellDiffGit)
    readonly scmGit?: Omit<ShellDiffGit, 'repoId'>;
  };
  changes?: ChangesTabState;
  // a chat's review (D60), kept current by its owner
  review?: ChatReviewTab;
  timeline?: ShellTimelineTab & { readonly title: string };
  // the Result is the tab's documentId; upload: an offline save that met a changed target, whose inputs are its document's
  merge?: ({ readonly repoId: string; readonly path: string } | { readonly upload: true; readonly path: string }) & { readonly title: string };
}

// What the active tab is to source control (MenuState.editorGit).
export type ActiveEditorGit = 'file' | 'workingTreeDiff' | 'indexDiff' | null;

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

// A worktree delete's Don't Save answers: document id to the unsaved text the user answered for.
export type RootCloseAnswers = ReadonlyMap<string, string>;

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
  // hides the editor pane when it is shown; called when the published tab list empties, file and page tabs alike
  readonly hidePane: () => void;
  // Open to the Side: the editor pane shows, and a maximized chat or terminal gives way to it
  readonly showPaneBeside: () => void;
  // every root a tab may name a file in, keyed by root key (folder-root.ts): the open projects and their chat worktrees
  readonly projects: () => readonly Project[];
  // the OS whose path rules an authority's paths follow: this computer's, or the target's
  readonly authorityOs: (authority: string) => NodeJS.Platform;
  // the branch of a chat worktree's root key, for the tab's chip; undefined for a project folder
  readonly worktreeBranch: (rootKey: string) => string | undefined;
  readonly copy: (text: string) => Promise<void>;
  readonly reveal: (absolutePath: string) => Promise<void>;
  // Mention this file in chat: core's resolver for the selected chat
  readonly mention: (file: FileRef | { readonly path: string }) => Promise<void>;
  // the window's browser tabs; undefined while no window is open
  readonly browser: () => BrowserTabSource | undefined;
  // a warning toast
  readonly warn: (message: string) => void;
  // a remote authority's host as this computer names it
  readonly hostName: (authority: string) => string;
  // a Search Editor's document left with its last tab
  readonly searchEditorClosed: (documentId: string) => void;
  // a chat review's tab closed, by the user or by its owner
  readonly reviewClosed: (reviewId: string) => void;
  // a code tab's Open Changes: source control's diff of that file
  readonly openChanges: (location: Location) => Promise<void>;
  // the file's place in an open repository of a trusted project (ShellEditorTab.git), on the file's own authority; undefined
  // anywhere else
  readonly gitOf: (location: Location) => ShellFileGit | undefined;
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


// The one place a tab's title reaches the shell, which shows it in the strip, the menus and as the tab's accessible name.
// displayPath stays raw because the shell splits it on separators, and escapes it where it shows it; a page's title is the
// browser's own text, which the shell cleans itself.
function shownTitle(tab: ShellEditorTab): ShellEditorTab {
  return { ...tab, title: visibleText(tab.title) };
}

function placeFields(place: Place): Pick<ShellEditorTab, 'projectKey' | 'relativePath' | 'displayPath'> {
  return {
    ...(place.projectKey !== undefined ? { projectKey: place.projectKey } : {}),
    ...(place.relativePath !== undefined ? { relativePath: place.relativePath } : {}),
    displayPath: place.path,
  };
}

// A diff side as the shell renders it: an image or a file the editor does not open as text is a placeholder, which only the
// modified side, the one the tab's Open File shows, offers to open when it is a file on disk.
function diffSide(document: Document | undefined, modified: boolean): ShellDiffSide {
  if (document?.kind === 'text') return { kind: 'text' };
  if (!document) return { kind: 'notDisplayed', reason: 'missing', openable: false };
  // a remote file whose host is not connected shows nothing of it
  if (document.kind === 'offline') return { kind: 'notDisplayed', reason: 'unreadable', openable: false };
  const bytes = document.bytes;
  return {
    kind: 'notDisplayed',
    reason: document.kind === 'image' ? 'binary' : document.reason,
    ...(bytes !== undefined ? { bytes } : {}),
    openable: modified && document.location !== undefined,
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
  // each showDiff tab still open, settling its closed once the tab is gone
  private readonly diffClosed = new Map<string, () => void>();
  private readonly subscriptions: Disposable[];
  private stateScheduled = false;
  private persistScheduled = false;
  // the last state sent to the shell listed a tab; compared per publish, so a close an open replaces in the same tick keeps the pane
  private publishedTabs = false;
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
      // an offline placeholder's host connected, or an awaiting backup moved: its tabs show the new document id
      deps.documents.onDidReplace(({ from, to }) => {
        const document = this.deps.documents.get(to);
        if (!document) return;
        const showing = this.tabs.filter((tab) => tab.documentId === from);
        if (showing.length === 0) {
          if (!this.holds(to)) this.deps.documents.release(to, false);
          return;
        }
        for (const tab of showing) {
          tab.documentId = to;
          tab.kind = this.kindFor(document, tab.kind);
        }
        this.stateChanged();
      }),
    ];
  }

  state(): ShellEditorState {
    return {
      tabs: [...this.tabs.map((tab) => shownTitle(this.shellTab(tab))), ...this.browserTabs()],
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

  /**
   * A multi-file diff: the tab already showing that repository's source (a group, a stash's commit, a commit pair), updated,
   * else a new one; a user action focuses it.
   */
  showChanges(state: ChangesTabState, opts: { readonly focus: boolean }): string {
    const key = (source: ScmChangesTab['source']): string => (source.kind === 'stash' ? `stash:${source.hash}` : source.kind === 'refs' ? `refs:${source.left}:${source.right}` : source.kind);
    const same = (tab: Tab): boolean => tab.changes?.changes.repoId === state.changes.repoId && key(tab.changes.changes.source) === key(state.changes.source);
    const existing = this.tabs.find(same);
    if (existing) existing.changes = state;
    const tab = existing ?? this.addTab({ id: randomUUID(), kind: 'changes', changes: state });
    this.afterOpen(tab, opts);
    // afterOpen pushes nothing for the tab already active
    this.stateChanged();
    return tab.id;
  }

  /**
   * Closes the changes and diff tabs of a repository source control no longer has. A diff whose editable side holds unsaved
   * edits becomes that file's own tab in its place, keeping the document, as VS Code replaces a diff whose original is gone;
   * when the file already has its own tab, the edits stay there and the diff closes.
   */
  async closeChanges(repoId: string): Promise<void> {
    const repoDiff = (tab: Tab): boolean => tab.diff?.scmRepoId === repoId;
    for (const tab of this.tabs.filter(repoDiff)) {
      const edited = this.deps.documents.get(tab.diff!.modifiedId);
      if (edited?.kind !== 'text' || edited.readOnlyReason !== undefined || !isDocumentDirty(edited)) continue;
      if (this.tabs.some((other) => other !== tab && other.documentId === edited.id)) continue;
      this.replaceWithFileTab(tab, edited);
    }
    const mergeOf = (tab: Tab): boolean => tab.merge !== undefined && 'repoId' in tab.merge && tab.merge.repoId === repoId;
    const ofRepo = (tab: Tab): boolean => tab.changes?.changes.repoId === repoId || tab.timeline?.repoId === repoId || mergeOf(tab) || repoDiff(tab);
    for (const tab of this.tabs.filter(mergeOf)) {
      const document = tab.documentId !== undefined ? this.deps.documents.get(tab.documentId) : undefined;
      if (document && isDocumentDirty(document) && !this.tabs.some((other) => other.kind === 'code' && other.documentId === document.id)) this.showDocument(document);
    }
    await this.closeTabs(this.tabs.filter(ofRepo).map((tab) => tab.id), { ask: false });
  }

  /** Closes the changes tabs whose content matches, with no question: they hold no edits. */
  async closeChangesTabs(matches: (changes: ScmChangesTab) => boolean): Promise<void> {
    await this.closeTabs(this.tabs.filter((tab) => tab.changes !== undefined && matches(tab.changes.changes)).map((tab) => tab.id), { ask: false });
  }

  /** The open changes tabs, for their owner to keep current. */
  changesTabs(): ReadonlyArray<{ readonly tabId: string; readonly state: ChangesTabState }> {
    return this.tabs.flatMap((tab) => (tab.changes ? [{ tabId: tab.id, state: tab.changes }] : []));
  }

  updateChanges(tabId: string, state: ChangesTabState): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (!tab?.changes || JSON.stringify(tab.changes) === JSON.stringify(state)) return;
    tab.changes = state;
    this.stateChanged();
  }

  /** A chat's review tab: the one of that review updated, else a new one; a user action focuses it. */
  showReview(review: ChatReviewTab, opts: { readonly focus: boolean }): string {
    const existing = this.tabs.find((tab) => tab.review?.reviewId === review.reviewId);
    if (existing) existing.review = review;
    const tab = existing ?? this.addTab({ id: randomUUID(), kind: 'review', review });
    this.afterOpen(tab, opts);
    this.stateChanged();
    return tab.id;
  }

  /** The open review tabs' states. */
  reviewTabs(): readonly ChatReviewTab[] {
    return this.tabs.flatMap((tab) => (tab.review ? [tab.review] : []));
  }

  updateReview(review: ChatReviewTab): void {
    const tab = this.tabs.find((candidate) => candidate.review?.reviewId === review.reviewId);
    if (!tab || JSON.stringify(tab.review) === JSON.stringify(review)) return;
    tab.review = review;
    this.stateChanged();
  }

  async closeReview(reviewId: string): Promise<void> {
    await this.closeTabs(this.tabs.filter((tab) => tab.review?.reviewId === reviewId).map((tab) => tab.id), { ask: false });
  }

  /** A file's Timeline tab, reused for the same file; focused for a user action. */
  showTimeline(timeline: ShellTimelineTab, title: string, opts: { readonly focus: boolean }): string {
    const existing = this.tabs.find((tab) => tab.timeline?.repoId === timeline.repoId && tab.timeline.path === timeline.path);
    const tab = existing ?? this.addTab({ id: randomUUID(), kind: 'timeline', timeline: { ...timeline, title } });
    this.afterOpen(tab, opts);
    return tab.id;
  }

  /** A conflicted file's merge editor tab over its own document (the Result), reused for the same file. */
  showMerge(merge: { readonly repoId: string; readonly path: string }, document: Document, title: string, opts: { readonly focus: boolean }): string {
    const existing = this.tabs.find((tab) => tab.kind === 'merge' && tab.documentId === document.id);
    const tab = existing ?? this.addTab({ id: randomUUID(), kind: 'merge', documentId: document.id, merge: { ...merge, title } });
    this.afterOpen(tab, opts);
    return tab.id;
  }

  /**
   * The merge editor of an offline save that met a changed target (TextDocument.uploadConflict), opened in the background
   * unless the pane shows nothing; the conflict summary's Review focuses it (focusUploadMerge).
   */
  showUploadMerge(document: TextDocument): void {
    const relativePath = document.location?.relativePath;
    if (relativePath === undefined || !document.uploadConflict) throw new Error('Not an upload conflict of a project file');
    if (this.tabs.some((tab) => tab.kind === 'merge' && tab.documentId === document.id)) return;
    const tab = this.addTab({ id: randomUUID(), kind: 'merge', documentId: document.id, merge: { upload: true, path: relativePath, title: this.deps.t('Merging: {0}', document.name) } });
    if (this.activeId === null) this.activate(tab.id);
    this.deps.showPane();
    this.stateChanged();
  }

  /** A document the service holds with no tab that needs the user again (an offline save that did not upload), in the background. */
  showHeld(document: TextDocument): void {
    if (this.holds(document.id)) return;
    const tab = this.addTab({ id: randomUUID(), kind: this.kindFor(document), documentId: document.id });
    if (this.activeId === null) this.activate(tab.id);
    this.deps.showPane();
    this.stateChanged();
  }

  /** Review on the conflict summary: the upload merge of that project file, focused. */
  focusUploadMerge(file: FileRef): void {
    const tab = this.tabs.find((candidate) => {
      if (candidate.kind !== 'merge' || !candidate.merge || !('upload' in candidate.merge) || candidate.documentId === undefined) return false;
      const location = this.deps.documents.get(candidate.documentId)?.location;
      return location?.projectKey === file.projectKey && location.relativePath === file.relativePath;
    });
    if (tab) this.afterOpen(tab, { focus: true });
  }

  /** An upload merge tab's three inputs, read from its document: base as last read, the target's text, the text saved here. */
  uploadMergeInputs(tabId: string): ScmMergeInputsResult {
    const document = this.uploadMergeDocument(tabId);
    const conflict = document?.uploadConflict;
    if (!document || !conflict) return { ok: false, reason: 'notConflicted' };
    const labels = uploadMergeLabels(this.deps.hostName(authorityKeyOfProject(document.location!.projectKey!)), this.deps.t);
    return { ok: true, base: conflict.base, current: conflict.current, incoming: conflict.incoming, labels, operation: 'merge' };
  }

  /** Complete Merge of an upload merge: the Result saves through its host's workspace over the target's text, and the tab closes. */
  async completeUploadMerge(tabId: string): Promise<void> {
    const document = this.uploadMergeDocument(tabId);
    if (!document?.uploadConflict) throw new Error('Not an upload merge');
    if (!(await this.saveDocuments([document.id]))) {
      this.deps.warn(this.deps.t('The file could not be saved, so the merge was not completed.'));
      return;
    }
    this.deps.documents.endUploadConflict(document.id);
    await this.closeMerge(document.id);
  }

  private uploadMergeDocument(tabId: string): TextDocument | undefined {
    const tab = this.tab(tabId);
    if (tab.kind !== 'merge' || !tab.merge || !('upload' in tab.merge) || tab.documentId === undefined) throw new Error('Not an upload merge tab');
    const document = this.deps.documents.get(tab.documentId);
    return document?.kind === 'text' ? document : undefined;
  }

  /** The merge editor tabs of a Result, closed with no question: the Result is the file's own document, which keeps its edits. */
  async closeMerge(documentId: string): Promise<void> {
    const merges = this.tabs.filter((tab) => tab.kind === 'merge' && tab.documentId === documentId);
    // the file's own tab takes over the document first, so closing the merge tab never releases unsaved edits
    for (const tab of merges) {
      const document = tab.documentId !== undefined ? this.deps.documents.get(tab.documentId) : undefined;
      if (document && isDocumentDirty(document) && !this.tabs.some((other) => other.kind === 'code' && other.documentId === document.id)) this.showDocument(document);
    }
    await this.closeTabs(merges.map((tab) => tab.id), { ask: false });
  }

  /** The diff tabs of source control changes, whose git side their owner refreshes. */
  scmDiffTabs(): ReadonlyArray<{ readonly repoId: string; readonly git: Omit<ShellDiffGit, 'repoId'>; readonly originalId: string; readonly modifiedId: string }> {
    return this.tabs.flatMap((tab) =>
      tab.diff?.scmGit && tab.diff.scmRepoId !== undefined ? [{ repoId: tab.diff.scmRepoId, git: tab.diff.scmGit, originalId: tab.diff.originalId, modifiedId: tab.diff.modifiedId }] : [],
    );
  }

  /** New text for a git side of a source control diff tab; the shell applies it in place. */
  replaceGitSide(documentId: string, text: string): void {
    if (!this.tabs.some((tab) => tab.diff?.scmGit && (tab.diff.originalId === documentId || tab.diff.modifiedId === documentId))) return;
    this.deps.documents.replaceMemory(documentId, text);
  }

  /** Repositories opened or closed: the tabs' git places are published again. */
  gitChanged(): void {
    this.stateChanged(false);
  }

  /** The active tab's kind; undefined without one. */
  activeKind(): EditorTabKind | undefined {
    if (this.activeId === null) return undefined;
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId);
    if (tab) return tab.kind;
    return this.browserTabs().some((candidate) => candidate.id === this.activeId) ? 'browser' : undefined;
  }

  /** The active tab to source control: a code tab of a file in an open repository, or a diff of a working tree or index change. */
  activeGit(): ActiveEditorGit {
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId);
    if (!tab) return null;
    if (tab.diff?.scmGit) return tab.diff.scmGit.group === 'index' ? 'indexDiff' : 'workingTreeDiff';
    if (tab.kind !== 'code' || tab.documentId === undefined) return null;
    const location = this.deps.documents.get(tab.documentId)?.location;
    return location && this.deps.gitOf(location) ? 'file' : null;
  }

  /** A path core named (a tool card click, the agent): shown in the pane, focused only for a user's click. */
  async openPath(filePath: string, opts: { readonly line?: number; readonly focus: boolean; readonly preview?: boolean }): Promise<void> {
    const document = await this.deps.documents.openPath(filePath);
    const tab = this.showDocument(document, opts.preview === true && isMarkdown(document) ? 'markdownPreview' : undefined);
    this.afterOpen(tab, { focus: opts.focus, ...(opts.line !== undefined ? { line: opts.line } : {}) });
  }

  /** A core-originated side the editor does not show as text, in its own tab titled title. */
  openPlaceholder(title: string, side: NotShownSide): void {
    const document = this.deps.documents.openPlaceholder(title, side.notDisplayed, side.bytes);
    const tab = this.addTab({ id: randomUUID(), kind: 'notDisplayed', documentId: document.id });
    this.afterOpen(tab, { focus: true });
  }

  /** A core-originated read-only text (a git side such as HEAD:path) in its own tab, titled title, coloured as fileName. */
  openReadOnly(title: string, content: string, fileName: string, focus: boolean): void {
    const document = this.deps.documents.openMemory(title, content, { untitled: false, languageId: languageIdForName(fileName) });
    const tab = this.addTab({ id: randomUUID(), kind: 'code', documentId: document.id });
    this.afterOpen(tab, { focus });
  }

  /** A core-originated Markdown text (a remote core's system prompt, an MCP tool's schema) as a rendered preview tab titled title. */
  openMarkdownText(title: string, content: string, focus: boolean): void {
    const document = this.deps.documents.openMemory(title, content, { untitled: false, languageId: 'markdown' });
    const tab = this.addTab({ id: randomUUID(), kind: 'markdownPreview', documentId: document.id });
    this.afterOpen(tab, { focus });
  }

  openUntitled(content: string, name: string, languageId: string, opts: { readonly focus: boolean }): void {
    const document = this.deps.documents.openMemory(name, content, { untitled: true, languageId });
    const tab = this.addTab({ id: randomUUID(), kind: 'untitled', documentId: document.id });
    this.afterOpen(tab, { focus: opts.focus });
  }

  /**
   * A diff without an approval: two read-only sides, unless a side is a file inside a project, which stays editable. filePath
   * names the file it shows, and title its tab after that file's current name. A side the editor does not show as text
   * (NotShownSide, or a file that is binary or too large) is a placeholder the shell renders beside the other side.
   */
  async showDiff(
    title: (fileName: string) => string,
    filePath: string,
    left: DiffSide | NotShownSide,
    right: DiffSide | NotShownSide,
    opts: { readonly focus: boolean; readonly scm?: ScmDiffOrigin },
  ): Promise<{ close(): void; readonly closed: Promise<void> }> {
    const [original, modified] = await Promise.all([this.sideDocument(left), this.sideDocument(right)]);
    const fileSide = 'path' in right ? modified : 'path' in left ? original : undefined;
    const subject: DiffSubject = fileSide ? { documentId: fileSide.id } : { place: await this.placeOfPath(filePath) };
    const tab = this.openDiffTab(title, original, modified, subject, scmFlags(opts.scm));
    this.afterOpen(tab, { focus: opts.focus });
    const closed = new Promise<void>((resolve) => this.diffClosed.set(tab.id, resolve));
    // Edits the user made to the file in this tab are asked about, as VS Code's tabGroups.close asks before closing a dirty editor.
    return { close: () => this.closeTabs([tab.id], { ask: true }), closed };
  }

  /** A project file's disk text by FileRef, through its project's workspace; '' for a file not on disk yet. */
  async projectFileText(file: FileRef): Promise<string> {
    if (!this.deps.projects().some((project) => project.key === file.projectKey)) throw new Error(`${file.projectKey} is not an open project`);
    const read = await this.deps.documents.readClosedFile(file.projectKey, file.relativePath);
    if (read.kind === 'readOnly') throw new Error(`${file.relativePath} cannot be shown as text`);
    return read.kind === 'text' ? read.text : '';
  }

  /**
   * A remote core's diff: its file sides are project files of that host, opened by FileRef through its workspace, so a target
   * path is never matched against this computer's files or editors; a file side not on disk yet shows empty.
   */
  async showRemoteDiff(
    title: (fileName: string) => string,
    file: FileRef,
    left: RemoteDiffSide,
    right: RemoteDiffSide,
    opts: { readonly focus: boolean; readonly scm?: ScmDiffOrigin },
  ): Promise<{ close(): void; readonly closed: Promise<void> }> {
    const side = async (diffSide: RemoteDiffSide): Promise<Document> => {
      if ('notDisplayed' in diffSide) return this.deps.documents.openPlaceholder(diffSide.name, diffSide.notDisplayed, diffSide.bytes);
      if (!('file' in diffSide)) return this.deps.documents.openMemory(diffSide.name, diffSide.content, { untitled: false });
      const opened = await this.deps.documents.openProjectFile(diffSide.file.projectKey, diffSide.file.relativePath);
      if (opened.ok) return opened.document;
      if (opened.reason !== 'missing') throw new Error(`${diffSide.file.relativePath} cannot be shown: ${opened.reason}`);
      return this.deps.documents.openMemory(path.posix.basename(diffSide.file.relativePath), '', { untitled: false });
    };
    const [original, modified] = await Promise.all([side(left), side(right)]);
    const fileSide = 'file' in right ? modified : 'file' in left ? original : undefined;
    const subject: DiffSubject = fileSide ? { documentId: fileSide.id } : { place: this.placeOfFile(file) };
    const tab = this.openDiffTab(title, original, modified, subject, scmFlags(opts.scm));
    this.afterOpen(tab, { focus: opts.focus });
    const closed = new Promise<void>((resolve) => this.diffClosed.set(tab.id, resolve));
    return { close: () => this.closeTabs([tab.id], { ask: true }), closed };
  }

  /**
   * Each file's tab opened without taking the active tab, unless the pane shows none (VS Code's background open); the shell
   * gets the tabs in one state push.
   */
  async openInBackground(files: ReadonlyArray<{ readonly path: string } | { readonly file: FileRef }>): Promise<void> {
    let first: Tab | undefined;
    try {
      for (const entry of files) {
        const document = 'path' in entry ? await this.deps.documents.openPath(entry.path) : await this.projectDocument(entry.file);
        const kind = this.kindFor(document);
        const tab = this.tabs.find((candidate) => candidate.documentId === document.id && candidate.kind === kind) ?? this.addTab({ id: randomUUID(), kind, documentId: document.id }, false);
        first ??= tab;
      }
    } finally {
      if (first) {
        if (this.activeId === null) this.activate(first.id);
        this.deps.showPane();
        this.stateChanged();
      }
    }
  }

  /** Close All Diff Editors: the diff tabs source control opened for the repository, asking about unsaved edits. */
  async closeScmDiffs(repoId: string): Promise<void> {
    await this.closeTabs(this.tabs.filter((tab) => tab.diff?.scmRepoId === repoId).map((tab) => tab.id), { ask: true });
  }

  /**
   * Close All Unmodified Editors: every clean text tab (VS Code's TabInputText: a file, untitled, settings or log tab) whose file
   * has no change in source control.
   */
  async closeUnmodified(changed: (location: Location) => boolean): Promise<void> {
    const text: ReadonlySet<FileTabKind> = new Set(['code', 'untitled', 'settings', 'log']);
    const targets = this.tabs.filter((tab) => {
      const document = tab.documentId !== undefined ? this.deps.documents.get(tab.documentId) : undefined;
      return text.has(tab.kind) && document !== undefined && !isDocumentDirty(document) && !(document.location && changed(document.location));
    });
    await this.closeTabs(targets.map((tab) => tab.id), { ask: false });
  }

  /**
   * A worktree delete's tab questions (rule 14), asked before anything closes: Save, Don't Save or Cancel for each dirty
   * document a tab of the root shows. Save saves at once, while the root still resolves; Don't Save is remembered with the
   * text it was given for and drops nothing yet. A document answered earlier whose text is unchanged is not asked again.
   * undefined: the user cancelled, or a save failed and its tab says why.
   */
  async confirmCloseRoot(rootKey: string, answered: RootCloseAnswers = new Map()): Promise<RootCloseAnswers | undefined> {
    await this.flush();
    const discarded = new Map(answered);
    for (const document of this.rootDocuments(rootKey)) {
      if (document.kind !== 'text' || !isDocumentDirty(document) || discarded.get(document.id) === document.text) continue;
      const choice = await this.askToSave(document, true);
      if (choice === 'cancel') return undefined;
      if (choice === 'discard') discarded.set(document.id, document.text);
    }
    return discarded.size === answered.size && [...discarded].every(([id, text]) => answered.get(id) === text) ? answered : discarded;
  }

  /**
   * Closes every tab of the root, dropping the unsaved text the user answered Don't Save for; false, closing nothing, when a
   * document of it holds unsaved text no answer covers.
   */
  closeRoot(rootKey: string, answers: RootCloseAnswers): boolean {
    const documents = this.rootDocuments(rootKey);
    if (documents.some((document) => document.kind === 'text' && isDocumentDirty(document) && answers.get(document.id) !== document.text)) return false;
    const ids = new Set(documents.map((document) => document.id));
    const targets = this.tabs.filter((tab) => [tab.documentId, tab.diff?.modifiedId, tab.diff?.originalId].some((id) => id !== undefined && ids.has(id)));
    if (targets.length === 0) return true;
    this.tabs = this.tabs.filter((tab) => !targets.includes(tab));
    this.tabsRemoved();
    const held = new Set(this.tabs.flatMap((tab) => [tab.documentId, tab.diff?.originalId, tab.diff?.modifiedId]));
    for (const tab of targets) {
      for (const id of tab.diff ? [tab.diff.originalId, tab.diff.modifiedId] : tab.documentId !== undefined ? [tab.documentId] : []) {
        if (!held.has(id) && this.deps.documents.get(id)) this.releaseDocument(id);
      }
      if (tab.review) this.deps.reviewClosed(tab.review.reviewId);
    }
    if (targets.some((tab) => tab.id === this.activeId)) this.activateFallback();
    this.stateChanged();
    return true;
  }

  // The documents the root's tabs show: each one's file, or a Search Editor's search, lies in the root.
  private rootDocuments(rootKey: string): Document[] {
    const documents = new Map<string, Document>();
    for (const tab of this.tabs) {
      for (const id of [tab.documentId, tab.diff?.originalId, tab.diff?.modifiedId]) {
        const document = id !== undefined ? this.deps.documents.get(id) : undefined;
        const projectKey = document?.kind === 'text' && document.searchEditor ? document.searchEditor.projectKey : document?.location?.projectKey;
        if (document && projectKey === rootKey) documents.set(document.id, document);
      }
    }
    return [...documents.values()];
  }

  /**
   * Closes the active file tab as Close Editor does, only while it shows that file: a project file by its project place (a
   * remote file's path is its host's), a file outside every project by this computer's path; cleanOnly leaves a tab with
   * unsaved edits open.
   */
  async closeActive(file: FileRef | { readonly path: string }, opts: { readonly cleanOnly: boolean }): Promise<void> {
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId);
    if (!tab) return;
    const document = tab.documentId !== undefined ? this.deps.documents.get(tab.documentId) : undefined;
    const location = document?.location;
    const shows = location !== undefined && ('path' in file ? isLocalLocation(location) && folderKey(location.path) === folderKey(file.path) : location.projectKey === file.projectKey && location.relativePath === file.relativePath);
    if (!shows || (opts.cleanOnly && isDocumentDirty(document!))) return;
    await this.closeTabs([tab.id], { ask: true });
  }

  /**
   * The unsaved documents of files on this computer's disk, once the shell's last edits arrived (the save-before-commit
   * prompt); a remote file's path is its host's, so it never matches a local repository's.
   */
  async dirtyFiles(): Promise<ReadonlyArray<{ readonly documentId: string; readonly path: string }>> {
    await this.flush();
    return this.dirtyDocuments().flatMap((document) =>
      document.untitled || document.settingsScope !== undefined || document.searchEditor || !document.location || !isLocalLocation(document.location) ? [] : [{ documentId: document.id, path: document.location.path }],
    );
  }

  /** Saves these documents as Save does, formatting first while format on save is on; false when one did not save. */
  async saveDocuments(documentIds: readonly string[]): Promise<boolean> {
    const documents = this.dirtyDocuments().filter((document) => documentIds.includes(document.id));
    await this.flush(this.formatsOnSave(documents));
    for (const document of documents) {
      const result = await this.deps.documents.save(document.id, document.version, document.text);
      if (!result.ok) return false;
      this.noteRecent(document.id);
    }
    return true;
  }

  /** Search's replace preview of a project file or an untitled buffer: one read-only diff tab per file, which a later preview of that file takes over. */
  openReplacePreview(file: FileRef | { readonly documentId: string }, original: string, modified: string): void {
    const subject: DiffSubject = 'documentId' in file ? { documentId: file.documentId } : { place: this.placeOfFile(file) };
    const previous = this.tabs.find((tab) => tab.diff?.replacePreview === true && this.sameSubject(tab.diff.subject, subject));
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
    this.showSettings(document, key);
  }

  /** Edit settings.json for a host's machine scope: its own ~/.damocles/settings.json as a settings tab titled title. */
  async openHostSettingsFile(authority: string, title: string, key?: string): Promise<void> {
    this.showSettings(await this.deps.documents.openHostSettings(authority, title), key);
  }

  private showSettings(document: Document, key: string | undefined): void {
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
        if (document?.location) await this.deps.openChanges(document.location);
        return;
      case 'copyPath':
      case 'copyRelativePath': {
        const location = document?.location;
        if (!location) return;
        const relative = action === 'copyRelativePath' && location.relativePath !== undefined;
        await this.deps.copy(relative ? location.relativePath!.split('/').join(this.flavorOf(location).sep) : location.path);
        return;
      }
      case 'revealInExplorer':
        if (!document?.location) return;
        if (!isLocalLocation(document.location)) this.deps.warn(this.deps.t('The file is not on this computer.'));
        else await this.deps.reveal(document.location.path);
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

  /** Whether a file tab belongs to a project match accepts, without building the shell's whole state. */
  hasProjectTab(match: (projectKey: string) => boolean): boolean {
    return this.tabs.some((tab) => {
      const { projectKey } = this.shellTab(tab);
      return projectKey !== undefined && match(projectKey);
    });
  }

  activeContext(): ActiveEditorContext | undefined {
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId);
    const document = tab?.documentId !== undefined ? this.deps.documents.get(tab.documentId) : undefined;
    if (!tab || !document || (tab.kind !== 'code' && tab.kind !== 'markdownPreview')) return { filePath: undefined, selection: undefined };
    const range = this.selection?.documentId === document.id ? this.selection.range : null;
    const selection = range && document.kind === 'text' ? selectionText(document.text, range) : undefined;
    return { filePath: document.location?.path, selection };
  }

  /** Where the file activeContext describes is, on its own authority; undefined without one. */
  activeLocation(): Location | undefined {
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId);
    if (tab?.kind !== 'code' && tab?.kind !== 'markdownPreview') return undefined;
    return tab.documentId !== undefined ? this.deps.documents.get(tab.documentId)?.location : undefined;
  }

  /** The project key of the document activeContext describes; undefined for one outside every project. */
  activeProjectKey(): string | undefined {
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId);
    return tab?.documentId !== undefined ? this.deps.documents.get(tab.documentId)?.location?.projectKey : undefined;
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
        ? this.deps.t('Do you want to save the changes you made to {0}?', visibleText(dirty[0]!.name))
        : this.deps.t('Do you want to save the changes to the following {0} files?', dirty.length),
      detail: [...(dirty.length > 1 ? [dirty.map((document) => visibleText(document.name)).join('\n')] : []), this.deps.t('Your changes will be lost if you don\'t save them.')].join('\n\n'),
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
      this.tabsRemoved();
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
    } else if ('file' in persisted && this.deps.documents.awaitsHost(persisted.file.projectKey)) {
      // a remote file whose host is not connected shows the offline placeholder, never anything from this computer's disk
      const placeholder = this.deps.documents.openOffline(persisted.file.projectKey, persisted.file.relativePath);
      const kind = this.kindFor(placeholder, persisted.kind);
      return this.tabs.find((tab) => tab.documentId === placeholder.id && tab.kind === kind) ?? this.addTab({ id: randomUUID(), kind, documentId: placeholder.id }, false);
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
    this.deps.warn(this.deps.t('The unsaved changes to {0} are in an untitled editor: {1}', visibleText(backup.name), placed));
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
    } else if (target.kind === 'hostSettings') {
      // throws while the host is not connected, which keeps the text in an untitled editor
      document = await this.deps.documents.openHostSettings(target.authority, backup.name);
      const os = this.deps.authorityOs(target.authority);
      if (!document.location || folderKeyOn(os, document.location.path) !== folderKeyOn(os, target.path)) return this.refuseBackup(document, this.deps.t('That settings file does not apply now.'));
    } else {
      if (this.liveProjectKey(target.projectKey) === undefined) {
        return parseRootKey(target.projectKey)?.worktreeId !== undefined ? this.deps.t('Its worktree no longer exists.') : this.deps.t('Its project is no longer open.');
      }
      if (this.deps.documents.awaitsHost(target.projectKey)) {
        // its host is not connected: the buffer opens dirty with the backup's text and takes the file's disk text once it connects
        document = this.deps.documents.openAwaitingHost(target.projectKey, target.relativePath, { encoding: backup.encoding, bom: backup.bom, eol: backup.eol });
      } else {
        const opened = await this.deps.documents.openProjectFile(target.projectKey, target.relativePath, { missing: backup });
        if (!opened.ok) {
          if (opened.reason === 'outside') return this.deps.t('It is now outside its project.');
          return opened.reason === 'missing' ? this.deps.t('Its project folder is missing.') : this.deps.t('It cannot be read.');
        }
        document = opened.document;
      }
    }
    if (document.kind !== 'text' || document.readOnlyReason !== undefined) return this.refuseBackup(document, this.deps.t('The editor cannot change it as it is on disk now.'));
    // A second backup of one file (a crash between two sessions) never overwrites the text the first restored.
    if (isDocumentDirty(document)) return this.refuseBackup(document, this.deps.t('Another backup of it was restored first.'));
    this.deps.documents.restoreBuffer(document.id, backup.text, backup.backupId);
    const kind = target.kind === 'settings' || target.kind === 'hostSettings' ? 'settings' : this.kindFor(document, preferred === 'markdownPreview' ? preferred : undefined);
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

  private async projectDocument(file: FileRef): Promise<Document> {
    const opened = await this.deps.documents.openProjectFile(file.projectKey, file.relativePath);
    if (!opened.ok) throw new Error(`${file.relativePath} could not be opened (${opened.reason})`);
    return opened.document;
  }

  private async sideDocument(side: DiffSide | NotShownSide): Promise<Document> {
    if ('notDisplayed' in side) return this.deps.documents.openPlaceholder(side.name, side.notDisplayed, side.bytes);
    if ('path' in side) return this.deps.documents.openPath(side.path);
    return this.deps.documents.openMemory(side.name, side.content, { untitled: false });
  }

  private openDiffTab(
    title: (fileName: string) => string,
    original: Document,
    modified: Document,
    subject: DiffSubject,
    flags: { readonly conflictCompare?: true; readonly replacePreview?: true; readonly scmRepoId?: string; readonly scmGit?: Omit<ShellDiffGit, 'repoId'> } = {},
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
    return { path: this.flavorOf(file).join(project?.fsPath ?? '', ...file.relativePath.split('/')), projectKey: file.projectKey, relativePath: file.relativePath };
  }

  private subjectName(subject: DiffSubject): string {
    if ('place' in subject) return this.flavorOf(subject.place).basename(subject.place.path);
    return this.deps.documents.get(subject.documentId)?.name ?? '';
  }

  private sameSubject(a: DiffSubject, b: DiffSubject): boolean {
    if ('documentId' in a || 'documentId' in b) return 'documentId' in a && 'documentId' in b && a.documentId === b.documentId;
    if (a.place.projectKey !== b.place.projectKey || a.place.relativePath !== b.place.relativePath) return false;
    const os = this.osOf(a.place);
    return folderKeyOn(os, a.place.path) === folderKeyOn(os, b.place.path);
  }

  // The OS a project's file is on; this computer's outside every project.
  private osOf(place: { readonly projectKey?: string }): NodeJS.Platform {
    return this.deps.authorityOs(place.projectKey === undefined ? 'local' : authorityKeyOfProject(place.projectKey));
  }

  private flavorOf(place: { readonly projectKey?: string }): path.PlatformPath {
    return pathFor({ os: this.osOf(place) });
  }

  // The diff's original side goes with it; the edited document stays, shown by the new tab.
  private replaceWithFileTab(tab: Tab, document: TextDocument): void {
    const fileTab: Tab = { id: randomUUID(), kind: this.kindFor(document), documentId: document.id };
    this.tabs.splice(this.tabs.indexOf(tab), 1, fileTab);
    this.tabsRemoved();
    const originalId = tab.diff!.originalId;
    if (originalId !== document.id && !this.tabs.some((other) => other.documentId === originalId || other.diff?.originalId === originalId || other.diff?.modifiedId === originalId)) this.releaseDocument(originalId);
    if (this.activeId === tab.id) this.setActive(fileTab.id);
    else this.stateChanged();
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
    if (document.kind === 'offline') return preferred ?? 'code';
    if (document.kind === 'image') return 'image';
    if (document.kind === 'notDisplayed') return 'notDisplayed';
    if (document.searchEditor) return 'searchEditor';
    if (document.untitled) return 'untitled';
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
  // cancellable: the question offers Cancel beside Save and Don't Save, for a close that is part of a larger action
  private async closeTabs(tabIds: readonly string[], opts: { readonly ask: boolean; readonly cancellable?: boolean }): Promise<void> {
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
        if ((await this.askToSave(document as TextDocument, opts.cancellable === true)) === 'cancel') return;
      }
      this.tabs = this.tabs.filter((candidate) => candidate !== tab);
      this.tabsRemoved();
      // Asked again after the question: another tab may have opened the document meanwhile.
      for (const id of documentIds) if (!heldElsewhere(id)) this.releaseDocument(id);
      if (tab.review) this.deps.reviewClosed(tab.review.reviewId);
      if (this.activeId === tab.id) this.activateFallback();
      this.stateChanged();
    }
  }

  // cancel: the user cancelled, or the save failed and its tab says why
  private async askToSave(document: TextDocument, cancellable: boolean): Promise<'saved' | 'discard' | 'cancel'> {
    const choice = await this.deps.ask({
      severity: 'warning',
      message: this.deps.t('Do you want to save the changes you made to {0}?', visibleText(document.name)),
      detail: this.deps.t('Your changes will be lost if you don\'t save them.'),
      // Escape or dismissing the dialog answers undefined, which keeps the tab open, as Cancel does.
      actions: [this.deps.t('Save'), this.deps.t('Don\'t Save')],
      ...(cancellable ? { cancelLabel: this.deps.t('Cancel') } : {}),
      defaultAction: 0,
    });
    if (choice === undefined) return 'cancel';
    if (choice === 1) return 'discard';
    await this.flush(this.formatsOnSave([document]));
    const result = await this.deps.documents.save(document.id, document.version, document.text);
    return result.ok ? 'saved' : 'cancel';
  }

  // Every removal of a tab from this.tabs calls this, so a showDiff caller learns its tab is gone however it went.
  private tabsRemoved(): void {
    for (const [tabId, closed] of this.diffClosed) {
      if (this.tabs.some((tab) => tab.id === tabId)) continue;
      this.diffClosed.delete(tabId);
      closed();
    }
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
    if (tab.changes) {
      return { id: tab.id, kind: 'changes', title: tab.changes.title, displayPath: tab.changes.title, dirty: false, readOnly: true, conflict: false, changes: tab.changes.changes };
    }
    if (tab.review) {
      return { id: tab.id, kind: 'review', title: tab.review.title, displayPath: tab.review.title, dirty: false, readOnly: true, conflict: false, review: tab.review };
    }
    if (tab.timeline) {
      const { repoId, path: file, title } = tab.timeline;
      return { id: tab.id, kind: 'timeline', title, displayPath: file, dirty: false, readOnly: true, conflict: false, timeline: { repoId, path: file } };
    }
    if (tab.merge) {
      const document = this.deps.documents.get(tab.documentId!)!;
      const { title, ...merge } = tab.merge;
      return {
        id: tab.id,
        kind: 'merge',
        documentId: document.id,
        title,
        ...this.placeOf(document),
        dirty: isDocumentDirty(document),
        readOnly: document.kind !== 'text' || document.readOnlyReason !== undefined,
        conflict: document.kind === 'text' && document.conflict,
        merge: { ...merge, documentId: document.id },
      };
    }
    if (tab.diff) {
      const original = this.deps.documents.get(tab.diff.originalId);
      const modified = this.deps.documents.get(tab.diff.modifiedId);
      const { originalId, modifiedId, added, removed, conflictCompare, subject, scmGit, scmRepoId } = tab.diff;
      const sides = { original: diffSide(original, false), modified: diffSide(modified, true) };
      const git = scmGit && scmRepoId !== undefined ? { git: { repoId: scmRepoId, ...scmGit } } : {};
      return {
        id: tab.id,
        kind: 'diff',
        diff: { originalId, modifiedId, added, removed, ...(conflictCompare ? { conflictCompare } : {}), ...(sides.original.kind === 'text' && sides.modified.kind === 'text' ? {} : { sides }), ...git },
        title: tab.diff.title(this.subjectName(subject)),
        ...('place' in subject ? this.withBranch(placeFields(subject.place)) : this.placeOf(this.deps.documents.get(subject.documentId))),
        dirty: modified !== undefined && isDocumentDirty(modified),
        readOnly: modified?.kind !== 'text' || modified.readOnlyReason !== undefined,
        ...(modified?.kind === 'text' && modified.readOnlyReason !== undefined ? { readOnlyReason: modified.readOnlyReason } : {}),
        conflict: modified?.kind === 'text' && modified.conflict,
      };
    }
    const document = this.deps.documents.get(tab.documentId!)!;
    const readOnlyReason = document.kind === 'text' ? document.readOnlyReason : undefined;
    // a host's own settings file validates as its user file does
    const settingsScope = tab.kind === 'settings' && document.kind === 'text' ? document.settingsScope ?? (document.location?.host !== undefined ? 'user' : undefined) : undefined;
    const git = tab.kind === 'code' && document.location ? this.deps.gitOf(document.location) : undefined;
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
      ...(document.kind === 'text' && document.pendingUpload ? { pendingUpload: true as const } : {}),
      ...(document.kind === 'text' && document.orphaned ? { deleted: true as const } : {}),
      ...(settingsScope !== undefined ? { settingsScope } : {}),
      ...(document.kind === 'text' && document.searchEditor ? { searchEditor: this.searchEditorOf(document) } : {}),
      ...(git ? { git } : {}),
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
    if (document.location?.host !== undefined) return document.name;
    const scope = document.kind === 'text' ? document.settingsScope : undefined;
    return scope === 'local' ? 'settings.local.json' : 'settings.json';
  }

  private placeOf(document: Document | undefined): Pick<ShellEditorTab, 'projectKey' | 'worktreeBranch' | 'relativePath' | 'displayPath'> {
    const location = document?.location;
    const projectKey = document?.kind === 'text' && document.searchEditor ? document.searchEditor.projectKey : location?.projectKey;
    const branch = projectKey !== undefined ? this.deps.worktreeBranch(projectKey) : undefined;
    return {
      ...(projectKey !== undefined ? { projectKey } : {}),
      ...(branch !== undefined ? { worktreeBranch: branch } : {}),
      ...(location?.relativePath !== undefined ? { relativePath: location.relativePath } : {}),
      displayPath: location?.path ?? document?.name ?? '',
    };
  }

  private withBranch(fields: Pick<ShellEditorTab, 'projectKey' | 'relativePath' | 'displayPath'>): Pick<ShellEditorTab, 'projectKey' | 'worktreeBranch' | 'relativePath' | 'displayPath'> {
    const branch = fields.projectKey !== undefined ? this.deps.worktreeBranch(fields.projectKey) : undefined;
    return branch !== undefined ? { ...fields, worktreeBranch: branch } : fields;
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
    const backupId = document.kind === 'text' && (isDocumentDirty(document) || document.pendingUpload) ? document.backupId : undefined;
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
    // review and timeline tabs name ids of this run, and a merge tab is never restored (AD8)
    if (tab.kind === 'diff' || tab.kind === 'changes' || tab.kind === 'review' || tab.kind === 'timeline' || tab.kind === 'merge') return undefined;
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
      const state = this.state();
      this.deps.sendState(state);
      if (this.publishedTabs && state.tabs.length === 0) this.deps.hidePane();
      this.publishedTabs = state.tabs.length > 0;
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
