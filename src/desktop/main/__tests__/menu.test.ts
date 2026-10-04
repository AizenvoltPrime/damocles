import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const electron = vi.hoisted(() => ({ template: [] as MenuItemConstructorOptions[] }));

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      electron.template = template;
      return {};
    },
    setApplicationMenu: vi.fn(),
    getApplicationMenu: () => null,
  },
}));

import { installApplicationMenu, MENU_IDS, shellShortcutLabels, togglePaneShortcutLabel, type MenuActions, type MenuState } from '../menu';
import { createDesktopLocalizationService } from '../platform/localization-service';

function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

const calls: string[] = [];
const actions = new Proxy({} as MenuActions, {
  get: (_target, name: string) => (...args: unknown[]) => calls.push([name, ...args].join(':')),
});

const CHAT: MenuState = { chat: true, browser: true, page: false, focus: 'chat' };
const NONE: MenuState = { chat: false, browser: false, page: false, focus: undefined };

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
});

describe('application menu', () => {
  it('binds the three contributed keybindings and the chat and window accelerators', () => {
    const items = build('win32', CHAT);
    expect(byId(items, MENU_IDS.openChat).accelerator).toBe('CmdOrCtrl+Shift+U');
    expect(byId(items, MENU_IDS.togglePromptNavigator).accelerator).toBe('CmdOrCtrl+K');
    expect(byId(items, MENU_IDS.toggleBrowserDevTools).accelerator).toBe('F12');
    expect(byId(items, MENU_IDS.togglePane).accelerator).toBe('CmdOrCtrl+Shift+B');
    expect(byId(items, MENU_IDS.focusNextPart).accelerator).toBe('F6');
    expect(byId(items, MENU_IDS.focusPreviousPart).accelerator).toBe('Shift+F6');
    expect(byId(items, MENU_IDS.newChat).accelerator).toBe('CmdOrCtrl+N');
    expect(byId(items, MENU_IDS.toggleSidebar).accelerator).toBe('CmdOrCtrl+B');
    expect(byId(items, MENU_IDS.closePage).accelerator).toBe('CmdOrCtrl+W');
    expect(byId(items, MENU_IDS.nextChat).accelerator).toBe('Ctrl+Tab');
    expect(byId(items, MENU_IDS.previousChat).accelerator).toBe('Ctrl+Shift+Tab');
    expect(byId(items, `${MENU_IDS.nextChat}.pageDown`)).toMatchObject({ accelerator: 'CmdOrCtrl+PageDown', visible: false, acceleratorWorksWhenHidden: true });
    expect(byId(items, `${MENU_IDS.previousChat}.pageUp`)).toMatchObject({ accelerator: 'CmdOrCtrl+PageUp', visible: false });
    expect(items.some((item) => item.accelerator === 'CmdOrCtrl+T')).toBe(false);
  });

  it('uses the Cmd variants on macOS and adds the app menu', () => {
    const items = build('darwin', NONE);
    expect(byId(items, MENU_IDS.nextChat).accelerator).toBe('Cmd+Shift+]');
    expect(byId(items, MENU_IDS.previousChat).accelerator).toBe('Cmd+Shift+[');
    expect(byId(items, `${MENU_IDS.nextChat}.ctrlTab`).accelerator).toBe('Ctrl+Tab');
    expect(electron.template[0]?.role).toBe('appMenu');
    expect(items.some((item) => item.id === 'damocles.quit')).toBe(false);
  });

  it('enables F12 only for an active pane page, the pane toggle only with the browser on, and Ctrl+K only for a chat tab', () => {
    let items = build('linux', CHAT);
    expect(byId(items, MENU_IDS.togglePromptNavigator).enabled).toBe(true);
    expect(byId(items, MENU_IDS.togglePane).enabled).toBe(true);
    expect(byId(items, MENU_IDS.toggleBrowserDevTools).enabled).toBe(false);
    items = build('linux', { ...CHAT, page: true });
    expect(byId(items, MENU_IDS.toggleBrowserDevTools).enabled).toBe(true);
    items = build('linux', { ...CHAT, browser: false });
    expect(byId(items, MENU_IDS.togglePane).enabled).toBe(false);
    items = build('linux', NONE);
    expect(byId(items, MENU_IDS.togglePromptNavigator).enabled).toBe(false);
    expect(byId(items, MENU_IDS.togglePane).enabled).toBe(false);
  });

  it('enables Close Page only while the browser pane holds focus over an active page, so Ctrl+W reaches the chat otherwise', () => {
    expect(byId(build('win32', { ...CHAT, page: true, focus: 'pane' }), MENU_IDS.closePage).enabled).toBe(true);
    expect(byId(build('win32', { ...CHAT, page: true, focus: 'chat' }), MENU_IDS.closePage).enabled).toBe(false);
    expect(byId(build('win32', { ...CHAT, page: true, focus: 'sidebar' }), MENU_IDS.closePage).enabled).toBe(false);
    expect(byId(build('win32', { ...CHAT, page: false, focus: 'pane' }), MENU_IDS.closePage).enabled).toBe(false);
  });

  it('keeps New Chat, Toggle Sidebar and Settings unique and labels them per platform for the shell', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const accelerators = build(platform, CHAT).flatMap((item) => (typeof item.accelerator === 'string' ? [item.accelerator] : []));
      expect(accelerators.filter((accelerator) => accelerator === 'CmdOrCtrl+N')).toHaveLength(1);
      expect(accelerators.filter((accelerator) => accelerator === 'CmdOrCtrl+B')).toHaveLength(1);
      expect(accelerators.filter((accelerator) => accelerator === 'CmdOrCtrl+,')).toHaveLength(1);
    }
    expect(shellShortcutLabels('win32')).toEqual({ newChat: 'Ctrl+N', toggleSidebar: 'Ctrl+B', settings: 'Ctrl+,' });
    expect(shellShortcutLabels('darwin')).toEqual({ newChat: '⌘N', toggleSidebar: '⌘B', settings: '⌘,' });
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

  it('keeps the pane shortcut off every other accelerator and off Alt, which is AltGr on Windows', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const accelerators = build(platform, CHAT).flatMap((item) => (typeof item.accelerator === 'string' ? [item.accelerator] : []));
      expect(accelerators.filter((accelerator) => accelerator === 'CmdOrCtrl+Shift+B')).toHaveLength(1);
      expect(accelerators.find((accelerator) => accelerator === 'CmdOrCtrl+Shift+B')).not.toContain('Alt');
    }
    expect(togglePaneShortcutLabel('win32')).toBe('Ctrl+Shift+B');
    expect(togglePaneShortcutLabel('darwin')).toBe('⇧⌘B');
  });

  it('has the Edit and Window roles on every platform and never a Chromium DevTools role', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const items = build(platform, CHAT);
      expect(items.map((item) => item.role)).toEqual(expect.arrayContaining(['editMenu', 'windowMenu', 'copy', 'paste', 'selectAll']));
      expect(items.some((item) => item.role === 'toggleDevTools' || item.role === 'viewMenu' || item.role === 'forceReload' || item.role === 'reload')).toBe(false);
    }
  });

  it('routes each item to its action', () => {
    const items = build('win32', { ...CHAT, page: true, focus: 'pane' });
    for (const id of [MENU_IDS.openChat, MENU_IDS.newChat, MENU_IDS.toggleBrowserDevTools, MENU_IDS.nextChat, MENU_IDS.previousChat, MENU_IDS.focusNextPart, MENU_IDS.focusPreviousPart, MENU_IDS.togglePane, MENU_IDS.toggleSidebar, MENU_IDS.closePage]) {
      (byId(items, id).click as () => void)();
    }
    expect(calls).toEqual(['openChat', 'newChat', 'toggleBrowserDevTools', 'selectRelativeChat:1', 'selectRelativeChat:-1', 'focusPart:1', 'focusPart:-1', 'togglePane', 'toggleSidebar', 'closePage']);
  });

  it('localizes labels, including package.nls command titles', () => {
    const items = build('win32', CHAT, 'el');
    expect(byId(items, MENU_IDS.openChat).label).toBe('Άνοιγμα Συνομιλίας');
    expect(byId(items, MENU_IDS.closePage).label).toBe('Κλείσιμο σελίδας');
    expect(byId(items, MENU_IDS.newChat).label).toBe('Νέα συνομιλία');
    expect(byId(items, 'damocles.menu.edit').label).toBe('Επεξεργασία');
  });
});
