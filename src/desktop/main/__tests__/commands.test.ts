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

import { acceleratorLabel, CommandPalette, desktopCommands, isEnabled, keyFires, MENU_IDS, openChatForProjectId, terminalPassKeys } from '../commands';
import { installApplicationMenu, type MenuActions, type MenuState } from '../menu';
import { createDesktopLocalizationService } from '../platform/localization-service';

const calls: string[] = [];
const actions = new Proxy({} as MenuActions, {
  get: (_target, name: string) => (...args: unknown[]) => calls.push([name, ...args].join(':')),
});

const PROJECTS = [{ fsPath: 'C:\\work\\alpha', name: 'alpha' }] as never;
const CHAT: MenuState = { chat: true, editor: false, browser: true, page: false, focus: 'chat', updateCheck: true, project: true, terminal: undefined, terminalSplit: false, terminalInput: false, search: { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible: false } };
const EDITOR: MenuState = { ...CHAT, editor: true, focus: 'editor' };
const NONE: MenuState = { chat: false, editor: false, browser: false, page: false, focus: undefined, updateCheck: false, project: false, terminal: undefined, terminalSplit: false, terminalInput: false, search: { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible: false } };
const PLATFORMS = ['win32', 'linux', 'darwin'] as const;

const en = createDesktopLocalizationService(process.cwd(), 'en', () => undefined);
const el = createDesktopLocalizationService(process.cwd(), 'el', () => undefined);

function palette(l10n = en, platform: NodeJS.Platform = 'win32'): CommandPalette {
  return new CommandPalette({ commands: () => desktopCommands(PROJECTS, actions, platform), l10n, english: en, platform, log: () => undefined });
}

function menuItems(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  installApplicationMenu(PROJECTS, actions, en, CHAT, platform);
  const flatten = (items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
  return flatten(electron.template);
}

beforeEach(() => {
  calls.length = 0;
});

describe('command registry', () => {
  it('enables each command by the focus context', () => {
    const byId = new Map(desktopCommands(PROJECTS, actions, 'win32').map((command) => [command.id, command]));
    const enabled = (id: string, context: MenuState) => isEnabled(byId.get(id)!, context);
    expect(enabled(MENU_IDS.save, EDITOR)).toBe(true);
    expect(enabled(MENU_IDS.save, CHAT)).toBe(false);
    expect(enabled(MENU_IDS.closeEditor, { ...EDITOR, editor: false })).toBe(false);
    for (const id of [MENU_IDS.chatContextUsage, MENU_IDS.chatRewind, MENU_IDS.chatViewSessionPlan, MENU_IDS.togglePromptNavigator]) {
      expect(enabled(id, CHAT)).toBe(true);
      expect(enabled(id, NONE)).toBe(false);
    }
    expect(enabled(MENU_IDS.formatDocument, EDITOR)).toBe(true);
    expect(enabled(MENU_IDS.formatDocument, CHAT)).toBe(false);
    expect(enabled(MENU_IDS.formatDocument, { ...EDITOR, editor: false })).toBe(false);
    expect(enabled(MENU_IDS.findInFiles, NONE)).toBe(true);
    expect(enabled(MENU_IDS.toggleBrowserDevTools, { ...CHAT, page: true })).toBe(true);
    expect(enabled(MENU_IDS.checkForUpdates, NONE)).toBe(false);
  });

  it('has unique ids and registers each accelerator once per platform', () => {
    for (const platform of PLATFORMS) {
      const commands = desktopCommands(PROJECTS, actions, platform);
      expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
      const registered = menuItems(platform).filter((item) => typeof item.accelerator === 'string' && item.registerAccelerator !== false).map((item) => item.accelerator as string);
      expect(new Set(registered).size, platform).toBe(registered.length);
    }
  });

  it('puts every command with a shortcut on a menu item with that shortcut, and every command on the menu', () => {
    for (const platform of PLATFORMS) {
      const items = menuItems(platform);
      for (const command of desktopCommands(PROJECTS, actions, platform)) {
        const item = items.find((candidate) => candidate.id === command.id);
        expect(item, `${platform} ${command.id}`).toBeDefined();
        expect(item!.accelerator, `${platform} ${command.id}`).toBe(command.accelerator);
      }
    }
  });

  it('adds Find in Files and Replace in Files to Edit, the palette to View, and the ten chat commands to Chat', () => {
    menuItems('win32');
    const submenu = (id: string) => (electron.template.find((menu) => menu.id === id)!.submenu as MenuItemConstructorOptions[]).map((item) => item.id);
    expect(submenu('damocles.menu.edit')).toEqual(expect.arrayContaining([MENU_IDS.findInFiles, MENU_IDS.replaceInFiles]));
    expect(submenu('damocles.menu.view')[0]).toBe(MENU_IDS.showCommands);
    expect(submenu('damocles.menu.chat').filter((id) => id?.startsWith('damocles.chat.'))).toHaveLength(10);
    const items = menuItems('win32');
    expect(items.find((item) => item.id === MENU_IDS.showCommands)).toMatchObject({ label: 'Command Palette...', accelerator: 'CmdOrCtrl+Shift+P' });
    expect(items.find((item) => item.id === MENU_IDS.findInFiles)).toMatchObject({ label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F' });
    expect(items.find((item) => item.id === MENU_IDS.replaceInFiles)).toMatchObject({ label: 'Replace in Files', accelerator: 'CmdOrCtrl+Shift+H' });
    for (const id of [MENU_IDS.findInFiles, MENU_IDS.replaceInFiles, MENU_IDS.showCommands, MENU_IDS.chatContextUsage]) (items.find((item) => item.id === id)!.click as () => void)();
    expect(calls).toEqual(['searchInFiles:false', 'searchInFiles:true', 'showCommands', 'runChatCommand:contextUsage']);
  });

  it('puts Format Document in Edit with Shift+Alt+F, and the palette lists it as Edit: Format Document', () => {
    for (const platform of PLATFORMS) {
      menuItems(platform);
      const edit = (electron.template.find((menu) => menu.id === 'damocles.menu.edit')!.submenu as MenuItemConstructorOptions[]).map((item) => item.id);
      expect(edit).toContain(MENU_IDS.formatDocument);
    }
    const items = menuItems('win32');
    expect(items.find((item) => item.id === MENU_IDS.formatDocument)).toMatchObject({ label: 'Format Document', accelerator: 'Shift+Alt+F', enabled: false });
    (items.find((item) => item.id === MENU_IDS.formatDocument)!.click as () => void)();
    expect(calls).toEqual(['formatDocument']);
    const listed = palette(el).list(EDITOR).find((entry) => entry.id === MENU_IDS.formatDocument);
    expect(listed).toMatchObject({ label: 'Επεξεργασία: Μορφοποίηση εγγράφου', englishLabel: 'Edit: Format Document', accelerator: 'Shift+Alt+F', enabled: true });
    expect(palette().list(CHAT).find((entry) => entry.id === MENU_IDS.formatDocument)?.enabled).toBe(false);
  });

  it('writes shortcuts as the platform does', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+F', 'win32')).toBe('Ctrl+Shift+F');
    expect(acceleratorLabel('CmdOrCtrl+Shift+F', 'darwin')).toBe('⇧⌘F');
    expect(acceleratorLabel('Ctrl+`', 'darwin')).toBe('⌃`');
    expect(acceleratorLabel('Shift+F6', 'linux')).toBe('Shift+F6');
    expect(acceleratorLabel('CmdOrCtrl+,', 'win32')).toBe('Ctrl+,');
  });
});

describe('command palette', () => {
  it('lists "Category: Title" with the shortcut and the enablement of the captured context, and the English label in Greek', () => {
    const save = palette().list(CHAT).find((entry) => entry.id === MENU_IDS.save)!;
    expect(save).toEqual({ id: MENU_IDS.save, label: 'File: Save', englishLabel: 'File: Save', category: 'File', accelerator: 'Ctrl+S', enabled: false, recent: false });
    expect(palette().list(EDITOR).find((entry) => entry.id === MENU_IDS.save)!.enabled).toBe(true);
    const context = palette(el).list(CHAT).find((entry) => entry.id === MENU_IDS.chatContextUsage)!;
    expect(context.englishLabel).toBe('Chat: Context usage');
    expect(context.label).not.toBe(context.englishLabel);
    expect(palette().list(CHAT).find((entry) => entry.id === openChatForProjectId('C:\\work\\alpha'))?.label).toBe('File: Open Chat in alpha');
    expect(palette(en, 'darwin').list(CHAT).find((entry) => entry.id === MENU_IDS.showCommands)?.accelerator).toBe('⇧⌘P');
  });

  it('runs a command in the context captured when the palette opened, never one disabled there or unknown', () => {
    const commands = palette();
    expect(commands.run(MENU_IDS.save, CHAT)).toBe(false);
    expect(commands.run('damocles.notACommand', EDITOR)).toBe(false);
    expect(commands.run(openChatForProjectId('C:\\elsewhere'), EDITOR)).toBe(false);
    expect(calls).toEqual([]);
    expect(commands.run(MENU_IDS.save, EDITOR)).toBe(true);
    expect(commands.run(MENU_IDS.chatContextUsage, CHAT)).toBe(true);
    expect(commands.run(openChatForProjectId('C:\\work\\alpha'), NONE)).toBe(true);
    expect(calls).toEqual(['saveEditor', 'runChatCommand:contextUsage', 'openChatForProject:C:\\work\\alpha']);
  });

  it('lists the commands run this session first, the most recent on top, then the rest by label', () => {
    const commands = palette();
    commands.run(MENU_IDS.toggleSidebar, CHAT);
    commands.run(MENU_IDS.findInFiles, CHAT);
    commands.run(MENU_IDS.toggleSidebar, CHAT);
    const listed = commands.list(CHAT);
    expect(listed.slice(0, 2).map((entry) => [entry.id, entry.recent])).toEqual([[MENU_IDS.toggleSidebar, true], [MENU_IDS.findInFiles, true]]);
    const rest = listed.slice(2).map((entry) => entry.label);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, 'en')));
    expect(listed.slice(2).every((entry) => !entry.recent)).toBe(true);
  });
});

describe('Search commands', () => {
  const SEARCH = { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible: false };
  const state = (focus: MenuState['focus'], search: Partial<typeof SEARCH>): MenuState => ({ ...NONE, focus, search: { ...SEARCH, ...search } });
  const command = (id: string) => desktopCommands(PROJECTS, actions, 'win32').find((candidate) => candidate.id === id)!;

  it('keeps VS Code\'s keys, enabled by the active Search Editor or the view and fired only where VS Code\'s when clauses allow them', () => {
    expect(command(MENU_IDS.searchAgain)).toMatchObject({ accelerator: 'CmdOrCtrl+Shift+R', category: { message: 'Search' } });
    expect(command(MENU_IDS.searchAgain).enabled!(state('editor', { editorActive: true }))).toBe(true);
    expect(command(MENU_IDS.searchAgain).enabled!(state('sidebar', { editorActive: true }))).toBe(true);
    expect(command(MENU_IDS.searchAgain).enabled!(state('editor', {}))).toBe(false);
    expect(keyFires(command(MENU_IDS.searchAgain), state('editor', { editorActive: true }))).toBe(true);
    expect(keyFires(command(MENU_IDS.searchAgain), state('sidebar', { editorActive: true }))).toBe(false);
    expect(keyFires(command(MENU_IDS.focusNextSearchResult), state('chat', { editorActive: true }))).toBe(false);
    expect(keyFires(command(MENU_IDS.focusNextSearchResult), state('chat', { editorActive: true, viewHasResults: true }))).toBe(true);
    expect(command(MENU_IDS.focusNextSearchResult).enabled!(state('chat', { editorActive: true }))).toBe(true);
    expect(command(MENU_IDS.toggleSearchEditorContextLines).accelerator).toBe('Alt+L');
    expect(command(MENU_IDS.increaseSearchEditorContextLines).accelerator).toBe('Alt+=');
    expect(command(MENU_IDS.decreaseSearchEditorContextLines).accelerator).toBe('Alt+-');
    expect(command(MENU_IDS.focusNextSearchResult).enabled!(state('chat', { viewHasResults: true }))).toBe(true);
    expect(command(MENU_IDS.focusNextSearchResult).enabled!(state('chat', {}))).toBe(false);
    expect(command(MENU_IDS.cancelSearch).enabled!(state('sidebar', { viewRunning: true }))).toBe(true);
    expect(command(MENU_IDS.toggleQueryDetails).enabled!(state('sidebar', { viewVisible: true }))).toBe(true);
  });

  it('sends F4 to the focused Search Editor, else to the view', () => {
    calls.length = 0;
    command(MENU_IDS.focusNextSearchResult).run(state('editor', { editorActive: true }), 'accelerator');
    command(MENU_IDS.focusNextSearchResult).run(state('sidebar', { viewHasResults: true }), 'accelerator');
    command(MENU_IDS.openSearchEditor).run(NONE, 'palette');
    // a menu click moved focus to the title bar, so it acts on the active editor as VS Code's focusNextSearchResult does
    command(MENU_IDS.focusNextSearchResult).run(state(undefined, { editorActive: true, viewHasResults: true }), 'menu');
    command(MENU_IDS.focusNextSearchResult).run(state('sidebar', { editorActive: true, viewHasResults: true }), 'accelerator');
    expect(calls).toEqual(['searchEditorCommand:focusNextResult', 'searchViewCommand:focusNextResult', 'openSearchEditor', 'searchEditorCommand:focusNextResult', 'searchViewCommand:focusNextResult']);
  });

  it('gives no two enabled-together commands the same accelerator', () => {
    const accelerators = desktopCommands(PROJECTS, actions, 'win32').filter((candidate) => candidate.accelerator !== undefined && candidate.registerAccelerator !== false).map((candidate) => candidate.accelerator);
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });
});

describe('split terminal commands', () => {
  const TERMINAL: MenuState = { ...CHAT, focus: 'terminal', terminal: 'running', terminalInput: true };
  const SPLIT: MenuState = { ...TERMINAL, terminalSplit: true };
  const command = (platform: NodeJS.Platform, id: string) => desktopCommands(PROJECTS, actions, platform).find((candidate) => candidate.id === id)!;
  const PANE_IDS = [MENU_IDS.splitTerminal, MENU_IDS.unsplitTerminal, MENU_IDS.focusPreviousTerminalPane, MENU_IDS.focusNextTerminalPane, MENU_IDS.resizeTerminalPaneLeft, MENU_IDS.resizeTerminalPaneRight];

  it('binds VS Code\'s keys on each platform: Split, Focus Previous and Next Pane everywhere, Resize Pane on Linux and macOS only', () => {
    const keys = (platform: NodeJS.Platform) => PANE_IDS.map((id) => command(platform, id).accelerator);
    expect(keys('win32')).toEqual(['Ctrl+Shift+5', undefined, 'Alt+Left', 'Alt+Right', undefined, undefined]);
    expect(keys('linux')).toEqual(['Ctrl+Shift+5', undefined, 'Alt+Left', 'Alt+Right', 'Ctrl+Shift+Left', 'Ctrl+Shift+Right']);
    expect(keys('darwin')).toEqual(['Cmd+\\', undefined, 'Alt+Cmd+Left', 'Alt+Cmd+Right', 'Cmd+Ctrl+Left', 'Cmd+Ctrl+Right']);
  });

  it('fires Split and Resize Pane keys only from a terminal, and the pane focus keys only from a terminal in a split group', () => {
    for (const platform of PLATFORMS) {
      const key = (id: string, context: MenuState) => keyFires(command(platform, id), context);
      expect(key(MENU_IDS.splitTerminal, TERMINAL)).toBe(true);
      expect(key(MENU_IDS.splitTerminal, { ...TERMINAL, focus: 'chat' })).toBe(false);
      expect(key(MENU_IDS.splitTerminal, { ...TERMINAL, terminal: undefined })).toBe(false);
      expect(key(MENU_IDS.focusPreviousTerminalPane, TERMINAL)).toBe(false);
      expect(key(MENU_IDS.focusNextTerminalPane, SPLIT)).toBe(true);
      expect(key(MENU_IDS.focusNextTerminalPane, { ...SPLIT, focus: 'chat' })).toBe(false);
      expect(key(MENU_IDS.resizeTerminalPaneLeft, { ...SPLIT, focus: 'editor' })).toBe(false);
      // the menu and the palette follow VS Code's preconditions alone: a terminal exists
      for (const id of PANE_IDS) {
        expect(isEnabled(command(platform, id), { ...TERMINAL, focus: 'chat' }), `${platform} ${id}`).toBe(true);
        expect(isEnabled(command(platform, id), NONE), `${platform} ${id}`).toBe(false);
      }
    }
  });

  // VS Code's terminalFocus: the skip list and the terminal's own keys hold only while the xterm's input has focus.
  it('keeps app keys working from the terminal pane\'s list, tab and fields, which are not the xterm', () => {
    for (const platform of PLATFORMS) {
      const key = (id: string, context: MenuState) => keyFires(command(platform, id), context);
      const pane: MenuState = { ...SPLIT, terminalInput: false };
      expect(key(MENU_IDS.findInFiles, SPLIT), platform).toBe(false);
      expect(key(MENU_IDS.findInFiles, pane), platform).toBe(true);
      expect(key(MENU_IDS.focusNextPart, pane), platform).toBe(true);
      for (const id of [MENU_IDS.splitTerminal, MENU_IDS.focusNextTerminalPane]) expect(key(id, pane), `${platform} ${id}`).toBe(false);
    }
  });

  it('passes the pane focus keys through xterm only for a split group, and Split, Resize Pane and F6 always', () => {
    const passed = (platform: NodeJS.Platform, splitActive: boolean) => terminalPassKeys(desktopCommands(PROJECTS, actions, platform), { ...CHAT, terminal: 'running', terminalSplit: splitActive });
    expect(passed('win32', false)).toEqual(expect.arrayContaining(['Ctrl+Shift+5', 'F6', 'Shift+F6']));
    expect(passed('win32', false)).not.toContain('Alt+Left');
    expect(passed('win32', true)).toEqual(expect.arrayContaining(['Alt+Left', 'Alt+Right', 'F6', 'Shift+F6']));
    expect(passed('linux', false)).toEqual(expect.arrayContaining(['Ctrl+Shift+Left', 'Ctrl+Shift+Right']));
    expect(passed('darwin', false)).not.toContain('Alt+Cmd+Left');
    expect(passed('darwin', true)).toEqual(expect.arrayContaining(['Cmd+\\', 'Alt+Cmd+Left', 'Alt+Cmd+Right', 'Cmd+Ctrl+Left']));
  });

  it('runs each pane action and lists the commands in English and Greek', () => {
    const commands = palette(el);
    for (const id of PANE_IDS) expect(commands.run(id, SPLIT)).toBe(true);
    expect(calls).toEqual(['splitTerminal', 'unsplitTerminal', 'focusTerminalPane:-1', 'focusTerminalPane:1', 'resizeTerminalPane:left', 'resizeTerminalPane:right']);
    const listed = commands.list(SPLIT).filter((entry) => PANE_IDS.includes(entry.id as (typeof PANE_IDS)[number]));
    expect(listed.map((entry) => entry.englishLabel).sort()).toEqual([
      'Terminal: Focus Next Terminal in Terminal Group',
      'Terminal: Focus Previous Terminal in Terminal Group',
      'Terminal: Resize Terminal Left',
      'Terminal: Resize Terminal Right',
      'Terminal: Split Terminal',
      'Terminal: Unsplit Terminal',
    ]);
    for (const entry of listed) expect(entry.label, entry.id).not.toBe(entry.englishLabel);
  });

  it('names Focus Next and Previous Terminal by the groups they walk, as VS Code does', () => {
    const listed = palette(el).list(SPLIT);
    const english = (id: string) => listed.find((entry) => entry.id === id)!.englishLabel;
    expect([english(MENU_IDS.focusNextTerminal), english(MENU_IDS.focusPreviousTerminal)]).toEqual(['Terminal: Focus Next Terminal Group', 'Terminal: Focus Previous Terminal Group']);
    expect(listed.find((entry) => entry.id === MENU_IDS.focusNextTerminal)!.label).toBe('Τερματικό: Εστίαση στην επόμενη ομάδα τερματικών');
  });
});
