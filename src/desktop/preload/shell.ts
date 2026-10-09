import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { applyHostTheme } from './apply-theme';
import type { PanelTheme } from './panel-channels';
import type { OverlayAnswer } from './overlay-channels';
import {
  SHELL_CHANNELS,
  type ChatMutationResult,
  type EditorCommand,
  type EditorConflictResult,
  type EditorDocumentChange,
  type EditorFlushRequest,
  type EditorFormatReply,
  type EditorOpenResult,
  type EditorReveal,
  type EditorSaveResult,
  type FileRef,
  type FilesChanged,
  type FilesDeleteResult,
  type FilesListResult,
  type FilesMutationResult,
  type SearchCommandMessage,
  type SearchDone,
  type SearchEditorConfig,
  type SearchEditorHighlights,
  type SearchEditorOpenResult,
  type SearchFileKey,
  type SearchFileUpdate,
  type SearchFocus,
  type SearchPreviewResult,
  type SearchQuery,
  type SearchReplaceResult,
  type SearchResultsBatch,
  type SearchStartResult,
  type ContentBounds,
  type DamoclesShellApi,
  type SelectChatResult,
  type ShellChatList,
  type ShellDocumentContent,
  type ShellEditorState,
  type ShellFocusPart,
  type ShellState,
} from './shell-channels';
import type { UpdateSnapshot } from './updates';
import {
  TERMINAL_CHANNELS,
  type DamoclesTerminalApi,
  type TerminalCreateResult,
  type TerminalData,
  type TerminalLinkKind,
  type TerminalRunAction,
  type TerminalState,
} from './terminal-channels';

function queryOf(query: SearchQuery): SearchQuery {
  return {
    pattern: query.pattern,
    isRegex: query.isRegex,
    matchCase: query.matchCase,
    wholeWord: query.wholeWord,
    include: query.include,
    exclude: query.exclude,
    useExcludeSettingsAndIgnoreFiles: query.useExcludeSettingsAndIgnoreFiles,
    onlyOpenEditors: query.onlyOpenEditors,
  };
}

function fileKeysOf(files: readonly SearchFileKey[]): SearchFileKey[] {
  return files.map((key) => (key.kind === 'file' ? { kind: 'file', relativePath: key.relativePath } : { kind: 'untitled', documentId: key.documentId }));
}

const SEARCH_EDITOR_CONFIG_KEYS = ['query', 'isRegex', 'matchCase', 'wholeWord', 'include', 'exclude', 'useExcludeSettingsAndIgnoreFiles', 'onlyOpenEditors', 'contextLines', 'showIncludesExcludes'] as const;

// The config's own fields and nothing else; a partial one keeps only those it sets.
function searchEditorConfigOf<T extends Partial<SearchEditorConfig>>(config: T): T {
  const copy: Record<string, unknown> = {};
  for (const key of SEARCH_EDITOR_CONFIG_KEYS) if (config[key] !== undefined) copy[key] = config[key];
  return copy as T;
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const terminal: DamoclesTerminalApi = {
  getState: () => ipcRenderer.invoke(TERMINAL_CHANNELS.getState) as Promise<TerminalState>,
  onState: (listener) => subscribe<TerminalState>(TERMINAL_CHANNELS.state, listener),
  onData: (listener) => subscribe<TerminalData>(TERMINAL_CHANNELS.data, listener),
  onFocus: (listener) => subscribe<{ id: string }>(TERMINAL_CHANNELS.focus, (message) => listener(message.id)),
  onStartRename: (listener) => subscribe<{ id: string }>(TERMINAL_CHANNELS.startRename, (message) => listener(message.id)),
  onRequestPaste: (listener) => subscribe<{ id: string }>(TERMINAL_CHANNELS.requestPaste, (message) => listener(message.id)),
  onRevealInFiles: (listener) => subscribe<FileRef>(TERMINAL_CHANNELS.revealInFiles, listener),
  onRunAction: (listener) => subscribe<TerminalRunAction>(TERMINAL_CHANNELS.runAction, listener),
  create: (request) => ipcRenderer.invoke(TERMINAL_CHANNELS.create, { profileId: request.profileId, projectKey: request.projectKey }) as Promise<TerminalCreateResult>,
  openNew: () => {
    ipcRenderer.send(TERMINAL_CHANNELS.new);
  },
  input: (input) => {
    ipcRenderer.send(TERMINAL_CHANNELS.input, { id: input.id, data: input.data });
  },
  resize: (resize) => {
    ipcRenderer.send(TERMINAL_CHANNELS.resize, { id: resize.id, cols: resize.cols, rows: resize.rows });
  },
  ack: (ack) => {
    ipcRenderer.send(TERMINAL_CHANNELS.ack, { id: ack.id, chars: ack.chars });
  },
  kill: (id) => {
    ipcRenderer.send(TERMINAL_CHANNELS.kill, { id });
  },
  restart: (id) => {
    ipcRenderer.send(TERMINAL_CHANNELS.restart, { id });
  },
  select: (id) => {
    ipcRenderer.send(TERMINAL_CHANNELS.select, { id });
  },
  split: (id) => {
    ipcRenderer.send(TERMINAL_CHANNELS.split, { id });
  },
  unsplit: (id) => {
    ipcRenderer.send(TERMINAL_CHANNELS.unsplit, { id });
  },
  resizePanes: (request) => {
    ipcRenderer.send(TERMINAL_CHANNELS.resizePanes, { groupId: request.groupId, sizes: [...request.sizes] });
  },
  setListWidth: (rem) => {
    ipcRenderer.send(TERMINAL_CHANNELS.listWidth, { rem });
  },
  paste: (request) => {
    ipcRenderer.send(TERMINAL_CHANNELS.paste, { id: request.id, bracketedPasteMode: request.bracketedPasteMode, source: request.source });
  },
  reportInputFocus: (focused) => {
    ipcRenderer.send(TERMINAL_CHANNELS.inputFocus, { focused });
  },
  resolveLinks: (request) => ipcRenderer.invoke(TERMINAL_CHANNELS.resolveLinks, { id: request.id, paths: [...request.paths] }) as Promise<Array<TerminalLinkKind | null>>,
  openLink: (request) => {
    ipcRenderer.send(TERMINAL_CHANNELS.openLink, { id: request.id, path: request.path, line: request.line, column: request.column });
  },
  rename: (request) => {
    ipcRenderer.send(TERMINAL_CHANNELS.rename, { id: request.id, name: request.name });
  },
  pickIcon: (id) => {
    ipcRenderer.send(TERMINAL_CHANNELS.pickIcon, { id });
  },
  pickColor: (id) => {
    ipcRenderer.send(TERMINAL_CHANNELS.pickColor, { id });
  },
  selectDefaultProfile: () => {
    ipcRenderer.send(TERMINAL_CHANNELS.selectDefaultProfile);
  },
  addToChat: (request) => {
    ipcRenderer.send(TERMINAL_CHANNELS.addToChat, { id: request.id, source: request.source, commandId: request.commandId, text: request.text, omittedLines: request.omittedLines });
  },
};

// The shell HTML carries the theme from its creation; this keeps it current after a theme change.
ipcRenderer.on(SHELL_CHANNELS.theme, (_event, theme: PanelTheme) => applyHostTheme(theme));

const api: DamoclesShellApi = {
  getState: () => ipcRenderer.invoke(SHELL_CHANNELS.getState) as Promise<ShellState>,
  onState: (listener) => subscribe<ShellState>(SHELL_CHANNELS.state, listener),
  addProject: () => ipcRenderer.invoke(SHELL_CHANNELS.addProject) as Promise<void>,
  removeProject: (key) => ipcRenderer.invoke(SHELL_CHANNELS.removeProject, key) as ReturnType<DamoclesShellApi['removeProject']>,
  selectProject: (key) => ipcRenderer.invoke(SHELL_CHANNELS.selectProject, key) as Promise<void>,
  grantTrust: (key) => ipcRenderer.invoke(SHELL_CHANNELS.grantTrust, key) as Promise<void>,
  listChats: (projectKey, stateRevision) => ipcRenderer.invoke(SHELL_CHANNELS.chatsList, projectKey, stateRevision) as Promise<ShellChatList | null>,
  searchChats: (projectKey, query, stateRevision) => ipcRenderer.invoke(SHELL_CHANNELS.chatsSearch, projectKey, query, stateRevision) as Promise<ShellChatList | null>,
  onChatsChanged: (listener) => subscribe<string>(SHELL_CHANNELS.chatsChanged, listener),
  selectChat: (chatId) => ipcRenderer.invoke(SHELL_CHANNELS.chatsSelect, chatId) as Promise<SelectChatResult>,
  newChat: (projectKey) => ipcRenderer.invoke(SHELL_CHANNELS.chatsNew, projectKey) as Promise<void>,
  renameChat: (chatId, name) => ipcRenderer.invoke(SHELL_CHANNELS.chatsRename, chatId, name) as Promise<ChatMutationResult>,
  tagChat: (chatId, tag) => ipcRenderer.invoke(SHELL_CHANNELS.chatsTag, chatId, tag) as Promise<ChatMutationResult>,
  deleteChat: (chatId) => ipcRenderer.invoke(SHELL_CHANNELS.chatsDelete, chatId) as Promise<ChatMutationResult>,
  requestOverlay: (request) => ipcRenderer.invoke(SHELL_CHANNELS.overlayRequest, request) as Promise<OverlayAnswer>,
  openAppMenu: (anchor) => ipcRenderer.invoke(SHELL_CHANNELS.appMenu, { x: anchor.x, y: anchor.y }) as Promise<void>,
  toggleTheme: () => ipcRenderer.invoke(SHELL_CHANNELS.toggleTheme) as Promise<void>,
  toggleSidebar: () => ipcRenderer.invoke(SHELL_CHANNELS.toggleSidebar) as Promise<void>,
  showSidebar: () => ipcRenderer.invoke(SHELL_CHANNELS.showSidebar) as Promise<void>,
  windowControl: (control) => ipcRenderer.invoke(SHELL_CHANNELS.windowControl, control) as Promise<void>,
  openSettings: (section) => ipcRenderer.invoke(SHELL_CHANNELS.openSettings, section) as Promise<void>,
  reportContentBounds: (bounds: ContentBounds) => {
    ipcRenderer.send(SHELL_CHANNELS.contentBounds, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  },
  reportSidebarLayout: (layout) => {
    ipcRenderer.send(SHELL_CHANNELS.sidebarLayout, { sidebarWidth: layout.sidebarWidth, sections: layout.sections, search: layout.search });
  },
  reportGridSizes: (sizes) => {
    ipcRenderer.send(SHELL_CHANNELS.gridSizes, { sideWidth: sizes.sideWidth, bottomHeight: sizes.bottomHeight });
  },
  reportFocusedPart: (part) => {
    ipcRenderer.send(SHELL_CHANNELS.focusedPart, part);
  },
  onFocusPart: (listener) => subscribe<ShellFocusPart>(SHELL_CHANNELS.focusPart, listener),
  layoutMove: (pane, slot) => ipcRenderer.invoke(SHELL_CHANNELS.layoutMove, { pane, slot }) as Promise<void>,
  toggleEditor: () => ipcRenderer.invoke(SHELL_CHANNELS.toggleEditor) as Promise<void>,
  toggleTerminal: () => ipcRenderer.invoke(SHELL_CHANNELS.toggleTerminal) as Promise<void>,
  toggleMaximize: (pane) => ipcRenderer.invoke(SHELL_CHANNELS.toggleMaximize, { pane }) as Promise<void>,
  getEditorState: () => ipcRenderer.invoke(SHELL_CHANNELS.editorGetState) as Promise<ShellEditorState>,
  onEditorState: (listener) => subscribe<ShellEditorState>(SHELL_CHANNELS.editorState, listener),
  getDocument: (documentId) => ipcRenderer.invoke(SHELL_CHANNELS.editorGetDocument, { documentId }) as Promise<ShellDocumentContent>,
  onDocumentChanged: (listener) => subscribe<EditorDocumentChange>(SHELL_CHANNELS.editorDocumentChanged, listener),
  openEditor: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.editorOpen, {
      projectKey: request.projectKey,
      relativePath: request.relativePath,
      line: request.line,
      as: request.as,
      preserveFocus: request.preserveFocus,
      toSide: request.toSide,
    }) as Promise<EditorOpenResult>,
  editorTab: (request) => ipcRenderer.invoke(SHELL_CHANNELS.editorTab, { action: request.action, tabId: request.tabId }) as Promise<void>,
  reportEdit: (edit) => {
    ipcRenderer.send(SHELL_CHANNELS.editorEdit, { documentId: edit.documentId, version: edit.version, seq: edit.seq, text: edit.text, overReload: edit.overReload });
  },
  saveDocument: (request) => ipcRenderer.invoke(SHELL_CHANNELS.editorSave, { documentId: request.documentId, version: request.version, text: request.text }) as Promise<EditorSaveResult>,
  saveDocumentAs: (request) => ipcRenderer.invoke(SHELL_CHANNELS.editorSaveAs, { documentId: request.documentId, version: request.version, text: request.text }) as Promise<EditorSaveResult>,
  resolveConflict: (request) => ipcRenderer.invoke(SHELL_CHANNELS.editorConflict, { documentId: request.documentId, action: request.action }) as Promise<EditorConflictResult>,
  formatDocument: (request) => ipcRenderer.invoke(SHELL_CHANNELS.editorFormat, {
    documentId: request.documentId,
    text: request.text,
    options: { tabSize: request.options.tabSize, insertSpaces: request.options.insertSpaces },
    reason: request.reason,
  }) as Promise<EditorFormatReply>,
  reportFormatFailure: (failure) => {
    ipcRenderer.send(SHELL_CHANNELS.editorFormatFailed, { documentId: failure.documentId, reason: failure.reason, timedOut: failure.timedOut, message: failure.message });
  },
  reportSelection: (report) => {
    const range = report.selection;
    const selection = range ? { startLine: range.startLine, startColumn: range.startColumn, endLine: range.endLine, endColumn: range.endColumn } : null;
    ipcRenderer.send(SHELL_CHANNELS.editorSelection, { documentId: report.documentId, selection });
  },
  mentionTab: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.editorMention, { tabId }) as Promise<void>,
  setFocusOverlay: (open) => ipcRenderer.invoke(SHELL_CHANNELS.editorFocusOverlay, { open }) as Promise<void>,
  onEditorCommand: (listener) => subscribe<EditorCommand>(SHELL_CHANNELS.editorCommand, listener),
  onEditorFlush: (listener) => subscribe<EditorFlushRequest>(SHELL_CHANNELS.editorFlush, (message) => listener({ requestId: message.requestId, format: [...message.format] })),
  editorFlushed: (requestId) => {
    ipcRenderer.send(SHELL_CHANNELS.editorFlushed, { requestId });
  },
  onEditorFocus: (listener) => subscribe<{ tabId: string }>(SHELL_CHANNELS.editorFocus, (message) => listener(message.tabId)),
  onEditorReveal: (listener) => subscribe<EditorReveal>(SHELL_CHANNELS.editorReveal, listener),
  browserAction: (request) => ipcRenderer.invoke(SHELL_CHANNELS.browserAction, { tabId: request.tabId, action: request.action }) as Promise<void>,
  navigateBrowser: (request) => ipcRenderer.invoke(SHELL_CHANNELS.browserNavigate, { tabId: request.tabId, url: request.url }) as Promise<boolean>,
  reportBrowserBounds: (area) => {
    ipcRenderer.send(SHELL_CHANNELS.browserBounds, area ? { x: area.x, y: area.y, width: area.width, height: area.height, radius: area.radius } : null);
  },
  listFiles: (request) => ipcRenderer.invoke(SHELL_CHANNELS.filesList, { projectKey: request.projectKey, relativeDir: request.relativeDir, report: request.report === true }) as Promise<FilesListResult>,
  createFile: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.filesCreate, { projectKey: request.projectKey, relativeDir: request.relativeDir, name: request.name, kind: request.kind }) as Promise<FilesMutationResult>,
  renameFile: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.filesRename, { projectKey: request.projectKey, relativePath: request.relativePath, newName: request.newName }) as Promise<FilesMutationResult>,
  deleteFile: (file) => ipcRenderer.invoke(SHELL_CHANNELS.filesDelete, { projectKey: file.projectKey, relativePath: file.relativePath }) as Promise<FilesDeleteResult>,
  copyFilePath: (file, relative) => ipcRenderer.invoke(SHELL_CHANNELS.filesCopyPath, { projectKey: file.projectKey, relativePath: file.relativePath, relative }) as Promise<void>,
  revealFile: (file) => ipcRenderer.invoke(SHELL_CHANNELS.filesReveal, { projectKey: file.projectKey, relativePath: file.relativePath }) as Promise<void>,
  mentionFile: (file) => ipcRenderer.invoke(SHELL_CHANNELS.filesMention, { projectKey: file.projectKey, relativePath: file.relativePath }) as Promise<void>,
  onFilesChanged: (listener) => subscribe<FilesChanged>(SHELL_CHANNELS.filesChanged, listener),
  openQuickOpen: () => ipcRenderer.invoke(SHELL_CHANNELS.quickOpen) as Promise<void>,
  showCommands: () => ipcRenderer.invoke(SHELL_CHANNELS.showCommands) as Promise<void>,
  reportDropZonesPointer: (pointer) => {
    ipcRenderer.send(SHELL_CHANNELS.dropZonesPointer, { x: pointer.x, y: pointer.y, released: pointer.released });
  },
  startSearch: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.searchStart, { searchId: request.searchId, query: queryOf(request.query), immediate: request.immediate }) as Promise<SearchStartResult>,
  cancelSearch: () => ipcRenderer.invoke(SHELL_CHANNELS.searchCancel, {}) as Promise<void>,
  clearSearch: () => ipcRenderer.invoke(SHELL_CHANNELS.searchClear, {}) as Promise<void>,
  dismissSearch: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.searchDismiss, { searchId: request.searchId, matchIds: [...request.matchIds], files: fileKeysOf(request.files) }) as Promise<void>,
  copySearchResults: (request) => {
    const target = request.target;
    const copied = target.kind === 'matches' ? { kind: target.kind, matchIds: [...target.matchIds] } : target.kind === 'files' ? { kind: target.kind, files: fileKeysOf(target.files) } : { kind: target.kind };
    return ipcRenderer.invoke(SHELL_CHANNELS.searchCopy, { searchId: request.searchId, target: copied }) as Promise<void>;
  },
  findInFolder: (folder) => ipcRenderer.invoke(SHELL_CHANNELS.searchFindInFolder, { projectKey: folder.projectKey, relativePath: folder.relativePath }) as Promise<void>,
  onSearchResults: (listener) => subscribe<SearchResultsBatch>(SHELL_CHANNELS.searchResults, listener),
  onSearchFileUpdate: (listener) => subscribe<SearchFileUpdate>(SHELL_CHANNELS.searchFileUpdate, listener),
  onSearchDone: (listener) => subscribe<SearchDone>(SHELL_CHANNELS.searchDone, listener),
  onSearchFocus: (listener) => subscribe<SearchFocus>(SHELL_CHANNELS.searchFocus, listener),
  onSearchCommand: (listener) => subscribe<SearchCommandMessage>(SHELL_CHANNELS.searchCommand, listener),
  confirmReplace: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.searchConfirmReplace, { occurrences: request.occurrences, files: request.files, replacement: request.replacement }) as Promise<boolean>,
  replaceInFiles: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.searchReplace, { searchId: request.searchId, replacement: request.replacement, preserveCase: request.preserveCase, matchIds: [...request.matchIds] }) as Promise<SearchReplaceResult>,
  previewReplace: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.searchPreview, { searchId: request.searchId, replacement: request.replacement, preserveCase: request.preserveCase, matchIds: [...request.matchIds] }) as Promise<SearchPreviewResult>,
  openSearchEditor: (request) => {
    const payload = request.from === 'viewResults' ? { from: request.from, searchId: request.searchId } : { from: request.from, ...(request.config ? { config: searchEditorConfigOf(request.config) } : {}) };
    return ipcRenderer.invoke(SHELL_CHANNELS.searchEditorOpenNew, payload) as Promise<{ readonly tabId: string }>;
  },
  setSearchEditorConfig: (documentId, config) => ipcRenderer.invoke(SHELL_CHANNELS.searchEditorConfig, { documentId, config: searchEditorConfigOf(config) }) as Promise<void>,
  runSearchEditor: (documentId) => ipcRenderer.invoke(SHELL_CHANNELS.searchEditorRun, { documentId }) as Promise<void>,
  openSearchEditorResult: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.searchEditorOpenResult, { documentId: request.documentId, line: request.line, column: request.column, toSide: request.toSide }) as Promise<SearchEditorOpenResult>,
  onSearchEditorHighlights: (listener) => subscribe<SearchEditorHighlights>(SHELL_CHANNELS.searchEditorHighlights, listener),
  getUpdate: () => ipcRenderer.invoke(SHELL_CHANNELS.updateGet) as Promise<UpdateSnapshot>,
  onUpdate: (listener) => subscribe<UpdateSnapshot>(SHELL_CHANNELS.updateState, listener),
  runUpdateAction: (action) => ipcRenderer.invoke(SHELL_CHANNELS.updateRun, action) as Promise<void>,
  terminal,
};

contextBridge.exposeInMainWorld('damoclesShell', api);
