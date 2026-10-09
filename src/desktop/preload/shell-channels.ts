// Shared by the shell preload, main and (as types only) the shell app; the shell never sees panel channels.

import type { OverlayAnswer, OverlayRequest } from './overlay-channels';
import type { NotificationBell } from './notifications';
import type { SettingsSectionId } from '../../shared/settings-sections';
import type { UpdateAction, UpdateSnapshot } from './updates';
import type { SettingsFileScope } from '../../shared/types/messages';
import type { SearchFileKey, SearchFileResult, SearchQuery, SearchRange, SearchSortOrder } from '../../shared/text-search';
import type { DamoclesTerminalApi } from './terminal-channels';
import type { SEARCH_ACTIONS_POSITIONS, SEARCH_COLLAPSE_RESULTS, SEARCH_DEFAULT_VIEW_MODES, SEARCH_EDITOR_DOUBLE_CLICK, SEARCH_MODES } from '../main/desktop-configuration';

export type { SearchFileKey, SearchFileResult, SearchMatch, SearchPreview, SearchQuery, SearchRange, SearchSortOrder } from '../../shared/text-search';

export const SHELL_CHANNELS = {
  // renderer → main, invoke
  getState: 'damocles:shell:get-state',
  addProject: 'damocles:shell:add-project',
  removeProject: 'damocles:shell:remove-project',
  selectProject: 'damocles:shell:select-project',
  grantTrust: 'damocles:shell:grant-trust',
  chatsList: 'damocles:shell:chats:list',
  chatsSearch: 'damocles:shell:chats:search',
  chatsSelect: 'damocles:shell:chats:select',
  chatsNew: 'damocles:shell:chats:new',
  chatsRename: 'damocles:shell:chats:rename',
  chatsTag: 'damocles:shell:chats:tag',
  chatsDelete: 'damocles:shell:chats:delete',
  overlayRequest: 'damocles:shell:overlay:request',
  appMenu: 'damocles:shell:window:app-menu',
  toggleTheme: 'damocles:shell:window:toggle-theme',
  toggleSidebar: 'damocles:shell:window:toggle-sidebar',
  // shows a hidden sidebar and never hides it (Reveal in Files)
  showSidebar: 'damocles:shell:window:show-sidebar',
  // a WindowControl from the title bar's window buttons (Windows, Linux)
  windowControl: 'damocles:shell:window:control',
  // section?: a SettingsSectionId; opens the settings modal in the overlay
  openSettings: 'damocles:shell:window:open-settings',
  // the title-bar pill: UpdateSnapshot, and an UpdateAction main runs when its state offers it
  updateGet: 'damocles:shell:update:get',
  updateRun: 'damocles:shell:update:run',
  // renderer → main, send
  contentBounds: 'damocles:shell:content-bounds',
  sidebarLayout: 'damocles:shell:sidebar-layout',
  gridSizes: 'damocles:shell:grid-sizes',
  focusedPart: 'damocles:shell:focused-part',
  // main → renderer
  state: 'damocles:shell:state',
  // projectKey whose chat list changed; the shell refetches when it shows that project
  chatsChanged: 'damocles:shell:chats:changed',
  // F6 landed on the sidebar; the shell focuses the sidebar's current row
  focusPart: 'damocles:shell:focus-part',
  // main → renderer, PanelTheme; the preload applies it to the page itself
  theme: 'damocles:shell:theme',
  // main → renderer, UpdateSnapshot after each update state change
  updateState: 'damocles:shell:update:state',

  // Layout grid, renderer → main, invoke
  // { pane: GridPane, slot: GridSlot }: main applies moveGridPane and publishes the new layout in ShellState
  layoutMove: 'damocles:shell:layout:move',
  toggleEditor: 'damocles:shell:layout:toggle-editor',
  toggleTerminal: 'damocles:shell:layout:toggle-terminal',
  // { pane: GridPane }
  toggleMaximize: 'damocles:shell:layout:toggle-maximize',

  // Editor pane, renderer → main, invoke
  editorGetState: 'damocles:shell:editor:get-state',
  // { documentId } → ShellDocumentContent
  editorGetDocument: 'damocles:shell:editor:get-document',
  // EditorOpenRequest → EditorOpenResult; a user action: main activates the tab and the shell focuses it
  editorOpen: 'damocles:shell:editor:open',
  // EditorTabRequest
  editorTab: 'damocles:shell:editor:tab',
  // EditorTextRequest → EditorSaveResult
  editorSave: 'damocles:shell:editor:save',
  editorSaveAs: 'damocles:shell:editor:save-as',
  // EditorFormatRequest → EditorFormatReply: format on save and Format Document (D29); main answers text or a verdict, never a path
  editorFormat: 'damocles:shell:editor:format',
  // EditorConflictRequest → EditorConflictResult; the shell flushes editor:edit first, main uses the text it holds
  editorConflict: 'damocles:shell:editor:conflict',
  // { tabId }: Mention this file in chat
  editorMention: 'damocles:shell:editor:mention',
  // { open: boolean }: main hides the chat view while the focus overlay is open
  editorFocusOverlay: 'damocles:shell:editor:focus-overlay',
  // Editor pane, renderer → main, send
  // EditorEditReport, trailing-throttled by the shell (<= EDITOR_EDIT_THROTTLE_MS) and flushed before save, conflict and flushed
  editorEdit: 'damocles:shell:editor:edit',
  // EditorSelectionReport, throttled; feeds the IDE context of the selected chat
  editorSelection: 'damocles:shell:editor:selection',
  // EditorBuiltinFormatFailure: Monaco's built-in formatter failed or ran past the budget; main logs it and tells the user
  editorFormatFailed: 'damocles:shell:editor:format-failed',
  // { requestId }: answers editor:flush once every pending editor:edit is sent
  editorFlushed: 'damocles:shell:editor:flushed',
  // Editor pane, main → renderer
  // ShellEditorState snapshot on every change; it never carries text
  editorState: 'damocles:shell:editor:state',
  // EditorDocumentChange: a clean-buffer reload, log growth or reverted text; applied as a model edit that keeps view state
  editorDocumentChanged: 'damocles:shell:editor:document-changed',
  // EditorCommand from a menu accelerator; the shell runs it on the active tab
  editorCommand: 'damocles:shell:editor:command',
  // EditorFlushRequest: quit, window close or a save in their prompts; the shell formats the named documents, sends its
  // pending edits, then editor:flushed
  editorFlush: 'damocles:shell:editor:flush',
  // { tabId }: main opened a tab the user asked for (Quick Open, a tool card); the shell focuses its editor
  editorFocus: 'damocles:shell:editor:focus',
  // EditorReveal: an open named a line; the shell scrolls the tab's editor to it and puts the caret there, focus unchanged
  editorReveal: 'damocles:shell:editor:reveal',

  // Browser tabs (D14): the selected chat's pages, renderer → main, invoke
  // BrowserActionRequest
  browserAction: 'damocles:shell:browser:action',
  // BrowserNavigateRequest → boolean: false when main refused the address, and nothing navigated
  browserNavigate: 'damocles:shell:browser:navigate',
  // Browser tabs, renderer → main, send
  // BrowserPageArea | null: the active browser tab's page area, which main covers with the page's view
  browserBounds: 'damocles:shell:browser:bounds',

  // Files, renderer → main, invoke
  // FilesListRequest → FilesListResult
  filesList: 'damocles:shell:files:list',
  // FilesCreateRequest → FilesMutationResult
  filesCreate: 'damocles:shell:files:create',
  // FilesRenameRequest → FilesMutationResult
  filesRename: 'damocles:shell:files:rename',
  // FileRef → FilesDeleteResult; main confirms, then moves it to the OS trash
  filesDelete: 'damocles:shell:files:delete',
  // FileRef & { relative: boolean }
  filesCopyPath: 'damocles:shell:files:copy-path',
  // FileRef
  filesReveal: 'damocles:shell:files:reveal',
  // FileRef: Mention in chat; the same resolver as a drop on the composer
  filesMention: 'damocles:shell:files:mention',
  // Files, main → renderer
  // FilesChanged; the shell refetches only the expanded directories it names
  filesChanged: 'damocles:shell:files:changed',

  // { x, y, released }: the pointer of a pane drag the shell captured, forwarded to the overlay's open dropZones request
  dropZonesPointer: 'damocles:shell:drop-zones:pointer',

  // Quick Open: Ctrl+P's equivalent for the title-bar search box; main opens the overlay's quickOpen request
  quickOpen: 'damocles:shell:quick-open:open',
  // the editor context menu's Command Palette...: main opens the palette as Show All Commands does
  showCommands: 'damocles:shell:commands:show',

  // Search, renderer → main, invoke
  // SearchStartRequest → SearchStartResult; the shell sends its pending editor:edit first, so main searches current buffers
  searchStart: 'damocles:shell:search:start',
  // {}: Cancel Search; the view's run stops and its SearchDone says cancelled, the results sent so far stay
  searchCancel: 'damocles:shell:search:cancel',
  // {}: kills the running search and forgets its matches
  searchClear: 'damocles:shell:search:clear',
  // SearchDismissRequest: main keeps the dismissals for the run and answers with search:file-update
  searchDismiss: 'damocles:shell:search:dismiss',
  // SearchCopyRequest: Copy, Copy All; main writes VS Code's text to the clipboard
  searchCopy: 'damocles:shell:search:copy',
  // SearchConfirmReplaceRequest → boolean; Replace All's question, asked through the overlay dialog
  searchConfirmReplace: 'damocles:shell:search:confirm-replace',
  // SearchReplaceRequest → SearchReplaceResult; closed files only, the shell replaces open ones in their buffers
  searchReplace: 'damocles:shell:search:replace',
  // SearchPreviewRequest → SearchPreviewResult: opens, or reuses, the file's read-only replace preview diff tab
  searchPreview: 'damocles:shell:search:preview',
  // FileRef of a folder: Find in Folder..., routed by damocles.desktop.search.mode
  searchFindInFolder: 'damocles:shell:search:find-in-folder',
  // Search, main → renderer
  // SearchResultsBatch: each file in exactly one batch
  searchResults: 'damocles:shell:search:results',
  // SearchFileUpdate: a live re-search, a dismissal or a replace changed one file of the view's results
  searchFileUpdate: 'damocles:shell:search:file-update',
  // SearchDone; not sent for a search a newer one killed
  searchDone: 'damocles:shell:search:done',
  // SearchFocus from Find in Files, Replace in Files and Find in Folder, after main showed the sidebar
  searchFocus: 'damocles:shell:search:focus',
  // SearchCommandMessage: a registry command the Search view or a Search Editor tab carries out
  searchCommand: 'damocles:shell:search:command',

  // Search Editor, renderer → main, invoke
  // SearchEditorOpenRequest → { tabId }
  searchEditorOpenNew: 'damocles:shell:search-editor:open-new',
  // { documentId, config: SearchEditorConfig }
  searchEditorConfig: 'damocles:shell:search-editor:config',
  // { documentId }: runs the tab's config; the body and its highlights come back as pushes
  searchEditorRun: 'damocles:shell:search-editor:run',
  // SearchEditorOpenResultRequest → EditorOpenResult | notResult; main reads the body it holds, never a path from the shell
  searchEditorOpenResult: 'damocles:shell:search-editor:open-result',
  // Search Editor, main → renderer
  // SearchEditorHighlights
  searchEditorHighlights: 'damocles:shell:search-editor:highlights',
} as const;

// Bounds of the editor, Files and Quick Open channels; main refuses a payload outside them.
// Must stay equal to MAX_RELATIVE_PATH_LENGTH in src/shared/relative-path.ts.
export const MAX_RELATIVE_PATH_LENGTH = 4096;
// Match ids of one search:replace, search:preview, search:dismiss or search:copy, and files of one dismissal or copy.
export const MAX_SEARCH_PAYLOAD_MATCHES = 20_000;
// Replace All's confirmation counts.
export const MAX_REPLACE_OCCURRENCES = 1_000_000;
export const MAX_REPLACE_FILES = 100_000;
// A file or folder name in Files' create and rename.
export const MAX_FILE_NAME_LENGTH = 255;
// Characters of buffer text in one editor:edit or save; EDITOR_MAX_DOCUMENT_BYTES of UTF-16 text at most.
export const MAX_EDITOR_TEXT_CHARS: number = 10 * 1024 * 1024;
export const MAX_EDITOR_LINE = 10_000_000;
// The shell sends editor:edit at most this often per document.
export const EDITOR_EDIT_THROTTLE_MS = 250;

// Bounds the shell may send; main clamps nothing, it rejects anything outside these.
export const MAX_ID_LENGTH = 200;
export const MAX_SEARCH_LENGTH = 200;
export const MAX_CHAT_NAME_LENGTH = 200;
export const MAX_TAG_LENGTH = 50;
// Larger than any real display in CSS px; a coordinate or size outside [0, MAX_SHELL_COORDINATE] is malformed.
export const MAX_SHELL_COORDINATE = 100_000;
// AD7 layout minimums, CSS px.
export const MIN_SIDEBAR_WIDTH = 220;
export const MIN_SECTION_SIZE = 60;

// Prefix of the id of a loaded chat that has no session file yet; a stored chat's id is its sessionId.
export const NEW_CHAT_ID_PREFIX = 'new:';

export type ShellLocale = 'en' | 'el';
export type ShellPlatform = 'win32' | 'darwin' | 'linux';

export const WINDOW_CONTROLS = ['minimize', 'toggleMaximize', 'close'] as const;
export type WindowControl = (typeof WINDOW_CONTROLS)[number];
export type ShellWindowState = 'normal' | 'maximized' | 'fullScreen';

// waiting = the chat needs the user (requires_action)
export type ChatStatus = 'running' | 'waiting' | 'idle';

export interface ShellProject {
  readonly key: string;
  readonly name: string;
  readonly fsPath: string;
  readonly trusted: boolean;
  // the project's branch from git's HEAD file (D42); undefined outside git
  readonly branch?: string;
  // loaded chats of this project by status
  readonly running: number;
  readonly waiting: number;
}

export interface ShellChat {
  // issued by main; the shell passes it back verbatim
  readonly id: string;
  // '' is a new conversation, which the shell labels itself
  readonly title: string;
  // epoch ms of the last activity, for the Today / Yesterday / Earlier groups
  readonly timestamp: number;
  readonly tag?: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly status: ChatStatus;
  readonly loaded: boolean;
}

export interface ShellChatList {
  readonly projectKey: string;
  // newest first
  readonly chats: readonly ShellChat[];
  // every tag used in the project, sorted
  readonly tags: readonly string[];
}

export type SelectChatResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'leased' | 'missing' };
export type ChatMutationResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'leased' | 'missing' | 'failed' };

export interface ShellSectionLayout {
  readonly collapsed: boolean;
  // CSS px, >= MIN_SECTION_SIZE
  readonly size: number;
}

export const GRID_PANES = ['chat', 'editor', 'terminal'] as const;
export type GridPane = (typeof GRID_PANES)[number];
export const GRID_SLOTS = ['main', 'side', 'bottom'] as const;
export type GridSlot = (typeof GRID_SLOTS)[number];

export interface ShellGridLayout {
  // a permutation: each pane in exactly one slot
  readonly slots: { readonly main: GridPane; readonly side: GridPane; readonly bottom: GridPane };
  // chat is always shown
  readonly visible: { readonly editor: boolean; readonly terminal: boolean };
  // CSS px at the current zoom, like sidebarWidth; the clamps live in the shell's layout-model.ts, main only range-checks
  readonly sideWidth: number;
  readonly bottomHeight: number;
  // the pane that fills the grid; null = none
  readonly maximized: GridPane | null;
}

export const DEFAULT_GRID_LAYOUT: ShellGridLayout = {
  slots: { main: 'chat', side: 'editor', bottom: 'terminal' },
  visible: { editor: true, terminal: false },
  sideWidth: 520,
  bottomHeight: 230,
  maximized: null,
};

function slotOf(grid: ShellGridLayout, pane: GridPane): GridSlot {
  return GRID_SLOTS.find((slot) => grid.slots[slot] === pane)!;
}

/**
 * The one swap rule, used by main and the shell: pane goes to slot, the pane there takes pane's old slot, and the moved pane
 * shows. A maximized pane stays maximized only while it keeps its slot.
 */
export function moveGridPane(grid: ShellGridLayout, pane: GridPane, slot: GridSlot): ShellGridLayout {
  const from = slotOf(grid, pane);
  const displaced = grid.slots[slot];
  const slots = { ...grid.slots, [from]: displaced, [slot]: pane };
  const visible = pane === 'chat' ? grid.visible : { ...grid.visible, [pane]: true };
  const maximized = grid.maximized === pane || grid.maximized === displaced ? (from === slot ? grid.maximized : null) : grid.maximized;
  return { ...grid, slots, visible, maximized };
}

/** Shows or hides the editor or terminal; hiding the maximized pane restores the grid. */
export function toggleGridPane(grid: ShellGridLayout, pane: 'editor' | 'terminal'): ShellGridLayout {
  const shown = !grid.visible[pane];
  return { ...grid, visible: { ...grid.visible, [pane]: shown }, maximized: !shown && grid.maximized === pane ? null : grid.maximized };
}

/** Maximizes pane (showing it), or restores the grid when pane is the maximized one. */
export function toggleGridMaximize(grid: ShellGridLayout, pane: GridPane): ShellGridLayout {
  if (grid.maximized === pane) return { ...grid, maximized: null };
  const visible = pane === 'chat' ? grid.visible : { ...grid.visible, [pane]: true };
  return { ...grid, visible, maximized: pane };
}

// The inputs' history, oldest first, each at most MAX_SEARCH_HISTORY entries bounded like its input (VS Code's SearchHistoryService).
export interface SearchHistory {
  readonly query: readonly string[];
  readonly replace: readonly string[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export const EMPTY_SEARCH_HISTORY: SearchHistory = { query: [], replace: [], include: [], exclude: [] };

export type SearchViewMode = (typeof SEARCH_DEFAULT_VIEW_MODES)[number];

// The Search section's query, toggles and history for one project, restored with the layout; never its results or replace text.
export interface SearchViewState {
  readonly pattern: string;
  readonly isRegex: boolean;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly useExcludeSettingsAndIgnoreFiles: boolean;
  readonly replaceOpen: boolean;
  readonly include: string;
  readonly exclude: string;
  readonly onlyOpenEditors: boolean;
  readonly preserveCase: boolean;
  // Toggle Search Details
  readonly detailsOpen: boolean;
  readonly viewMode: SearchViewMode;
  readonly history: SearchHistory;
  // the Replace input's text while the Replace row shows, else empty (VS Code's query.replaceText)
  readonly replaceText: string;
}

// Projects whose Search view state the layout keeps.
export const MAX_SEARCH_VIEW_STATES = 100;

export interface ShellLayout {
  readonly sidebarVisible: boolean;
  // CSS px, >= MIN_SIDEBAR_WIDTH
  readonly sidebarWidth: number;
  // The first open section of Chats, Files, Search and Projects takes the height the others leave, so Chats has no size.
  readonly sections: {
    readonly projects: ShellSectionLayout;
    readonly files: ShellSectionLayout;
    readonly search: ShellSectionLayout;
    readonly chats: { readonly collapsed: boolean };
  };
  readonly grid: ShellGridLayout;
  // by project key
  readonly search: { readonly [projectKey: string]: SearchViewState };
}

// The parts of the layout the shell writes, each reported by its owner alone; main owns the rest.
export type ShellSidebarLayout = Pick<ShellLayout, 'sidebarWidth' | 'sections' | 'search'>;
export type ShellGridSizes = Pick<ShellGridLayout, 'sideWidth' | 'bottomHeight'>;

export type ShellFocusPart = 'sidebar' | 'editor' | 'terminal';
export const SHELL_FOCUS_PARTS: readonly ShellFocusPart[] = ['sidebar', 'editor', 'terminal'];

// Editor pane (main's editor-pane.ts relay). Ids are issued by main; the shell passes them back verbatim.
export type EditorTabKind = 'code' | 'diff' | 'markdownPreview' | 'image' | 'untitled' | 'settings' | 'log' | 'notDisplayed' | 'browser' | 'searchEditor';
export type EditorReadOnlyReason = 'encoding' | 'log' | 'outsideProject' | 'tooLarge';

// A browser page of the selected chat (D14), as main observed it from the host messages core posts to the page.
export interface ShellBrowserPage {
  readonly url: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  // the element picker is armed on this page
  readonly picking: boolean;
  // a size-capped data: URL of the page's favicon
  readonly iconDataUrl?: string;
}

export interface ShellEditorTab {
  readonly id: string;
  readonly kind: EditorTabKind;
  // absent on diff and browser tabs
  readonly documentId?: string;
  // conflictCompare: the conflict bar's Compare, whose bar offers only Overwrite and Revert; either closes it
  readonly diff?: { readonly originalId: string; readonly modifiedId: string; readonly added: number; readonly removed: number; readonly conflictCompare?: true };
  // browser tabs only
  readonly browser?: ShellBrowserPage;
  // a browser tab's is the page's own title, which the shell shows without bidi controls
  readonly title: string;
  // absent for files outside every project (agent opens), untitled and core-generated documents
  readonly projectKey?: string;
  // '/' separated; the breadcrumbs; absent outside projects
  readonly relativePath?: string;
  // the tooltip and the breadcrumb fallback
  readonly displayPath: string;
  readonly dirty: boolean;
  readonly readOnly: boolean;
  readonly readOnlyReason?: EditorReadOnlyReason;
  // the disk changed under a dirty buffer, or a save was refused for a change on disk
  readonly conflict: boolean;
  // the file was deleted on disk (VS Code's orphaned editor): dirty only when edited, and a save recreates it
  readonly deleted?: true;
  // settings tabs only: which settings file, for the JSON schema variant (user, or project/local)
  readonly settingsScope?: SettingsFileScope;
  // searchEditor tabs only: main's config of the editor, whether its search runs, and what its message line says
  // untitled: no .code-search file yet, so a save asks where
  readonly searchEditor?: { readonly config: SearchEditorConfig; readonly running: boolean; readonly untitled: boolean; readonly message?: SearchEditorMessage };
}

// A Search Editor's query (VS Code's SearchConfiguration without the notebook filters).
export interface SearchEditorConfig {
  readonly query: string;
  readonly isRegex: boolean;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly include: string;
  readonly exclude: string;
  readonly useExcludeSettingsAndIgnoreFiles: boolean;
  readonly onlyOpenEditors: boolean;
  // 0..MAX_CONTEXT_LINES
  readonly contextLines: number;
  readonly showIncludesExcludes: boolean;
}

// stale: the editor holds a query and no results (a reopened file, a restored tab), VS Code's "Run Search"
export type SearchEditorMessage =
  | { readonly kind: 'error'; readonly text: string }
  | { readonly kind: 'invalidGlob'; readonly glob: string }
  | { readonly kind: 'noProject' }
  | { readonly kind: 'headerError'; readonly text: string }
  | { readonly kind: 'stale' };

export type SearchEditorOpenRequest =
  // New Search Editor, Open New Search Editor (the view's inputs) and Find in Folder in an editor mode
  | { readonly from: 'blank'; readonly config?: Partial<SearchEditorConfig> }
  // Open Results in Editor: main's own results of the view's search
  | { readonly from: 'viewResults'; readonly searchId: number };

// 1-based position in the Search Editor's body
export interface SearchEditorOpenResultRequest {
  readonly documentId: string;
  readonly line: number;
  readonly column: number;
  readonly toSide: boolean;
}

export type SearchEditorOpenResult = EditorOpenResult | { readonly ok: false; readonly reason: 'notResult' };

// ranges: the matches in the body of that content version
export interface SearchEditorHighlights {
  readonly documentId: string;
  readonly version: number;
  readonly ranges: readonly SearchRange[];
}

export interface ShellEditorSettings {
  readonly fontSize: number;
  readonly tabSize: number;
  readonly detectIndentation: boolean;
  readonly wordWrap: 'off' | 'on';
  readonly minimap: boolean;
  readonly renderWhitespace: 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
  readonly autoSave: 'off' | 'afterDelay' | 'onFocusChange';
  readonly formatOnSave: boolean;
}

export interface ShellEditorState {
  // in tab order
  readonly tabs: readonly ShellEditorTab[];
  readonly activeTabId: string | null;
  readonly settings: ShellEditorSettings;
  // every document a tab shows, by id
  readonly documents: Readonly<Record<string, ShellEditorDocument>>;
}

// What a document's Monaco model is named after: a rename or Save As changes it, and the shell moves the model to match.
export interface ShellEditorDocument {
  readonly name: string;
  // the native path of a document that is a file
  readonly path?: string;
  // a text document's Monaco language
  readonly languageId?: string;
}

export type ShellDocumentContent =
  // version: main's content version, bumped only when main replaces the text (a reload, a revert) and pushed with it in
  // editor:document-changed; a save, save-as or overwrite keeps it. An editor:edit for another version is dropped.
  // editSeq: the seq of the last editor:edit main applied, so the shell knows which keystrokes a replacement covered.
  | {
      readonly kind: 'text';
      readonly documentId: string;
      readonly version: number;
      readonly editSeq: number;
      readonly text: string;
      readonly languageId: string;
      readonly eol: '\n' | '\r\n';
      readonly encoding: DocumentEncoding;
      readonly bom: boolean;
    }
  // dataUrl: a size-capped data: URL of a png, jpeg, gif, webp, bmp, x-icon or svg+xml image, for an <img> only
  | { readonly kind: 'image'; readonly documentId: string; readonly dataUrl: string; readonly bytes: number }
  | { readonly kind: 'notDisplayed'; readonly documentId: string; readonly reason: 'binary' | 'tooLarge' | 'unreadable'; readonly bytes?: number };

export type DocumentEncoding = 'utf8' | 'utf16le' | 'utf16be';

export interface EditorDocumentChange {
  readonly documentId: string;
  readonly content: ShellDocumentContent;
}

export interface EditorOpenRequest {
  readonly projectKey: string;
  readonly relativePath: string;
  // 1-based
  readonly line?: number;
  // markdown: the preview or the source tab
  readonly as?: 'preview' | 'source';
  // Search's single click: the tab shows and keyboard focus stays where it is
  readonly preserveFocus?: boolean;
  // Open to the Side: the editor pane shows even when hidden or behind the maximized chat
  readonly toSide?: boolean;
}

export type EditorOpenResult = { readonly ok: true; readonly tabId: string } | { readonly ok: false; readonly reason: 'outside' | 'missing' | 'failed' };

export const EDITOR_TAB_ACTIONS = [
  'activate',
  'close',
  'closeOthers',
  'closeRight',
  'closeAll',
  // markdown: Show preview, Show source
  'openPreview',
  'openSource',
  // a diff tab's file, or the file of a preview
  'openFile',
  // a code tab's file as a diff against git HEAD (slice 10); refused until then
  'openChanges',
  'copyPath',
  'copyRelativePath',
  'revealInExplorer',
] as const;
export type EditorTabAction = (typeof EDITOR_TAB_ACTIONS)[number];

export interface EditorTabRequest {
  readonly action: EditorTabAction;
  readonly tabId: string;
}

// text: the whole buffer; version: the ShellDocumentContent version the buffer started from
export interface EditorTextRequest {
  readonly documentId: string;
  readonly version: number;
  readonly text: string;
}

// editor:edit. seq: the shell's per-document edit counter, increasing. overReload: the keystrokes were typed over text main
// replaced before it saw them, so main keeps them as the buffer and flags the conflict instead of taking them as edits of
// the new text.
export interface EditorEditReport extends EditorTextRequest {
  readonly seq: number;
  readonly overReload: boolean;
}

export type EditorSaveResult =
  | { readonly ok: true }
  // conflict: the file changed on disk, and the tab now shows the conflict bar
  | { readonly ok: false; readonly reason: 'conflict' | 'readOnly' | 'cancelled' | 'failed'; readonly message?: string };

export interface EditorConflictRequest {
  readonly documentId: string;
  readonly action: 'compare' | 'overwrite' | 'revert';
}

export type EditorConflictResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'cancelled' | 'failed'; readonly message?: string };

// 1-based, Monaco's selection; startLine/startColumn may follow endLine/endColumn for a backward selection
export interface EditorSelectionRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface EditorSelectionReport {
  readonly documentId: string;
  // null: no selection (a caret only)
  readonly selection: EditorSelectionRange | null;
}

export type EditorCommand = 'save' | 'saveAs' | 'close' | 'next' | 'previous' | 'formatDocument';

export type EditorFormatReason = 'save' | 'command';

// Monaco's resolved indentation of the buffer.
export interface EditorFormatOptions {
  readonly tabSize: number;
  readonly insertSpaces: boolean;
}

// editor:format. text: the whole buffer; reason: a save (only while format on save is on) or Format Document.
export interface EditorFormatRequest {
  readonly documentId: string;
  readonly text: string;
  readonly options: EditorFormatOptions;
  readonly reason: EditorFormatReason;
}

// D29: a format that takes longer is abandoned and the save goes on unformatted. Prettier has this long to load and then
// this long to format; past the second, main kills the formatter host.
export const EDITOR_FORMAT_TIMEOUT_MS = 3000;

// Tab sizes a format request may carry.
export const MAX_FORMAT_TAB_SIZE = 32;

// builtin: the shell runs Monaco's formatter; skipped: no formatter applies; failed: main told the user, the save goes on.
export type EditorFormatReply =
  | { readonly kind: 'formatted'; readonly text: string }
  | { readonly kind: 'unchanged' | 'builtin' | 'skipped' | 'failed' };

// editor:format-failed; message: the formatter's error, cut to MAX_FORMAT_ERROR_CHARS
export interface EditorBuiltinFormatFailure {
  readonly documentId: string;
  readonly reason: EditorFormatReason;
  readonly timedOut: boolean;
  readonly message: string;
}

export const MAX_FORMAT_ERROR_CHARS = 1000;

// The editor context menu's items, each with a key binding.
export type EditorMenuShortcut =
  | 'goToDefinition'
  | 'goToReferences'
  | 'renameSymbol'
  | 'changeAllOccurrences'
  | 'formatDocument'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'commandPalette';

// editor:flush. format: documents the shell formats before it flushes, as Ctrl+S would (a save in the close and quit prompts).
export interface EditorFlushRequest {
  readonly requestId: string;
  readonly format: readonly string[];
}

export interface EditorReveal {
  readonly tabId: string;
  // 1-based
  readonly line: number;
  // selected when present: a Search Editor result's position
  readonly range?: SearchRange;
}

// What a browser tab's navigation bar and context menu ask of its page; main resolves tabId among the selected chat's pages.
export const BROWSER_ACTIONS = ['back', 'forward', 'reload', 'pickElement', 'devTools', 'openExternal', 'copyUrl'] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export interface BrowserActionRequest {
  readonly tabId: string;
  readonly action: BrowserAction;
}

// url: the address as typed; main checks it with isTypedAddress and core reads it with typedAddress
export interface BrowserNavigateRequest {
  readonly tabId: string;
  readonly url: string;
}

// Files (main's files/file-tree.ts). '' is the project folder itself.
export interface FileRef {
  readonly projectKey: string;
  readonly relativePath: string;
}

export interface FilesListRequest {
  readonly projectKey: string;
  readonly relativeDir: string;
  // a user action waits on the listing: main reports a failure in its one Files toast
  readonly report?: boolean;
}

export interface FileEntry {
  readonly name: string;
  // a symlink is listed by what it points to and never followed outside the project
  readonly kind: 'file' | 'dir';
}

export type FilesListResult =
  // directories first, then files, each in VS Code's default explorer order
  | { readonly ok: true; readonly entries: readonly FileEntry[] }
  | { readonly ok: false; readonly reason: 'outside' | 'missing' | 'failed' };

export interface FilesCreateRequest {
  readonly projectKey: string;
  readonly relativeDir: string;
  readonly name: string;
  readonly kind: 'file' | 'dir';
}

export interface FilesRenameRequest {
  readonly projectKey: string;
  readonly relativePath: string;
  readonly newName: string;
}

export type FilesMutationResult =
  | { readonly ok: true; readonly relativePath: string }
  | { readonly ok: false; readonly reason: 'invalidName' | 'exists' | 'outside' | 'missing' | 'failed'; readonly message?: string };

export type FilesDeleteResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'cancelled' | 'outside' | 'missing' | 'failed'; readonly message?: string };

// CSS px in the shell page's coordinates; released ends the drag
export interface DropZonesPointer {
  readonly x: number;
  readonly y: number;
  readonly released: boolean;
}

export interface FilesChanged {
  readonly projectKey: string;
  // '' is the project folder; each is a directory whose listing may have changed
  readonly relativeDirs: readonly string[];
}

// searchId: issued by the shell, larger than every earlier one; the shell sends its pending editor:edit first
export interface SearchStartRequest {
  readonly searchId: number;
  readonly query: SearchQuery;
  // Enter: no debounce
  readonly immediate: boolean;
}

export type SearchStartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: 'invalidGlob'; readonly glob: string }
  | { readonly ok: false; readonly error: 'noProject' };

export interface SearchResultsBatch {
  readonly searchId: number;
  // Match Case as main searched with it, smart case applied; the shell's buffer replace and preview use it
  readonly matchCase: boolean;
  readonly files: readonly SearchFileResult[];
}

// file: the file's matches now, or null when it left the results (no match left, or dismissed); a key may come back
export interface SearchFileUpdate {
  readonly searchId: number;
  // as in SearchResultsBatch
  readonly matchCase: boolean;
  readonly key: SearchFileKey;
  readonly file: SearchFileResult | null;
}

// The open buffers' search in main: the regular expression is one ripgrep takes and JavaScript does not, or it ran out of time.
export type SearchBufferWarning = 'unsupportedRegex' | 'timedOut';

export interface SearchDone {
  readonly searchId: number;
  readonly resultCount: number;
  readonly fileCount: number;
  // stopped at the result limit (damocles.desktop.search.maxResults)
  readonly limitHit: boolean;
  // ripgrep's message, such as a regex parse error
  readonly error?: string;
  // Cancel Search stopped it
  readonly cancelled?: true;
  readonly bufferWarning?: SearchBufferWarning;
}

export interface SearchFocus {
  readonly replace: boolean;
  // Find in Folder: the folder as VS Code's files-to-include entry
  readonly include?: string;
}

// matchIds: dismissed matches; files: dismissed files, which stay out until Refresh
export interface SearchDismissRequest {
  readonly searchId: number;
  readonly matchIds: readonly number[];
  readonly files: readonly SearchFileKey[];
}

export type SearchCopyTarget =
  | { readonly kind: 'matches'; readonly matchIds: readonly number[] }
  | { readonly kind: 'files'; readonly files: readonly SearchFileKey[] }
  | { readonly kind: 'all' };

export interface SearchCopyRequest {
  readonly searchId: number;
  readonly target: SearchCopyTarget;
}

export interface SearchConfirmReplaceRequest {
  readonly occurrences: number;
  readonly files: number;
  readonly replacement: string;
}

// matchIds: main's ids of the searchId's matches in closed project files; an open buffer's match is refused
export interface SearchReplaceRequest {
  readonly searchId: number;
  readonly replacement: string;
  readonly preserveCase: boolean;
  readonly matchIds: readonly number[];
}

// changed: a match is no longer at its range with its text; readOnly: not valid UTF-8 without a BOM, or too large;
// openInEditor: the file has an editor buffer now; conflict: the file changed while it was written; timedOut: the regex
// took too long on the file's text; unsupportedRegex: ripgrep's engine took the pattern but JavaScript cannot compile it
export type SearchSkipReason = 'changed' | 'readOnly' | 'openInEditor' | 'conflict' | 'timedOut' | 'unsupportedRegex';

// A closed file Replace did not write; failed: the write itself failed, with the file system's message.
export type SearchReplaceSkip =
  | { readonly relativePath: string; readonly reason: SearchSkipReason }
  | { readonly relativePath: string; readonly reason: 'failed'; readonly message: string };

export interface SearchReplaceResult {
  readonly replacedFiles: number;
  readonly replacedCount: number;
  readonly skipped: readonly SearchReplaceSkip[];
}

// matchIds: matches of one file or buffer of the search
export interface SearchPreviewRequest {
  readonly searchId: number;
  readonly replacement: string;
  readonly preserveCase: boolean;
  readonly matchIds: readonly number[];
}

// ok: the preview tab shows; otherwise why the file cannot be previewed, as Replace would skip it
export type SearchPreviewResult = { readonly ok: true } | { readonly ok: false; readonly reason: SearchSkipReason };

// openNewSearchEditor: the view opens a Search Editor with its current inputs (searchEditor:open-new from 'blank')
export type SearchViewCommand =
  | 'focusNextResult'
  | 'focusPreviousResult'
  | 'toggleQueryDetails'
  | 'refresh'
  | 'clearResults'
  | 'collapseAll'
  | 'expandAll'
  | 'viewAsTree'
  | 'viewAsList'
  | 'openNewSearchEditor';
export type SearchEditorCommand =
  | 'rerun'
  | 'focusInput'
  | 'focusIncludes'
  | 'focusExcludes'
  | 'toggleMatchCase'
  | 'toggleWholeWord'
  | 'toggleRegex'
  | 'toggleContextLines'
  | 'increaseContextLines'
  | 'decreaseContextLines'
  | 'selectAllMatches'
  | 'deleteFileResults'
  | 'toggleQueryDetails'
  | 'focusNextResult'
  | 'focusPreviousResult';

export type SearchCommandMessage =
  | { readonly target: 'view'; readonly command: SearchViewCommand }
  | { readonly target: 'editor'; readonly tabId: string; readonly command: SearchEditorCommand };

// The Search settings the shell applies; main republishes ShellState when one changes.
export interface ShellSearchSettings {
  readonly mode: (typeof SEARCH_MODES)[number];
  readonly searchOnType: boolean;
  readonly searchOnTypeDebouncePeriod: number;
  readonly sortOrder: SearchSortOrder;
  readonly collapseResults: (typeof SEARCH_COLLAPSE_RESULTS)[number];
  readonly showLineNumbers: boolean;
  readonly seedOnFocus: boolean;
  readonly seedWithNearestWord: boolean;
  readonly useReplacePreview: boolean;
  readonly defaultViewMode: SearchViewMode;
  readonly actionsPosition: (typeof SEARCH_ACTIONS_POSITIONS)[number];
  readonly searchEditor: { readonly doubleClickBehaviour: (typeof SEARCH_EDITOR_DOUBLE_CLICK)[number]; readonly focusResultsOnSearch: boolean };
}

export interface ShellState {
  // counts the states main gave this page; a chat list or search names the one its project key came from
  readonly revision: number;
  readonly locale: ShellLocale;
  readonly platform: ShellPlatform;
  readonly windowState: ShellWindowState;
  readonly projects: readonly ShellProject[];
  // projectKey is absent until main knows a project: before the core starts and nothing is selected yet
  readonly selected: { readonly projectKey?: string; readonly chatId?: string };
  // the breadcrumb's chat
  readonly selectedChat?: { readonly id: string; readonly title: string; readonly status: ChatStatus };
  readonly effectiveTheme: 'dark' | 'light';
  readonly layout: ShellLayout;
  // bumped when main replaces the layout itself (Restore default layout); the shell's own reports never bump it
  readonly layoutRevision: number;
  // display labels of menu accelerators, e.g. "Ctrl+N"
  readonly shortcuts: {
    readonly newChat: string;
    readonly toggleSidebar: string;
    readonly settings: string;
    readonly quickOpen: string;
    readonly toggleTerminal: string;
    readonly newTerminal: string;
    readonly splitTerminal: string;
    readonly closeEditor: string;
    readonly searchAgain: string;
    readonly toggleQueryDetails: string;
    readonly focusNextSearchResult: string;
    readonly editorMenu: Readonly<Record<EditorMenuShortcut, string>>;
  };
  readonly notifications: NotificationBell;
  readonly search: ShellSearchSettings;
}

// CSS px relative to the window's content area; main scales by the shell's zoom factor.
export interface ContentBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// The page area also carries its card's inner corner radius in CSS px, which main rounds the page view's corners to.
export interface BrowserPageArea extends ContentBounds {
  readonly radius: number;
}

export type RemoveProjectResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface DamoclesShellApi {
  getState(): Promise<ShellState>;
  // full snapshot on every change; returns the unsubscribe
  onState(listener: (state: ShellState) => void): () => void;
  addProject(): Promise<void>;
  removeProject(key: string): Promise<RemoveProjectResult>;
  // selects the project's last viewed chat, or a new chat in it
  selectProject(key: string): Promise<void>;
  grantTrust(key: string): Promise<void>;
  // stateRevision: the ShellState the key came from. null: the project has left main's list since that state, and main has
  // sent the state without it.
  listChats(projectKey: string, stateRevision: number): Promise<ShellChatList | null>;
  searchChats(projectKey: string, query: string, stateRevision: number): Promise<ShellChatList | null>;
  onChatsChanged(listener: (projectKey: string) => void): () => void;
  selectChat(chatId: string): Promise<SelectChatResult>;
  // a new chat in projectKey, or in the selected project when omitted
  newChat(projectKey?: string): Promise<void>;
  renameChat(chatId: string, name: string): Promise<ChatMutationResult>;
  // null removes the tag
  tagChat(chatId: string, tag: string | null): Promise<ChatMutationResult>;
  // the shell has already asked the user to confirm
  deleteChat(chatId: string): Promise<ChatMutationResult>;
  // shows a menu or dialog in the overlay and resolves with the user's answer
  requestOverlay(request: OverlayRequest): Promise<OverlayAnswer>;
  // pops the application menu up at a point in CSS px
  openAppMenu(anchor: { readonly x: number; readonly y: number }): Promise<void>;
  toggleTheme(): Promise<void>;
  toggleSidebar(): Promise<void>;
  // resolves once main showed the sidebar; the state that says so follows
  showSidebar(): Promise<void>;
  windowControl(control: WindowControl): Promise<void>;
  // the title-bar gear; resolves once main started opening the modal
  openSettings(section?: SettingsSectionId): Promise<void>;
  // the chat pane's slot rectangle; main places the selected chat's view there
  reportContentBounds(bounds: ContentBounds): void;
  // the sidebar's width, section sizes and Search states; main keeps the sidebar's visibility
  reportSidebarLayout(layout: ShellSidebarLayout): void;
  // the grid's sash sizes; main keeps the slots, visibility and maximized pane
  reportGridSizes(sizes: ShellGridSizes): void;
  // the shell part holding keyboard focus, null when focus left the shell's parts
  reportFocusedPart(part: ShellFocusPart | null): void;
  onFocusPart(listener: (part: ShellFocusPart) => void): () => void;
  // Layout grid; each resolves once main published the new layout in ShellState
  layoutMove(pane: GridPane, slot: GridSlot): Promise<void>;
  toggleEditor(): Promise<void>;
  toggleTerminal(): Promise<void>;
  toggleMaximize(pane: GridPane): Promise<void>;
  // Editor pane
  getEditorState(): Promise<ShellEditorState>;
  // returns the unsubscribe
  onEditorState(listener: (state: ShellEditorState) => void): () => void;
  getDocument(documentId: string): Promise<ShellDocumentContent>;
  onDocumentChanged(listener: (change: EditorDocumentChange) => void): () => void;
  openEditor(request: EditorOpenRequest): Promise<EditorOpenResult>;
  editorTab(request: EditorTabRequest): Promise<void>;
  // trailing-throttled by the caller to at most one per EDITOR_EDIT_THROTTLE_MS per document
  reportEdit(edit: EditorEditReport): void;
  saveDocument(request: EditorTextRequest): Promise<EditorSaveResult>;
  saveDocumentAs(request: EditorTextRequest): Promise<EditorSaveResult>;
  resolveConflict(request: EditorConflictRequest): Promise<EditorConflictResult>;
  formatDocument(request: EditorFormatRequest): Promise<EditorFormatReply>;
  reportFormatFailure(failure: EditorBuiltinFormatFailure): void;
  reportSelection(report: EditorSelectionReport): void;
  mentionTab(tabId: string): Promise<void>;
  setFocusOverlay(open: boolean): Promise<void>;
  onEditorCommand(listener: (command: EditorCommand) => void): () => void;
  // answer each with editorFlushed(requestId) after formatting the named documents and sending every pending edit
  onEditorFlush(listener: (request: EditorFlushRequest) => void): () => void;
  editorFlushed(requestId: string): void;
  onEditorFocus(listener: (tabId: string) => void): () => void;
  onEditorReveal(listener: (reveal: EditorReveal) => void): () => void;
  // Browser tabs
  browserAction(request: BrowserActionRequest): Promise<void>;
  navigateBrowser(request: BrowserNavigateRequest): Promise<boolean>;
  // the active browser tab's page area in CSS px, null while no browser tab shows one
  reportBrowserBounds(area: BrowserPageArea | null): void;
  // Files
  listFiles(request: FilesListRequest): Promise<FilesListResult>;
  createFile(request: FilesCreateRequest): Promise<FilesMutationResult>;
  renameFile(request: FilesRenameRequest): Promise<FilesMutationResult>;
  deleteFile(file: FileRef): Promise<FilesDeleteResult>;
  copyFilePath(file: FileRef, relative: boolean): Promise<void>;
  revealFile(file: FileRef): Promise<void>;
  mentionFile(file: FileRef): Promise<void>;
  onFilesChanged(listener: (change: FilesChanged) => void): () => void;
  // Quick Open in the overlay
  openQuickOpen(): Promise<void>;
  // the command palette in the overlay
  showCommands(): Promise<void>;
  // a pane drag past its threshold: main forwards it while the overlay's dropZones request is open
  reportDropZonesPointer(pointer: DropZonesPointer): void;
  // Search
  startSearch(request: SearchStartRequest): Promise<SearchStartResult>;
  cancelSearch(): Promise<void>;
  clearSearch(): Promise<void>;
  dismissSearch(request: SearchDismissRequest): Promise<void>;
  copySearchResults(request: SearchCopyRequest): Promise<void>;
  // a folder of Files: Find in Folder...
  findInFolder(folder: FileRef): Promise<void>;
  // each returns the unsubscribe
  onSearchResults(listener: (batch: SearchResultsBatch) => void): () => void;
  onSearchFileUpdate(listener: (update: SearchFileUpdate) => void): () => void;
  onSearchDone(listener: (done: SearchDone) => void): () => void;
  onSearchFocus(listener: (focus: SearchFocus) => void): () => void;
  onSearchCommand(listener: (message: SearchCommandMessage) => void): () => void;
  confirmReplace(request: SearchConfirmReplaceRequest): Promise<boolean>;
  replaceInFiles(request: SearchReplaceRequest): Promise<SearchReplaceResult>;
  previewReplace(request: SearchPreviewRequest): Promise<SearchPreviewResult>;
  // Search Editor
  openSearchEditor(request: SearchEditorOpenRequest): Promise<{ readonly tabId: string }>;
  setSearchEditorConfig(documentId: string, config: SearchEditorConfig): Promise<void>;
  runSearchEditor(documentId: string): Promise<void>;
  // send pending editor:edit first; main reads the body it holds
  openSearchEditorResult(request: SearchEditorOpenResultRequest): Promise<SearchEditorOpenResult>;
  onSearchEditorHighlights(listener: (highlights: SearchEditorHighlights) => void): () => void;
  getUpdate(): Promise<UpdateSnapshot>;
  // returns the unsubscribe
  onUpdate(listener: (snapshot: UpdateSnapshot) => void): () => void;
  // main refuses an action the current update state does not offer
  runUpdateAction(action: UpdateAction): Promise<void>;
  // the integrated terminal (terminal-channels.ts)
  readonly terminal: DamoclesTerminalApi;
}
