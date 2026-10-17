import type { OpenFolder } from '../../platform/workspace-folders';
import type { ChatCommand } from '../../shared/types/messages';
import { visibleText } from '../../shared/visible-text';
import type { PaletteCommand } from '../preload/overlay-channels';
import type { ScmCommitVariant } from '../preload/scm-channels';
import { EDITOR_GIT_KEYBINDINGS, type EditorCommand, type EditorMenuShortcut, type SearchEditorCommand, type SearchViewCommand } from '../preload/shell-channels';
import type { MenuActions, MenuState } from './menu';
import type { DesktopLocalizationService } from './platform/localization-service';

// Stable ids: tests find items with Menu.getApplicationMenu().getMenuItemById(id) and click() them; the palette runs them.
export const MENU_IDS = {
  addProject: 'damocles.addProject',
  newChat: 'damocles.newChat',
  openChat: 'damocles.openChat',
  openChatForProjectMenu: 'damocles.openChatForProject',
  newSession: 'damocles.newSession',
  cancelSession: 'damocles.cancelSession',
  quickOpen: 'damocles.quickOpen',
  showCommands: 'damocles.showCommands',
  findInFiles: 'damocles.search.findInFiles',
  replaceInFiles: 'damocles.search.replaceInFiles',
  focusNextSearchResult: 'damocles.search.focusNextSearchResult',
  focusPreviousSearchResult: 'damocles.search.focusPreviousSearchResult',
  toggleQueryDetails: 'damocles.search.toggleQueryDetails',
  cancelSearch: 'damocles.search.cancelSearch',
  refreshSearch: 'damocles.search.refreshSearchResults',
  clearSearchResults: 'damocles.search.clearSearchResults',
  collapseSearchResults: 'damocles.search.collapseSearchResults',
  expandSearchResults: 'damocles.search.expandSearchResults',
  viewAsTree: 'damocles.search.viewAsTree',
  viewAsList: 'damocles.search.viewAsList',
  clearSearchHistory: 'damocles.search.clearHistory',
  toggleSearchOnType: 'damocles.search.toggleSearchOnType',
  newSearchEditor: 'damocles.searchEditor.new',
  openSearchEditor: 'damocles.searchEditor.open',
  openNewSearchEditor: 'damocles.searchEditor.openNew',
  openResultsInEditor: 'damocles.searchEditor.openResults',
  searchAgain: 'damocles.searchEditor.rerun',
  focusSearchEditorInput: 'damocles.searchEditor.focusInput',
  focusSearchEditorIncludes: 'damocles.searchEditor.focusFilesToInclude',
  focusSearchEditorExcludes: 'damocles.searchEditor.focusFilesToExclude',
  toggleSearchEditorMatchCase: 'damocles.searchEditor.toggleMatchCase',
  toggleSearchEditorWholeWord: 'damocles.searchEditor.toggleWholeWord',
  toggleSearchEditorRegex: 'damocles.searchEditor.toggleRegex',
  toggleSearchEditorContextLines: 'damocles.searchEditor.toggleContextLines',
  increaseSearchEditorContextLines: 'damocles.searchEditor.increaseContextLines',
  decreaseSearchEditorContextLines: 'damocles.searchEditor.decreaseContextLines',
  selectAllSearchEditorMatches: 'damocles.searchEditor.selectAllMatches',
  deleteSearchEditorFileResults: 'damocles.searchEditor.deleteFileResults',
  save: 'damocles.editor.save',
  saveAs: 'damocles.editor.saveAs',
  formatDocument: 'damocles.editor.formatDocument',
  closeEditor: 'damocles.editor.close',
  nextEditor: 'damocles.editor.next',
  previousEditor: 'damocles.editor.previous',
  toggleEditor: 'damocles.toggleEditor',
  toggleTerminal: 'damocles.toggleTerminal',
  newTerminal: 'damocles.terminal.new',
  killTerminal: 'damocles.terminal.kill',
  restartTerminal: 'damocles.terminal.restart',
  newTerminalWithProfile: 'damocles.terminal.newWithProfile',
  selectDefaultTerminalProfile: 'damocles.terminal.selectDefaultProfile',
  killAllTerminals: 'damocles.terminal.killAll',
  focusNextTerminal: 'damocles.terminal.focusNext',
  focusPreviousTerminal: 'damocles.terminal.focusPrevious',
  splitTerminal: 'damocles.terminal.split',
  unsplitTerminal: 'damocles.terminal.unsplit',
  focusPreviousTerminalPane: 'damocles.terminal.focusPreviousPane',
  focusNextTerminalPane: 'damocles.terminal.focusNextPane',
  resizeTerminalPaneLeft: 'damocles.terminal.resizePaneLeft',
  resizeTerminalPaneRight: 'damocles.terminal.resizePaneRight',
  renameTerminal: 'damocles.terminal.rename',
  changeTerminalIcon: 'damocles.terminal.changeIcon',
  changeTerminalColor: 'damocles.terminal.changeColor',
  copyLastTerminalCommand: 'damocles.terminal.copyLastCommand',
  copyLastTerminalCommandOutput: 'damocles.terminal.copyLastCommandOutput',
  addTerminalToChat: 'damocles.terminal.addToChat',
  scrollToPreviousTerminalCommand: 'damocles.terminal.scrollToPreviousCommand',
  scrollToNextTerminalCommand: 'damocles.terminal.scrollToNextCommand',
  toggleSidebar: 'damocles.toggleSidebar',
  nextChat: 'damocles.nextChat',
  previousChat: 'damocles.previousChat',
  focusNextPart: 'damocles.focusNextPart',
  focusPreviousPart: 'damocles.focusPreviousPart',
  togglePromptNavigator: 'damocles.togglePromptNavigator',
  newBrowserPage: 'damocles.browser.newPage',
  toggleBrowserDevTools: 'damocles.browser.toggleDevTools',
  showLog: 'damocles.showLog',
  openSettings: 'damocles.openSettings',
  about: 'damocles.about',
  releaseNotes: 'damocles.releaseNotes',
  checkForUpdates: 'damocles.checkForUpdates',
  chatContextUsage: 'damocles.chat.contextUsage',
  chatSubscriptionUsage: 'damocles.chat.subscriptionUsage',
  chatUsageStatistics: 'damocles.chat.usageStatistics',
  chatMcpServers: 'damocles.chat.mcpServers',
  chatTools: 'damocles.chat.tools',
  chatMemory: 'damocles.chat.memory',
  chatRewind: 'damocles.chat.rewind',
  chatSideQuestion: 'damocles.chat.sideQuestion',
  chatOpenSessionLog: 'damocles.chat.openSessionLog',
  chatViewSessionPlan: 'damocles.chat.viewSessionPlan',
  gitInit: 'damocles.git.init',
  gitOpenRepository: 'damocles.git.openRepository',
  gitClose: 'damocles.git.close',
  gitCloseOtherRepositories: 'damocles.git.closeOtherRepositories',
  gitReopenClosedRepositories: 'damocles.git.reopenClosedRepositories',
  gitRefresh: 'damocles.git.refresh',
  gitShowOutput: 'damocles.git.showOutput',
  gitStage: 'damocles.git.stage',
  gitStageAll: 'damocles.git.stageAll',
  gitStageAllTracked: 'damocles.git.stageAllTracked',
  gitStageAllUntracked: 'damocles.git.stageAllUntracked',
  gitStageAllMerge: 'damocles.git.stageAllMerge',
  gitUnstage: 'damocles.git.unstage',
  gitUnstageAll: 'damocles.git.unstageAll',
  gitClean: 'damocles.git.clean',
  gitCleanAll: 'damocles.git.cleanAll',
  gitCleanAllTracked: 'damocles.git.cleanAllTracked',
  gitCleanAllUntracked: 'damocles.git.cleanAllUntracked',
  gitOpenChange: 'damocles.git.openChange',
  gitOpenFile: 'damocles.git.openFile',
  gitOpenHeadFile: 'damocles.git.openHEADFile',
  gitIgnore: 'damocles.git.ignore',
  gitCommit: 'damocles.git.commit',
  gitMergeAbort: 'damocles.git.mergeAbort',
  gitRebaseAbort: 'damocles.git.rebaseAbort',
  gitCherryPickAbort: 'damocles.git.cherryPickAbort',
  gitCherryPick: 'damocles.git.cherryPick',
  gitViewChanges: 'damocles.git.viewChanges',
  gitViewStagedChanges: 'damocles.git.viewStagedChanges',
  gitViewUntrackedChanges: 'damocles.git.viewUntrackedChanges',
  gitManageUnsafeRepositories: 'damocles.git.manageUnsafeRepositories',
  gitOpenRepositoriesInParentFolders: 'damocles.git.openRepositoriesInParentFolders',
  gitCommitStaged: 'damocles.git.commitStaged',
  gitCommitAll: 'damocles.git.commitAll',
  gitCommitAmend: 'damocles.git.commitAmend',
  gitCommitStagedAmend: 'damocles.git.commitStagedAmend',
  gitCommitAllAmend: 'damocles.git.commitAllAmend',
  gitCommitSigned: 'damocles.git.commitSigned',
  gitCommitStagedSigned: 'damocles.git.commitStagedSigned',
  gitCommitAllSigned: 'damocles.git.commitAllSigned',
  gitCommitNoVerify: 'damocles.git.commitNoVerify',
  gitCommitStagedNoVerify: 'damocles.git.commitStagedNoVerify',
  gitCommitAllNoVerify: 'damocles.git.commitAllNoVerify',
  gitCommitAmendNoVerify: 'damocles.git.commitAmendNoVerify',
  gitCommitStagedAmendNoVerify: 'damocles.git.commitStagedAmendNoVerify',
  gitCommitAllAmendNoVerify: 'damocles.git.commitAllAmendNoVerify',
  gitCommitSignedNoVerify: 'damocles.git.commitSignedNoVerify',
  gitCommitStagedSignedNoVerify: 'damocles.git.commitStagedSignedNoVerify',
  gitCommitAllSignedNoVerify: 'damocles.git.commitAllSignedNoVerify',
  gitCommitEmpty: 'damocles.git.commitEmpty',
  gitCommitEmptyNoVerify: 'damocles.git.commitEmptyNoVerify',
  gitUndoCommit: 'damocles.git.undoCommit',
  gitRename: 'damocles.git.rename',
  gitDelete: 'damocles.git.delete',
  gitOpenAllChanges: 'damocles.git.openAllChanges',
  gitCloseAllDiffEditors: 'damocles.git.closeAllDiffEditors',
  gitCloseAllUnmodifiedEditors: 'damocles.git.closeAllUnmodifiedEditors',
  gitClone: 'damocles.git.clone',
  gitCloneRecursive: 'damocles.git.cloneRecursive',
  gitFetch: 'damocles.git.fetch',
  gitFetchPrune: 'damocles.git.fetchPrune',
  gitFetchAll: 'damocles.git.fetchAll',
  gitPull: 'damocles.git.pull',
  gitPullRebase: 'damocles.git.pullRebase',
  gitPullFrom: 'damocles.git.pullFrom',
  gitPush: 'damocles.git.push',
  gitPushForce: 'damocles.git.pushForce',
  gitPushTo: 'damocles.git.pushTo',
  gitPushToForce: 'damocles.git.pushToForce',
  gitPushWithTags: 'damocles.git.pushWithTags',
  gitPushWithTagsForce: 'damocles.git.pushWithTagsForce',
  gitSync: 'damocles.git.sync',
  gitSyncRebase: 'damocles.git.syncRebase',
  gitPublish: 'damocles.git.publish',
  gitAddRemote: 'damocles.git.addRemote',
  gitRemoveRemote: 'damocles.git.removeRemote',
  gitCheckout: 'damocles.git.checkout',
  gitCheckoutDetached: 'damocles.git.checkoutDetached',
  gitBranch: 'damocles.git.branch',
  gitBranchFrom: 'damocles.git.branchFrom',
  gitRenameBranch: 'damocles.git.renameBranch',
  gitDeleteBranch: 'damocles.git.deleteBranch',
  gitDeleteRemoteBranch: 'damocles.git.deleteRemoteBranch',
  gitMerge: 'damocles.git.merge',
  gitRebase: 'damocles.git.rebase',
  gitCreateTag: 'damocles.git.createTag',
  gitDeleteTag: 'damocles.git.deleteTag',
  gitDeleteRemoteTag: 'damocles.git.deleteRemoteTag',
  gitPushTags: 'damocles.git.pushTags',
  gitCreateWorktree: 'damocles.git.createWorktree',
  gitDeleteWorktree: 'damocles.git.deleteWorktree',
  gitStash: 'damocles.git.stash',
  gitStashIncludeUntracked: 'damocles.git.stashIncludeUntracked',
  gitStashStaged: 'damocles.git.stashStaged',
  gitStashApplyLatest: 'damocles.git.stashApplyLatest',
  gitStashApply: 'damocles.git.stashApply',
  gitStashPopLatest: 'damocles.git.stashPopLatest',
  gitStashPop: 'damocles.git.stashPop',
  gitStashDrop: 'damocles.git.stashDrop',
  gitStashDropAll: 'damocles.git.stashDropAll',
  gitStashView: 'damocles.git.stashView',
  gitStageSelectedRanges: 'damocles.git.stageSelectedRanges',
  gitUnstageSelectedRanges: 'damocles.git.unstageSelectedRanges',
  gitRevertSelectedRanges: 'damocles.git.revertSelectedRanges',
  gitOpenTimeline: 'damocles.git.openTimeline',
  gitToggleInlineBlame: 'damocles.git.blame.toggleEditorDecoration',
  gitShowLineBlame: 'damocles.git.showLineBlame',
  nextChange: 'damocles.editor.nextChange',
  previousChange: 'damocles.editor.previousChange',
  mergeAcceptCurrent: 'damocles.mergeConflict.acceptCurrent',
  mergeAcceptIncoming: 'damocles.mergeConflict.acceptIncoming',
  mergeAcceptBoth: 'damocles.mergeConflict.acceptBoth',
  mergeAcceptAllCurrent: 'damocles.mergeConflict.acceptAllCurrent',
  mergeAcceptAllIncoming: 'damocles.mergeConflict.acceptAllIncoming',
  mergeNextConflict: 'damocles.mergeConflict.next',
  mergePreviousConflict: 'damocles.mergeConflict.previous',
  chatReviewChanges: 'damocles.chat.reviewChanges',
  chatNewInWorktree: 'damocles.chat.newChatInWorktree',
  chatHandOffToWorktree: 'damocles.chat.handOffToWorktree',
  chatHandOffToProjectFolder: 'damocles.chat.handOffToProjectFolder',
  worktreeApply: 'damocles.worktree.apply',
  worktreeMerge: 'damocles.worktree.merge',
  worktreeUpdate: 'damocles.worktree.update',
  worktreePushBranch: 'damocles.worktree.pushBranch',
  worktreeDelete: 'damocles.worktree.delete',
} as const;

// One command per project, "Open Chat in Project" in the File menu; the id carries the project's absolute path.
export function openChatForProjectId(fsPath: string): string {
  return `${MENU_IDS.openChatForProjectMenu}:${fsPath}`;
}

export const NEW_CHAT_ACCELERATOR = 'CmdOrCtrl+N';
// VS Code's per-OS pattern: no Ctrl+Alt letter chord on Windows, where Ctrl+Alt is AltGr.
export function newChatInWorktreeAccelerator(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Cmd+Alt+N';
  return platform === 'linux' ? 'Ctrl+Alt+N' : 'Shift+Alt+N';
}
export const TOGGLE_SIDEBAR_ACCELERATOR = 'CmdOrCtrl+B';
export const OPEN_SETTINGS_ACCELERATOR = 'CmdOrCtrl+,';
export const QUICK_OPEN_ACCELERATOR = 'CmdOrCtrl+P';
export const CLOSE_EDITOR_ACCELERATOR = 'CmdOrCtrl+W';
// VS Code's Toggle Terminal is Ctrl+` on every platform, macOS included.
export const TOGGLE_TERMINAL_ACCELERATOR = 'Ctrl+`';
export const NEW_TERMINAL_ACCELERATOR = 'Ctrl+Shift+`';
// VS Code's Split Terminal (terminalActions.ts): Ctrl+Shift+5, Cmd+\ on macOS.
export function splitTerminalAccelerator(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'Cmd+\\' : 'Ctrl+Shift+5';
}
export const SHOW_COMMANDS_ACCELERATOR = 'CmdOrCtrl+Shift+P';
export const FIND_IN_FILES_ACCELERATOR = 'CmdOrCtrl+Shift+F';
export const REPLACE_IN_FILES_ACCELERATOR = 'CmdOrCtrl+Shift+H';
// VS Code's search keys (searchActionsNav.ts, searchEditor.contribution.ts).
export const SEARCH_AGAIN_ACCELERATOR = 'CmdOrCtrl+Shift+R';
export const TOGGLE_QUERY_DETAILS_ACCELERATOR = 'CmdOrCtrl+Shift+J';
export const FOCUS_NEXT_SEARCH_RESULT_ACCELERATOR = 'F4';
export const FOCUS_PREVIOUS_SEARCH_RESULT_ACCELERATOR = 'Shift+F4';
// VS Code's Format Document on Windows and macOS.
export const FORMAT_DOCUMENT_ACCELERATOR = 'Shift+Alt+F';

// The editor context menu's keys: Monaco's own bindings for its commands (goToCommands.js, rename.js, multicursor.js), the
// Edit menu's clipboard roles and the registry's Format Document and Show All Commands.
export const EDITOR_MENU_ACCELERATORS: Readonly<Record<EditorMenuShortcut, string>> = {
  goToDefinition: 'F12',
  goToReferences: 'Shift+F12',
  renameSymbol: 'F2',
  changeAllOccurrences: 'CmdOrCtrl+F2',
  formatDocument: FORMAT_DOCUMENT_ACCELERATOR,
  cut: 'CmdOrCtrl+X',
  copy: 'CmdOrCtrl+C',
  paste: 'CmdOrCtrl+V',
  commandPalette: SHOW_COMMANDS_ACCELERATOR,
};

// A string resolved in the UI language for the menu and the palette, and in English for the palette's English match.
export type Label =
  | { readonly message: string; readonly args?: readonly string[] }
  | { readonly packageKey: string }
  // shown as it is, such as a project's name
  | { readonly text: string };

const t = (message: string, ...args: string[]): Label => ({ message, args });
const pkg = (packageKey: string): Label => ({ packageKey });

export function resolveLabel(label: Label, l10n: DesktopLocalizationService): string {
  if ('text' in label) return label.text;
  return 'packageKey' in label ? l10n.packageString(label.packageKey) : l10n.t(label.message, ...(label.args ?? []));
}

// How a run started: a menu click, a menu accelerator, or the palette.
export type CommandSource = 'menu' | 'accelerator' | 'palette';

/** A desktop command (AD11): the menu bar and the palette are both built from these. The context is the menu state. */
export interface Command {
  readonly id: string;
  readonly title: Label;
  // the title while the context holds a mode that changes what the command does; absent: title
  readonly titleIn?: (context: MenuState) => Label;
  readonly category: Label;
  // the menu item's label when it differs from the palette title (Command Palette... for Show All Commands)
  readonly menuLabel?: Label;
  readonly sublabel?: string;
  readonly accelerator?: string;
  // a Monaco keybinding (a chord) shown as the palette's hint; never a menu accelerator
  readonly keybinding?: readonly string[];
  // the accelerator is only shown here: another owner (an item that routes it by focus, the xterm) handles the key
  readonly registerAccelerator?: false;
  // VS Code's precondition, which never reads keyboard focus: the menu item, the palette entry and the key; absent: always
  readonly enabled?: (context: MenuState) => boolean;
  // VS Code's menus.commandPalette when clause: the palette lists the command only while it holds; absent: always listed
  readonly palette?: (context: MenuState) => boolean;
  // while it holds, the command leaves the palette and its menu item leaves the menu, which a change rebuilds
  readonly hidden?: (context: MenuState) => boolean;
  // the accelerator also fires while an xterm has focus (VS Code's commandsToSkipShell); every other one reaches the pty
  readonly inTerminal?: true;
  // VS Code's keybinding when clause: whether the accelerator runs the command, never whether its menu item is enabled
  readonly keyWhen?: (context: MenuState) => boolean;
  readonly run: (context: MenuState, source: CommandSource) => void;
}

// Save, Save As, Format Document and Close Editor act on the active editor tab; their keys fire only from the editor.
const hasEditor = (context: MenuState): boolean => context.editor;
const editorFocus = (context: MenuState): boolean => context.focus === 'editor';

const hasChat = (context: MenuState): boolean => context.chat;

const hasTerminal = (context: MenuState): boolean => context.terminal !== undefined;

// VS Code's terminalFocus, the xterm's own input rather than anywhere in the pane, and splitTerminalActive (terminalActions.ts).
const terminalFocus = (context: MenuState): boolean => context.focus === 'terminal' && context.terminalInput;
const splitTerminalFocus = (context: MenuState): boolean => terminalFocus(context) && context.terminalSplit;

// A Search Editor tab is the active editor and the editor holds keyboard focus (VS Code's InSearchEditor).
const inSearchEditor = (context: MenuState): boolean => context.focus === 'editor' && context.search.editorActive;

// A key or the palette acts where focus was; a menu click, which takes focus to the title bar, on the active editor (VS Code's
// focusNextSearchResult).
const toSearchEditor = (context: MenuState, source: CommandSource): boolean => (source === 'menu' ? context.search.editorActive : inSearchEditor(context));

// The Search Editor commands (searchEditor.contribution.ts), with VS Code's keys; titles that do not name the editor say so.
const SEARCH_EDITOR_COMMANDS: ReadonlyArray<{ readonly id: string; readonly command: SearchEditorCommand; readonly title: Label; readonly accelerator?: string }> = [
  { id: MENU_IDS.searchAgain, command: 'rerun', title: t('Search Again in Search Editor'), accelerator: SEARCH_AGAIN_ACCELERATOR },
  { id: MENU_IDS.focusSearchEditorInput, command: 'focusInput', title: t('Focus Search Editor Input') },
  { id: MENU_IDS.focusSearchEditorIncludes, command: 'focusIncludes', title: t('Focus Search Editor Files to Include') },
  { id: MENU_IDS.focusSearchEditorExcludes, command: 'focusExcludes', title: t('Focus Search Editor Files to Exclude') },
  { id: MENU_IDS.toggleSearchEditorMatchCase, command: 'toggleMatchCase', title: t('Toggle Match Case in Search Editor') },
  { id: MENU_IDS.toggleSearchEditorWholeWord, command: 'toggleWholeWord', title: t('Toggle Match Whole Word in Search Editor') },
  { id: MENU_IDS.toggleSearchEditorRegex, command: 'toggleRegex', title: t('Toggle Use Regular Expression in Search Editor') },
  { id: MENU_IDS.toggleSearchEditorContextLines, command: 'toggleContextLines', title: t('Toggle Context Lines in Search Editor'), accelerator: 'Alt+L' },
  { id: MENU_IDS.increaseSearchEditorContextLines, command: 'increaseContextLines', title: t('Increase Context Lines in Search Editor'), accelerator: 'Alt+=' },
  { id: MENU_IDS.decreaseSearchEditorContextLines, command: 'decreaseContextLines', title: t('Decrease Context Lines in Search Editor'), accelerator: 'Alt+-' },
  { id: MENU_IDS.selectAllSearchEditorMatches, command: 'selectAllMatches', title: t('Select All Matches in Search Editor'), accelerator: 'CmdOrCtrl+Shift+L' },
  { id: MENU_IDS.deleteSearchEditorFileResults, command: 'deleteFileResults', title: t('Delete File Results in Search Editor'), accelerator: 'CmdOrCtrl+Shift+Backspace' },
];

export const SEARCH_EDITOR_COMMAND_IDS: readonly string[] = SEARCH_EDITOR_COMMANDS.map((command) => command.id);

// The Search view's palette commands (searchActionsTopBar.ts); the view carries them out.
const SEARCH_VIEW_COMMANDS: ReadonlyArray<{ readonly id: string; readonly command: SearchViewCommand; readonly title: Label; readonly enabled: (context: MenuState) => boolean }> = [
  { id: MENU_IDS.refreshSearch, command: 'refresh', title: t('Refresh'), enabled: (context) => context.search.viewHasSearch },
  { id: MENU_IDS.clearSearchResults, command: 'clearResults', title: t('Clear Search Results'), enabled: (context) => context.search.viewHasSearch },
  { id: MENU_IDS.collapseSearchResults, command: 'collapseAll', title: t('Collapse All'), enabled: (context) => context.search.viewHasResults },
  { id: MENU_IDS.expandSearchResults, command: 'expandAll', title: t('Expand All'), enabled: (context) => context.search.viewHasResults },
  { id: MENU_IDS.viewAsTree, command: 'viewAsTree', title: t('View as Tree'), enabled: () => true },
  { id: MENU_IDS.viewAsList, command: 'viewAsList', title: t('View as List'), enabled: () => true },
];

// The Chat menu's chat features (D28), in the order the menu lists them.
const CHAT_FEATURES: ReadonlyArray<{ readonly id: string; readonly command: ChatCommand; readonly title: Label }> = [
  { id: MENU_IDS.chatContextUsage, command: 'contextUsage', title: t('Context usage') },
  { id: MENU_IDS.chatSubscriptionUsage, command: 'subscriptionUsage', title: t('Subscription usage') },
  { id: MENU_IDS.chatUsageStatistics, command: 'usageStatistics', title: t('Usage statistics') },
  { id: MENU_IDS.chatMcpServers, command: 'mcpServers', title: t('MCP servers') },
  { id: MENU_IDS.chatTools, command: 'tools', title: t('Tools') },
  { id: MENU_IDS.chatMemory, command: 'memory', title: t('Memory') },
  { id: MENU_IDS.chatRewind, command: 'rewind', title: t('Rewind') },
  { id: MENU_IDS.chatSideQuestion, command: 'sideQuestion', title: t('Side question') },
  { id: MENU_IDS.chatOpenSessionLog, command: 'openSessionLog', title: t('Open session log') },
  { id: MENU_IDS.chatViewSessionPlan, command: 'viewSessionPlan', title: t('View session plan') },
];

export const CHAT_FEATURE_IDS: readonly string[] = CHAT_FEATURES.map((feature) => feature.id);

// Source control's commands: VS Code's titles, its menus.commandPalette when clauses as palette and its enablement as enabled
// (extensions/git/package.json).
export const GIT_COMMAND_IDS: readonly string[] = Object.entries(MENU_IDS).filter(([key]) => key.startsWith('git')).map(([, id]) => id);

// The editor's change navigation and merge-conflict commands, which the Edit menu lists in these groups.
export const EDITOR_GIT_MENU_GROUPS: ReadonlyArray<readonly string[]> = [
  [MENU_IDS.nextChange, MENU_IDS.previousChange],
  [MENU_IDS.mergeAcceptCurrent, MENU_IDS.mergeAcceptIncoming, MENU_IDS.mergeAcceptBoth, MENU_IDS.mergeAcceptAllCurrent, MENU_IDS.mergeAcceptAllIncoming, MENU_IDS.mergeNextConflict, MENU_IDS.mergePreviousConflict],
];

// View › Source Control with a separator between groups, as VS Code's SCM menus group these commands. Holds each
// GIT_COMMAND_IDS entry once.
export const GIT_MENU_GROUPS: ReadonlyArray<readonly string[]> = [
  [MENU_IDS.gitInit, MENU_IDS.gitOpenRepository, MENU_IDS.gitClose, MENU_IDS.gitCloseOtherRepositories, MENU_IDS.gitReopenClosedRepositories, MENU_IDS.gitOpenRepositoriesInParentFolders, MENU_IDS.gitManageUnsafeRepositories, MENU_IDS.gitRefresh],
  [MENU_IDS.gitCommit, MENU_IDS.gitCommitStaged, MENU_IDS.gitCommitAll, MENU_IDS.gitUndoCommit, MENU_IDS.gitRebaseAbort, MENU_IDS.gitMergeAbort, MENU_IDS.gitCherryPickAbort],
  [MENU_IDS.gitCommitNoVerify, MENU_IDS.gitCommitStagedNoVerify, MENU_IDS.gitCommitAllNoVerify],
  [MENU_IDS.gitCommitAmend, MENU_IDS.gitCommitStagedAmend, MENU_IDS.gitCommitAllAmend],
  [MENU_IDS.gitCommitAmendNoVerify, MENU_IDS.gitCommitStagedAmendNoVerify, MENU_IDS.gitCommitAllAmendNoVerify],
  [MENU_IDS.gitCommitSigned, MENU_IDS.gitCommitStagedSigned, MENU_IDS.gitCommitAllSigned],
  [MENU_IDS.gitCommitSignedNoVerify, MENU_IDS.gitCommitStagedSignedNoVerify, MENU_IDS.gitCommitAllSignedNoVerify],
  [MENU_IDS.gitCommitEmpty, MENU_IDS.gitCommitEmptyNoVerify],
  [MENU_IDS.gitStageAll, MENU_IDS.gitUnstageAll, MENU_IDS.gitCleanAll],
  [MENU_IDS.gitStageAllTracked, MENU_IDS.gitStageAllUntracked, MENU_IDS.gitStageAllMerge, MENU_IDS.gitCleanAllTracked, MENU_IDS.gitCleanAllUntracked, MENU_IDS.gitViewChanges, MENU_IDS.gitViewStagedChanges, MENU_IDS.gitViewUntrackedChanges, MENU_IDS.gitOpenAllChanges],
  [MENU_IDS.gitOpenFile, MENU_IDS.gitOpenHeadFile, MENU_IDS.gitOpenChange, MENU_IDS.gitStage, MENU_IDS.gitUnstage, MENU_IDS.gitClean, MENU_IDS.gitIgnore, MENU_IDS.gitRename, MENU_IDS.gitDelete],
  [MENU_IDS.gitCloseAllDiffEditors, MENU_IDS.gitCloseAllUnmodifiedEditors],
  [MENU_IDS.gitClone, MENU_IDS.gitCloneRecursive],
  [MENU_IDS.gitPull, MENU_IDS.gitPullRebase, MENU_IDS.gitPullFrom, MENU_IDS.gitPush, MENU_IDS.gitPushTo, MENU_IDS.gitPushWithTags, MENU_IDS.gitSync, MENU_IDS.gitSyncRebase, MENU_IDS.gitPublish],
  [MENU_IDS.gitPushForce, MENU_IDS.gitPushToForce, MENU_IDS.gitPushWithTagsForce],
  [MENU_IDS.gitFetch, MENU_IDS.gitFetchPrune, MENU_IDS.gitFetchAll],
  [MENU_IDS.gitAddRemote, MENU_IDS.gitRemoveRemote],
  [MENU_IDS.gitCheckout, MENU_IDS.gitCheckoutDetached, MENU_IDS.gitMerge, MENU_IDS.gitRebase, MENU_IDS.gitCherryPick, MENU_IDS.gitBranch, MENU_IDS.gitBranchFrom, MENU_IDS.gitRenameBranch, MENU_IDS.gitDeleteBranch, MENU_IDS.gitDeleteRemoteBranch],
  [MENU_IDS.gitStash, MENU_IDS.gitStashIncludeUntracked, MENU_IDS.gitStashStaged, MENU_IDS.gitStashApplyLatest, MENU_IDS.gitStashApply, MENU_IDS.gitStashPopLatest, MENU_IDS.gitStashPop, MENU_IDS.gitStashDrop, MENU_IDS.gitStashDropAll, MENU_IDS.gitStashView],
  [MENU_IDS.gitCreateTag, MENU_IDS.gitDeleteTag, MENU_IDS.gitDeleteRemoteTag, MENU_IDS.gitPushTags],
  [MENU_IDS.gitCreateWorktree, MENU_IDS.gitDeleteWorktree],
  [MENU_IDS.gitStageSelectedRanges, MENU_IDS.gitUnstageSelectedRanges, MENU_IDS.gitRevertSelectedRanges],
  [MENU_IDS.gitOpenTimeline, MENU_IDS.gitShowLineBlame, MENU_IDS.gitToggleInlineBlame],
  [MENU_IDS.gitShowOutput],
];

function gitCommands(actions: MenuActions): Command[] {
  const git = t('Git');
  const available = (context: MenuState): boolean => context.scm.available;
  const open = (context: MenuState): boolean => context.scm.available && context.scm.openRepositoryCount !== 0;
  const changed = (context: MenuState): boolean => open(context) && context.scm.activeFileHasChanges;
  const inProgress = (operation: MenuState['scm']['operation']) => (context: MenuState): boolean => open(context) && context.scm.operation === operation;
  // a menu item is enabled only where the palette lists the command, so a click never acts on nothing
  const command = (id: string, title: Label, palette: (context: MenuState) => boolean, run: () => void, enabled?: (context: MenuState) => boolean, amendedTitle?: Label): Command => ({
    id,
    title,
    ...(amendedTitle ? { titleIn: (context: MenuState) => (context.scm.amending ? amendedTitle : title) } : {}),
    category: git,
    palette,
    enabled: (context) => palette(context) && (enabled?.(context) ?? true),
    run,
  });
  const activeFile = (op: Parameters<MenuActions['scmActiveFile']>[0]) => () => actions.scmActiveFile(op);
  const noVerify = (context: MenuState): boolean => open(context) && context.scm.allowNoVerifyCommit;
  const commit = (scope: ScmCommitVariant['scope'], flags: Partial<Omit<ScmCommitVariant, 'scope'>> = {}) => () =>
    actions.scmCommit({ scope, amend: false, signoff: false, noVerify: false, empty: false, ...flags });
  // VS Code's commit variants (git.commit* in extensions/git/package.json), each with its exact title, and the title of what
  // the commit box's amend mode makes it (the shell's AMENDED_LABELS in scm-menus.ts)
  const commits: ReadonlyArray<readonly [string, Label, ScmCommitVariant['scope'], Partial<Omit<ScmCommitVariant, 'scope'>>, Label?]> = [
    [MENU_IDS.gitCommitStaged, t('Commit Staged'), 'staged', {}, t('Commit Staged (Amend)')],
    [MENU_IDS.gitCommitAll, t('Commit All'), 'all', {}, t('Commit All (Amend)')],
    [MENU_IDS.gitCommitAmend, t('Commit (Amend)'), 'auto', { amend: true }],
    [MENU_IDS.gitCommitStagedAmend, t('Commit Staged (Amend)'), 'staged', { amend: true }],
    [MENU_IDS.gitCommitAllAmend, t('Commit All (Amend)'), 'all', { amend: true }],
    [MENU_IDS.gitCommitSigned, t('Commit (Signed Off)'), 'auto', { signoff: true }, t('Commit (Amend, Signed Off)')],
    [MENU_IDS.gitCommitStagedSigned, t('Commit Staged (Signed Off)'), 'staged', { signoff: true }, t('Commit Staged (Amend, Signed Off)')],
    [MENU_IDS.gitCommitAllSigned, t('Commit All (Signed Off)'), 'all', { signoff: true }, t('Commit All (Amend, Signed Off)')],
    [MENU_IDS.gitCommitNoVerify, t('Commit (No Verify)'), 'auto', { noVerify: true }, t('Commit (Amend, No Verify)')],
    [MENU_IDS.gitCommitStagedNoVerify, t('Commit Staged (No Verify)'), 'staged', { noVerify: true }, t('Commit Staged (Amend, No Verify)')],
    [MENU_IDS.gitCommitAllNoVerify, t('Commit All (No Verify)'), 'all', { noVerify: true }, t('Commit All (Amend, No Verify)')],
    [MENU_IDS.gitCommitAmendNoVerify, t('Commit (Amend, No Verify)'), 'auto', { amend: true, noVerify: true }],
    [MENU_IDS.gitCommitStagedAmendNoVerify, t('Commit Staged (Amend, No Verify)'), 'staged', { amend: true, noVerify: true }],
    [MENU_IDS.gitCommitAllAmendNoVerify, t('Commit All (Amend, No Verify)'), 'all', { amend: true, noVerify: true }],
    [MENU_IDS.gitCommitSignedNoVerify, t('Commit (Signed Off, No Verify)'), 'auto', { signoff: true, noVerify: true }, t('Commit (Amend, Signed Off, No Verify)')],
    [MENU_IDS.gitCommitStagedSignedNoVerify, t('Commit Staged (Signed Off, No Verify)'), 'staged', { signoff: true, noVerify: true }, t('Commit Staged (Amend, Signed Off, No Verify)')],
    [MENU_IDS.gitCommitAllSignedNoVerify, t('Commit All (Signed Off, No Verify)'), 'all', { signoff: true, noVerify: true }, t('Commit All (Amend, Signed Off, No Verify)')],
    [MENU_IDS.gitCommitEmpty, t('Commit Empty'), 'auto', { empty: true }, t('Commit Empty (Amend)')],
    [MENU_IDS.gitCommitEmptyNoVerify, t('Commit Empty (No Verify)'), 'auto', { empty: true, noVerify: true }, t('Commit Empty (Amend, No Verify)')],
  ];
  // in amend mode every other variant amends, so the amend ones leave the palette and the menu, as they leave the commit box's
  const amending = (context: MenuState): boolean => context.scm.amending;
  // VS Code's enablement !operationInProgress on the remote commands: one remote operation runs per repository
  const idle = (context: MenuState): boolean => !context.scm.remoteRunning;
  const idleCommand = (id: string, title: Label, request: Parameters<MenuActions['scmRun']>[0]): Command => command(id, title, open, () => actions.scmRun(request), idle);
  // config.git.allowForcePush: the force variants exist only while it is on, in the palette and the menu alike
  const forceCommand = (id: string, title: Label, request: Parameters<MenuActions['scmRun']>[0]): Command => ({
    ...command(id, title, (context) => open(context) && context.scm.allowForcePush, () => actions.scmRun(request), idle),
    hidden: (context) => !context.scm.allowForcePush,
  });
  // Clone runs no code of an existing repository, so it needs git alone, whatever the selected project's trust
  const cloneAvailable = (context: MenuState): boolean => context.scm.gitFound;
  return [
    command(MENU_IDS.gitInit, t('Initialize Repository'), available, () => actions.scmRun({ op: 'init' })),
    command(MENU_IDS.gitOpenRepository, t('Open Repository'), available, () => actions.scmRun({ op: 'openRepository' })),
    command(MENU_IDS.gitClose, t('Close Repository'), open, () => actions.scmRun({ op: 'closeRepository' })),
    command(MENU_IDS.gitCloseOtherRepositories, t('Close Other Repositories'), (context) => available(context) && context.scm.openRepositoryCount > 1, () => actions.scmRun({ op: 'closeOtherRepositories' })),
    command(MENU_IDS.gitReopenClosedRepositories, t('Reopen Closed Repositories...'), () => true, () => actions.scmRun({ op: 'reopenClosed' }), (context) => context.scm.closedRepositoryCount !== 0),
    command(MENU_IDS.gitRefresh, t('Refresh'), open, () => actions.scmRun({ op: 'refresh' })),
    command(MENU_IDS.gitShowOutput, t('Show Git Output'), () => true, () => actions.scmRun({ op: 'showOutput' })),
    command(MENU_IDS.gitStage, t('Stage Changes'), open, activeFile('stage')),
    command(MENU_IDS.gitStageAll, t('Stage All Changes'), open, () => actions.scmRun({ op: 'stageAll', scope: 'all' })),
    command(MENU_IDS.gitStageAllTracked, t('Stage All Tracked Changes'), open, () => actions.scmRun({ op: 'stageAll', scope: 'tracked' })),
    command(MENU_IDS.gitStageAllUntracked, t('Stage All Untracked Changes'), open, () => actions.scmRun({ op: 'stageAll', scope: 'untracked' })),
    command(MENU_IDS.gitStageAllMerge, t('Stage All Merge Changes'), open, () => actions.scmRun({ op: 'stageAll', scope: 'merge' })),
    command(MENU_IDS.gitUnstage, t('Unstage Changes'), open, activeFile('unstage')),
    command(MENU_IDS.gitUnstageAll, t('Unstage All Changes'), open, () => actions.scmRun({ op: 'unstageAll' })),
    command(MENU_IDS.gitClean, t('Discard Changes'), open, activeFile('discard')),
    command(MENU_IDS.gitCleanAll, t('Discard All Changes'), open, () => actions.scmRun({ op: 'discardAll', scope: 'all' })),
    command(MENU_IDS.gitCleanAllTracked, t('Discard All Tracked Changes'), open, () => actions.scmRun({ op: 'discardAll', scope: 'tracked' })),
    command(MENU_IDS.gitCleanAllUntracked, t('Discard All Untracked Changes'), open, () => actions.scmRun({ op: 'discardAll', scope: 'untracked' })),
    command(MENU_IDS.gitOpenChange, t('Open Changes'), open, activeFile('openChanges')),
    command(MENU_IDS.gitOpenFile, t('Open File'), changed, activeFile('openFile')),
    command(MENU_IDS.gitOpenHeadFile, t('Open File (HEAD)'), changed, activeFile('openFileHead')),
    command(MENU_IDS.gitIgnore, t('Add to .gitignore'), (context) => open(context) && context.scm.activeFileInRepository, activeFile('addToGitignore')),
    command(MENU_IDS.gitCommit, t('Commit'), open, commit('auto'), undefined, t('Commit (Amend)')),
    ...commits.map(([id, title, scope, flags, amendedTitle]): Command => ({
      ...command(id, title, flags.noVerify ? noVerify : open, commit(scope, flags), undefined, amendedTitle),
      ...(flags.amend ? { hidden: amending } : {}),
    })),
    command(MENU_IDS.gitUndoCommit, t('Undo Last Commit'), open, () => actions.scmRun({ op: 'undoLastCommit' })),
    command(MENU_IDS.gitRename, t('Rename'), (context) => open(context) && context.scm.activeEditorFile && context.scm.activeFileInRepository, activeFile('rename')),
    command(MENU_IDS.gitDelete, t('Delete'), (context) => open(context) && context.scm.activeEditorFile, activeFile('delete')),
    command(MENU_IDS.gitOpenAllChanges, t('Open All Changes'), () => true, () => actions.scmRun({ op: 'openAllChanges' }), open),
    command(MENU_IDS.gitCloseAllDiffEditors, t('Close All Diff Editors'), open, () => actions.scmRun({ op: 'closeAllDiffEditors' })),
    command(MENU_IDS.gitCloseAllUnmodifiedEditors, t('Close All Unmodified Editors'), () => true, () => actions.scmRun({ op: 'closeAllUnmodifiedEditors' })),
    command(MENU_IDS.gitMergeAbort, t('Abort Merge'), inProgress('merge'), () => actions.scmRun({ op: 'abortOperation' }), (context) => context.scm.operation === 'merge'),
    command(MENU_IDS.gitRebaseAbort, t('Abort Rebase'), inProgress('rebase'), () => actions.scmRun({ op: 'abortOperation' }), (context) => context.scm.operation === 'rebase'),
    command(MENU_IDS.gitCherryPickAbort, t('Abort Cherry Pick'), inProgress('cherryPick'), () => actions.scmRun({ op: 'abortOperation' })),
    command(MENU_IDS.gitViewChanges, t('Open Changes'), available, () => actions.scmRun({ op: 'openGroupChanges', group: 'workingTree' })),
    command(MENU_IDS.gitViewStagedChanges, t('Open Staged Changes'), available, () => actions.scmRun({ op: 'openGroupChanges', group: 'index' })),
    command(MENU_IDS.gitViewUntrackedChanges, t('Open Untracked Changes'), (context) => available(context) && context.scm.untrackedChanges === 'separate', () => actions.scmRun({ op: 'openGroupChanges', group: 'untracked' })),
    command(MENU_IDS.gitManageUnsafeRepositories, t('Manage Unsafe Repositories'), (context) => available(context) && context.scm.unsafeRepositoryCount !== 0, () => actions.scmRun({ op: 'manageUnsafeRepositories' })),
    command(MENU_IDS.gitOpenRepositoriesInParentFolders, t('Open Repositories In Parent Folders'), (context) => available(context) && context.scm.parentRepositoryCount !== 0, () => actions.scmRun({ op: 'openParentRepositories' })),
    command(MENU_IDS.gitClone, t('Clone'), cloneAvailable, () => actions.scmRun({ op: 'clone', recursive: false })),
    command(MENU_IDS.gitCloneRecursive, t('Clone (Recursive)'), cloneAvailable, () => actions.scmRun({ op: 'clone', recursive: true })),
    idleCommand(MENU_IDS.gitFetch, t('Fetch'), { op: 'fetch', scope: 'default' }),
    idleCommand(MENU_IDS.gitFetchPrune, t('Fetch (Prune)'), { op: 'fetch', scope: 'prune' }),
    idleCommand(MENU_IDS.gitFetchAll, t('Fetch From All Remotes'), { op: 'fetch', scope: 'all' }),
    idleCommand(MENU_IDS.gitPull, t('Pull'), { op: 'pull', rebase: false }),
    idleCommand(MENU_IDS.gitPullRebase, t('Pull (Rebase)'), { op: 'pull', rebase: true }),
    idleCommand(MENU_IDS.gitPullFrom, t('Pull from...'), { op: 'pullFrom' }),
    idleCommand(MENU_IDS.gitPush, t('Push'), { op: 'push', to: false, force: false, followTags: false }),
    forceCommand(MENU_IDS.gitPushForce, t('Push (Force)'), { op: 'push', to: false, force: true, followTags: false }),
    idleCommand(MENU_IDS.gitPushTo, t('Push to...'), { op: 'push', to: true, force: false, followTags: false }),
    forceCommand(MENU_IDS.gitPushToForce, t('Push to... (Force)'), { op: 'push', to: true, force: true, followTags: false }),
    idleCommand(MENU_IDS.gitPushWithTags, t('Push (Follow Tags)'), { op: 'push', to: false, force: false, followTags: true }),
    forceCommand(MENU_IDS.gitPushWithTagsForce, t('Push (Follow Tags, Force)'), { op: 'push', to: false, force: true, followTags: true }),
    idleCommand(MENU_IDS.gitSync, t('Sync'), { op: 'sync', rebase: false }),
    idleCommand(MENU_IDS.gitSyncRebase, t('Sync (Rebase)'), { op: 'sync', rebase: true }),
    idleCommand(MENU_IDS.gitPublish, t('Publish Branch...'), { op: 'publish' }),
    idleCommand(MENU_IDS.gitAddRemote, t('Add Remote...'), { op: 'addRemote' }),
    idleCommand(MENU_IDS.gitRemoveRemote, t('Remove Remote'), { op: 'removeRemote' }),
    command(MENU_IDS.gitCheckout, t('Checkout to...'), open, () => actions.scmRun({ op: 'checkout', detached: false })),
    command(MENU_IDS.gitCheckoutDetached, t('Checkout to (Detached)...'), open, () => actions.scmRun({ op: 'checkout', detached: true })),
    command(MENU_IDS.gitBranch, t('Create Branch...'), open, () => actions.scmRun({ op: 'createBranch', from: false })),
    command(MENU_IDS.gitBranchFrom, t('Create Branch From...'), open, () => actions.scmRun({ op: 'createBranch', from: true })),
    command(MENU_IDS.gitRenameBranch, t('Rename Branch...'), open, () => actions.scmRun({ op: 'renameBranch' })),
    command(MENU_IDS.gitDeleteBranch, t('Delete Branch...'), open, () => actions.scmRun({ op: 'deleteBranch' })),
    idleCommand(MENU_IDS.gitDeleteRemoteBranch, t('Delete Remote Branch...'), { op: 'deleteRemoteBranch' }),
    command(MENU_IDS.gitMerge, t('Merge...'), open, () => actions.scmRun({ op: 'merge' })),
    command(MENU_IDS.gitRebase, t('Rebase Branch...'), open, () => actions.scmRun({ op: 'rebase' })),
    // VS Code's git.cherryPick, enabled only with no merge, rebase or cherry-pick in progress
    command(MENU_IDS.gitCherryPick, t('Cherry Pick...'), (context) => open(context) && context.scm.operation === null, () => actions.scmRun({ op: 'cherryPick' })),
    command(MENU_IDS.gitCreateTag, t('Create Tag...'), open, () => actions.scmRun({ op: 'createTag' })),
    command(MENU_IDS.gitDeleteTag, t('Delete Tag...'), open, () => actions.scmRun({ op: 'deleteTag' })),
    idleCommand(MENU_IDS.gitDeleteRemoteTag, t('Delete Remote Tag...'), { op: 'deleteRemoteTag' }),
    idleCommand(MENU_IDS.gitPushTags, t('Push Tags'), { op: 'pushTags' }),
    command(MENU_IDS.gitCreateWorktree, t('Create Worktree...'), open, () => actions.scmRun({ op: 'createWorktree' })),
    command(MENU_IDS.gitDeleteWorktree, t('Delete Worktree...'), open, () => actions.scmRun({ op: 'deleteWorktree' })),
    command(MENU_IDS.gitStash, t('Stash'), open, () => actions.scmRun({ op: 'stash', scope: 'default' })),
    command(MENU_IDS.gitStashIncludeUntracked, t('Stash (Include Untracked)'), open, () => actions.scmRun({ op: 'stash', scope: 'includeUntracked' })),
    // VS Code's gitVersion2.35: Stash Staged exists only with git 2.35 or later, in the palette and the menu alike
    {
      ...command(MENU_IDS.gitStashStaged, t('Stash Staged'), (context) => open(context) && context.scm.stashStaged, () => actions.scmRun({ op: 'stash', scope: 'staged' })),
      hidden: (context) => !context.scm.stashStaged,
    },
    command(MENU_IDS.gitStashApplyLatest, t('Apply Latest Stash'), open, () => actions.scmRun({ op: 'stashApply', pop: false, target: 'latest' })),
    command(MENU_IDS.gitStashApply, t('Apply Stash...'), open, () => actions.scmRun({ op: 'stashApply', pop: false, target: 'pick' })),
    command(MENU_IDS.gitStashPopLatest, t('Pop Latest Stash'), open, () => actions.scmRun({ op: 'stashApply', pop: true, target: 'latest' })),
    command(MENU_IDS.gitStashPop, t('Pop Stash...'), open, () => actions.scmRun({ op: 'stashApply', pop: true, target: 'pick' })),
    command(MENU_IDS.gitStashDrop, t('Drop Stash...'), open, () => actions.scmRun({ op: 'stashDrop', target: 'pick' })),
    command(MENU_IDS.gitStashDropAll, t('Drop All Stashes...'), open, () => actions.scmRun({ op: 'stashDropAll' })),
    // VS Code lists View Stash... with config.git.enabled && !git.missing alone; with no repository it says so
    command(MENU_IDS.gitStashView, t('View Stash...'), available, () => actions.scmRun({ op: 'viewStash', target: 'pick' })),
    // resourceScheme == file: a code tab of a repository file, or a diff tab against the index whose right side is that file
    {
      ...command(MENU_IDS.gitStageSelectedRanges, t('Stage Selected Ranges'), (context) => open(context) && (context.editorGit === 'file' || context.editorGit === 'workingTreeDiff'), () => actions.editorCommand('stageSelectedRanges')),
      keybinding: EDITOR_GIT_KEYBINDINGS.stageSelectedRanges,
    },
    // resourceScheme == git: a diff tab of staged changes, whose right side is the index
    {
      ...command(MENU_IDS.gitUnstageSelectedRanges, t('Unstage Selected Ranges'), (context) => open(context) && context.editorGit === 'indexDiff', () => actions.editorCommand('unstageSelectedRanges')),
      keybinding: EDITOR_GIT_KEYBINDINGS.unstageSelectedRanges,
    },
    {
      ...command(MENU_IDS.gitRevertSelectedRanges, t('Revert Selected Ranges'), (context) => open(context) && (context.editorGit === 'file' || context.editorGit === 'workingTreeDiff'), () => actions.editorCommand('revertSelectedRanges')),
      keybinding: EDITOR_GIT_KEYBINDINGS.revertSelectedRanges,
    },
    command(MENU_IDS.gitOpenTimeline, t('Open Timeline'), (context) => open(context) && context.editorGit !== null, () => actions.editorCommand('openTimeline')),
    // the keyboard's way to the inline blame's card on a code tab of a repository file
    command(MENU_IDS.gitShowLineBlame, t('Show Line Blame'), (context) => open(context) && context.editorGit === 'file', () => actions.editorCommand('showLineBlame')),
    // git.blame.toggleEditorDecoration is always in VS Code's palette; it flips the setting
    command(MENU_IDS.gitToggleInlineBlame, t('Toggle Inline Blame'), () => true, () => actions.toggleInlineBlame()),
  ];
}

// The editor's change navigation (quickDiffWidget.ts Go to Next and Previous Change) and merge-conflict's commands, each on
// the active editor; palette entries for what the gutter, the peek and the code lenses offer.
function editorGitCommands(actions: MenuActions): Command[] {
  const edit = t('Edit');
  const merge = t('Merge Conflict');
  // a text, diff or merge tab, where the editor carries the command out
  const changes = (context: MenuState): boolean => context.editor && (context.editorGit !== null || context.editorKind === 'diff');
  // merge-conflict reads text alone, so any editable text tab or the merge editor
  const conflicts = (context: MenuState): boolean => context.editor && (context.editorKind === 'code' || context.editorKind === 'untitled' || context.editorKind === 'merge');
  const conflictCommand = (id: string, title: Label, command: EditorCommand): Command => ({ id, title, category: merge, enabled: conflicts, run: () => actions.editorCommand(command) });
  return [
    { id: MENU_IDS.nextChange, title: t('Go to Next Change'), category: edit, keybinding: EDITOR_GIT_KEYBINDINGS.nextChange, enabled: changes, run: () => actions.editorCommand('nextChange') },
    { id: MENU_IDS.previousChange, title: t('Go to Previous Change'), category: edit, keybinding: EDITOR_GIT_KEYBINDINGS.previousChange, enabled: changes, run: () => actions.editorCommand('previousChange') },
    conflictCommand(MENU_IDS.mergeAcceptCurrent, t('Accept Current'), 'acceptCurrent'),
    conflictCommand(MENU_IDS.mergeAcceptIncoming, t('Accept Incoming'), 'acceptIncoming'),
    conflictCommand(MENU_IDS.mergeAcceptBoth, t('Accept Both'), 'acceptBoth'),
    conflictCommand(MENU_IDS.mergeAcceptAllCurrent, t('Accept All Current'), 'acceptAllCurrent'),
    conflictCommand(MENU_IDS.mergeAcceptAllIncoming, t('Accept All Incoming'), 'acceptAllIncoming'),
    conflictCommand(MENU_IDS.mergeNextConflict, t('Next Conflict'), 'nextConflict'),
    conflictCommand(MENU_IDS.mergePreviousConflict, t('Previous Conflict'), 'previousConflict'),
  ];
}

/** Every desktop command, the per-project ones included; ids are unique. */
export function desktopCommands(projects: readonly OpenFolder[], actions: MenuActions, platform: NodeJS.Platform): Command[] {
  const mac = platform === 'darwin';
  const linux = platform === 'linux';
  const file = t('File');
  const view = t('View');
  const chat = t('Chat');
  const help = t('Help');
  const search = t('Search');
  const edit = t('Edit');
  const terminal = t('Terminal');
  // Ctrl+Tab and Ctrl+Shift+Tab: the next or previous editor while the editor holds focus, else the next or previous chat.
  const relative = (delta: 1 | -1) => (_context: MenuState, source: CommandSource): void => {
    if (source === 'accelerator') actions.relativeByKeyboard(delta);
    else actions.selectRelativeChat(delta);
  };
  return [
    { id: MENU_IDS.newChat, title: t('New Chat'), category: file, accelerator: NEW_CHAT_ACCELERATOR, inTerminal: true, run: () => actions.newChat() },
    // the selected chat's live worktree; other callers name one through MenuActions.newChatInWorktree
    {
      id: MENU_IDS.chatNewInWorktree,
      title: t('New Chat in This Worktree'),
      category: chat,
      accelerator: newChatInWorktreeAccelerator(platform),
      inTerminal: true,
      enabled: (context) => context.newChatInWorktree !== undefined,
      run: (context) => actions.newChatInWorktree(context.newChatInWorktree),
    },
    { id: MENU_IDS.openChat, title: pkg('command.openChat.title'), category: file, accelerator: 'CmdOrCtrl+Shift+U', run: () => actions.openChat() },
    ...projects.map((project): Command => ({
      id: openChatForProjectId(project.fsPath),
      title: t('Open Chat in {0}', project.name),
      menuLabel: { text: project.name },
      sublabel: project.fsPath,
      category: file,
      run: () => actions.openChatForProject(project.fsPath),
    })),
    { id: MENU_IDS.quickOpen, title: t('Quick Open...'), category: file, accelerator: QUICK_OPEN_ACCELERATOR, inTerminal: true, run: () => actions.quickOpen() },
    { id: MENU_IDS.save, title: t('Save'), category: file, accelerator: 'CmdOrCtrl+S', enabled: hasEditor, keyWhen: editorFocus, run: () => actions.saveEditor() },
    { id: MENU_IDS.saveAs, title: t('Save As...'), category: file, accelerator: 'CmdOrCtrl+Shift+S', enabled: hasEditor, keyWhen: editorFocus, run: () => actions.saveEditorAs() },
    { id: MENU_IDS.addProject, title: t('Add Project...'), category: file, run: () => actions.addProject() },
    { id: MENU_IDS.openSettings, title: t('Settings...'), category: file, accelerator: OPEN_SETTINGS_ACCELERATOR, inTerminal: true, run: () => actions.openSettings() },
    { id: MENU_IDS.closeEditor, title: t('Close Editor'), category: file, accelerator: CLOSE_EDITOR_ACCELERATOR, enabled: hasEditor, keyWhen: editorFocus, run: () => actions.closeEditor() },
    { id: MENU_IDS.formatDocument, title: t('Format Document'), category: edit, accelerator: FORMAT_DOCUMENT_ACCELERATOR, enabled: hasEditor, keyWhen: editorFocus, run: () => actions.formatDocument() },
    { id: MENU_IDS.findInFiles, title: t('Find in Files'), category: search, accelerator: FIND_IN_FILES_ACCELERATOR, run: () => actions.searchInFiles(false) },
    { id: MENU_IDS.replaceInFiles, title: t('Replace in Files'), category: search, accelerator: REPLACE_IN_FILES_ACCELERATOR, run: () => actions.searchInFiles(true) },
    // F4 walks the focused Search Editor's results, else the Search view's (VS Code's HasSearchResults and InSearchEditor rules).
    {
      id: MENU_IDS.focusNextSearchResult,
      title: t('Focus Next Search Result'),
      category: search,
      accelerator: FOCUS_NEXT_SEARCH_RESULT_ACCELERATOR,
      enabled: (context) => context.search.editorActive || context.search.viewHasResults,
      keyWhen: (context) => inSearchEditor(context) || context.search.viewHasResults,
      run: (context, source) => (toSearchEditor(context, source) ? actions.searchEditorCommand('focusNextResult') : actions.searchViewCommand('focusNextResult')),
    },
    {
      id: MENU_IDS.focusPreviousSearchResult,
      title: t('Focus Previous Search Result'),
      category: search,
      accelerator: FOCUS_PREVIOUS_SEARCH_RESULT_ACCELERATOR,
      enabled: (context) => context.search.editorActive || context.search.viewHasResults,
      keyWhen: (context) => inSearchEditor(context) || context.search.viewHasResults,
      run: (context, source) => (toSearchEditor(context, source) ? actions.searchEditorCommand('focusPreviousResult') : actions.searchViewCommand('focusPreviousResult')),
    },
    {
      id: MENU_IDS.toggleQueryDetails,
      title: t('Toggle Query Details'),
      category: search,
      accelerator: TOGGLE_QUERY_DETAILS_ACCELERATOR,
      enabled: (context) => context.search.editorActive || context.search.viewVisible,
      keyWhen: (context) => inSearchEditor(context) || context.search.viewVisible,
      run: (context, source) => (toSearchEditor(context, source) ? actions.searchEditorCommand('toggleQueryDetails') : actions.searchViewCommand('toggleQueryDetails')),
    },
    { id: MENU_IDS.cancelSearch, title: t('Cancel Search'), category: search, enabled: (context) => context.search.viewRunning, run: () => actions.cancelSearch() },
    ...SEARCH_VIEW_COMMANDS.map((command): Command => ({ id: command.id, title: command.title, category: search, enabled: command.enabled, run: () => actions.searchViewCommand(command.command) })),
    { id: MENU_IDS.clearSearchHistory, title: t('Clear Search History'), category: search, run: () => actions.clearSearchHistory() },
    { id: MENU_IDS.toggleSearchOnType, title: t('Toggle Search on Type'), category: search, run: () => actions.toggleSearchOnType() },
    { id: MENU_IDS.newSearchEditor, title: t('New Search Editor'), category: search, run: () => actions.newSearchEditor() },
    { id: MENU_IDS.openSearchEditor, title: t('Open Search Editor'), category: search, run: () => actions.openSearchEditor() },
    { id: MENU_IDS.openNewSearchEditor, title: t('Open New Search Editor'), category: search, run: () => actions.searchViewCommand('openNewSearchEditor') },
    { id: MENU_IDS.openResultsInEditor, title: t('Open Results in Editor'), category: search, enabled: (context) => context.search.viewHasResults, run: () => actions.openResultsInEditor() },
    ...SEARCH_EDITOR_COMMANDS.map((command): Command => ({
      id: command.id,
      title: command.title,
      category: search,
      ...(command.accelerator !== undefined ? { accelerator: command.accelerator } : {}),
      enabled: (context) => context.search.editorActive,
      keyWhen: editorFocus,
      run: () => actions.searchEditorCommand(command.command),
    })),
    { id: MENU_IDS.toggleSidebar, title: t('Toggle Sidebar'), category: view, accelerator: TOGGLE_SIDEBAR_ACCELERATOR, inTerminal: true, run: () => actions.toggleSidebar() },
    { id: MENU_IDS.toggleEditor, title: t('Toggle Editor Pane'), category: view, run: () => actions.toggleEditor() },
    { id: MENU_IDS.toggleTerminal, title: t('Toggle Terminal'), category: view, accelerator: TOGGLE_TERMINAL_ACCELERATOR, inTerminal: true, run: (_context, source) => actions.toggleTerminal(source === 'accelerator') },
    { id: MENU_IDS.showCommands, title: t('Show All Commands'), menuLabel: t('Command Palette...'), category: view, accelerator: SHOW_COMMANDS_ACCELERATOR, inTerminal: true, run: () => actions.showCommands() },
    { id: MENU_IDS.nextChat, title: t('Next Chat'), category: view, accelerator: mac ? 'Cmd+Shift+]' : 'Ctrl+Tab', run: relative(1) },
    { id: MENU_IDS.previousChat, title: t('Previous Chat'), category: view, accelerator: mac ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab', run: relative(-1) },
    { id: MENU_IDS.nextEditor, title: t('Next Editor'), category: view, accelerator: 'Ctrl+Tab', registerAccelerator: false, enabled: (context) => context.editor, run: () => actions.cycleEditor(1) },
    { id: MENU_IDS.previousEditor, title: t('Previous Editor'), category: view, accelerator: 'Ctrl+Shift+Tab', registerAccelerator: false, enabled: (context) => context.editor, run: () => actions.cycleEditor(-1) },
    { id: MENU_IDS.focusNextPart, title: t('Focus Next Part'), category: view, accelerator: 'F6', inTerminal: true, run: () => actions.focusPart(1) },
    { id: MENU_IDS.focusPreviousPart, title: t('Focus Previous Part'), category: view, accelerator: 'Shift+F6', inTerminal: true, run: () => actions.focusPart(-1) },
    { id: MENU_IDS.newTerminal, title: t('New Terminal'), category: terminal, accelerator: NEW_TERMINAL_ACCELERATOR, enabled: (context) => context.terminalCreate, run: () => actions.newTerminal() },
    { id: MENU_IDS.killTerminal, title: t('Kill Terminal'), category: terminal, enabled: (context) => context.terminal !== undefined, run: () => actions.killTerminal() },
    { id: MENU_IDS.restartTerminal, title: t('Restart Terminal'), category: terminal, enabled: (context) => context.terminal === 'exited', run: () => actions.restartTerminal() },
    // The same quick pick as New Terminal, whose first step is the profile (VS Code's Create New Terminal (With Profile)).
    { id: MENU_IDS.newTerminalWithProfile, title: t('New Terminal With Profile'), category: terminal, enabled: (context) => context.terminalCreate, run: () => actions.newTerminal() },
    { id: MENU_IDS.selectDefaultTerminalProfile, title: t('Select Default Profile'), category: terminal, run: () => actions.selectDefaultTerminalProfile() },
    { id: MENU_IDS.renameTerminal, title: t('Rename...'), category: terminal, enabled: hasTerminal, run: () => actions.renameTerminal() },
    { id: MENU_IDS.changeTerminalIcon, title: t('Change Icon...'), category: terminal, enabled: hasTerminal, run: () => actions.changeTerminalIcon() },
    { id: MENU_IDS.changeTerminalColor, title: t('Change Color...'), category: terminal, enabled: hasTerminal, run: () => actions.changeTerminalColor() },
    // Palette only: VS Code's Ctrl+PageDown and Ctrl+PageUp (Cmd+Shift+] and [ on macOS) are Next and Previous Chat here.
    { id: MENU_IDS.focusNextTerminal, title: t('Focus Next Terminal Group'), category: terminal, enabled: hasTerminal, run: () => actions.focusRelativeTerminal(1) },
    { id: MENU_IDS.focusPreviousTerminal, title: t('Focus Previous Terminal Group'), category: terminal, enabled: hasTerminal, run: () => actions.focusRelativeTerminal(-1) },
    { id: MENU_IDS.killAllTerminals, title: t('Kill All Terminals'), category: terminal, enabled: hasTerminal, run: () => actions.killAllTerminals() },
    // VS Code's split group commands (terminalActions.ts) with its keys, when clauses and preconditions; Resize Pane has no
    // Windows key there.
    { id: MENU_IDS.splitTerminal, title: t('Split Terminal'), category: terminal, accelerator: splitTerminalAccelerator(platform), inTerminal: true, keyWhen: terminalFocus, enabled: hasTerminal, run: () => actions.splitTerminal() },
    { id: MENU_IDS.unsplitTerminal, title: t('Unsplit Terminal'), category: terminal, enabled: hasTerminal, run: () => actions.unsplitTerminal() },
    { id: MENU_IDS.focusPreviousTerminalPane, title: t('Focus Previous Terminal in Terminal Group'), category: terminal, accelerator: mac ? 'Alt+Cmd+Left' : 'Alt+Left', inTerminal: true, keyWhen: splitTerminalFocus, enabled: hasTerminal, run: () => actions.focusTerminalPane(-1) },
    { id: MENU_IDS.focusNextTerminalPane, title: t('Focus Next Terminal in Terminal Group'), category: terminal, accelerator: mac ? 'Alt+Cmd+Right' : 'Alt+Right', inTerminal: true, keyWhen: splitTerminalFocus, enabled: hasTerminal, run: () => actions.focusTerminalPane(1) },
    {
      id: MENU_IDS.resizeTerminalPaneLeft,
      title: t('Resize Terminal Left'),
      category: terminal,
      ...(mac ? { accelerator: 'Cmd+Ctrl+Left' } : linux ? { accelerator: 'Ctrl+Shift+Left' } : {}),
      inTerminal: true,
      keyWhen: terminalFocus,
      enabled: hasTerminal,
      run: () => actions.resizeTerminalPane('left'),
    },
    {
      id: MENU_IDS.resizeTerminalPaneRight,
      title: t('Resize Terminal Right'),
      category: terminal,
      ...(mac ? { accelerator: 'Cmd+Ctrl+Right' } : linux ? { accelerator: 'Ctrl+Shift+Right' } : {}),
      inTerminal: true,
      keyWhen: terminalFocus,
      enabled: hasTerminal,
      run: () => actions.resizeTerminalPane('right'),
    },
    // The shell carries these out on the active terminal's buffer (VS Code's terminal clipboard and chat actions).
    { id: MENU_IDS.copyLastTerminalCommand, title: t('Copy Last Command'), category: terminal, enabled: hasTerminal, run: () => actions.runTerminalAction('copyLastCommand') },
    { id: MENU_IDS.copyLastTerminalCommandOutput, title: t('Copy Last Command Output'), category: terminal, enabled: hasTerminal, run: () => actions.runTerminalAction('copyLastCommandOutput') },
    { id: MENU_IDS.addTerminalToChat, title: t('Add to Chat'), category: terminal, enabled: hasTerminal, run: () => actions.runTerminalAction('addToChat') },
    // The xterm takes Ctrl+Up and Ctrl+Down itself while it has command marks, so the menu shows the keys without owning them.
    { id: MENU_IDS.scrollToPreviousTerminalCommand, title: t('Scroll to Previous Command'), category: terminal, accelerator: 'CmdOrCtrl+Up', registerAccelerator: false, enabled: hasTerminal, run: () => actions.runTerminalAction('scrollToPreviousCommand') },
    { id: MENU_IDS.scrollToNextTerminalCommand, title: t('Scroll to Next Command'), category: terminal, accelerator: 'CmdOrCtrl+Down', registerAccelerator: false, enabled: hasTerminal, run: () => actions.runTerminalAction('scrollToNextCommand') },
    { id: MENU_IDS.newBrowserPage, title: t('New Browser Page'), category: view, enabled: (context) => context.chat && context.browser, run: () => actions.newBrowserPage() },
    { id: MENU_IDS.toggleBrowserDevTools, title: t('Toggle Browser Developer Tools'), category: view, accelerator: 'F12', enabled: (context) => context.page, run: () => actions.toggleBrowserDevTools() },
    { id: MENU_IDS.newSession, title: pkg('command.newSession.title'), category: chat, run: () => actions.newSession() },
    { id: MENU_IDS.cancelSession, title: pkg('command.cancelSession.title'), category: chat, run: () => actions.cancelSession() },
    { id: MENU_IDS.togglePromptNavigator, title: t('Toggle Prompt Navigator'), category: chat, accelerator: 'CmdOrCtrl+K', enabled: hasChat, run: () => actions.togglePromptNavigator() },
    ...CHAT_FEATURES.map((feature): Command => ({ id: feature.id, title: feature.title, category: chat, enabled: hasChat, run: () => actions.runChatCommand(feature.command) })),
    // D60: the selected chat's changes tab, in the Chat menu and the palette, while that chat has changes
    { id: MENU_IDS.chatReviewChanges, title: t('Review Changes'), category: chat, enabled: (context) => context.selectedChatHasChanges, run: () => actions.reviewChatChanges() },
    // D61: the selected chat moves between its project folder and its worktree while it is idle
    { id: MENU_IDS.chatHandOffToWorktree, title: t('Hand Off to Worktree'), category: chat, enabled: (context) => context.handOff?.canHandOff === true && context.handOff.place === 'project', run: () => actions.handOff('worktree') },
    { id: MENU_IDS.chatHandOffToProjectFolder, title: t('Hand Off to Project Folder'), category: chat, enabled: (context) => context.handOff?.canHandOff === true && context.handOff.place === 'worktree', run: () => actions.handOff('project') },
    ...worktreeCommands(actions),
    { id: MENU_IDS.showLog, title: pkg('command.showLog.title'), category: chat, run: () => actions.showLog() },
    { id: MENU_IDS.about, title: t('About Damocles'), category: help, run: () => actions.about() },
    { id: MENU_IDS.releaseNotes, title: t('Release Notes'), category: help, run: () => actions.releaseNotes() },
    { id: MENU_IDS.checkForUpdates, title: t('Check for Updates...'), category: help, enabled: (context) => context.updateCheck, run: () => actions.checkForUpdates() },
    ...gitCommands(actions),
    ...editorGitCommands(actions),
  ];
}

// D33's finish actions on the selected chat's worktree; Apply, Merge, Update and Delete wait while a chat using it works.
function worktreeCommands(actions: MenuActions): Command[] {
  const worktree = t('Worktree');
  const idle = (context: MenuState): boolean => context.worktree !== undefined && !context.worktree.finish.busy;
  const onBranch = (context: MenuState): boolean => idle(context) && !context.worktree!.finish.detachedTarget;
  // git's branch name, shown with its control and bidi characters visible in the native menu and the palette
  const branchTitle = (message: string, fallback: string) => (context: MenuState): Label => (context.worktree?.baseBranch !== undefined ? t(message, visibleText(context.worktree.baseBranch)) : t(fallback));
  return [
    { id: MENU_IDS.worktreeApply, title: t('Apply to project folder'), category: worktree, enabled: idle, run: () => actions.worktreeFinish('apply') },
    { id: MENU_IDS.worktreeMerge, title: t('Merge into branch'), titleIn: branchTitle('Merge into {0}', 'Merge into branch'), category: worktree, enabled: onBranch, run: () => actions.worktreeFinish('merge') },
    { id: MENU_IDS.worktreeUpdate, title: t('Update from branch'), titleIn: branchTitle('Update from {0}', 'Update from branch'), category: worktree, enabled: onBranch, run: () => actions.worktreeFinish('update') },
    { id: MENU_IDS.worktreePushBranch, title: t('Push branch'), category: worktree, enabled: (context) => context.worktree?.finish.hasRemote === true, run: () => actions.worktreeFinish('push') },
    { id: MENU_IDS.worktreeDelete, title: t('Delete worktree'), category: worktree, enabled: idle, run: () => actions.worktreeFinish('delete') },
  ];
}

/** The command's title in the context, for the palette entry and the menu item that has no label of its own. */
export function commandTitle(command: Command, context: MenuState): Label {
  return command.titleIn?.(context) ?? command.title;
}

/** Whether the command is out of the palette and the menu in the context. */
export function isHidden(command: Command, context: MenuState): boolean {
  return command.hidden?.(context) ?? false;
}

/** The precondition: whether the menu item and the palette entry are enabled, wherever keyboard focus is. */
export function isEnabled(command: Command, context: MenuState): boolean {
  return command.enabled?.(context) ?? true;
}

/**
 * Whether the command's accelerator runs it, as VS Code's menubar.ts runs an accelerator as a keybinding resolved against its
 * when clause: the precondition, the key's when clause, and while a terminal's xterm has focus only the skip list. Electron calls a
 * menu accelerator only for a key the focused page left unhandled, so a key that does not run its command has already
 * reached the page or the pty.
 */
export function keyFires(command: Command, context: MenuState): boolean {
  if (command.accelerator === undefined || command.registerAccelerator === false) return false;
  if (terminalFocus(context) && command.inTerminal !== true) return false;
  return isEnabled(command, context) && (command.keyWhen?.(context) ?? true);
}

/**
 * The accelerators of the skip list whose when clause holds in a focused terminal, which the shell's xterm leaves unhandled so
 * they reach the menu; context.terminalSplit: the active terminal group has more than one pane.
 */
export function terminalPassKeys(commands: readonly Command[], context: MenuState): string[] {
  const terminal: MenuState = { ...context, focus: 'terminal', terminalInput: true };
  return commands.flatMap((command) => (command.inTerminal === true && command.accelerator !== undefined && (command.keyWhen?.(terminal) ?? true) ? [command.accelerator] : []));
}

const MAC_MODIFIERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(Ctrl|Control)$/, '⌃'],
  [/^(Alt|Option)$/, '⌥'],
  [/^Shift$/, '⇧'],
  [/^(Cmd|Command|CmdOrCtrl|CommandOrControl)$/, '⌘'],
];

/** An Electron accelerator as the platform writes it: 'Ctrl+Shift+F' on Windows and Linux, '⇧⌘F' on macOS. */
export function acceleratorLabel(accelerator: string, platform: NodeJS.Platform): string {
  const parts = accelerator.split('+');
  // '+' itself as the key leaves an empty last part
  const key = parts.at(-1) === '' ? '+' : parts.at(-1)!;
  const modifiers = parts.slice(0, parts.at(-1) === '' ? -2 : -1);
  if (platform !== 'darwin') return [...modifiers.map((modifier) => (/^(CmdOrCtrl|CommandOrControl|Control)$/.test(modifier) ? 'Ctrl' : modifier)), key].join('+');
  const symbols = MAC_MODIFIERS.flatMap(([pattern, symbol]) => (modifiers.some((modifier) => pattern.test(modifier)) ? [symbol] : []));
  return symbols.join('') + key;
}

/**
 * The command palette over the registry: lists the commands for the focus context main captured when it opened, and runs
 * one only when it is registered and enabled in that context. Commands run this session come first, most recent on top.
 */
export class CommandPalette {
  private readonly commands: () => readonly Command[];
  private readonly l10n: DesktopLocalizationService;
  private readonly english: DesktopLocalizationService;
  private readonly platform: NodeJS.Platform;
  private readonly log: (line: string) => void;
  private recent: string[] = [];

  constructor(deps: {
    readonly commands: () => readonly Command[];
    readonly l10n: DesktopLocalizationService;
    readonly english: DesktopLocalizationService;
    readonly platform: NodeJS.Platform;
    readonly log: (line: string) => void;
  }) {
    this.commands = deps.commands;
    this.l10n = deps.l10n;
    this.english = deps.english;
    this.platform = deps.platform;
    this.log = deps.log;
  }

  list(context: MenuState): PaletteCommand[] {
    const entries = this.commands().filter((command) => (command.palette?.(context) ?? true) && !isHidden(command, context)).map((command): PaletteCommand => {
      const category = resolveLabel(command.category, this.l10n);
      return {
        id: command.id,
        label: `${category}: ${resolveLabel(commandTitle(command, context), this.l10n)}`,
        englishLabel: `${resolveLabel(command.category, this.english)}: ${resolveLabel(commandTitle(command, context), this.english)}`,
        category,
        accelerator: command.accelerator !== undefined ? acceleratorLabel(command.accelerator, this.platform) : command.keybinding ? command.keybinding.map((part) => acceleratorLabel(part, this.platform)).join(' ') : null,
        enabled: isEnabled(command, context),
        recent: this.recent.includes(command.id),
      };
    });
    const rank = (entry: PaletteCommand): number => (entry.recent ? this.recent.indexOf(entry.id) : Infinity);
    return entries.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, this.l10n.language));
  }

  /** Runs id in the captured context; false, and nothing runs, for an id that is not registered or not enabled there. */
  run(id: string, context: MenuState): boolean {
    const command = this.commands().find((candidate) => candidate.id === id);
    if (!command || !isEnabled(command, context) || !(command.palette?.(context) ?? true) || isHidden(command, context)) {
      this.log(`[commands] refusing ${command ? 'disabled' : 'unknown'} command ${id.slice(0, 200)}`);
      return false;
    }
    this.recent = [id, ...this.recent.filter((other) => other !== id)];
    command.run(context, 'palette');
    return true;
  }
}
