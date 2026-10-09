import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { OpenFolder } from '../../platform/workspace-folders';
import type { ChatCommand } from '../../shared/types/messages';
import type { SearchEditorCommand, SearchViewCommand, ShellState } from '../preload/shell-channels';
import type { TerminalAction, TerminalStatus } from '../preload/terminal-channels';
import {
  acceleratorLabel,
  CLOSE_EDITOR_ACCELERATOR,
  EDITOR_MENU_ACCELERATORS,
  splitTerminalAccelerator,
  FOCUS_NEXT_SEARCH_RESULT_ACCELERATOR,
  NEW_CHAT_ACCELERATOR,
  NEW_TERMINAL_ACCELERATOR,
  OPEN_SETTINGS_ACCELERATOR,
  QUICK_OPEN_ACCELERATOR,
  SEARCH_AGAIN_ACCELERATOR,
  TOGGLE_QUERY_DETAILS_ACCELERATOR,
  TOGGLE_SIDEBAR_ACCELERATOR,
  TOGGLE_TERMINAL_ACCELERATOR,
} from './commands';
import { CHAT_FEATURE_IDS, desktopCommands, isEnabled, keyFires, MENU_IDS, openChatForProjectId, resolveLabel, SEARCH_EDITOR_COMMAND_IDS, terminalPassKeys, type Command } from './commands';
import type { DesktopLocalizationService } from './platform/localization-service';

export {
  CLOSE_EDITOR_ACCELERATOR,
  MENU_IDS,
  NEW_CHAT_ACCELERATOR,
  NEW_TERMINAL_ACCELERATOR,
  OPEN_SETTINGS_ACCELERATOR,
  openChatForProjectId,
  QUICK_OPEN_ACCELERATOR,
  TOGGLE_SIDEBAR_ACCELERATOR,
  TOGGLE_TERMINAL_ACCELERATOR,
} from './commands';

/** The shortcuts the shell labels, as the platform writes them. */
export function shellShortcutLabels(platform: NodeJS.Platform = process.platform): ShellState['shortcuts'] {
  const search = {
    searchAgain: acceleratorLabel(SEARCH_AGAIN_ACCELERATOR, platform),
    toggleQueryDetails: acceleratorLabel(TOGGLE_QUERY_DETAILS_ACCELERATOR, platform),
    focusNextSearchResult: acceleratorLabel(FOCUS_NEXT_SEARCH_RESULT_ACCELERATOR, platform),
  };
  const editorMenu = Object.fromEntries(Object.entries(EDITOR_MENU_ACCELERATORS).map(([item, accelerator]) => [item, acceleratorLabel(accelerator, platform)])) as ShellState['shortcuts']['editorMenu'];
  const splitTerminal = acceleratorLabel(splitTerminalAccelerator(platform), platform);
  return {
    newChat: acceleratorLabel(NEW_CHAT_ACCELERATOR, platform),
    toggleSidebar: acceleratorLabel(TOGGLE_SIDEBAR_ACCELERATOR, platform),
    settings: acceleratorLabel(OPEN_SETTINGS_ACCELERATOR, platform),
    quickOpen: acceleratorLabel(QUICK_OPEN_ACCELERATOR, platform),
    toggleTerminal: acceleratorLabel(TOGGLE_TERMINAL_ACCELERATOR, platform),
    newTerminal: acceleratorLabel(NEW_TERMINAL_ACCELERATOR, platform),
    splitTerminal,
    closeEditor: acceleratorLabel(CLOSE_EDITOR_ACCELERATOR, platform),
    ...search,
    editorMenu,
  };
}

// The part holding keyboard focus, F6's stops: the shell's sidebar and editor (its page tabs' views included), the selected chat
// the terminal (while it shows a terminal) and the desktop popups' window.
export type FocusPart = 'sidebar' | 'editor' | 'terminal' | 'chat' | 'toasts';

// What the context-bound items act on: a selected chat, the browser feature, a page tab as the active editor tab and the
// part holding keyboard focus (undefined while the window has none, or the title bar has it), and whether the update
// state takes a check (packaged, and not checking, downloading or holding an update). The commands' context (AD11).
export interface MenuState {
  readonly chat: boolean;
  // the editor pane has an active tab
  readonly editor: boolean;
  readonly browser: boolean;
  readonly page: boolean;
  readonly focus: FocusPart | undefined;
  readonly updateCheck: boolean;
  // a project is open, so a terminal can start
  readonly project: boolean;
  // the active terminal's status; undefined without a terminal
  readonly terminal: TerminalStatus | undefined;
  // the active terminal group has more than one pane (VS Code's splitTerminalActive)
  readonly terminalSplit: boolean;
  // an xterm's own input has keyboard focus (VS Code's terminalFocus); focus 'terminal' is anywhere in the terminal pane
  readonly terminalInput: boolean;
  readonly search: SearchMenuState;
}

// Search's part of the context: what main's search service and editor pane hold, never what a renderer reports.
// The Search view's and the Search Editors' commands besides Find and Replace in Files, in the Edit menu's Search submenu.
const SEARCH_MENU_IDS: readonly string[] = [
  MENU_IDS.newSearchEditor,
  MENU_IDS.openSearchEditor,
  MENU_IDS.openNewSearchEditor,
  MENU_IDS.openResultsInEditor,
  MENU_IDS.focusNextSearchResult,
  MENU_IDS.focusPreviousSearchResult,
  MENU_IDS.toggleQueryDetails,
  MENU_IDS.cancelSearch,
  MENU_IDS.refreshSearch,
  MENU_IDS.clearSearchResults,
  MENU_IDS.collapseSearchResults,
  MENU_IDS.expandSearchResults,
  MENU_IDS.viewAsTree,
  MENU_IDS.viewAsList,
  MENU_IDS.clearSearchHistory,
  MENU_IDS.toggleSearchOnType,
];

export interface SearchMenuState {
  // the active editor tab is a Search Editor
  readonly editorActive: boolean;
  // the Search view has a search, has results, and its ripgrep still runs
  readonly viewHasSearch: boolean;
  readonly viewHasResults: boolean;
  readonly viewRunning: boolean;
  // the sidebar shows with its Search section open
  readonly viewVisible: boolean;
}

export interface MenuActions {
  addProject(): void;
  newChat(): void;
  openChat(): void;
  openChatForProject(fsPath: string): void;
  newSession(): void;
  cancelSession(): void;
  quickOpen(): void;
  // the command palette: the quickOpen overlay in commands mode
  showCommands(): void;
  // Find in Files, or Replace in Files with replace set: the sidebar's Search section
  searchInFiles(replace: boolean): void;
  // the active editor tab's Save, Save As and Close
  saveEditor(): void;
  saveEditorAs(): void;
  // Format Document on the active editor tab, without saving
  formatDocument(): void;
  closeEditor(): void;
  // 1 activates the next editor tab, -1 the previous one
  cycleEditor(delta: 1 | -1): void;
  toggleEditor(): void;
  // byKeyboard: Ctrl+`, which focuses a shown terminal that lacks focus (VS Code's toggle); a click shows or hides the pane
  toggleTerminal(byKeyboard: boolean): void;
  // the new-terminal quick pick
  newTerminal(): void;
  // the active terminal
  killTerminal(): void;
  restartTerminal(): void;
  killAllTerminals(): void;
  // 1 focuses the active pane of the group after the active one in the list, -1 the one before, wrapping
  focusRelativeTerminal(delta: 1 | -1): void;
  // the active terminal: a new pane right of it, which takes focus; or it leaves its split group for a group of its own
  splitTerminal(): void;
  unsplitTerminal(): void;
  // 1 focuses the next pane of the active group, -1 the previous one, wrapping
  focusTerminalPane(delta: 1 | -1): void;
  // the active pane's edge moves by VS Code's step, which the shell measures
  resizeTerminalPane(direction: 'left' | 'right'): void;
  // the active terminal: its inline rename in the shell, or the icon or color quick pick
  renameTerminal(): void;
  changeTerminalIcon(): void;
  changeTerminalColor(): void;
  // the default profile quick pick, written to damocles.desktop.terminal.defaultProfile
  selectDefaultTerminalProfile(): void;
  // a buffer command the shell carries out on the active terminal, which takes keyboard focus
  runTerminalAction(action: TerminalAction): void;
  // Edit › Paste (matchStyle: macOS Paste and Match Style): through main into a terminal with keyboard focus, else native
  paste(matchStyle: boolean): void;
  toggleSidebar(): void;
  openSettings(): void;
  // 1 selects the next chat of the selected project's list, -1 the previous one
  selectRelativeChat(delta: 1 | -1): void;
  // Ctrl+Tab and Ctrl+Shift+Tab: the next or previous editor while the editor holds focus, else the next or previous chat
  relativeByKeyboard(delta: 1 | -1): void;
  // 1 moves keyboard focus to the next part (sidebar, editor, chat, the desktop popups), -1 to the previous one
  focusPart(delta: 1 | -1): void;
  togglePromptNavigator(): void;
  // a chat feature in the selected chat (runChatCommand)
  runChatCommand(command: ChatCommand): void;
  // a blank page in the selected chat, as an editor tab whose address field takes focus
  newBrowserPage(): void;
  toggleBrowserDevTools(): void;
  setExploreApiKey(): void;
  showLog(): void;
  // Settings › About
  about(): void;
  // Settings › About with the running version expanded in What's new
  releaseNotes(): void;
  checkForUpdates(): void;
  // a command the Search view or the focused Search Editor carries out
  searchViewCommand(command: SearchViewCommand): void;
  searchEditorCommand(command: SearchEditorCommand): void;
  cancelSearch(): void;
  clearSearchHistory(): void;
  toggleSearchOnType(): void;
  newSearchEditor(): void;
  // Open Search Editor: the most recent Search Editor, else a new one (VS Code's location 'reuse')
  openSearchEditor(): void;
  // Open Results in Editor: the Search view's results in a new Search Editor
  openResultsInEditor(): void;
}

type MenuClick = NonNullable<MenuItemConstructorOptions['click']>;

// The installed menu's items by id with their commands, and the state its clicks run in, kept current by updateMenuState.
let installedCommands: readonly Command[] = [];
let installedItems: ReadonlyArray<readonly [string, Command]> = [];
let currentState: MenuState | undefined;

/** Builds and installs the application menu from the command registry; the context-bound items start enabled for state. */
export function installApplicationMenu(
  projects: readonly OpenFolder[],
  actions: MenuActions,
  l10n: DesktopLocalizationService,
  state: MenuState,
  platform: NodeJS.Platform = process.platform,
): void {
  const mac = platform === 'darwin';
  const commands = desktopCommands(projects, actions, platform);
  installedCommands = commands;
  currentState = state;
  const byId = new Map(commands.map((command) => [command.id, command]));
  const items: Array<readonly [string, Command]> = [];
  // An item enables by its precondition; its accelerator runs it only where the key's when clause holds (keyFires).
  const runFrom = (command: Command): MenuClick => (_item, _window, event) => {
    const context = currentState ?? state;
    if (event?.triggeredByAccelerator !== true) command.run(context, 'menu');
    else if (keyFires(command, context)) command.run(context, 'accelerator');
  };
  const item = (id: string): MenuItemConstructorOptions => {
    const command = byId.get(id)!;
    items.push([id, command]);
    return {
      id,
      label: resolveLabel(command.menuLabel ?? command.title, l10n),
      ...(command.sublabel !== undefined ? { sublabel: command.sublabel } : {}),
      ...(command.accelerator !== undefined ? { accelerator: command.accelerator } : {}),
      ...(command.registerAccelerator === false ? { registerAccelerator: false } : {}),
      enabled: isEnabled(command, state),
      click: runFrom(command),
    };
  };
  // Hidden items carry the alternate accelerators; Windows and Linux honour a hidden item's accelerator, macOS only with this flag.
  const alternate = (id: string, accelerator: string, commandId: string): MenuItemConstructorOptions => {
    const command = byId.get(commandId)!;
    items.push([id, command]);
    return { id, label: id, accelerator, visible: false, acceleratorWorksWhenHidden: true, enabled: isEnabled(command, state), click: runFrom(command) };
  };

  const projectItems: MenuItemConstructorOptions[] = projects.length > 0
    ? projects.map((project) => item(openChatForProjectId(project.fsPath)))
    : [{ id: `${MENU_IDS.openChatForProjectMenu}:none`, label: l10n.t('No projects yet'), enabled: false }];

  // macOS keeps Settings in the app menu, Windows and Linux in File, each with the platform's Ctrl+, / Cmd+,.
  const settingsItem = item(MENU_IDS.openSettings);
  const fileMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.file',
    label: l10n.t('File'),
    submenu: [
      item(MENU_IDS.newChat),
      item(MENU_IDS.openChat),
      { id: MENU_IDS.openChatForProjectMenu, label: l10n.t('Open Chat in Project'), submenu: projectItems },
      item(MENU_IDS.quickOpen),
      { type: 'separator' },
      item(MENU_IDS.save),
      item(MENU_IDS.saveAs),
      { type: 'separator' },
      item(MENU_IDS.addProject),
      { type: 'separator' },
      ...(mac ? [] : [settingsItem, { type: 'separator' as const }]),
      item(MENU_IDS.closeEditor),
      ...(mac ? [] : [{ type: 'separator' as const }, { id: 'damocles.quit', role: 'quit' as const, label: l10n.t('Quit') }]),
    ],
  };
  const chatMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.chat',
    label: l10n.t('Chat'),
    submenu: [
      item(MENU_IDS.newSession),
      item(MENU_IDS.cancelSession),
      { type: 'separator' },
      ...CHAT_FEATURE_IDS.map(item),
      { type: 'separator' },
      item(MENU_IDS.togglePromptNavigator),
      item(MENU_IDS.setExploreApiKey),
      { type: 'separator' },
      item(MENU_IDS.showLog),
    ],
  };
  const viewMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.view',
    label: l10n.t('View'),
    submenu: [
      item(MENU_IDS.showCommands),
      { type: 'separator' },
      item(MENU_IDS.toggleSidebar),
      item(MENU_IDS.toggleEditor),
      item(MENU_IDS.toggleTerminal),
      item(MENU_IDS.newTerminal),
      item(MENU_IDS.killTerminal),
      item(MENU_IDS.restartTerminal),
      {
        id: 'damocles.menu.terminal',
        label: l10n.t('Terminal'),
        submenu: [
          item(MENU_IDS.newTerminalWithProfile),
          item(MENU_IDS.selectDefaultTerminalProfile),
          { type: 'separator' },
          item(MENU_IDS.renameTerminal),
          item(MENU_IDS.changeTerminalIcon),
          item(MENU_IDS.changeTerminalColor),
          { type: 'separator' },
          item(MENU_IDS.focusNextTerminal),
          item(MENU_IDS.focusPreviousTerminal),
          item(MENU_IDS.killAllTerminals),
          { type: 'separator' },
          item(MENU_IDS.splitTerminal),
          item(MENU_IDS.unsplitTerminal),
          item(MENU_IDS.focusPreviousTerminalPane),
          item(MENU_IDS.focusNextTerminalPane),
          item(MENU_IDS.resizeTerminalPaneLeft),
          item(MENU_IDS.resizeTerminalPaneRight),
          { type: 'separator' },
          item(MENU_IDS.copyLastTerminalCommand),
          item(MENU_IDS.copyLastTerminalCommandOutput),
          item(MENU_IDS.addTerminalToChat),
          item(MENU_IDS.scrollToPreviousTerminalCommand),
          item(MENU_IDS.scrollToNextTerminalCommand),
        ],
      },
      { type: 'separator' },
      // Electron registers one item per accelerator, so the chat items own Ctrl+Tab and route it by focus, as VS Code's when clauses do.
      item(MENU_IDS.nextChat),
      item(MENU_IDS.previousChat),
      alternate(`${MENU_IDS.nextChat}.pageDown`, 'CmdOrCtrl+PageDown', MENU_IDS.nextChat),
      alternate(`${MENU_IDS.previousChat}.pageUp`, 'CmdOrCtrl+PageUp', MENU_IDS.previousChat),
      ...(mac ? [alternate(`${MENU_IDS.nextChat}.ctrlTab`, 'Ctrl+Tab', MENU_IDS.nextChat), alternate(`${MENU_IDS.previousChat}.ctrlShiftTab`, 'Ctrl+Shift+Tab', MENU_IDS.previousChat)] : []),
      // Shown with Ctrl+Tab, which the chat items register and route here while the editor holds focus.
      item(MENU_IDS.nextEditor),
      item(MENU_IDS.previousEditor),
      item(MENU_IDS.focusNextPart),
      item(MENU_IDS.focusPreviousPart),
      { type: 'separator' },
      item(MENU_IDS.newBrowserPage),
      item(MENU_IDS.toggleBrowserDevTools),
    ],
  };
  const t = (label: string): string => l10n.t(label);
  // macOS keeps them in the app menu, Windows and Linux in Help.
  const aboutItems: MenuItemConstructorOptions[] = [item(MENU_IDS.about), item(MENU_IDS.releaseNotes), item(MENU_IDS.checkForUpdates)];
  const appMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.app',
    role: 'appMenu',
    submenu: [
      ...aboutItems,
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'services', label: t('Services') },
      { type: 'separator' },
      { role: 'hide', label: t('Hide Damocles') },
      { role: 'hideOthers', label: t('Hide Others') },
      { role: 'unhide', label: t('Show All') },
      { type: 'separator' },
      { role: 'quit', label: t('Quit Damocles') },
    ],
  };
  // macOS needs the Edit menu for copy, paste and select all to work inside any renderer; roles supply the accelerators.
  const editMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.edit',
    role: 'editMenu',
    label: t('Edit'),
    submenu: [
      { role: 'undo', label: t('Undo') },
      { role: 'redo', label: t('Redo') },
      { type: 'separator' },
      { role: 'cut', label: t('Cut') },
      { role: 'copy', label: t('Copy') },
      // Not the paste roles: they hand the clipboard to the focused page, and a terminal pastes through main instead.
      { id: 'damocles.edit.paste', label: t('Paste'), accelerator: 'CmdOrCtrl+V', click: () => actions.paste(false) },
      ...(mac ? [{ id: 'damocles.edit.pasteAndMatchStyle', label: t('Paste and Match Style'), accelerator: 'Cmd+Alt+Shift+V', click: () => actions.paste(true) }] : []),
      { role: 'delete', label: t('Delete') },
      { type: 'separator' },
      { role: 'selectAll', label: t('Select All') },
      { type: 'separator' },
      item(MENU_IDS.formatDocument),
      { type: 'separator' },
      item(MENU_IDS.findInFiles),
      item(MENU_IDS.replaceInFiles),
      // Every registry command has a menu item (AD11); VS Code keeps these in the Search view's toolbar and key bindings.
      { id: 'damocles.menu.search', label: t('Search'), submenu: SEARCH_MENU_IDS.map(item) },
      { id: 'damocles.menu.searchEditor', label: t('Search Editor'), submenu: SEARCH_EDITOR_COMMAND_IDS.map(item) },
    ],
  };
  const windowMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.window',
    role: 'windowMenu',
    label: t('Window'),
    submenu: mac
      ? [{ role: 'minimize', label: t('Minimize') }, { role: 'zoom', label: t('Zoom') }, { type: 'separator' }, { role: 'front', label: t('Bring All to Front') }]
      // No close role here: its CmdOrCtrl+W would compete with Close Editor.
      : [{ role: 'minimize', label: t('Minimize') }],
  };
  const helpMenu: MenuItemConstructorOptions = { id: 'damocles.menu.help', label: t('Help'), submenu: aboutItems };
  const template: MenuItemConstructorOptions[] = mac
    ? [appMenu, fileMenu, editMenu, viewMenu, chatMenu, windowMenu]
    : [fileMenu, editMenu, viewMenu, chatMenu, windowMenu, helpMenu];
  installedItems = items;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The installed skip list's accelerators, which TerminalState.passKeys carries to the shell. */
export function installedTerminalPassKeys(splitActive: boolean): string[] {
  return currentState ? terminalPassKeys(installedCommands, { ...currentState, terminalSplit: splitActive }) : [];
}

/** Pops the application menu up at a point of the window (DIP), for the title bar logo where the menu bar is hidden. */
export function popupApplicationMenu(window: BrowserWindow, anchor: { readonly x: number; readonly y: number }): void {
  Menu.getApplicationMenu()?.popup({ window, x: anchor.x, y: anchor.y });
}

// The state each accelerator is resolved in, and the items' preconditions; keyboard focus never disables an item.
export function updateMenuState(state: MenuState): void {
  currentState = state;
  const menu = Menu.getApplicationMenu();
  for (const [id, command] of installedItems) {
    const menuItem = menu?.getMenuItemById(id);
    if (menuItem) menuItem.enabled = isEnabled(command, state);
  }
}
