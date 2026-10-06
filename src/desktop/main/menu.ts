import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { OpenFolder } from '../../platform/workspace-folders';
import type { DesktopLocalizationService } from './platform/localization-service';

// Stable ids: tests find items with Menu.getApplicationMenu().getMenuItemById(id) and click() them.
export const MENU_IDS = {
  addProject: 'damocles.addProject',
  newChat: 'damocles.newChat',
  openChat: 'damocles.openChat',
  openChatForProjectMenu: 'damocles.openChatForProject',
  newSession: 'damocles.newSession',
  cancelSession: 'damocles.cancelSession',
  closePage: 'damocles.closePage',
  toggleSidebar: 'damocles.toggleSidebar',
  nextChat: 'damocles.nextChat',
  previousChat: 'damocles.previousChat',
  focusNextPart: 'damocles.focusNextPart',
  focusPreviousPart: 'damocles.focusPreviousPart',
  togglePromptNavigator: 'damocles.togglePromptNavigator',
  togglePane: 'damocles.browser.togglePane',
  toggleBrowserDevTools: 'damocles.browser.toggleDevTools',
  setExploreApiKey: 'damocles.setExploreApiKey',
  showLog: 'damocles.showLog',
  openSettings: 'damocles.openSettings',
} as const;

// One item per project in the "Open Chat in Project" submenu; the id carries the project's absolute path.
export function openChatForProjectId(fsPath: string): string {
  return `${MENU_IDS.openChatForProjectMenu}:${fsPath}`;
}

// No Alt: on Windows AltGr is Ctrl+Alt, and AltGr+B types a character on several keyboard layouts.
export const TOGGLE_PANE_ACCELERATOR = 'CmdOrCtrl+Shift+B';
export const NEW_CHAT_ACCELERATOR = 'CmdOrCtrl+N';
export const TOGGLE_SIDEBAR_ACCELERATOR = 'CmdOrCtrl+B';
export const OPEN_SETTINGS_ACCELERATOR = 'CmdOrCtrl+,';

/** The toggle shortcut as the platform writes it, for tooltips. */
export function togglePaneShortcutLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '⇧⌘B' : 'Ctrl+Shift+B';
}

/** The New Chat, Toggle Sidebar and Settings shortcuts as the platform writes them, for the shell's labels. */
export function shellShortcutLabels(platform: NodeJS.Platform = process.platform): { readonly newChat: string; readonly toggleSidebar: string; readonly settings: string } {
  return platform === 'darwin'
    ? { newChat: '⌘N', toggleSidebar: '⌘B', settings: '⌘,' }
    : { newChat: 'Ctrl+N', toggleSidebar: 'Ctrl+B', settings: 'Ctrl+,' };
}

// The part holding keyboard focus, F6's stops: the shell's sidebar, the selected chat, the browser pane, the desktop popups' window.
export type FocusPart = 'sidebar' | 'chat' | 'pane' | 'toasts';

// What the context-bound items act on: a selected chat, the browser feature, an active page in the open pane and the
// part holding keyboard focus (undefined while the window has none, or the title bar has it).
export interface MenuState {
  readonly chat: boolean;
  readonly browser: boolean;
  readonly page: boolean;
  readonly focus: FocusPart | undefined;
}

export interface MenuActions {
  addProject(): void;
  newChat(): void;
  openChat(): void;
  openChatForProject(fsPath: string): void;
  newSession(): void;
  cancelSession(): void;
  closePage(): void;
  toggleSidebar(): void;
  openSettings(): void;
  // 1 selects the next chat of the selected project's list, -1 the previous one
  selectRelativeChat(delta: 1 | -1): void;
  // 1 moves keyboard focus to the next part (sidebar, chat, pane, the desktop popups), -1 to the previous one
  focusPart(delta: 1 | -1): void;
  togglePromptNavigator(): void;
  togglePane(): void;
  toggleBrowserDevTools(): void;
  setExploreApiKey(): void;
  showLog(): void;
}

// Hidden items carry the alternate accelerators; Windows and Linux honour a hidden item's accelerator, macOS only with this flag.
function alternate(id: string, accelerator: string, click: () => void): MenuItemConstructorOptions {
  return { id, label: id, accelerator, visible: false, acceleratorWorksWhenHidden: true, click };
}

/** Builds and installs the application menu; the context-bound items start enabled for state. */
export function installApplicationMenu(
  projects: readonly OpenFolder[],
  actions: MenuActions,
  l10n: DesktopLocalizationService,
  state: MenuState,
  platform: NodeJS.Platform = process.platform,
): void {
  const mac = platform === 'darwin';
  const projectItems: MenuItemConstructorOptions[] = projects.length > 0
    ? projects.map((project) => ({
      id: openChatForProjectId(project.fsPath),
      label: project.name,
      sublabel: project.fsPath,
      click: () => actions.openChatForProject(project.fsPath),
    }))
    : [{ id: `${MENU_IDS.openChatForProjectMenu}:none`, label: l10n.t('No projects yet'), enabled: false }];

  const next = (): void => actions.selectRelativeChat(1);
  const previous = (): void => actions.selectRelativeChat(-1);

  // macOS keeps Settings in the app menu, Windows and Linux in File, each with the platform's Ctrl+, / Cmd+,.
  const settingsItem: MenuItemConstructorOptions = { id: MENU_IDS.openSettings, label: l10n.t('Settings...'), accelerator: OPEN_SETTINGS_ACCELERATOR, click: () => actions.openSettings() };
  const fileMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.file',
    label: l10n.t('File'),
    submenu: [
      { id: MENU_IDS.newChat, label: l10n.t('New Chat'), accelerator: NEW_CHAT_ACCELERATOR, click: () => actions.newChat() },
      { id: MENU_IDS.openChat, label: l10n.packageString('command.openChat.title'), accelerator: 'CmdOrCtrl+Shift+U', click: () => actions.openChat() },
      { id: MENU_IDS.openChatForProjectMenu, label: l10n.t('Open Chat in Project'), submenu: projectItems },
      { type: 'separator' },
      { id: MENU_IDS.addProject, label: l10n.t('Add Project...'), click: () => actions.addProject() },
      { type: 'separator' },
      ...(mac ? [] : [settingsItem, { type: 'separator' as const }]),
      { id: MENU_IDS.closePage, label: l10n.t('Close Page'), accelerator: 'CmdOrCtrl+W', enabled: closePageEnabled(state), click: () => actions.closePage() },
      ...(mac ? [] : [{ type: 'separator' as const }, { id: 'damocles.quit', role: 'quit' as const, label: l10n.t('Quit') }]),
    ],
  };
  const chatMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.chat',
    label: l10n.t('Chat'),
    submenu: [
      { id: MENU_IDS.newSession, label: l10n.packageString('command.newSession.title'), click: () => actions.newSession() },
      { id: MENU_IDS.cancelSession, label: l10n.packageString('command.cancelSession.title'), click: () => actions.cancelSession() },
      { type: 'separator' },
      {
        id: MENU_IDS.togglePromptNavigator,
        label: l10n.t('Toggle Prompt Navigator'),
        accelerator: 'CmdOrCtrl+K',
        enabled: state.chat,
        click: () => actions.togglePromptNavigator(),
      },
      { id: MENU_IDS.setExploreApiKey, label: l10n.packageString('command.setExploreApiKey.title'), click: () => actions.setExploreApiKey() },
      { type: 'separator' },
      { id: MENU_IDS.showLog, label: l10n.packageString('command.showLog.title'), click: () => actions.showLog() },
    ],
  };
  const viewMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.view',
    label: l10n.t('View'),
    submenu: [
      { id: MENU_IDS.toggleSidebar, label: l10n.t('Toggle Sidebar'), accelerator: TOGGLE_SIDEBAR_ACCELERATOR, click: () => actions.toggleSidebar() },
      { type: 'separator' },
      { id: MENU_IDS.nextChat, label: l10n.t('Next Chat'), accelerator: mac ? 'Cmd+Shift+]' : 'Ctrl+Tab', click: next },
      { id: MENU_IDS.previousChat, label: l10n.t('Previous Chat'), accelerator: mac ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab', click: previous },
      alternate(`${MENU_IDS.nextChat}.pageDown`, 'CmdOrCtrl+PageDown', next),
      alternate(`${MENU_IDS.previousChat}.pageUp`, 'CmdOrCtrl+PageUp', previous),
      ...(mac ? [alternate(`${MENU_IDS.nextChat}.ctrlTab`, 'Ctrl+Tab', next), alternate(`${MENU_IDS.previousChat}.ctrlShiftTab`, 'Ctrl+Shift+Tab', previous)] : []),
      { id: MENU_IDS.focusNextPart, label: l10n.t('Focus Next Part'), accelerator: 'F6', click: () => actions.focusPart(1) },
      { id: MENU_IDS.focusPreviousPart, label: l10n.t('Focus Previous Part'), accelerator: 'Shift+F6', click: () => actions.focusPart(-1) },
      { type: 'separator' },
      {
        id: MENU_IDS.togglePane,
        label: l10n.t('Toggle Browser Pane'),
        accelerator: TOGGLE_PANE_ACCELERATOR,
        enabled: state.chat && state.browser,
        click: () => actions.togglePane(),
      },
      {
        id: MENU_IDS.toggleBrowserDevTools,
        label: l10n.t('Toggle Browser Developer Tools'),
        accelerator: 'F12',
        enabled: state.page,
        click: () => actions.toggleBrowserDevTools(),
      },
    ],
  };
  const t = (label: string): string => l10n.t(label);
  const appMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.app',
    role: 'appMenu',
    submenu: [
      { role: 'about', label: t('About Damocles') },
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
      { role: 'paste', label: t('Paste') },
      ...(mac ? [{ role: 'pasteAndMatchStyle' as const, label: t('Paste and Match Style') }] : []),
      { role: 'delete', label: t('Delete') },
      { type: 'separator' },
      { role: 'selectAll', label: t('Select All') },
    ],
  };
  const windowMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.window',
    role: 'windowMenu',
    label: t('Window'),
    submenu: mac
      ? [{ role: 'minimize', label: t('Minimize') }, { role: 'zoom', label: t('Zoom') }, { type: 'separator' }, { role: 'front', label: t('Bring All to Front') }]
      // No close role here: its CmdOrCtrl+W would compete with Close Page.
      : [{ role: 'minimize', label: t('Minimize') }],
  };
  const template: MenuItemConstructorOptions[] = [...(mac ? [appMenu] : []), fileMenu, editMenu, viewMenu, chatMenu, windowMenu];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Close Page acts on the browser pane's active page and only while the pane holds keyboard focus.
function closePageEnabled(state: MenuState): boolean {
  return state.focus === 'pane' && state.page;
}

/** Pops the application menu up at a point of the window (DIP), for the title bar logo where the menu bar is hidden. */
export function popupApplicationMenu(window: BrowserWindow, anchor: { readonly x: number; readonly y: number }): void {
  Menu.getApplicationMenu()?.popup({ window, x: anchor.x, y: anchor.y });
}

// A disabled item's accelerator does not fire, so F12, Ctrl+K, Ctrl+W and Ctrl+Shift+B reach the page unless they apply, like VS Code's `when` clauses.
export function updateMenuState(state: MenuState): void {
  const menu = Menu.getApplicationMenu();
  const closePage = menu?.getMenuItemById(MENU_IDS.closePage);
  if (closePage) closePage.enabled = closePageEnabled(state);
  const promptNavigator = menu?.getMenuItemById(MENU_IDS.togglePromptNavigator);
  if (promptNavigator) promptNavigator.enabled = state.chat;
  const pane = menu?.getMenuItemById(MENU_IDS.togglePane);
  if (pane) pane.enabled = state.chat && state.browser;
  const devTools = menu?.getMenuItemById(MENU_IDS.toggleBrowserDevTools);
  if (devTools) devTools.enabled = state.page;
}
