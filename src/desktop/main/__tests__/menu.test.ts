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

import { installApplicationMenu, MENU_IDS, togglePaneShortcutLabel, type MenuActions, type MenuState } from '../menu';
import { createDesktopLocalizationService } from '../platform/localization-service';

function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

const calls: string[] = [];
const actions = new Proxy({} as MenuActions, {
  get: (_target, name: string) => (...args: unknown[]) => calls.push([name, ...args].join(':')),
});

const CHAT: MenuState = { chat: true, browser: true, page: false };
const NONE: MenuState = { chat: false, browser: false, page: false };

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
  it('binds the three contributed keybindings and the tab accelerators', () => {
    const items = build('win32', CHAT);
    expect(byId(items, MENU_IDS.openChat).accelerator).toBe('CmdOrCtrl+Shift+U');
    expect(byId(items, MENU_IDS.togglePromptNavigator).accelerator).toBe('CmdOrCtrl+K');
    expect(byId(items, MENU_IDS.toggleBrowserDevTools).accelerator).toBe('F12');
    expect(byId(items, MENU_IDS.togglePane).accelerator).toBe('CmdOrCtrl+Shift+B');
    expect(byId(items, MENU_IDS.focusNextPart).accelerator).toBe('F6');
    expect(byId(items, MENU_IDS.focusPreviousPart).accelerator).toBe('Shift+F6');
    expect(byId(items, MENU_IDS.newTab).accelerator).toBe('CmdOrCtrl+T');
    expect(byId(items, MENU_IDS.closeTab).accelerator).toBe('CmdOrCtrl+W');
    expect(byId(items, MENU_IDS.nextTab).accelerator).toBe('Ctrl+Tab');
    expect(byId(items, MENU_IDS.previousTab).accelerator).toBe('Ctrl+Shift+Tab');
    expect(byId(items, `${MENU_IDS.nextTab}.pageDown`)).toMatchObject({ accelerator: 'CmdOrCtrl+PageDown', visible: false, acceleratorWorksWhenHidden: true });
    expect(byId(items, `${MENU_IDS.previousTab}.pageUp`)).toMatchObject({ accelerator: 'CmdOrCtrl+PageUp', visible: false });
  });

  it('uses the Cmd variants on macOS and adds the app menu', () => {
    const items = build('darwin', NONE);
    expect(byId(items, MENU_IDS.nextTab).accelerator).toBe('Cmd+Shift+]');
    expect(byId(items, MENU_IDS.previousTab).accelerator).toBe('Cmd+Shift+[');
    expect(byId(items, `${MENU_IDS.nextTab}.ctrlTab`).accelerator).toBe('Ctrl+Tab');
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
    const items = build('win32', { ...CHAT, page: true });
    for (const id of [MENU_IDS.openChat, MENU_IDS.toggleBrowserDevTools, MENU_IDS.nextTab, MENU_IDS.focusNextPart, MENU_IDS.focusPreviousPart, MENU_IDS.togglePane]) {
      (byId(items, id).click as () => void)();
    }
    expect(calls).toEqual(['openChat', 'toggleBrowserDevTools', 'selectRelativeTab:1', 'focusPart:1', 'focusPart:-1', 'togglePane']);
  });

  it('localizes labels, including package.nls command titles', () => {
    const items = build('win32', CHAT, 'el');
    expect(byId(items, MENU_IDS.openChat).label).toBe('Άνοιγμα Συνομιλίας');
    expect(byId(items, MENU_IDS.closeTab).label).toBe('Κλείσιμο καρτέλας');
    expect(byId(items, 'damocles.menu.edit').label).toBe('Επεξεργασία');
  });
});
