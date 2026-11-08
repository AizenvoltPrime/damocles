import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { applyHostTheme } from './apply-theme';
import type { PanelTheme } from './panel-channels';
import type { OverlayAnswer } from './overlay-channels';
import {
  SHELL_CHANNELS,
  type ChatMutationResult,
  type ChatsWorktreeOptions,
  type ShownFolder,
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
  type FilesClipboardChanged,
  type FilesDeleteResult,
  type FilesListResult,
  type FilesMutationResult,
  type FilesPasteResult,
  type FilesTransferProgress,
  type FilesTransferStartResult,
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
  type DesignReplayProgress,
  type DesignFreeze,
  type DesignMarkupSent,
  type DesignPreviewClosed,
  type SelectChatResult,
  type ShellChatList,
  type ShellDocumentContent,
  type ShellEditorState,
  type ShellFocusPart,
  type ShellState,
} from './shell-channels';
import type { UpdateSnapshot } from './updates';
import {
  SCM_CHANNELS,
  type DamoclesScmApi,
  type ScmArtifactsChanged,
  type ScmArtifactsResult,
  type ScmBlameResult,
  type ScmCloneState,
  type ScmCommitInput,
  type ScmCommitResult,
  type ScmDecorations,
  type ScmFileDiffResult,
  type ScmGenerateResult,
  type ScmMergeFileResult,
  type ScmMergeInputsResult,
  type ScmQuickDiffBaseResult,
  type ScmRepoSnapshot,
  type ScmResource,
  type ScmRunResult,
  type ScmSetInput,
  type ScmSettings,
  type ScmShellCommand,
  type ScmShellState,
  type ScmTimelineResult,
  type ScmHistoryResult,
  type ScmCommitDetailsResult,
  type ScmView,
} from './scm-channels';
import { PORTS_CHANNELS, type DamoclesPortsApi, type PortsView } from './ports-channels';
import { REVIEW_CHANNELS, type ChatReviewFileDiffResult, type ChatReviewSendResult, type DamoclesReviewApi } from './review-channels';
import {
  TERMINAL_CHANNELS,
  type DamoclesTerminalApi,
  type TerminalCreateResult,
  type TerminalData,
  type TerminalScreen,
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
  onScreen: (listener) => subscribe<TerminalScreen>(TERMINAL_CHANNELS.screen, listener),
  onFocus: (listener) => subscribe<{ id: string }>(TERMINAL_CHANNELS.focus, (message) => listener(message.id)),
  onStartRename: (listener) => subscribe<{ id: string }>(TERMINAL_CHANNELS.startRename, (message) => listener(message.id)),
  onRequestPaste: (listener) => subscribe<{ id: string }>(TERMINAL_CHANNELS.requestPaste, (message) => listener(message.id)),
  onRevealInFiles: (listener) => subscribe<FileRef>(TERMINAL_CHANNELS.revealInFiles, listener),
  onRunAction: (listener) => subscribe<TerminalRunAction>(TERMINAL_CHANNELS.runAction, listener),
  create: (request) => ipcRenderer.invoke(TERMINAL_CHANNELS.create, { profileId: request.profileId, target: { ...request.target } }) as Promise<TerminalCreateResult>,
  openNew: () => {
    ipcRenderer.send(TERMINAL_CHANNELS.new);
  },
  openNewMenu: (anchor) => ipcRenderer.invoke(TERMINAL_CHANNELS.newMenu, { anchor: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height } }) as Promise<void>,
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
  clear: (id) => {
    ipcRenderer.send(TERMINAL_CHANNELS.clear, { id });
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
  move: (move) => {
    switch (move.kind) {
      case 'reorder':
      case 'join':
        ipcRenderer.send(TERMINAL_CHANNELS.move, { kind: move.kind, id: move.id, target: move.target, side: move.side });
        return;
      case 'detach':
      case 'toEditor':
        ipcRenderer.send(TERMINAL_CHANNELS.move, { kind: move.kind, id: move.id });
        return;
      case 'step':
        ipcRenderer.send(TERMINAL_CHANNELS.move, { kind: move.kind, id: move.id, delta: move.delta });
        return;
    }
  },
  joinPick: (id) => {
    ipcRenderer.send(TERMINAL_CHANNELS.joinPick, { id });
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
  reportInputFocus: (id) => {
    ipcRenderer.send(TERMINAL_CHANNELS.inputFocus, { id });
  },
  resolveLinks: (request) => ipcRenderer.invoke(TERMINAL_CHANNELS.resolveLinks, { id: request.id, paths: [...request.paths] }) as Promise<Array<TerminalLinkKind | null>>,
  openLink: (request) => {
    ipcRenderer.send(TERMINAL_CHANNELS.openLink, { id: request.id, path: request.path, line: request.line, column: request.column });
  },
  openWebLink: (request) => {
    ipcRenderer.send(TERMINAL_CHANNELS.openWebLink, { id: request.id, url: request.url });
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

// Requests leave as plain JSON copies: a renderer's reactive proxy cannot be cloned, and main checks the exact fields.
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const scm: DamoclesScmApi = {
  getState: () => ipcRenderer.invoke(SCM_CHANNELS.getState) as Promise<ScmShellState>,
  onView: (listener) => subscribe<ScmView>(SCM_CHANNELS.view, listener),
  onState: (listener) => subscribe<ScmRepoSnapshot>(SCM_CHANNELS.state, listener),
  onDecorations: (listener) => subscribe<ScmDecorations>(SCM_CHANNELS.decorations, listener),
  onSettings: (listener) => subscribe<ScmSettings>(SCM_CHANNELS.settings, listener),
  onCommand: (listener) => subscribe<ScmShellCommand>(SCM_CHANNELS.command, listener),
  onSetInput: (listener) => subscribe<ScmSetInput>(SCM_CHANNELS.setInput, listener),
  onClone: (listener) => subscribe<ScmCloneState>(SCM_CHANNELS.clone, listener),
  onArtifactsChanged: (listener) => subscribe<ScmArtifactsChanged>(SCM_CHANNELS.artifactsChanged, listener),
  artifacts: (request) => ipcRenderer.invoke(SCM_CHANNELS.artifacts, { repoId: request.repoId, group: request.group }) as Promise<ScmArtifactsResult>,
  select: (request) => ipcRenderer.invoke(SCM_CHANNELS.select, { projectKey: request.projectKey, repoId: request.repoId }) as Promise<void>,
  run: (request) => ipcRenderer.invoke(SCM_CHANNELS.run, plain(request)) as Promise<ScmRunResult>,
  commit: (request) => ipcRenderer.invoke(SCM_CHANNELS.commit, { repoId: request.repoId, message: request.message, variant: plain(request.variant), ...(request.postCommit !== undefined ? { postCommit: request.postCommit } : {}) }) as Promise<ScmCommitResult>,
  generateMessage: (repoId) => ipcRenderer.invoke(SCM_CHANNELS.generateMessage, { repoId }) as Promise<ScmGenerateResult>,
  fileDiff: (request) => ipcRenderer.invoke(SCM_CHANNELS.fileDiff, { repoId: request.repoId, source: plain(request.source), path: request.path }) as Promise<ScmFileDiffResult>,
  copy: (request) => ipcRenderer.invoke(SCM_CHANNELS.copy, { repoId: request.repoId, kind: request.kind, value: request.value }) as Promise<void>,
  commitInput: (repoId) => ipcRenderer.invoke(SCM_CHANNELS.commitInput, { repoId }) as Promise<ScmCommitInput>,
  reportAmend: (report) => ipcRenderer.invoke(SCM_CHANNELS.amend, { repoId: report.repoId, amending: report.amending }) as Promise<void>,
  quickDiffBase: (request) => ipcRenderer.invoke(SCM_CHANNELS.quickDiffBase, { repoId: request.repoId, path: request.path }) as Promise<ScmQuickDiffBaseResult>,
  blame: (request) => ipcRenderer.invoke(SCM_CHANNELS.blame, { repoId: request.repoId, path: request.path }) as Promise<ScmBlameResult>,
  timeline: (request) => ipcRenderer.invoke(SCM_CHANNELS.timeline, { repoId: request.repoId, path: request.path, ...(request.cursor !== undefined ? { cursor: request.cursor } : {}) }) as Promise<ScmTimelineResult>,
  mergeInputs: (request) => ipcRenderer.invoke(SCM_CHANNELS.mergeInputs, { repoId: request.repoId, path: request.path }) as Promise<ScmMergeInputsResult>,
  mergeFile: (request) => ipcRenderer.invoke(SCM_CHANNELS.mergeFile, { repoId: request.repoId, path: request.path, diff3: request.diff3 }) as Promise<ScmMergeFileResult>,
  resource: (request) => ipcRenderer.invoke(SCM_CHANNELS.resource, { projectKey: request.projectKey, relativePath: request.relativePath }) as Promise<ScmResource | null>,
  history: (request) => ipcRenderer.invoke(SCM_CHANNELS.history, { repoId: request.repoId, refs: plain(request.refs), ...(request.cursor !== undefined ? { cursor: request.cursor } : {}) }) as Promise<ScmHistoryResult>,
  commitDetails: (request) => ipcRenderer.invoke(SCM_CHANNELS.commitDetails, { repoId: request.repoId, hash: request.hash }) as Promise<ScmCommitDetailsResult>,
};

// The shell HTML carries the theme from its creation; this keeps it current after a theme change.
ipcRenderer.on(SHELL_CHANNELS.theme, (_event, theme: PanelTheme) => applyHostTheme(theme));

const review: DamoclesReviewApi = {
  fileDiff: (request) => ipcRenderer.invoke(REVIEW_CHANNELS.fileDiff, { reviewId: request.reviewId, path: request.path }) as Promise<ChatReviewFileDiffResult>,
  setScope: (request) => ipcRenderer.invoke(REVIEW_CHANNELS.setScope, { reviewId: request.reviewId, scope: request.scope }) as Promise<void>,
  send: (request) => ipcRenderer.invoke(REVIEW_CHANNELS.send, { reviewId: request.reviewId }) as Promise<ChatReviewSendResult>,
  discard: (request) => ipcRenderer.invoke(REVIEW_CHANNELS.discard, { reviewId: request.reviewId }) as Promise<void>,
  setDrafts: (request) => ipcRenderer.invoke(REVIEW_CHANNELS.setDrafts, { reviewId: request.reviewId, comments: plain(request.comments) }) as Promise<void>,
};

const ports: DamoclesPortsApi = {
  get: (hostId) => ipcRenderer.invoke(PORTS_CHANNELS.get, { hostId }) as Promise<PortsView | null>,
  onState: (listener) => subscribe<PortsView>(PORTS_CHANNELS.state, listener),
  forward: (projectKey) => ipcRenderer.invoke(PORTS_CHANNELS.forward, { projectKey }) as Promise<void>,
  forwardDetected: (projectKey, key) => ipcRenderer.invoke(PORTS_CHANNELS.forwardDetected, { projectKey, key }) as Promise<void>,
  stop: (projectKey, key) => ipcRenderer.invoke(PORTS_CHANNELS.stop, { projectKey, key }) as Promise<void>,
  setLabel: (projectKey, key) => ipcRenderer.invoke(PORTS_CHANNELS.setLabel, { projectKey, key }) as Promise<void>,
  changeLocalPort: (projectKey, key) => ipcRenderer.invoke(PORTS_CHANNELS.changeLocalPort, { projectKey, key }) as Promise<void>,
  setOnDetect: (projectKey, port, onDetect) => ipcRenderer.invoke(PORTS_CHANNELS.setOnDetect, { projectKey, port, onDetect }) as Promise<void>,
  openInPane: (projectKey, key) => ipcRenderer.invoke(PORTS_CHANNELS.openInPane, { projectKey, key }) as Promise<void>,
  openInBrowser: (projectKey, key) => ipcRenderer.invoke(PORTS_CHANNELS.openInBrowser, { projectKey, key }) as Promise<void>,
  copyAddress: (projectKey, key) => ipcRenderer.invoke(PORTS_CHANNELS.copyAddress, { projectKey, key }) as Promise<void>,
  undoFallback: (projectKey) => ipcRenderer.invoke(PORTS_CHANNELS.undoFallback, { projectKey }) as Promise<void>,
};

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
  newChat: (projectKey, worktree) => ipcRenderer.invoke(SHELL_CHANNELS.chatsNew, projectKey, ...(worktree !== undefined ? [worktree] : [])) as Promise<void>,
  newChatInWorktree: (request) => ipcRenderer.invoke(SHELL_CHANNELS.chatsNewInWorktree, { projectKey: request.projectKey, worktreeId: request.worktreeId }) as Promise<void>,
  chatsWorktreeOptions: (projectKey) => ipcRenderer.invoke(SHELL_CHANNELS.chatsWorktreeOptions, { projectKey }) as Promise<ChatsWorktreeOptions>,
  showFolder: (request) => ipcRenderer.invoke(SHELL_CHANNELS.showFolder, { projectKey: request.projectKey, show: request.show }) as Promise<void>,
  onShownFolder: (listener) => subscribe<ShownFolder>(SHELL_CHANNELS.shownFolder, listener),
  worktreeFinish: (request) => ipcRenderer.invoke(SHELL_CHANNELS.worktreeFinish, { projectKey: request.projectKey, worktreeId: request.worktreeId, action: request.action }) as Promise<void>,
  renameChat: (chatId, name) => ipcRenderer.invoke(SHELL_CHANNELS.chatsRename, chatId, name) as Promise<ChatMutationResult>,
  tagChat: (chatId, tag) => ipcRenderer.invoke(SHELL_CHANNELS.chatsTag, chatId, tag) as Promise<ChatMutationResult>,
  deleteChat: (chatId) => ipcRenderer.invoke(SHELL_CHANNELS.chatsDelete, chatId) as Promise<ChatMutationResult>,
  requestOverlay: (request) => ipcRenderer.invoke(SHELL_CHANNELS.overlayRequest, request) as Promise<OverlayAnswer>,
  openAppMenu: (anchor) => ipcRenderer.invoke(SHELL_CHANNELS.appMenu, { x: anchor.x, y: anchor.y }) as Promise<void>,
  toggleTheme: () => ipcRenderer.invoke(SHELL_CHANNELS.toggleTheme) as Promise<void>,
  restartEngine: (authority) => ipcRenderer.invoke(SHELL_CHANNELS.restartEngine, authority) as Promise<void>,
  renameHost: (hostId, name) => ipcRenderer.invoke(SHELL_CHANNELS.hostsRename, { hostId, name }) as ReturnType<DamoclesShellApi['renameHost']>,
  renameHostOnCard: (hostId) => ipcRenderer.invoke(SHELL_CHANNELS.hostsRenameOnCard, { hostId }) as Promise<void>,
  showHostCard: (hostId, anchor) => ipcRenderer.invoke(SHELL_CHANNELS.hostsShowCard, { hostId, anchor: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height } }) as Promise<void>,
  openConnect: () => ipcRenderer.invoke(SHELL_CHANNELS.connectOpen, {}) as Promise<void>,
  openHostFolder: (hostId) => ipcRenderer.invoke(SHELL_CHANNELS.hostsOpenFolder, { hostId }) as Promise<void>,
  reconnectHost: (hostId) => ipcRenderer.invoke(SHELL_CHANNELS.hostsReconnect, { hostId }) as Promise<void>,
  signInHost: (hostId) => ipcRenderer.invoke(SHELL_CHANNELS.hostsSignIn, { hostId }) as Promise<void>,
  showHostLog: (hostId) => ipcRenderer.invoke(SHELL_CHANNELS.hostsShowLog, { hostId }) as Promise<void>,
  switchHostWhenIdle: (hostId) => ipcRenderer.invoke(SHELL_CHANNELS.hostsSwitchWhenIdle, { hostId }) as Promise<void>,
  switchHostNow: (hostId) => ipcRenderer.invoke(SHELL_CHANNELS.hostsSwitchNow, { hostId }) as Promise<boolean>,
  setProjectsView: (view) => ipcRenderer.invoke(SHELL_CHANNELS.projectsSetView, { view }) as Promise<void>,
  setProjectGroupCollapsed: (group, collapsed) => ipcRenderer.invoke(SHELL_CHANNELS.projectsSetGroupCollapsed, { group, collapsed }) as Promise<void>,
  reorderProjects: (order) => ipcRenderer.invoke(SHELL_CHANNELS.projectsReorder, { order: [...order] }) as Promise<boolean>,
  reorderProjectGroups: (groupOrder) => ipcRenderer.invoke(SHELL_CHANNELS.projectsReorderGroups, { groupOrder: [...groupOrder] }) as Promise<boolean>,
  openAsProject: (request) => ipcRenderer.invoke(SHELL_CHANNELS.projectsOpenAsProject, { projectKey: request.projectKey, relativePath: request.relativePath }) as ReturnType<DamoclesShellApi['openAsProject']>,
  listWslDistros: () => ipcRenderer.invoke(SHELL_CHANNELS.wslListDistros, {}) as ReturnType<DamoclesShellApi['listWslDistros']>,
  reopenInWsl: (projectKey, distro) => ipcRenderer.invoke(SHELL_CHANNELS.wslReopen, distro === undefined ? { projectKey } : { projectKey, distro }) as ReturnType<DamoclesShellApi['reopenInWsl']>,
  dismissWslNotice: (projectKey) => ipcRenderer.invoke(SHELL_CHANNELS.wslDismissNotice, { projectKey }) as Promise<void>,
  reopenInContainer: (projectKey) => ipcRenderer.invoke(SHELL_CHANNELS.containersReopen, { projectKey }) as ReturnType<DamoclesShellApi['reopenInContainer']>,
  rebuildContainer: (projectKey) => ipcRenderer.invoke(SHELL_CHANNELS.containersRebuild, { projectKey }) as Promise<void>,
  toggleSidebar: () => ipcRenderer.invoke(SHELL_CHANNELS.toggleSidebar) as Promise<void>,
  showSidebar: () => ipcRenderer.invoke(SHELL_CHANNELS.showSidebar) as Promise<void>,
  windowControl: (control) => ipcRenderer.invoke(SHELL_CHANNELS.windowControl, control) as Promise<void>,
  openSettings: (section) => ipcRenderer.invoke(SHELL_CHANNELS.openSettings, section) as Promise<void>,
  reportContentBounds: (bounds: ContentBounds) => {
    ipcRenderer.send(SHELL_CHANNELS.contentBounds, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  },
  reportSidebarLayout: (layout) => {
    ipcRenderer.send(SHELL_CHANNELS.sidebarLayout, { sidebarWidth: layout.sidebarWidth, sections: layout.sections, sectionOrder: layout.sectionOrder, search: layout.search, scm: layout.scm, repositories: layout.repositories, graph: layout.graph });
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
    const { documentId, version, seq } = edit;
    ipcRenderer.send(SHELL_CHANNELS.editorEdit, 'changes' in edit
      ? { documentId, version, seq, changes: edit.changes.map((change) => ({ offset: change.offset, length: change.length, text: change.text })) }
      : { documentId, version, seq, text: edit.text, overReload: edit.overReload });
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
  openEditorLink: (request) => {
    ipcRenderer.send(SHELL_CHANNELS.editorOpenLink, { tabId: request.tabId, url: request.url });
  },
  reportSelection: (report) => {
    const range = report.selection;
    const selection = range ? { startLine: range.startLine, startColumn: range.startColumn, endLine: range.endLine, endColumn: range.endColumn } : null;
    ipcRenderer.send(SHELL_CHANNELS.editorSelection, { documentId: report.documentId, selection });
  },
  mentionTab: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.editorMention, { tabId }) as Promise<void>,
  uploadMergeInputs: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.editorMergeInputs, { tabId }) as Promise<ScmMergeInputsResult>,
  completeUploadMerge: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.editorCompleteMerge, { tabId }) as Promise<void>,
  setFocusOverlay: (open) => ipcRenderer.invoke(SHELL_CHANNELS.editorFocusOverlay, { open }) as Promise<void>,
  focusPage: (request) => ipcRenderer.invoke(SHELL_CHANNELS.editorFocusPage, { tabId: request.tabId }) as Promise<boolean>,
  onEditorCommand: (listener) => subscribe<EditorCommand>(SHELL_CHANNELS.editorCommand, listener),
  onEditorFlush: (listener) => subscribe<EditorFlushRequest>(SHELL_CHANNELS.editorFlush, (message) => listener({ requestId: message.requestId, format: [...message.format] })),
  editorFlushed: (requestId) => {
    ipcRenderer.send(SHELL_CHANNELS.editorFlushed, { requestId });
  },
  onEditorResync: (listener) => subscribe<{ documentId: string }>(SHELL_CHANNELS.editorResync, (message) => listener(message.documentId)),
  onEditorFocus: (listener) => subscribe<{ tabId: string }>(SHELL_CHANNELS.editorFocus, (message) => listener(message.tabId)),
  onEditorReveal: (listener) => subscribe<EditorReveal>(SHELL_CHANNELS.editorReveal, listener),
  browserAction: (request) => ipcRenderer.invoke(SHELL_CHANNELS.browserAction, { tabId: request.tabId, action: request.action }) as Promise<void>,
  navigateBrowser: (request) => ipcRenderer.invoke(SHELL_CHANNELS.browserNavigate, { tabId: request.tabId, url: request.url }) as Promise<boolean>,
  reportBrowserBounds: (area) => {
    ipcRenderer.send(SHELL_CHANNELS.browserBounds, area ? { x: area.x, y: area.y, width: area.width, height: area.height, radius: area.radius } : null);
  },
  setDesignPreview: (request) => ipcRenderer.invoke(SHELL_CHANNELS.designSet, {
    tabId: request.tabId,
    ...(request.width !== undefined ? { width: request.width } : {}),
    ...(request.state !== undefined ? { state: request.state } : {}),
    ...(request.provenance !== undefined ? { provenance: request.provenance } : {}),
  }) as Promise<void>,
  designPreviewAction: (request) => ipcRenderer.invoke(SHELL_CHANNELS.designAction, { tabId: request.tabId, action: request.action }) as Promise<void>,
  reportDesignPreviewBounds: (area) => {
    ipcRenderer.send(SHELL_CHANNELS.designBounds, area ? { tabId: area.tabId, x: area.x, y: area.y, width: area.width, height: area.height, radius: area.radius, zoom: area.zoom } : null);
  },
  htmlPreviewAction: (request) => ipcRenderer.invoke(SHELL_CHANNELS.htmlPreviewAction, { tabId: request.tabId, action: request.action }) as Promise<void>,
  reportHtmlPreviewBounds: (area) => {
    ipcRenderer.send(SHELL_CHANNELS.htmlPreviewBounds, area ? { tabId: area.tabId, x: area.x, y: area.y, width: area.width, height: area.height, radius: area.radius } : null);
  },
  onDesignReplay: (listener) => subscribe<DesignReplayProgress>(SHELL_CHANNELS.designReplay, listener),
  designFreeze: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.designFreeze, tabId) as Promise<DesignFreeze>,
  designMarkupEnter: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.designMarkupEnter, tabId) as Promise<void>,
  designMarkupExit: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.designMarkupExit, tabId) as Promise<void>,
  designMarkupSend: (request) => ipcRenderer.invoke(SHELL_CHANNELS.designMarkupSend, { tabId: request.tabId, png: request.png, json: request.json }) as Promise<DesignMarkupSent>,
  designTweakApply: (request) => ipcRenderer.invoke(SHELL_CHANNELS.designTweakApply, { tabId: request.tabId, property: request.property, token: request.token }) as Promise<void>,
  designTweakReset: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.designTweakReset, tabId) as Promise<void>,
  designTweakKeep: (request) => ipcRenderer.invoke(SHELL_CHANNELS.designTweakKeep, { tabId: request.tabId, tweakId: request.tweakId, value: request.value }) as Promise<void>,
  designLastFrame: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.designLastFrame, tabId) as Promise<string | null>,
  onDesignPreviewClosed: (listener) => subscribe<DesignPreviewClosed>(SHELL_CHANNELS.designClosed, (closed) => listener(closed.tabId)),
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
  copyFilesIn: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.filesCopyIn, {
      projectKey: request.projectKey,
      relativeDir: request.relativeDir,
      paths: [...request.paths],
      withoutPath: request.withoutPath,
      origin: request.origin,
    }) as Promise<FilesTransferStartResult>,
  pickFilesToCopyIn: (folder) => ipcRenderer.invoke(SHELL_CHANNELS.filesPickCopyIn, { projectKey: folder.projectKey, relativePath: folder.relativePath }) as Promise<FilesTransferStartResult>,
  dropFilesRow: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.filesDropRow, {
      from: { projectKey: request.from.projectKey, relativePath: request.from.relativePath },
      toDir: { projectKey: request.toDir.projectKey, relativePath: request.toDir.relativePath },
      copy: request.copy,
    }) as Promise<FilesTransferStartResult>,
  setFilesClipboard: (request) =>
    ipcRenderer.invoke(SHELL_CHANNELS.filesClipboardSet, { op: request.op, ref: { projectKey: request.ref.projectKey, relativePath: request.ref.relativePath } }) as Promise<void>,
  clearFilesClipboard: () => ipcRenderer.invoke(SHELL_CHANNELS.filesClipboardClear, {}) as Promise<void>,
  pasteFiles: (request) => ipcRenderer.invoke(SHELL_CHANNELS.filesPaste, { toDir: { projectKey: request.toDir.projectKey, relativePath: request.toDir.relativePath } }) as Promise<FilesPasteResult>,
  downloadFile: (file) => ipcRenderer.invoke(SHELL_CHANNELS.filesDownload, { projectKey: file.projectKey, relativePath: file.relativePath }) as Promise<FilesTransferStartResult>,
  cancelFilesTransfer: (transferId) => ipcRenderer.invoke(SHELL_CHANNELS.filesTransferCancel, { transferId }) as Promise<void>,
  onFilesTransferProgress: (listener) => subscribe<FilesTransferProgress>(SHELL_CHANNELS.filesTransferProgress, listener),
  onFilesClipboardChanged: (listener) => subscribe<FilesClipboardChanged>(SHELL_CHANNELS.filesClipboardChanged, listener),
  // Main checks every path; anything that is not a File has no path, like a File made in the page.
  pathsForFiles: (files) => Array.from(files, (file) => (file instanceof File ? webUtils.getPathForFile(file) : '')),
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
  scm,
  review,
  ports,
};

contextBridge.exposeInMainWorld('damoclesShell', api);
