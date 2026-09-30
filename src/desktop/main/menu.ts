import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { OpenFolder } from '../../platform/workspace-folders';
import type { DesktopLocalizationService } from './platform/localization-service';

// Stable ids: tests find items with Menu.getApplicationMenu().getMenuItemById(id) and click() them.
export const MENU_IDS = {
  addProject: 'damocles.addProject',
  newTab: 'damocles.newTab',
  openChat: 'damocles.openChat',
  openChatForProjectMenu: 'damocles.openChatForProject',
  newSession: 'damocles.newSession',
  cancelSession: 'damocles.cancelSession',
  closeTab: 'damocles.closeTab',
  nextTab: 'damocles.nextTab',
  previousTab: 'damocles.previousTab',
  focusNextPart: 'damocles.focusNextPart',
  focusPreviousPart: 'damocles.focusPreviousPart',
  togglePromptNavigator: 'damocles.togglePromptNavigator',
  togglePane: 'damocles.browser.togglePane',
  toggleBrowserDevTools: 'damocles.browser.toggleDevTools',
  setExploreApiKey: 'damocles.setExploreApiKey',
  showLog: 'damocles.showLog',
} as const;

// One item per project in the "Open Chat in Project" submenu; the id carries the project's absolute path.
export function openChatForProjectId(fsPath: string): string {
  return `${MENU_IDS.openChatForProjectMenu}:${fsPath}`;
}

// No Alt: on Windows AltGr is Ctrl+Alt, and AltGr+B types a character on several keyboard layouts.
export const TOGGLE_PANE_ACCELERATOR = 'CmdOrCtrl+Shift+B';

/** The toggle shortcut as the platform writes it, for tooltips. */
export function togglePaneShortcutLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '⇧⌘B' : 'Ctrl+Shift+B';
}

// What the context-bound items act on: a selected chat tab, the browser feature, and an active page in the open pane.
export interface MenuState {
  readonly chat: boolean;
  readonly browser: boolean;
  readonly page: boolean;
}

export interface MenuActions {
  addProject(): void;
  newTab(): void;
  openChat(): void;
  openChatForProject(fsPath: string): void;
  newSession(): void;
  cancelSession(): void;
  closeTab(): void;
  selectRelativeTab(delta: 1 | -1): void;
  // 1 moves keyboard focus to the next part of the window (tab strip, chat, pane), -1 to the previous one
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

  const next = (): void => actions.selectRelativeTab(1);
  const previous = (): void => actions.selectRelativeTab(-1);

  const fileMenu: MenuItemConstructorOptions = {
    id: 'damocles.menu.file',
    label: l10n.t('File'),
    submenu: [
      { id: MENU_IDS.newTab, label: l10n.t('New Tab'), accelerator: 'CmdOrCtrl+T', click: () => actions.newTab() },
      { id: MENU_IDS.openChat, label: l10n.packageString('command.openChat.title'), accelerator: 'CmdOrCtrl+Shift+U', click: () => actions.openChat() },
      { id: MENU_IDS.openChatForProjectMenu, label: l10n.t('Open Chat in Project'), submenu: projectItems },
      { type: 'separator' },
      { id: MENU_IDS.addProject, label: l10n.t('Add Project...'), click: () => actions.addProject() },
      { type: 'separator' },
      { id: MENU_IDS.closeTab, label: l10n.t('Close Tab'), accelerator: 'CmdOrCtrl+W', click: () => actions.closeTab() },
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
      { id: MENU_IDS.nextTab, label: l10n.t('Next Tab'), accelerator: mac ? 'Cmd+Shift+]' : 'Ctrl+Tab', click: next },
      { id: MENU_IDS.previousTab, label: l10n.t('Previous Tab'), accelerator: mac ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab', click: previous },
      alternate(`${MENU_IDS.nextTab}.pageDown`, 'CmdOrCtrl+PageDown', next),
      alternate(`${MENU_IDS.previousTab}.pageUp`, 'CmdOrCtrl+PageUp', previous),
      ...(mac ? [alternate(`${MENU_IDS.nextTab}.ctrlTab`, 'Ctrl+Tab', next), alternate(`${MENU_IDS.previousTab}.ctrlShiftTab`, 'Ctrl+Shift+Tab', previous)] : []),
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
      // No close role here: its CmdOrCtrl+W would compete with Close Tab.
      : [{ role: 'minimize', label: t('Minimize') }],
  };
  const template: MenuItemConstructorOptions[] = [...(mac ? [appMenu] : []), fileMenu, editMenu, viewMenu, chatMenu, windowMenu];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A disabled item's accelerator does not fire, so F12, Ctrl+K and Ctrl+Shift+B reach the page unless they apply, like VS Code's `when` clauses.
export function updateMenuState(state: MenuState): void {
  const menu = Menu.getApplicationMenu();
  const promptNavigator = menu?.getMenuItemById(MENU_IDS.togglePromptNavigator);
  if (promptNavigator) promptNavigator.enabled = state.chat;
  const pane = menu?.getMenuItemById(MENU_IDS.togglePane);
  if (pane) pane.enabled = state.chat && state.browser;
  const devTools = menu?.getMenuItemById(MENU_IDS.toggleBrowserDevTools);
  if (devTools) devTools.enabled = state.page;
}
