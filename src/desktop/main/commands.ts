import type { OpenFolder } from '../../platform/workspace-folders';
import type { ChatCommand } from '../../shared/types/messages';
import type { PaletteCommand } from '../preload/overlay-channels';
import type { EditorMenuShortcut, SearchEditorCommand, SearchViewCommand } from '../preload/shell-channels';
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
} as const;

// One command per project, "Open Chat in Project" in the File menu; the id carries the project's absolute path.
export function openChatForProjectId(fsPath: string): string {
  return `${MENU_IDS.openChatForProjectMenu}:${fsPath}`;
}

export const NEW_CHAT_ACCELERATOR = 'CmdOrCtrl+N';
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
  readonly category: Label;
  // the menu item's label when it differs from the palette title (Command Palette... for Show All Commands)
  readonly menuLabel?: Label;
  readonly sublabel?: string;
  readonly accelerator?: string;
  // the accelerator is only shown here: another owner (an item that routes it by focus, the xterm) handles the key
  readonly registerAccelerator?: false;
  // VS Code's precondition, which never reads keyboard focus: the menu item, the palette entry and the key; absent: always
  readonly enabled?: (context: MenuState) => boolean;
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
    { id: MENU_IDS.newTerminal, title: t('New Terminal'), category: terminal, accelerator: NEW_TERMINAL_ACCELERATOR, enabled: (context) => context.project, run: () => actions.newTerminal() },
    { id: MENU_IDS.killTerminal, title: t('Kill Terminal'), category: terminal, enabled: (context) => context.terminal !== undefined, run: () => actions.killTerminal() },
    { id: MENU_IDS.restartTerminal, title: t('Restart Terminal'), category: terminal, enabled: (context) => context.terminal === 'exited', run: () => actions.restartTerminal() },
    // The same quick pick as New Terminal, whose first step is the profile (VS Code's Create New Terminal (With Profile)).
    { id: MENU_IDS.newTerminalWithProfile, title: t('New Terminal With Profile'), category: terminal, enabled: (context) => context.project, run: () => actions.newTerminal() },
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
    { id: MENU_IDS.showLog, title: pkg('command.showLog.title'), category: chat, run: () => actions.showLog() },
    { id: MENU_IDS.about, title: t('About Damocles'), category: help, run: () => actions.about() },
    { id: MENU_IDS.releaseNotes, title: t('Release Notes'), category: help, run: () => actions.releaseNotes() },
    { id: MENU_IDS.checkForUpdates, title: t('Check for Updates...'), category: help, enabled: (context) => context.updateCheck, run: () => actions.checkForUpdates() },
  ];
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
    const entries = this.commands().map((command): PaletteCommand => {
      const category = resolveLabel(command.category, this.l10n);
      return {
        id: command.id,
        label: `${category}: ${resolveLabel(command.title, this.l10n)}`,
        englishLabel: `${resolveLabel(command.category, this.english)}: ${resolveLabel(command.title, this.english)}`,
        category,
        accelerator: command.accelerator === undefined ? null : acceleratorLabel(command.accelerator, this.platform),
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
    if (!command || !isEnabled(command, context)) {
      this.log(`[commands] refusing ${command ? 'disabled' : 'unknown'} command ${id.slice(0, 200)}`);
      return false;
    }
    this.recent = [id, ...this.recent.filter((other) => other !== id)];
    command.run(context, 'palette');
    return true;
  }
}
