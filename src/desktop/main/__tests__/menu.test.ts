import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const electron = vi.hoisted(() => ({ template: [] as MenuItemConstructorOptions[], menu: null as { getMenuItemById(id: string): { enabled: boolean } | null } | null }));

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      electron.template = template;
      return {};
    },
    setApplicationMenu: vi.fn(),
    getApplicationMenu: () => electron.menu,
  },
}));

import { installApplicationMenu, installedTerminalPassKeys, MENU_IDS, shellShortcutLabels, updateMenuState, type MenuActions, type MenuState } from '../menu';
import { createDesktopLocalizationService } from '../platform/localization-service';

function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

const calls: string[] = [];
const actions = new Proxy({} as MenuActions, {
  get: (_target, name: string) => (...args: unknown[]) => calls.push([name, ...args].join(':')),
});

const CHAT: MenuState = { chat: true, editor: false, browser: true, page: false, focus: 'chat', updateCheck: true, project: true, terminal: undefined, terminalSplit: false, terminalInput: false, search: { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible: false } };
const NONE: MenuState = { chat: false, editor: false, browser: false, page: false, focus: undefined, updateCheck: false, project: false, terminal: undefined, terminalSplit: false, terminalInput: false, search: { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible: false } };
const EDITOR: MenuState = { ...CHAT, editor: true, focus: 'editor' };

function build(platform: NodeJS.Platform, state: MenuState, language: 'en' | 'el' = 'en'): MenuItemConstructorOptions[] {
  installApplicationMenu([], actions, createDesktopLocalizationService(process.cwd(), language, () => undefined), state, platform);
  return flatten(electron.template);
}

const byId = (items: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions => {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`no ${id}`);
  return item;
};

beforeEach(() => {
  calls.length = 0;
  electron.menu = null;
});

describe('application menu', () => {
  it('binds the three contributed keybindings and the chat and window accelerators', () => {
    const items = build('win32', CHAT);
    expect(byId(items, MENU_IDS.openChat).accelerator).toBe('CmdOrCtrl+Shift+U');
    expect(byId(items, MENU_IDS.togglePromptNavigator).accelerator).toBe('CmdOrCtrl+K');
    expect(byId(items, MENU_IDS.toggleBrowserDevTools).accelerator).toBe('F12');
    expect(byId(items, MENU_IDS.newBrowserPage).accelerator).toBeUndefined();
    expect(byId(items, MENU_IDS.focusNextPart).accelerator).toBe('F6');
    expect(byId(items, MENU_IDS.focusPreviousPart).accelerator).toBe('Shift+F6');
    expect(byId(items, MENU_IDS.newChat).accelerator).toBe('CmdOrCtrl+N');
    expect(byId(items, MENU_IDS.toggleSidebar).accelerator).toBe('CmdOrCtrl+B');
    expect(byId(items, MENU_IDS.closeEditor).accelerator).toBe('CmdOrCtrl+W');
    expect(byId(items, MENU_IDS.save).accelerator).toBe('CmdOrCtrl+S');
    expect(byId(items, MENU_IDS.quickOpen).accelerator).toBe('CmdOrCtrl+P');
    expect(byId(items, MENU_IDS.toggleTerminal).accelerator).toBe('Ctrl+`');
    expect(byId(items, MENU_IDS.nextEditor)).toMatchObject({ accelerator: 'Ctrl+Tab', registerAccelerator: false });
    expect(byId(items, MENU_IDS.previousEditor)).toMatchObject({ accelerator: 'Ctrl+Shift+Tab', registerAccelerator: false });
    expect(byId(items, MENU_IDS.nextChat).accelerator).toBe('Ctrl+Tab');
    expect(byId(items, MENU_IDS.previousChat).accelerator).toBe('Ctrl+Shift+Tab');
    expect(byId(items, `${MENU_IDS.nextChat}.pageDown`)).toMatchObject({ accelerator: 'CmdOrCtrl+PageDown', visible: false, acceleratorWorksWhenHidden: true });
    expect(byId(items, `${MENU_IDS.previousChat}.pageUp`)).toMatchObject({ accelerator: 'CmdOrCtrl+PageUp', visible: false });
    expect(items.some((item) => item.accelerator === 'CmdOrCtrl+T')).toBe(false);
    expect(items.some((item) => item.accelerator === 'CmdOrCtrl+Shift+B')).toBe(false);
  });

  it('uses the Cmd variants on macOS and adds the app menu', () => {
    const items = build('darwin', NONE);
    expect(byId(items, MENU_IDS.nextChat).accelerator).toBe('Cmd+Shift+]');
    expect(byId(items, MENU_IDS.previousChat).accelerator).toBe('Cmd+Shift+[');
    expect(byId(items, `${MENU_IDS.nextChat}.ctrlTab`).accelerator).toBe('Ctrl+Tab');
    expect(electron.template[0]?.role).toBe('appMenu');
    expect(items.some((item) => item.id === 'damocles.quit')).toBe(false);
  });

  it('enables F12 only for an active page tab, New Browser Page only with the browser on, and Ctrl+K only for a chat tab', () => {
    let items = build('linux', CHAT);
    expect(byId(items, MENU_IDS.togglePromptNavigator).enabled).toBe(true);
    expect(byId(items, MENU_IDS.newBrowserPage).enabled).toBe(true);
    expect(byId(items, MENU_IDS.toggleBrowserDevTools).enabled).toBe(false);
    items = build('linux', { ...CHAT, page: true });
    expect(byId(items, MENU_IDS.toggleBrowserDevTools).enabled).toBe(true);
    items = build('linux', { ...CHAT, browser: false });
    expect(byId(items, MENU_IDS.newBrowserPage).enabled).toBe(false);
    items = build('linux', NONE);
    expect(byId(items, MENU_IDS.togglePromptNavigator).enabled).toBe(false);
    expect(byId(items, MENU_IDS.newBrowserPage).enabled).toBe(false);
  });

  it('enables Save, Save As, Format Document and Close Editor over a tab wherever focus is, and fires their keys only from the editor', () => {
    const editorItems = [MENU_IDS.save, MENU_IDS.saveAs, MENU_IDS.formatDocument, MENU_IDS.closeEditor];
    for (const id of editorItems) {
      for (const focus of ['editor', 'chat', 'sidebar', 'terminal', undefined] as const) expect(byId(build('win32', { ...EDITOR, focus }), id).enabled, `${id} ${focus}`).toBe(true);
      expect(byId(build('win32', { ...EDITOR, editor: false }), id).enabled).toBe(false);
    }
    const press = (state: MenuState, id: string) => (byId(build('win32', state), id).click as (...args: unknown[]) => void)(undefined, undefined, { triggeredByAccelerator: true });
    for (const id of editorItems) press({ ...EDITOR, focus: 'chat' }, id);
    expect(calls).toEqual([]);
    for (const id of editorItems) press(EDITOR, id);
    for (const id of editorItems) (byId(build('win32', { ...EDITOR, focus: undefined }), id).click as () => void)();
    expect(calls).toEqual(['saveEditor', 'saveEditorAs', 'formatDocument', 'closeEditor', 'saveEditor', 'saveEditorAs', 'formatDocument', 'closeEditor']);
    expect(byId(build('win32', EDITOR), MENU_IDS.nextEditor).enabled).toBe(true);
    expect(byId(build('win32', CHAT), MENU_IDS.nextEditor).enabled).toBe(false);
  });

  it('never runs an item from a key it only shows, which macOS registers as a key equivalent anyway', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const items = build(platform, { ...EDITOR, terminal: 'running', focus: 'terminal' });
      for (const id of [MENU_IDS.nextEditor, MENU_IDS.previousEditor, MENU_IDS.scrollToPreviousTerminalCommand, MENU_IDS.scrollToNextTerminalCommand]) {
        expect(byId(items, id).enabled, `${platform} ${id}`).toBe(true);
        (byId(items, id).click as (...args: unknown[]) => void)(undefined, undefined, { triggeredByAccelerator: true });
      }
    }
    expect(calls).toEqual([]);
  });

  it('has no Close Page: Ctrl+W belongs to Close Editor alone', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const items = build(platform, EDITOR);
      expect(items.some((item) => item.id === 'damocles.closePage')).toBe(false);
      expect(items.filter((item) => item.accelerator === 'CmdOrCtrl+W')).toHaveLength(1);
    }
  });

  it('routes Ctrl+Tab by focus only when the accelerator fired, and a menu click always picks a chat', () => {
    const items = build('win32', EDITOR);
    const click = (id: string, event?: { triggeredByAccelerator: boolean }) => (byId(items, id).click as (...args: unknown[]) => void)(undefined, undefined, event);
    click(MENU_IDS.nextChat, { triggeredByAccelerator: true });
    click(MENU_IDS.previousChat, { triggeredByAccelerator: true });
    click(MENU_IDS.nextChat, { triggeredByAccelerator: false });
    click(MENU_IDS.nextEditor);
    expect(calls).toEqual(['relativeByKeyboard:1', 'relativeByKeyboard:-1', 'selectRelativeChat:1', 'cycleEditor:1']);
  });

  it('keeps New Chat, Toggle Sidebar and Settings unique and labels them per platform for the shell', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const accelerators = build(platform, CHAT).flatMap((item) => (typeof item.accelerator === 'string' ? [item.accelerator] : []));
      expect(accelerators.filter((accelerator) => accelerator === 'CmdOrCtrl+N')).toHaveLength(1);
      expect(accelerators.filter((accelerator) => accelerator === 'CmdOrCtrl+B')).toHaveLength(1);
      expect(accelerators.filter((accelerator) => accelerator === 'CmdOrCtrl+,')).toHaveLength(1);
    }
    expect(shellShortcutLabels('win32')).toEqual({
      newChat: 'Ctrl+N', toggleSidebar: 'Ctrl+B', settings: 'Ctrl+,', quickOpen: 'Ctrl+P', toggleTerminal: 'Ctrl+`', newTerminal: 'Ctrl+Shift+`', splitTerminal: 'Ctrl+Shift+5', closeEditor: 'Ctrl+W', searchAgain: 'Ctrl+Shift+R', toggleQueryDetails: 'Ctrl+Shift+J', focusNextSearchResult: 'F4',
      editorMenu: { goToDefinition: 'F12', goToReferences: 'Shift+F12', renameSymbol: 'F2', changeAllOccurrences: 'Ctrl+F2', formatDocument: 'Shift+Alt+F', cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', commandPalette: 'Ctrl+Shift+P' },
    });
    expect(shellShortcutLabels('darwin')).toEqual({
      newChat: '⌘N', toggleSidebar: '⌘B', settings: '⌘,', quickOpen: '⌘P', toggleTerminal: '⌃`', newTerminal: '⌃⇧`', splitTerminal: '⌘\\', closeEditor: '⌘W', searchAgain: '⇧⌘R', toggleQueryDetails: '⇧⌘J', focusNextSearchResult: 'F4',
      editorMenu: { goToDefinition: 'F12', goToReferences: '⇧F12', renameSymbol: 'F2', changeAllOccurrences: '⌘F2', formatDocument: '⌥⇧F', cut: '⌘X', copy: '⌘C', paste: '⌘V', commandPalette: '⇧⌘P' },
    });
  });

  it('opens the settings from the app menu on macOS and from File elsewhere', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      calls.length = 0;
      const items = build(platform, CHAT);
      const menu = items.find((item) => Array.isArray(item.submenu) && item.submenu.some((child) => child.id === MENU_IDS.openSettings));
      expect(menu?.id).toBe(platform === 'darwin' ? 'damocles.menu.app' : 'damocles.menu.file');
      byId(items, MENU_IDS.openSettings).click?.(undefined as never, undefined, undefined as never);
      expect(calls).toEqual(['openSettings']);
    }
  });

  it('puts About, Release Notes and Check for Updates in Help, or in the app menu instead of the about role on macOS', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      calls.length = 0;
      build(platform, CHAT);
      const menu = electron.template.find((item) => Array.isArray(item.submenu) && item.submenu.some((child) => child.id === MENU_IDS.about))!;
      expect(menu.id).toBe(platform === 'darwin' ? 'damocles.menu.app' : 'damocles.menu.help');
      if (platform !== 'darwin') expect(electron.template.at(-1)).toBe(menu);
      const items = flatten(electron.template);
      expect(items.some((item) => item.role === 'about')).toBe(false);
      expect(items.filter((item) => item.id === MENU_IDS.about)).toHaveLength(1);
      for (const id of [MENU_IDS.about, MENU_IDS.releaseNotes, MENU_IDS.checkForUpdates]) (byId(items, id).click as () => void)();
      expect(calls).toEqual(['about', 'releaseNotes', 'checkForUpdates']);
    }
  });

  it('enables Check for Updates only while the update state takes a check', () => {
    expect(byId(build('win32', CHAT), MENU_IDS.checkForUpdates).enabled).toBe(true);
    expect(byId(build('darwin', NONE), MENU_IDS.checkForUpdates).enabled).toBe(false);
  });

  it('has the Edit and Window roles on every platform and never a Chromium DevTools role', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const items = build(platform, CHAT);
      expect(items.map((item) => item.role)).toEqual(expect.arrayContaining(['editMenu', 'windowMenu', 'copy', 'selectAll']));
      expect(items.some((item) => item.role === 'toggleDevTools' || item.role === 'viewMenu' || item.role === 'forceReload' || item.role === 'reload')).toBe(false);
    }
  });

  it('pastes through main instead of the paste roles, which would hand the clipboard to a focused terminal\'s page', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const items = build(platform, CHAT);
      expect(items.some((item) => item.role === 'paste' || item.role === 'pasteAndMatchStyle'), platform).toBe(false);
      expect(byId(items, 'damocles.edit.paste')).toMatchObject({ label: 'Paste', accelerator: 'CmdOrCtrl+V' });
      (byId(items, 'damocles.edit.paste').click as () => void)();
    }
    (byId(build('darwin', CHAT), 'damocles.edit.pasteAndMatchStyle').click as () => void)();
    expect(build('win32', CHAT).some((item) => item.id === 'damocles.edit.pasteAndMatchStyle')).toBe(false);
    expect(calls).toEqual(['paste:false', 'paste:false', 'paste:false', 'paste:true']);
  });

  it('puts the terminal palette commands in View › Terminal and routes them to the active terminal', () => {
    const items = build('win32', { ...CHAT, terminal: 'running' });
    for (const id of [
      MENU_IDS.newTerminalWithProfile,
      MENU_IDS.selectDefaultTerminalProfile,
      MENU_IDS.renameTerminal,
      MENU_IDS.changeTerminalIcon,
      MENU_IDS.changeTerminalColor,
      MENU_IDS.focusNextTerminal,
      MENU_IDS.focusPreviousTerminal,
      MENU_IDS.killAllTerminals,
    ]) {
      expect(byId(items, id).enabled, id).toBe(true);
      expect(byId(items, id).accelerator, id).toBeUndefined();
      (byId(items, id).click as () => void)();
    }
    expect(calls).toEqual(['newTerminal', 'selectDefaultTerminalProfile', 'renameTerminal', 'changeTerminalIcon', 'changeTerminalColor', 'focusRelativeTerminal:1', 'focusRelativeTerminal:-1', 'killAllTerminals']);
    const none = build('win32', { ...CHAT, terminal: undefined });
    for (const id of [MENU_IDS.renameTerminal, MENU_IDS.changeTerminalIcon, MENU_IDS.changeTerminalColor, MENU_IDS.focusNextTerminal, MENU_IDS.killAllTerminals]) expect(byId(none, id).enabled, id).toBe(false);
    expect(byId(none, MENU_IDS.selectDefaultTerminalProfile).enabled).toBe(true);
  });

  it('routes each item to its action', () => {
    const items = build('win32', { ...EDITOR, page: true });
    for (const id of [MENU_IDS.openChat, MENU_IDS.newChat, MENU_IDS.toggleBrowserDevTools, MENU_IDS.nextChat, MENU_IDS.previousChat, MENU_IDS.focusNextPart, MENU_IDS.focusPreviousPart, MENU_IDS.newBrowserPage, MENU_IDS.toggleSidebar, MENU_IDS.closeEditor, MENU_IDS.save, MENU_IDS.saveAs, MENU_IDS.quickOpen, MENU_IDS.toggleEditor, MENU_IDS.toggleTerminal, MENU_IDS.previousEditor]) {
      (byId(items, id).click as () => void)();
    }
    expect(calls).toEqual(['openChat', 'newChat', 'toggleBrowserDevTools', 'selectRelativeChat:1', 'selectRelativeChat:-1', 'focusPart:1', 'focusPart:-1', 'newBrowserPage', 'toggleSidebar', 'closeEditor', 'saveEditor', 'saveEditorAs', 'quickOpen', 'toggleEditor', 'toggleTerminal:false', 'cycleEditor:-1']);
  });

  it('tells Ctrl+` from a click on Toggle Terminal, and routes the terminal commands', () => {
    const items = build('win32', { ...CHAT, terminal: 'exited' });
    const click = (id: string, event?: { triggeredByAccelerator: boolean }) => (byId(items, id).click as (...args: unknown[]) => void)(undefined, undefined, event);
    click(MENU_IDS.toggleTerminal, { triggeredByAccelerator: true });
    click(MENU_IDS.toggleTerminal, { triggeredByAccelerator: false });
    click(MENU_IDS.newTerminal);
    click(MENU_IDS.killTerminal);
    click(MENU_IDS.restartTerminal);
    expect(calls).toEqual(['toggleTerminal:true', 'toggleTerminal:false', 'newTerminal', 'killTerminal', 'restartTerminal']);
    expect(byId(items, MENU_IDS.newTerminal).accelerator).toBe('Ctrl+Shift+`');
  });

  it('enables New Terminal only with a project, Kill Terminal with a terminal and Restart Terminal for an exited one', () => {
    expect(byId(build('win32', NONE), MENU_IDS.newTerminal).enabled).toBe(false);
    expect(byId(build('win32', CHAT), MENU_IDS.newTerminal).enabled).toBe(true);
    expect(byId(build('win32', CHAT), MENU_IDS.killTerminal).enabled).toBe(false);
    expect(byId(build('win32', { ...CHAT, terminal: 'running' }), MENU_IDS.killTerminal).enabled).toBe(true);
    expect(byId(build('win32', { ...CHAT, terminal: 'running' }), MENU_IDS.restartTerminal).enabled).toBe(false);
    expect(byId(build('win32', { ...CHAT, terminal: 'exited' }), MENU_IDS.restartTerminal).enabled).toBe(true);
  });

  // The skip list (VS Code's commandsToSkipShell): every other key a focused terminal leaves unhandled runs nothing.
  const SKIP_LIST = [MENU_IDS.quickOpen, MENU_IDS.showCommands, MENU_IDS.toggleTerminal, MENU_IDS.toggleSidebar, MENU_IDS.openSettings, MENU_IDS.newChat, MENU_IDS.focusNextPart, MENU_IDS.focusPreviousPart];
  const TERMINAL: MenuState = { ...CHAT, editor: true, page: true, focus: 'terminal', terminal: 'running', terminalInput: true };
  const YIELDING = [MENU_IDS.togglePromptNavigator, MENU_IDS.openChat, MENU_IDS.findInFiles, MENU_IDS.replaceInFiles, MENU_IDS.newTerminal, MENU_IDS.nextChat, MENU_IDS.previousChat, `${MENU_IDS.nextChat}.pageDown`, `${MENU_IDS.previousChat}.pageUp`, MENU_IDS.toggleBrowserDevTools];
  const pressIn = (items: MenuItemConstructorOptions[], id: string) => (byId(items, id).click as (...args: unknown[]) => void)(undefined, undefined, { triggeredByAccelerator: true });

  it('keeps every item enabled by its precondition while a terminal has focus, and runs only the skip list\'s keys there', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      calls.length = 0;
      const items = build(platform, TERMINAL);
      for (const id of [...SKIP_LIST, ...YIELDING, MENU_IDS.addProject, MENU_IDS.killTerminal]) expect(byId(items, id).enabled, `${platform} ${id}`).toBe(true);
      for (const id of YIELDING) pressIn(items, id);
      expect(calls, platform).toEqual([]);
      for (const id of SKIP_LIST) pressIn(items, id);
      expect(calls, platform).toHaveLength(SKIP_LIST.length);
      calls.length = 0;
      for (const id of YIELDING) (byId(items, id).click as (...args: unknown[]) => void)(undefined, undefined, { triggeredByAccelerator: false });
      expect(calls, `${platform} menu clicks`).toHaveLength(YIELDING.length);
      calls.length = 0;
      const chat = build(platform, { ...TERMINAL, focus: 'chat' });
      for (const id of YIELDING) pressIn(chat, id);
      expect(calls, `${platform} keys in the chat`).toHaveLength(YIELDING.length);
    }
  });

  it('publishes the skip list\'s accelerators for xterm to leave unhandled, without New Terminal', () => {
    build('win32', CHAT);
    expect(installedTerminalPassKeys(false).sort()).toEqual(['CmdOrCtrl+,', 'CmdOrCtrl+B', 'CmdOrCtrl+N', 'CmdOrCtrl+P', 'CmdOrCtrl+Shift+P', 'Ctrl+`', 'Ctrl+Shift+5', 'F6', 'Shift+F6'].sort());
    expect(installedTerminalPassKeys(true).sort()).toEqual(['Alt+Left', 'Alt+Right', 'CmdOrCtrl+,', 'CmdOrCtrl+B', 'CmdOrCtrl+N', 'CmdOrCtrl+P', 'CmdOrCtrl+Shift+P', 'Ctrl+`', 'Ctrl+Shift+5', 'F6', 'Shift+F6'].sort());
  });

  it('decides each key in the state focus moved to, and leaves the installed items enabled by their preconditions', () => {
    const items = new Map<string, { enabled: boolean }>();
    electron.menu = { getMenuItemById: (id) => items.get(id) ?? null };
    const built = build('win32', CHAT);
    for (const item of built) if (item.id !== undefined) items.set(item.id, { enabled: item.enabled !== false });
    updateMenuState(TERMINAL);
    for (const id of [...SKIP_LIST, ...YIELDING]) expect(items.get(id)!.enabled, id).toBe(true);
    for (const id of YIELDING) pressIn(built, id);
    expect(calls).toEqual([]);
    updateMenuState({ ...TERMINAL, focus: 'chat' });
    for (const id of YIELDING) pressIn(built, id);
    expect(calls).toHaveLength(YIELDING.length);
    // The title bar's application menu button takes focus from the terminal; the split group items stay enabled.
    updateMenuState({ ...TERMINAL, terminalSplit: true, focus: undefined });
    for (const id of [MENU_IDS.splitTerminal, MENU_IDS.focusPreviousTerminalPane, MENU_IDS.focusNextTerminalPane]) expect(items.get(id)!.enabled, id).toBe(true);
  });

  it('enables the split group items wherever focus is, and fires their keys only from a terminal, the pane keys only in a split group', () => {
    const PANES = [MENU_IDS.splitTerminal, MENU_IDS.focusPreviousTerminalPane, MENU_IDS.focusNextTerminalPane, MENU_IDS.resizeTerminalPaneLeft, MENU_IDS.resizeTerminalPaneRight];
    const SPLIT: MenuState = { ...TERMINAL, terminalSplit: true };
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      // the chat, the sidebar and the title bar's application menu
      for (const focus of ['chat', 'sidebar', undefined] as const) {
        calls.length = 0;
        const items = build(platform, { ...SPLIT, focus });
        for (const id of PANES) expect(byId(items, id).enabled, `${platform} ${id} ${focus}`).toBe(true);
        for (const id of PANES) pressIn(items, id);
        expect(calls, `${platform} keys ${focus}`).toEqual([]);
        (byId(items, MENU_IDS.splitTerminal).click as () => void)();
        (byId(items, MENU_IDS.focusNextTerminalPane).click as () => void)();
        expect(calls, `${platform} clicks ${focus}`).toEqual(['splitTerminal', 'focusTerminalPane:1']);
      }
      calls.length = 0;
      const single = build(platform, TERMINAL);
      for (const id of [MENU_IDS.splitTerminal, MENU_IDS.focusPreviousTerminalPane, MENU_IDS.focusNextTerminalPane]) pressIn(single, id);
      expect(calls, platform).toEqual(['splitTerminal']);
      calls.length = 0;
      const split = build(platform, SPLIT);
      for (const id of [MENU_IDS.focusPreviousTerminalPane, MENU_IDS.focusNextTerminalPane]) pressIn(split, id);
      expect(calls, platform).toEqual(['focusTerminalPane:-1', 'focusTerminalPane:1']);
    }
    expect(byId(build('win32', { ...CHAT, terminal: undefined }), MENU_IDS.splitTerminal).enabled).toBe(false);
  });

  it('runs a Search Editor command from the menu on the active Search Editor wherever focus is, and its key only from the editor', () => {
    const search = { editorActive: true, viewHasSearch: true, viewHasResults: true, viewRunning: false, viewVisible: true };
    const items = build('win32', { ...EDITOR, focus: undefined, search });
    for (const id of [MENU_IDS.searchAgain, MENU_IDS.focusNextSearchResult, MENU_IDS.toggleQueryDetails]) expect(byId(items, id).enabled, id).toBe(true);
    (byId(items, MENU_IDS.focusNextSearchResult).click as () => void)();
    (byId(items, MENU_IDS.searchAgain).click as () => void)();
    pressIn(items, MENU_IDS.searchAgain);
    pressIn(items, MENU_IDS.focusNextSearchResult);
    pressIn(build('win32', { ...EDITOR, search }), MENU_IDS.focusNextSearchResult);
    expect(calls).toEqual(['searchEditorCommand:focusNextResult', 'searchEditorCommand:rerun', 'searchViewCommand:focusNextResult', 'searchEditorCommand:focusNextResult']);
  });

  it('localizes labels, including package.nls command titles', () => {
    const items = build('win32', CHAT, 'el');
    expect(byId(items, MENU_IDS.openChat).label).toBe('Άνοιγμα Συνομιλίας');
    expect(byId(items, MENU_IDS.closeEditor).label).toBe('Κλείσιμο επεξεργαστή');
    expect(byId(items, MENU_IDS.quickOpen).label).toBe('Γρήγορο άνοιγμα...');
    expect(byId(items, MENU_IDS.newChat).label).toBe('Νέα συνομιλία');
    expect(byId(items, 'damocles.menu.edit').label).toBe('Επεξεργασία');
    expect(byId(items, 'damocles.menu.help').label).toBe('Βοήθεια');
    expect(byId(items, MENU_IDS.releaseNotes).label).toBe('Σημειώσεις έκδοσης');
    expect(byId(items, MENU_IDS.checkForUpdates).label).toBe('Έλεγχος για ενημερώσεις...');
  });
});
