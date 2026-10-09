import { vi } from 'vitest';
import { DEFAULT_GRID_LAYOUT, type DamoclesShellApi, type DropZonesPointer, type EditorCommand, type EditorDocumentChange, type EditorFlushRequest, type EditorReveal, type FileRef, type FilesChanged, type SearchCommandMessage, type SearchDone, type SearchEditorHighlights, type SearchFileUpdate, type SearchFocus, type SearchResultsBatch, type ShellSearchSettings, type ShellChat, type ShellChatList, type ShellEditorState, type ShellFocusPart, type ShellState } from '../../preload/shell-channels';
import type { DamoclesOverlayApi, OverlayAnswer, PaletteCommand, OverlayPrefs, OverlayRasterRequest, OverlayRequest, OverlayState, OverlayToast, QuickOpenQuery, QuickOpenResponse } from '../../preload/overlay-channels';
import type { ChimeTone, NotificationCenterState } from '../../preload/notifications';
import type { DamoclesTerminalApi, TerminalData, TerminalProfileReport, TerminalRunAction, TerminalState } from '../../preload/terminal-channels';
import type { ReleaseIndex, UpdateSnapshot, VersionInfo } from '../../preload/updates';
import type { SettingsTarget } from '../../../shared/settings-sections';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

// VS Code's search.* defaults, as main publishes them.
export const SEARCH_SETTINGS: ShellSearchSettings = {
  mode: 'view',
  searchOnType: true,
  searchOnTypeDebouncePeriod: 300,
  sortOrder: 'default',
  collapseResults: 'alwaysExpand',
  showLineNumbers: false,
  seedOnFocus: false,
  seedWithNearestWord: false,
  useReplacePreview: true,
  defaultViewMode: 'list',
  actionsPosition: 'right',
  searchEditor: { doubleClickBehaviour: 'goToLocation', focusResultsOnSearch: false },
};

export const STATE: ShellState = {
  revision: 1,
  locale: 'en',
  platform: 'win32',
  windowState: 'normal',
  projects: [
    { key: 'p1', name: 'alpha', fsPath: '/w/alpha', trusted: true, running: 1, waiting: 0 },
    { key: 'p2', name: 'beta', fsPath: '/w/beta', trusted: false, running: 2, waiting: 1, branch: 'main' },
  ],
  selected: { projectKey: 'p1', chatId: 'c1' },
  selectedChat: { id: 'c1', title: 'Fix login', status: 'idle' },
  effectiveTheme: 'dark',
  layout: {
    sidebarVisible: true,
    sidebarWidth: 300,
    sections: { projects: { collapsed: false, size: 150 }, chats: { collapsed: false }, files: { collapsed: false, size: 230 }, search: { collapsed: true, size: 260 } },
    grid: DEFAULT_GRID_LAYOUT,
    search: {},
  },
  layoutRevision: 0,
  shortcuts: { newChat: 'Ctrl+N', toggleSidebar: 'Ctrl+B', settings: 'Ctrl+,', quickOpen: 'Ctrl+P', toggleTerminal: 'Ctrl+`', newTerminal: 'Ctrl+Shift+`', splitTerminal: 'Ctrl+Shift+5', closeEditor: 'Ctrl+W', searchAgain: 'Ctrl+Shift+R', toggleQueryDetails: 'Ctrl+Shift+J', focusNextSearchResult: 'F4',
    editorMenu: { goToDefinition: 'F12', goToReferences: 'Shift+F12', renameSymbol: 'F2', changeAllOccurrences: 'Ctrl+F2', formatDocument: 'Shift+Alt+F', cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', commandPalette: 'Ctrl+Shift+P' } },
  notifications: { unseen: 0, doNotDisturb: false, popupsOff: false, attention: 0 },
  search: SEARCH_SETTINGS,
};

export function chat(overrides: Partial<ShellChat> & { id: string }): ShellChat {
  return { title: overrides.id, timestamp: Date.now(), status: 'idle', loaded: false, ...overrides };
}

export const TERMINAL_STATE: TerminalState = {
  terminals: [],
  groups: [],
  activeId: null,
  listWidthRem: 190 / 16,
  settings: { fontSize: 13, scrollback: 1000, cursorStyle: 'block', fontFamily: '', lineHeight: 1.2, cursorBlinking: false, macOptionIsMeta: false, decorationsEnabled: true },
  canCreate: true,
  passKeys: ['CmdOrCtrl+P', 'CmdOrCtrl+Shift+P', 'Ctrl+`', 'CmdOrCtrl+B', 'CmdOrCtrl+,', 'CmdOrCtrl+N', 'F6', 'Shift+F6'],
  profiles: [],
  screenReader: false,
  windowsBuild: 0,
};

export type FakeTerminalApi = DamoclesTerminalApi & {
  // main's terminal pushes
  pushState: (state: TerminalState) => void;
  data: (data: TerminalData) => void;
  focus: (id: string) => void;
  startRename: (id: string) => void;
  requestPaste: (id: string) => void;
  revealInFiles: (file: FileRef) => void;
  runAction: (request: TerminalRunAction) => void;
};

export function fakeTerminalApi(state: TerminalState = TERMINAL_STATE): FakeTerminalApi {
  const states = emitter<TerminalState>();
  const data = emitter<TerminalData>();
  const focus = emitter<string>();
  const startRename = emitter<string>();
  const requestPaste = emitter<string>();
  const revealInFiles = emitter<FileRef>();
  const runAction = emitter<TerminalRunAction>();
  return {
    getState: vi.fn(async () => state),
    onState: vi.fn(states.listen),
    onData: vi.fn(data.listen),
    onFocus: vi.fn(focus.listen),
    onStartRename: vi.fn(startRename.listen),
    onRequestPaste: vi.fn(requestPaste.listen),
    onRevealInFiles: vi.fn(revealInFiles.listen),
    onRunAction: vi.fn(runAction.listen),
    create: vi.fn(async () => ({ ok: true as const, id: 'term-1' })),
    openNew: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    ack: vi.fn(),
    kill: vi.fn(),
    restart: vi.fn(),
    select: vi.fn(),
    setListWidth: vi.fn(),
    paste: vi.fn(),
    reportInputFocus: vi.fn(),
    resolveLinks: vi.fn(async (request: { paths: readonly string[] }) => request.paths.map(() => null)),
    openLink: vi.fn(),
    rename: vi.fn(),
    pickIcon: vi.fn(),
    pickColor: vi.fn(),
    selectDefaultProfile: vi.fn(),
    addToChat: vi.fn(),
    split: vi.fn(),
    unsplit: vi.fn(),
    resizePanes: vi.fn(),
    pushState: states.emit,
    data: data.emit,
    focus: focus.emit,
    startRename: startRename.emit,
    requestPaste: requestPaste.emit,
    revealInFiles: revealInFiles.emit,
    runAction: runAction.emit,
  };
}

export type FakeShellApi = DamoclesShellApi & {
  terminal: FakeTerminalApi;
  push: (state: ShellState) => void;
  chatsChanged: (projectKey: string) => void;
  focusPart: (part: ShellFocusPart) => void;
  // answers the next requestOverlay call; unanswered requests resolve dismissed
  answerNext: (answer: OverlayAnswer) => void;
  overlayRequests: OverlayRequest[];
  // main's update state push
  pushUpdate: (snapshot: UpdateSnapshot) => void;
  // main's editor pane and Files pushes
  pushEditorState: (state: ShellEditorState) => void;
  documentChanged: (change: EditorDocumentChange) => void;
  editorCommand: (command: EditorCommand) => void;
  editorFlush: (request: EditorFlushRequest) => void;
  editorFocus: (tabId: string) => void;
  editorReveal: (reveal: EditorReveal) => void;
  filesChanged: (change: FilesChanged) => void;
  // main's Search pushes
  searchResults: (batch: SearchResultsBatch) => void;
  searchDone: (done: SearchDone) => void;
  searchFocus: (focus: SearchFocus) => void;
  searchFileUpdate: (update: SearchFileUpdate) => void;
  searchCommand: (message: SearchCommandMessage) => void;
  searchEditorHighlights: (highlights: SearchEditorHighlights) => void;
};

export const EDITOR_STATE: ShellEditorState = {
  tabs: [],
  activeTabId: null,
  settings: { fontSize: 13, tabSize: 4, detectIndentation: true, wordWrap: 'off', minimap: true, renderWhitespace: 'selection', autoSave: 'off', formatOnSave: false },
  documents: {},
};

export function emitter<T>(): { listen: (listener: (value: T) => void) => () => void; emit: (value: T) => void } {
  const listeners = new Set<(value: T) => void>();
  return {
    listen: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: (value) => { for (const listener of listeners) listener(value); },
  };
}

export const DISABLED_UPDATE: UpdateSnapshot = { state: { kind: 'disabled' }, lastCheckedAt: null, platform: 'win32' };

export function fakeShellApi(chats: readonly ShellChat[] = [], overrides: Partial<Omit<DamoclesShellApi, 'terminal'>> = {}): FakeShellApi {
  const stateListeners = new Set<(s: ShellState) => void>();
  const changedListeners = new Set<(key: string) => void>();
  const focusListeners = new Set<(part: ShellFocusPart) => void>();
  const answers: OverlayAnswer[] = [];
  const overlayRequests: OverlayRequest[] = [];
  const updateListeners = new Set<(s: UpdateSnapshot) => void>();
  const editorState = emitter<ShellEditorState>();
  const documentChanged = emitter<EditorDocumentChange>();
  const editorCommand = emitter<EditorCommand>();
  const editorFlush = emitter<EditorFlushRequest>();
  const editorFocus = emitter<string>();
  const editorReveal = emitter<EditorReveal>();
  const filesChanged = emitter<FilesChanged>();
  const searchResults = emitter<SearchResultsBatch>();
  const searchDone = emitter<SearchDone>();
  const searchFocus = emitter<SearchFocus>();
  const searchFileUpdate = emitter<SearchFileUpdate>();
  const searchCommand = emitter<SearchCommandMessage>();
  const searchEditorHighlights = emitter<SearchEditorHighlights>();
  const list = (projectKey: string): ShellChatList => ({
    projectKey,
    chats,
    tags: [...new Set(chats.flatMap((c) => (c.tag ? [c.tag] : [])))].sort(),
  });
  return {
    getState: vi.fn(async () => STATE),
    onState: vi.fn((listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); }),
    addProject: vi.fn(async () => {}),
    removeProject: vi.fn(async () => ({ ok: true as const })),
    selectProject: vi.fn(async () => {}),
    grantTrust: vi.fn(async () => {}),
    listChats: vi.fn(async (projectKey: string, _stateRevision: number): Promise<ShellChatList | null> => list(projectKey)),
    searchChats: vi.fn(async (projectKey: string, query: string, _stateRevision: number): Promise<ShellChatList | null> => ({ ...list(projectKey), chats: chats.filter((c) => c.title.includes(query)) })),
    onChatsChanged: vi.fn((listener) => { changedListeners.add(listener); return () => changedListeners.delete(listener); }),
    selectChat: vi.fn(async () => ({ ok: true as const })),
    newChat: vi.fn(async () => {}),
    renameChat: vi.fn(async () => ({ ok: true as const })),
    tagChat: vi.fn(async () => ({ ok: true as const })),
    deleteChat: vi.fn(async () => ({ ok: true as const })),
    requestOverlay: vi.fn(async (request: OverlayRequest) => {
      overlayRequests.push(request);
      return answers.shift() ?? { kind: 'dismissed' as const };
    }),
    openAppMenu: vi.fn(async () => {}),
    toggleTheme: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    toggleSidebar: vi.fn(async () => {}),
    showSidebar: vi.fn(async () => {}),
    windowControl: vi.fn(async () => {}),
    reportContentBounds: vi.fn(),
    reportSidebarLayout: vi.fn(),
    reportGridSizes: vi.fn(),
    reportFocusedPart: vi.fn(),
    onFocusPart: vi.fn((listener) => { focusListeners.add(listener); return () => focusListeners.delete(listener); }),
    getUpdate: vi.fn(async () => DISABLED_UPDATE),
    onUpdate: vi.fn((listener) => { updateListeners.add(listener); return () => updateListeners.delete(listener); }),
    runUpdateAction: vi.fn(async () => {}),
    layoutMove: vi.fn(async () => {}),
    toggleEditor: vi.fn(async () => {}),
    toggleTerminal: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    getEditorState: vi.fn(async () => EDITOR_STATE),
    onEditorState: vi.fn(editorState.listen),
    getDocument: vi.fn(async (documentId: string) => ({ kind: 'notDisplayed' as const, documentId, reason: 'unreadable' as const })),
    onDocumentChanged: vi.fn(documentChanged.listen),
    openEditor: vi.fn(async () => ({ ok: true as const, tabId: 't1' })),
    editorTab: vi.fn(async () => {}),
    reportEdit: vi.fn(),
    saveDocument: vi.fn(async () => ({ ok: true as const })),
    saveDocumentAs: vi.fn(async () => ({ ok: true as const })),
    resolveConflict: vi.fn(async () => ({ ok: true as const })),
    formatDocument: vi.fn(async () => ({ kind: 'skipped' as const })),
    reportFormatFailure: vi.fn(),
    reportSelection: vi.fn(),
    mentionTab: vi.fn(async () => {}),
    setFocusOverlay: vi.fn(async () => {}),
    onEditorCommand: vi.fn(editorCommand.listen),
    onEditorFlush: vi.fn(editorFlush.listen),
    editorFlushed: vi.fn(),
    onEditorFocus: vi.fn(editorFocus.listen),
    onEditorReveal: vi.fn(editorReveal.listen),
    browserAction: vi.fn(async () => {}),
    navigateBrowser: vi.fn(async () => true),
    reportBrowserBounds: vi.fn(),
    listFiles: vi.fn(async () => ({ ok: true as const, entries: [] })),
    createFile: vi.fn(async () => ({ ok: true as const, relativePath: 'new.ts' })),
    renameFile: vi.fn(async () => ({ ok: true as const, relativePath: 'renamed.ts' })),
    deleteFile: vi.fn(async () => ({ ok: true as const })),
    copyFilePath: vi.fn(async () => {}),
    revealFile: vi.fn(async () => {}),
    mentionFile: vi.fn(async () => {}),
    onFilesChanged: vi.fn(filesChanged.listen),
    openQuickOpen: vi.fn(async () => {}),
    showCommands: vi.fn(async () => {}),
    reportDropZonesPointer: vi.fn(),
    startSearch: vi.fn(async () => ({ ok: true as const })),
    cancelSearch: vi.fn(async () => {}),
    clearSearch: vi.fn(async () => {}),
    dismissSearch: vi.fn(async () => {}),
    copySearchResults: vi.fn(async () => {}),
    findInFolder: vi.fn(async () => {}),
    onSearchResults: vi.fn(searchResults.listen),
    onSearchFileUpdate: vi.fn(searchFileUpdate.listen),
    onSearchDone: vi.fn(searchDone.listen),
    onSearchFocus: vi.fn(searchFocus.listen),
    onSearchCommand: vi.fn(searchCommand.listen),
    openSearchEditor: vi.fn(async () => ({ tabId: 't-search' })),
    setSearchEditorConfig: vi.fn(async () => {}),
    runSearchEditor: vi.fn(async () => {}),
    openSearchEditorResult: vi.fn(async () => ({ ok: true as const, tabId: 't-result' })),
    onSearchEditorHighlights: vi.fn(searchEditorHighlights.listen),
    confirmReplace: vi.fn(async () => true),
    replaceInFiles: vi.fn(async () => ({ replacedFiles: 0, replacedCount: 0, skipped: [] })),
    previewReplace: vi.fn(async () => ({ ok: true as const })),
    terminal: fakeTerminalApi(),
    push: (state) => { for (const l of stateListeners) l(state); },
    chatsChanged: (key) => { for (const l of changedListeners) l(key); },
    focusPart: (part) => { for (const l of focusListeners) l(part); },
    answerNext: (answer) => { answers.push(answer); },
    overlayRequests,
    pushUpdate: (snapshot) => { for (const l of updateListeners) l(snapshot); },
    pushEditorState: editorState.emit,
    documentChanged: documentChanged.emit,
    editorCommand: editorCommand.emit,
    editorFlush: editorFlush.emit,
    editorFocus: editorFocus.emit,
    editorReveal: editorReveal.emit,
    filesChanged: filesChanged.emit,
    searchResults: searchResults.emit,
    searchDone: searchDone.emit,
    searchFocus: searchFocus.emit,
    searchFileUpdate: searchFileUpdate.emit,
    searchCommand: searchCommand.emit,
    searchEditorHighlights: searchEditorHighlights.emit,
    ...overrides,
  };
}

export type FakeOverlayApi = DamoclesOverlayApi & {
  request: (id: string, request: OverlayRequest) => void;
  cancel: (id: string) => void;
  toast: (toast: OverlayToast) => void;
  dismissToast: (id: string) => void;
  // main's F6 toast stop
  focusToasts: () => void;
  pushState: (state: OverlayState) => void;
  // main's side of the settings attachment
  settingsMessage: (message: ExtensionToWebviewMessage) => void;
  settingsAttached: (generation: number) => void;
  settingsTarget: (target: SettingsTarget) => void;
  prefsChanged: (prefs: OverlayPrefs) => void;
  // main's center: what getNotifications answers, and a push while the center is open
  center: { state: NotificationCenterState };
  pushNotifications: (state: NotificationCenterState) => void;
  // main's rasterize request
  rasterizeRequest: (request: OverlayRasterRequest) => void;
  // main's chime for a popup
  chime: (tone: ChimeTone) => void;
  // main's update state push while the settings modal is open
  pushUpdate: (snapshot: UpdateSnapshot) => void;
  // what getReleaseIndex answers, and getReleaseNotes per version
  releases: { index: ReleaseIndex; notes: Record<string, string> };
  // main's answer to each queryQuickOpen, and the shell's forwarded pane drag
  quickOpen: { answer: (query: QuickOpenQuery) => QuickOpenResponse };
  // what listCommands answers
  commands: { list: PaletteCommand[] };
  // what getTerminalProfiles answers, and main's push after it validates the profiles again
  terminalProfiles: { report: TerminalProfileReport };
  pushTerminalProfiles: (report: TerminalProfileReport) => void;
  dropZonesPointer: (pointer: DropZonesPointer) => void;
};

export const VERSION_INFO: VersionInfo = { version: '3.4.0', packaged: false, platform: 'win32', arch: 'x64', electron: '38.0.0', chromium: '140.0.0.0', node: '22.19.0' };

export function fakeOverlayApi(): FakeOverlayApi {
  const requestListeners = new Set<(id: string, request: OverlayRequest) => void>();
  const cancelListeners = new Set<(id: string) => void>();
  const toastListeners = new Set<(toast: OverlayToast) => void>();
  const dismissListeners = new Set<(id: string) => void>();
  const toastsFocusListeners = new Set<() => void>();
  const stateListeners = new Set<(state: OverlayState) => void>();
  const settingsListeners = new Set<(message: ExtensionToWebviewMessage) => void>();
  const attachedListeners = new Set<(attached: { generation: number }) => void>();
  const targetListeners = new Set<(target: SettingsTarget) => void>();
  const prefsListeners = new Set<(prefs: OverlayPrefs) => void>();
  const notificationListeners = new Set<(state: NotificationCenterState) => void>();
  const rasterizeListeners = new Set<(request: OverlayRasterRequest) => void>();
  const chimeListeners = new Set<(tone: ChimeTone) => void>();
  const updateListeners = new Set<(snapshot: UpdateSnapshot) => void>();
  const releases = { index: { current: '3.4.0', versions: [{ version: '3.4.0', date: '2026-10-05' }, { version: '3.3.0', date: '2026-10-03' }] } as ReleaseIndex, notes: {} as Record<string, string> };
  const center: { state: NotificationCenterState } = { state: { entries: [], doNotDisturb: false, popupsOff: false } };
  const quickOpen = { answer: (query: QuickOpenQuery): QuickOpenResponse => ({ generation: query.generation, mention: false, results: [] }) };
  const pointer = emitter<DropZonesPointer>();
  const commands: { list: PaletteCommand[] } = { list: [] };
  const terminalProfiles: { report: TerminalProfileReport } = { report: { profiles: [], hidden: [], problems: [] } };
  const profilesChanged = emitter<TerminalProfileReport>();
  return {
    getState: vi.fn(async () => ({ locale: 'en' as const, platform: 'win32' as const })),
    onState: vi.fn((listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); }),
    onRequest: vi.fn((listener) => { requestListeners.add(listener); return () => requestListeners.delete(listener); }),
    onCancel: vi.fn((listener) => { cancelListeners.add(listener); return () => cancelListeners.delete(listener); }),
    ack: vi.fn(),
    answer: vi.fn(),
    onToast: vi.fn((listener) => { toastListeners.add(listener); return () => toastListeners.delete(listener); }),
    onToastDismiss: vi.fn((listener) => { dismissListeners.add(listener); return () => dismissListeners.delete(listener); }),
    resolveToast: vi.fn(),
    reportToastArea: vi.fn(),
    reportToastPointer: vi.fn(),
    onToastsFocus: vi.fn((listener) => { toastsFocusListeners.add(listener); return () => toastsFocusListeners.delete(listener); }),
    leaveToasts: vi.fn(),
    holdToast: vi.fn(),
    getNotifications: vi.fn(async () => center.state),
    onNotifications: vi.fn((listener) => { notificationListeners.add(listener); return () => notificationListeners.delete(listener); }),
    clearNotifications: vi.fn(async () => {}),
    setDoNotDisturb: vi.fn(async () => {}),
    onRasterize: vi.fn((listener) => { rasterizeListeners.add(listener); return () => rasterizeListeners.delete(listener); }),
    rasterized: vi.fn(),
    onChime: vi.fn((listener) => { chimeListeners.add(listener); return () => chimeListeners.delete(listener); }),
    settingsSend: vi.fn(),
    onSettingsMessage: vi.fn((listener) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener); }),
    onSettingsAttached: vi.fn((listener) => { attachedListeners.add(listener); return () => attachedListeners.delete(listener); }),
    onSettingsTarget: vi.fn((listener) => { targetListeners.add(listener); return () => targetListeners.delete(listener); }),
    getPrefs: vi.fn(async (): Promise<OverlayPrefs> => ({ values: { 'damocles.desktop.theme': 'system', 'damocles.desktop.language': 'system' }, languageAtLaunch: 'system' })),
    onPrefsChanged: vi.fn((listener) => { prefsListeners.add(listener); return () => prefsListeners.delete(listener); }),
    setPref: vi.fn(async () => ({ ok: true as const, file: '/home/u/.damocles/settings.json' })),
    relaunch: vi.fn(async () => {}),
    resetLayout: vi.fn(async () => {}),
    getUpdate: vi.fn(async () => DISABLED_UPDATE),
    onUpdate: vi.fn((listener) => { updateListeners.add(listener); return () => updateListeners.delete(listener); }),
    checkForUpdates: vi.fn(async () => {}),
    restartToUpdate: vi.fn(async () => {}),
    showUpdateLog: vi.fn(async () => {}),
    copyVersionInfo: vi.fn(async () => {}),
    getVersionInfo: vi.fn(async () => VERSION_INFO),
    openReleasePage: vi.fn(async () => {}),
    getReleaseIndex: vi.fn(async () => releases.index),
    getReleaseNotes: vi.fn(async (version: string) => ({ version, markdown: releases.notes[version] ?? '' })),
    queryQuickOpen: vi.fn(async (query: QuickOpenQuery) => quickOpen.answer(query)),
    listCommands: vi.fn(async () => commands.list),
    getTerminalProfiles: vi.fn(async (): Promise<TerminalProfileReport> => terminalProfiles.report),
    onTerminalProfiles: vi.fn(profilesChanged.listen),
    onDropZonesPointer: vi.fn(pointer.listen),
    request: (id, request) => { for (const l of requestListeners) l(id, request); },
    cancel: (id) => { for (const l of cancelListeners) l(id); },
    toast: (toast) => { for (const l of toastListeners) l(toast); },
    dismissToast: (id) => { for (const l of dismissListeners) l(id); },
    focusToasts: () => { for (const l of toastsFocusListeners) l(); },
    pushState: (state) => { for (const l of stateListeners) l(state); },
    settingsMessage: (message) => { for (const l of settingsListeners) l(message); },
    settingsAttached: (generation) => { for (const l of attachedListeners) l({ generation }); },
    settingsTarget: (target) => { for (const l of targetListeners) l(target); },
    prefsChanged: (prefs) => { for (const l of prefsListeners) l(prefs); },
    center,
    pushNotifications: (state) => { center.state = state; for (const l of notificationListeners) l(state); },
    rasterizeRequest: (request) => { for (const l of rasterizeListeners) l(request); },
    chime: (tone) => { for (const l of chimeListeners) l(tone); },
    pushUpdate: (snapshot) => { for (const l of updateListeners) l(snapshot); },
    releases,
    quickOpen,
    commands,
    terminalProfiles,
    pushTerminalProfiles: (report) => { terminalProfiles.report = report; profilesChanged.emit(report); },
    dropZonesPointer: pointer.emit,
  };
}

export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element): void {
    this.observed.push(element);
  }
  unobserve(): void {}
  disconnect(): void {
    this.observed = [];
  }
}
