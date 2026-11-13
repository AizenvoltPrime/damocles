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

import { acceleratorLabel, CHAT_FEATURE_IDS, CommandPalette, desktopCommands, isEnabled, keyFires, MENU_IDS, newChatInWorktreeAccelerator, openChatForProjectId, terminalPassKeys } from '../commands';
import { installApplicationMenu, type MenuActions, type MenuState } from '../menu';
import { createDesktopLocalizationService } from '../../local-services/localization-service';
import { NO_SCM_MENU_STATE } from '../scm/scm-host';

const calls: string[] = [];
const actions = new Proxy({} as MenuActions, {
  get: (_target, name: string) => (...args: unknown[]) => calls.push([name, ...args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : arg))].join(':')),
});

const PROJECTS = [{ fsPath: 'C:\\work\\alpha', name: 'alpha' }] as never;
const CHAT: MenuState = { chat: true, liveChat: true, editor: false, browser: true, page: false, focus: 'chat', updateCheck: true, terminalCreate: true, terminal: undefined, terminalEditor: false, terminalTask: false, terminalSplit: false, terminalJoin: false, terminalInput: false, search: { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible: false }, scm: NO_SCM_MENU_STATE, editorKind: undefined, editorDocument: undefined, editorGit: null, selectedChatHasChanges: false, worktree: undefined, handOff: undefined, newChatInWorktree: undefined, remoteHostConnected: false, remoteHostSaved: false, clientCertificateSite: false };
const EDITOR: MenuState = { ...CHAT, editor: true, focus: 'editor', editorKind: 'code', editorDocument: { writable: true, formattable: true } };
const NONE: MenuState = { chat: false, liveChat: false, editor: false, browser: false, page: false, focus: undefined, updateCheck: false, terminalCreate: false, terminal: undefined, terminalEditor: false, terminalTask: false, terminalSplit: false, terminalJoin: false, terminalInput: false, search: { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible: false }, scm: NO_SCM_MENU_STATE, editorKind: undefined, editorDocument: undefined, editorGit: null, selectedChatHasChanges: false, worktree: undefined, handOff: undefined, newChatInWorktree: undefined, remoteHostConnected: false, remoteHostSaved: false, clientCertificateSite: false };
const PLATFORMS = ['win32', 'linux', 'darwin'] as const;

const en = createDesktopLocalizationService(process.cwd(), 'en', () => undefined);
const el = createDesktopLocalizationService(process.cwd(), 'el', () => undefined);

function palette(l10n = en, platform: NodeJS.Platform = 'win32'): CommandPalette {
  return new CommandPalette({ commands: () => desktopCommands(PROJECTS, actions, platform), l10n, english: en, platform, log: () => undefined });
}

// the force push commands leave the menu while allowForcePush is off, and Stash Staged below git 2.35, so the menu is
// built with both on
function menuItems(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  installApplicationMenu(PROJECTS, actions, en, { ...CHAT, scm: { ...CHAT.scm, allowForcePush: true, stashStaged: true } }, platform);
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
    expect(enabled(MENU_IDS.findInFiles, NONE)).toBe(true);
    expect(enabled(MENU_IDS.toggleBrowserDevTools, { ...CHAT, page: true })).toBe(true);
    // only a page tab showing an https address has a site to choose a certificate for
    expect(enabled(MENU_IDS.chooseClientCertificate, { ...CHAT, page: true })).toBe(false);
    expect(enabled(MENU_IDS.chooseClientCertificate, { ...CHAT, page: true, clientCertificateSite: true })).toBe(true);
    expect(enabled(MENU_IDS.checkForUpdates, NONE)).toBe(false);
  });

  it("enables Save, Save As and Format Document from the active tab's document, in the menu and the palette, and Close Editor for any tab", () => {
    const byId = new Map(desktopCommands(PROJECTS, actions, 'win32').map((command) => [command.id, command]));
    const documentCommands = [MENU_IDS.save, MENU_IDS.saveAs, MENU_IDS.formatDocument, MENU_IDS.closeEditor] as const;
    const enablement = (context: MenuState): boolean[] => {
      const menu = documentCommands.map((id) => isEnabled(byId.get(id)!, context));
      const entries = palette().list(context);
      expect(documentCommands.map((id) => entries.find((entry) => entry.id === id)!.enabled), context.editorKind).toEqual(menu);
      return menu;
    };
    // [Save, Save As, Format Document, Close Editor]
    for (const kind of ['markdownPreview', 'image', 'notDisplayed', 'changes', 'review', 'timeline', 'htmlPreview', 'browser', 'designPreview', 'terminal'] as const) {
      expect(enablement({ ...EDITOR, editorKind: kind, editorDocument: undefined }), kind).toEqual([false, false, false, true]);
    }
    expect(enablement({ ...EDITOR, editorKind: 'code', editorDocument: { writable: true, formattable: true } })).toEqual([true, true, true, true]);
    expect(enablement({ ...EDITOR, editorKind: 'log', editorDocument: { writable: false, formattable: false } })).toEqual([false, true, false, true]);
    expect(enablement({ ...EDITOR, editorKind: 'searchEditor', editorDocument: { writable: true, formattable: false } })).toEqual([true, true, false, true]);
    expect(enablement(CHAT)).toEqual([false, false, false, false]);
  });

  it("disables the commands that need the chat's core on an offline transcript, and keeps the prompt navigator", () => {
    const byId = new Map(desktopCommands(PROJECTS, actions, 'win32').map((command) => [command.id, command]));
    const enabled = (id: string, context: MenuState) => isEnabled(byId.get(id)!, context);
    const offline: MenuState = { ...CHAT, liveChat: false, selectedChatHasChanges: true };
    const live: MenuState = { ...CHAT, selectedChatHasChanges: true };
    const needCore = [...CHAT_FEATURE_IDS, MENU_IDS.newBrowserPage, MENU_IDS.chatReviewChanges];
    expect(needCore).toHaveLength(12);
    for (const id of needCore) {
      expect(enabled(id, offline)).toBe(false);
      expect(enabled(id, live)).toBe(true);
    }
    expect(enabled(MENU_IDS.togglePromptNavigator, offline)).toBe(true);
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

  it('adds Find in Files and Replace in Files to Edit, the palette to View, and the ten chat commands with Review Changes to Chat', () => {
    menuItems('win32');
    const submenu = (id: string) => (electron.template.find((menu) => menu.id === id)!.submenu as MenuItemConstructorOptions[]).map((item) => item.id);
    expect(submenu('damocles.menu.edit')).toEqual(expect.arrayContaining([MENU_IDS.findInFiles, MENU_IDS.replaceInFiles]));
    expect(submenu('damocles.menu.view')[0]).toBe(MENU_IDS.showCommands);
    expect(submenu('damocles.menu.chat').filter((id) => id?.startsWith('damocles.chat.'))).toEqual([...CHAT_FEATURE_IDS, MENU_IDS.chatReviewChanges, MENU_IDS.chatHandOffToWorktree, MENU_IDS.chatHandOffToProjectFolder]);
    const chatMenu = electron.template.find((menu) => menu.id === 'damocles.menu.chat')!.submenu as MenuItemConstructorOptions[];
    const worktreeMenu = chatMenu.find((item) => item.id === 'damocles.menu.worktree')!.submenu as MenuItemConstructorOptions[];
    expect(worktreeMenu.map((item) => item.id ?? item.type)).toEqual([MENU_IDS.worktreeApply, MENU_IDS.worktreeMerge, MENU_IDS.worktreeUpdate, MENU_IDS.worktreePushBranch, 'separator', MENU_IDS.worktreeDelete]);
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

  it('puts Restart Engine in the Chat menu under Show Log and in the palette, enabled with no chat loaded, as the engine may be down', () => {
    for (const platform of PLATFORMS) {
      menuItems(platform);
      const chat = (electron.template.find((menu) => menu.id === 'damocles.menu.chat')!.submenu as MenuItemConstructorOptions[]).map((item) => item.id);
      expect(chat.slice(-2), platform).toEqual([MENU_IDS.showLog, MENU_IDS.restartEngine]);
    }
    const item = menuItems('win32').find((candidate) => candidate.id === MENU_IDS.restartEngine)!;
    expect(item).toMatchObject({ label: 'Restart Engine', enabled: true });
    (item.click as () => void)();
    expect(calls).toEqual(['restartEngine']);
    expect(palette(el).list(NONE).find((entry) => entry.id === MENU_IDS.restartEngine)).toMatchObject({ englishLabel: 'Chat: Restart Engine', enabled: true, accelerator: null });
    expect(palette().run(MENU_IDS.restartEngine, NONE)).toBe(true);
    expect(calls).toEqual(['restartEngine', 'restartEngine']);
  });

  it('adds Chat: New Chat in This Worktree under New Chat with VS Code\'s per-OS key, enabled only for a chat working in its worktree', () => {
    const target = { projectKey: 'c:\\work\\alpha', worktreeId: 'abcd1234' };
    const inWorktree: MenuState = { ...CHAT, newChatInWorktree: target };
    for (const [platform, accelerator] of [['win32', 'Shift+Alt+N'], ['linux', 'Ctrl+Alt+N'], ['darwin', 'Cmd+Alt+N']] as const) {
      expect(newChatInWorktreeAccelerator(platform)).toBe(accelerator);
      const command = desktopCommands(PROJECTS, actions, platform).find((candidate) => candidate.id === 'damocles.chat.newChatInWorktree')!;
      expect(command).toMatchObject({ accelerator, inTerminal: true });
      expect(isEnabled(command, CHAT)).toBe(false);
      expect(isEnabled(command, NONE)).toBe(false);
      expect(isEnabled(command, inWorktree)).toBe(true);
      // like New Chat, the key reaches the menu from a focused terminal
      expect(keyFires(command, { ...inWorktree, focus: 'terminal', terminalInput: true })).toBe(true);
      expect(terminalPassKeys(desktopCommands(PROJECTS, actions, platform), inWorktree)).toContain(accelerator);
      menuItems(platform);
      const file = (electron.template.find((menu) => menu.id === 'damocles.menu.file')!.submenu as MenuItemConstructorOptions[]).map((item) => item.id);
      expect(file.indexOf(MENU_IDS.chatNewInWorktree)).toBe(file.indexOf(MENU_IDS.newChat) + 1);
    }
    expect(MENU_IDS.chatNewInWorktree).toBe('damocles.chat.newChatInWorktree');
    expect(palette().run(MENU_IDS.chatNewInWorktree, CHAT)).toBe(false);
    expect(palette().run(MENU_IDS.chatNewInWorktree, inWorktree)).toBe(true);
    expect(calls).toEqual([`newChatInWorktree:${JSON.stringify(target)}`]);
    expect(palette().list(inWorktree).find((entry) => entry.id === MENU_IDS.chatNewInWorktree)).toMatchObject({ label: 'Chat: New Chat in This Worktree', accelerator: 'Shift+Alt+N', enabled: true });
    expect(palette(el, 'darwin').list(inWorktree).find((entry) => entry.id === MENU_IDS.chatNewInWorktree)).toMatchObject({ label: 'Συνομιλία: Νέα συνομιλία σε αυτό το worktree', englishLabel: 'Chat: New Chat in This Worktree', accelerator: '⌥⌘N' });
    // Ctrl+N stays the project-folder New Chat
    expect(desktopCommands(PROJECTS, actions, 'win32').find((command) => command.id === MENU_IDS.newChat)).toMatchObject({ accelerator: 'CmdOrCtrl+N' });
  });

  it('gives New Chat in This Worktree a key no other menu item has on any platform, however the accelerator is spelled', () => {
    for (const platform of PLATFORMS) {
      const normalized = (accelerator: string): string => {
        const parts = accelerator.split('+');
        const key = parts.pop()!.toUpperCase();
        const modifiers = parts.map((part) => {
          if (part === 'CmdOrCtrl' || part === 'CommandOrControl') return platform === 'darwin' ? 'Cmd' : 'Ctrl';
          if (part === 'Command') return 'Cmd';
          if (part === 'Control') return 'Ctrl';
          if (part === 'Option') return 'Alt';
          return part;
        });
        return [...modifiers.sort(), key].join('+');
      };
      const own = normalized(newChatInWorktreeAccelerator(platform));
      const others = menuItems(platform).filter((item) => item.id !== MENU_IDS.chatNewInWorktree && typeof item.accelerator === 'string').map((item) => normalized(item.accelerator as string));
      expect(others, platform).not.toContain(own);
    }
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

describe('Git commit commands', () => {
  const OPEN: MenuState = { ...CHAT, scm: { ...NO_SCM_MENU_STATE, available: true, openRepositoryCount: 1 } };
  const labels = (context: MenuState): string[] => palette().list(context).map((entry) => entry.label).filter((label) => label.startsWith('Git: '));

  it('lists VS Code\'s commit variants, with the No Verify ones only while allowNoVerifyCommit is on', () => {
    const off = labels(OPEN);
    expect(off).toEqual(expect.arrayContaining(['Git: Commit', 'Git: Commit Staged', 'Git: Commit All', 'Git: Commit (Amend)', 'Git: Commit Staged (Amend)', 'Git: Commit All (Amend)', 'Git: Commit (Signed Off)', 'Git: Commit Staged (Signed Off)', 'Git: Commit All (Signed Off)', 'Git: Commit Empty', 'Git: Undo Last Commit', 'Git: Close All Diff Editors']));
    expect(off.filter((label) => label.includes('No Verify'))).toEqual([]);
    const on = labels({ ...OPEN, scm: { ...OPEN.scm, allowNoVerifyCommit: true } }).filter((label) => label.includes('No Verify'));
    expect(on.sort()).toEqual([
      'Git: Commit (Amend, No Verify)',
      'Git: Commit (No Verify)',
      'Git: Commit (Signed Off, No Verify)',
      'Git: Commit All (Amend, No Verify)',
      'Git: Commit All (No Verify)',
      'Git: Commit All (Signed Off, No Verify)',
      'Git: Commit Empty (No Verify)',
      'Git: Commit Staged (Amend, No Verify)',
      'Git: Commit Staged (No Verify)',
      'Git: Commit Staged (Signed Off, No Verify)',
    ]);
    expect(labels(CHAT).filter((label) => label.startsWith('Git: Commit'))).toEqual([]);
    expect(labels(OPEN)).not.toContain('Git: Restore Commit Template');
  });

  it('titles each commit variant as the amend it runs while the commit box amends, drops the amend variants, and reverts', () => {
    const NO_VERIFY = { ...OPEN, scm: { ...OPEN.scm, allowNoVerifyCommit: true } };
    const AMENDING = { ...NO_VERIFY, scm: { ...NO_VERIFY.scm, amending: true } };
    const commits = (context: MenuState): string[] => labels(context).filter((label) => label.startsWith('Git: Commit')).sort();
    expect(commits(AMENDING)).toEqual([
      'Git: Commit (Amend)',
      'Git: Commit (Amend, No Verify)',
      'Git: Commit (Amend, Signed Off)',
      'Git: Commit (Amend, Signed Off, No Verify)',
      'Git: Commit All (Amend)',
      'Git: Commit All (Amend, No Verify)',
      'Git: Commit All (Amend, Signed Off)',
      'Git: Commit All (Amend, Signed Off, No Verify)',
      'Git: Commit Empty (Amend)',
      'Git: Commit Empty (Amend, No Verify)',
      'Git: Commit Staged (Amend)',
      'Git: Commit Staged (Amend, No Verify)',
      'Git: Commit Staged (Amend, Signed Off)',
      'Git: Commit Staged (Amend, Signed Off, No Verify)',
    ]);
    const ids = palette().list(AMENDING).map((entry) => entry.id);
    for (const id of [MENU_IDS.gitCommitAmend, MENU_IDS.gitCommitStagedAmend, MENU_IDS.gitCommitAllAmend, MENU_IDS.gitCommitAmendNoVerify, MENU_IDS.gitCommitStagedAmendNoVerify, MENU_IDS.gitCommitAllAmendNoVerify]) {
      expect(ids, id).not.toContain(id);
      expect(palette().run(id, AMENDING), id).toBe(false);
    }
    expect(palette().list(AMENDING).find((entry) => entry.id === MENU_IDS.gitCommit)).toMatchObject({ label: 'Git: Commit (Amend)', englishLabel: 'Git: Commit (Amend)', enabled: true });
    const greek = palette(el).list(AMENDING);
    expect(greek.find((entry) => entry.id === MENU_IDS.gitCommitAllSigned)).toMatchObject({ label: 'Git: Υποβολή όλων (τροποποίηση, με sign-off)', englishLabel: 'Git: Commit All (Amend, Signed Off)' });
    expect(greek.find((entry) => entry.id === MENU_IDS.gitCommitEmpty)!.label).toBe('Git: Κενή υποβολή (τροποποίηση)');

    const back = commits(NO_VERIFY);
    expect(back).toEqual(expect.arrayContaining(['Git: Commit', 'Git: Commit (Amend)', 'Git: Commit (Signed Off, No Verify)', 'Git: Commit Empty']));
    expect(back).toHaveLength(20);
  });

  it('runs each variant as the shell\'s commit of its draft with that variant', () => {
    const commands = palette();
    const NO_VERIFY = { ...OPEN, scm: { ...OPEN.scm, allowNoVerifyCommit: true } };
    for (const id of [MENU_IDS.gitCommit, MENU_IDS.gitCommitAllAmend, MENU_IDS.gitCommitStagedSigned, MENU_IDS.gitCommitEmptyNoVerify]) expect(commands.run(id, NO_VERIFY)).toBe(true);
    expect(commands.run(MENU_IDS.gitCommitNoVerify, OPEN)).toBe(false);
    expect(calls).toEqual([
      'scmCommit:{"scope":"auto","amend":false,"signoff":false,"noVerify":false,"empty":false}',
      'scmCommit:{"scope":"all","amend":true,"signoff":false,"noVerify":false,"empty":false}',
      'scmCommit:{"scope":"staged","amend":false,"signoff":true,"noVerify":false,"empty":false}',
      'scmCommit:{"scope":"auto","amend":false,"signoff":false,"noVerify":true,"empty":true}',
    ]);
  });

  it('lists Rename for a file in a repository, Delete for any file, Open All Changes and Close All Unmodified Editors always', () => {
    const file = { ...OPEN, scm: { ...OPEN.scm, activeEditorFile: true } };
    expect(labels(file)).toEqual(expect.arrayContaining(['Git: Delete', 'Git: Open All Changes', 'Git: Close All Unmodified Editors']));
    expect(labels(file)).not.toContain('Git: Rename');
    expect(labels({ ...file, scm: { ...file.scm, activeFileInRepository: true } })).toContain('Git: Rename');
    expect(labels(OPEN)).not.toContain('Git: Delete');
    const none = palette().list(NONE);
    expect(none.find((entry) => entry.label === 'Git: Open All Changes')?.enabled).toBe(false);
    expect(none.find((entry) => entry.label === 'Git: Close All Unmodified Editors')?.enabled).toBe(true);
    const commands = palette();
    commands.run(MENU_IDS.gitRename, { ...file, scm: { ...file.scm, activeFileInRepository: true } });
    commands.run(MENU_IDS.gitDelete, file);
    commands.run(MENU_IDS.gitUndoCommit, OPEN);
    commands.run(MENU_IDS.gitCloseAllUnmodifiedEditors, NONE);
    expect(calls).toEqual(['scmActiveFile:rename', 'scmActiveFile:delete', 'scmRun:{"op":"undoLastCommit"}', 'scmRun:{"op":"closeAllUnmodifiedEditors"}']);
  });

  it('lists Cherry Pick... with no shortcut only while no merge, rebase or cherry-pick is in progress, and runs it with no commit', () => {
    expect(labels(OPEN)).toContain('Git: Cherry Pick...');
    for (const operation of ['merge', 'rebase', 'cherryPick'] as const) {
      const busy = { ...OPEN, scm: { ...OPEN.scm, operation } };
      expect(labels(busy), operation).not.toContain('Git: Cherry Pick...');
      expect(palette().run(MENU_IDS.gitCherryPick, busy), operation).toBe(false);
    }
    expect(labels(CHAT)).not.toContain('Git: Cherry Pick...');
    expect(palette().list(OPEN).find((entry) => entry.id === MENU_IDS.gitCherryPick)).toMatchObject({ enabled: true });
    expect(palette().list(OPEN).find((entry) => entry.id === MENU_IDS.gitCherryPick)?.accelerator).toBeNull();
    expect(palette().run(MENU_IDS.gitCherryPick, OPEN)).toBe(true);
    expect(calls).toEqual(['scmRun:{"op":"cherryPick"}']);
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
      expect(key(MENU_IDS.resizeTerminalPaneLeft, { ...SPLIT, focus: 'editor', terminalInput: false })).toBe(false);
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

  // VS Code skips the shell for Resize Pane in any focused terminal (its when clause is terminalFocus alone)
  it('lets Split Terminal\'s key reach an editor terminal\'s pty, and still passes Resize Pane and F6 there', () => {
    const passed = (platform: NodeJS.Platform) => terminalPassKeys(desktopCommands(PROJECTS, actions, platform), { ...CHAT, terminal: 'running', terminalEditor: true });
    expect(passed('win32')).not.toContain('Ctrl+Shift+5');
    expect(passed('win32')).toEqual(expect.arrayContaining(['F6', 'Shift+F6']));
    expect(passed('linux')).not.toContain('Ctrl+Shift+5');
    expect(passed('linux')).toEqual(expect.arrayContaining(['Ctrl+Shift+Left', 'Ctrl+Shift+Right']));
    expect(passed('darwin')).not.toContain('Cmd+\\');
    expect(passed('darwin')).toEqual(expect.arrayContaining(['Cmd+Ctrl+Left', 'Cmd+Ctrl+Right']));
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

  it('enables Join Terminals... only while the active terminal\'s group can take another terminal, and runs it in English and Greek', () => {
    const join = command('win32', MENU_IDS.joinTerminals);
    expect(join.accelerator).toBeUndefined();
    expect(isEnabled(join, TERMINAL)).toBe(false);
    expect(isEnabled(join, { ...TERMINAL, terminalJoin: true, focus: 'chat' })).toBe(true);
    for (const l10n of [en, el]) {
      const entry = palette(l10n).list({ ...TERMINAL, terminalJoin: true }).find((candidate) => candidate.id === MENU_IDS.joinTerminals)!;
      expect(entry.englishLabel).toBe('Terminal: Join Terminals...');
      if (l10n === el) expect(entry.label).toBe('Τερματικό: Ένωση τερματικών...');
    }
    expect(palette(el).run(MENU_IDS.joinTerminals, { ...TERMINAL, terminalJoin: true })).toBe(true);
    expect(palette(el).run(MENU_IDS.joinTerminals, TERMINAL)).toBe(false);
    expect(calls).toEqual(['joinTerminals']);
  });

  it('disables the group commands for an editor terminal and keeps the others on the command target', () => {
    const EDITOR_TERMINAL: MenuState = { ...TERMINAL, focus: 'editor', terminalEditor: true };
    const GROUP_IDS = [...PANE_IDS, MENU_IDS.focusNextTerminal, MENU_IDS.focusPreviousTerminal, MENU_IDS.moveTerminalToEditor];
    const TARGET_IDS = [MENU_IDS.killTerminal, MENU_IDS.renameTerminal, MENU_IDS.changeTerminalIcon, MENU_IDS.changeTerminalColor, MENU_IDS.copyLastTerminalCommand, MENU_IDS.copyLastTerminalCommandOutput, MENU_IDS.addTerminalToChat, MENU_IDS.scrollToPreviousTerminalCommand, MENU_IDS.scrollToNextTerminalCommand, MENU_IDS.killAllTerminals, MENU_IDS.moveTerminalToPanel];
    for (const id of GROUP_IDS) {
      expect(isEnabled(command('win32', id), EDITOR_TERMINAL), id).toBe(false);
      expect(isEnabled(command('win32', id), TERMINAL), id).toBe(true);
    }
    for (const id of TARGET_IDS) expect(isEnabled(command('win32', id), EDITOR_TERMINAL), id).toBe(true);
    expect(isEnabled(command('win32', MENU_IDS.moveTerminalToPanel), TERMINAL)).toBe(false);
    expect(isEnabled(command('win32', MENU_IDS.restartTerminal), { ...EDITOR_TERMINAL, terminal: 'exited' })).toBe(true);
    // an editor terminal's xterm is the terminal focus, so only the skip list's keys fire from it
    expect(keyFires(command('win32', MENU_IDS.findInFiles), EDITOR_TERMINAL)).toBe(false);
    expect(keyFires(command('win32', MENU_IDS.findInFiles), { ...EDITOR_TERMINAL, terminalInput: false })).toBe(true);
    expect(keyFires(command('win32', MENU_IDS.splitTerminal), EDITOR_TERMINAL)).toBe(false);
  });

  it('disables Join Terminals... and Move Terminal into Editor Area for a task terminal, which stays in the panel', () => {
    const TASK: MenuState = { ...TERMINAL, terminalTask: true };
    expect(isEnabled(command('win32', MENU_IDS.moveTerminalToEditor), TASK)).toBe(false);
    // main computes terminalJoin false for a task target (TerminalService.joinRoom)
    expect(isEnabled(command('win32', MENU_IDS.joinTerminals), { ...TASK, terminalJoin: false })).toBe(false);
    expect(isEnabled(command('win32', MENU_IDS.killTerminal), TASK)).toBe(true);
  });

  it('runs Move Terminal into Editor Area and into Panel from the palette, named in English and Greek', () => {
    const commands = palette(el);
    expect(commands.run(MENU_IDS.moveTerminalToEditor, TERMINAL)).toBe(true);
    expect(commands.run(MENU_IDS.moveTerminalToPanel, TERMINAL)).toBe(false);
    expect(commands.run(MENU_IDS.moveTerminalToPanel, { ...TERMINAL, terminalEditor: true })).toBe(true);
    expect(calls).toEqual(['moveTerminalToEditor', 'moveTerminalToPanel']);
    const listed = commands.list({ ...TERMINAL, terminalEditor: true });
    const entry = (id: string) => listed.find((candidate) => candidate.id === id)!;
    expect([entry(MENU_IDS.moveTerminalToEditor).englishLabel, entry(MENU_IDS.moveTerminalToPanel).englishLabel]).toEqual(['Terminal: Move Terminal into Editor Area', 'Terminal: Move Terminal into Panel']);
    expect(entry(MENU_IDS.moveTerminalToPanel).label).toBe('Τερματικό: Μετακίνηση τερματικού στο πάνελ');
    expect([entry(MENU_IDS.moveTerminalToEditor).enabled, entry(MENU_IDS.moveTerminalToPanel).enabled]).toEqual([false, true]);
  });

  it('names Focus Next and Previous Terminal by the groups they walk, as VS Code does', () => {
    const listed = palette(el).list(SPLIT);
    const english = (id: string) => listed.find((entry) => entry.id === id)!.englishLabel;
    expect([english(MENU_IDS.focusNextTerminal), english(MENU_IDS.focusPreviousTerminal)]).toEqual(['Terminal: Focus Next Terminal Group', 'Terminal: Focus Previous Terminal Group']);
    expect(listed.find((entry) => entry.id === MENU_IDS.focusNextTerminal)!.label).toBe('Τερματικό: Εστίαση στην επόμενη ομάδα τερματικών');
  });
});

describe('editor git and chat review commands', () => {
  const FILE: MenuState = { ...EDITOR, scm: { ...NO_SCM_MENU_STATE, available: true, openRepositoryCount: 1 }, editorKind: 'code', editorGit: 'file' };
  const entry = (context: MenuState, id: string, platform: NodeJS.Platform = 'win32') => palette(en, platform).list(context).find((candidate) => candidate.id === id);

  it('shows each editor chord as its palette hint, written for the platform', () => {
    expect(entry(FILE, MENU_IDS.gitStageSelectedRanges)?.accelerator).toBe('Ctrl+K Ctrl+Alt+S');
    expect(entry(FILE, MENU_IDS.gitRevertSelectedRanges)?.accelerator).toBe('Ctrl+K Ctrl+R');
    expect(entry(FILE, MENU_IDS.nextChange)?.accelerator).toBe('Alt+F5');
    expect(entry(FILE, MENU_IDS.previousChange)?.accelerator).toBe('Shift+Alt+F5');
    expect(entry(FILE, MENU_IDS.gitStageSelectedRanges, 'darwin')?.accelerator).toBe('⌘K ⌥⌘S');
  });

  it('lists Stage and Revert Selected Ranges for a file, and Unstage only for a diff of staged changes (VS Code resourceScheme)', () => {
    expect(entry(FILE, MENU_IDS.gitUnstageSelectedRanges)).toBeUndefined();
    const staged: MenuState = { ...FILE, editorKind: 'diff', editorGit: 'indexDiff' };
    expect(entry(staged, MENU_IDS.gitUnstageSelectedRanges)?.enabled).toBe(true);
    expect(entry(staged, MENU_IDS.gitStageSelectedRanges)).toBeUndefined();
    expect(entry({ ...FILE, editorGit: 'workingTreeDiff', editorKind: 'diff' }, MENU_IDS.gitStageSelectedRanges)?.enabled).toBe(true);
    expect(entry({ ...FILE, editorGit: null }, MENU_IDS.gitOpenTimeline)).toBeUndefined();
  });

  it('enables the merge-conflict commands on a text or merge tab, keeps Toggle Inline Blame always, and Review Changes on the chat having changes', () => {
    expect(entry(FILE, MENU_IDS.mergeAcceptBoth)?.enabled).toBe(true);
    expect(entry({ ...FILE, editorKind: 'merge', editorGit: null }, MENU_IDS.mergeNextConflict)?.enabled).toBe(true);
    expect(entry({ ...FILE, editorKind: 'image', editorGit: null }, MENU_IDS.mergeAcceptBoth)?.enabled).toBe(false);
    expect(entry(NONE, MENU_IDS.gitToggleInlineBlame)?.enabled).toBe(true);
    expect(entry(CHAT, MENU_IDS.chatReviewChanges)?.enabled).toBe(false);
    expect(entry({ ...CHAT, selectedChatHasChanges: true }, MENU_IDS.chatReviewChanges)?.enabled).toBe(true);
  });

  it('enables the worktree finish actions only while no chat using the worktree works, Merge on a branch and Push with a remote (C8)', () => {
    const finish = { busy: false, hasRemote: true, detachedTarget: false };
    const worktree: MenuState = { ...CHAT, worktree: { finish, baseBranch: 'main' }, handOff: { canHandOff: true, place: 'worktree' } };
    const enabled = (context: MenuState) => [MENU_IDS.worktreeApply, MENU_IDS.worktreeMerge, MENU_IDS.worktreeUpdate, MENU_IDS.worktreePushBranch, MENU_IDS.worktreeDelete].map((id) => entry(context, id)?.enabled);
    expect(enabled(worktree)).toEqual([true, true, true, true, true]);
    expect(entry(worktree, MENU_IDS.worktreeMerge)?.label).toBe('Worktree: Merge into main');
    expect(entry(worktree, MENU_IDS.worktreeUpdate)?.label).toBe('Worktree: Update from main');
    expect(enabled({ ...worktree, worktree: { finish: { ...finish, busy: true } } })).toEqual([false, false, false, true, false]);
    expect(enabled({ ...worktree, worktree: { finish: { ...finish, detachedTarget: true } } })).toEqual([true, false, false, true, true]);
    expect(enabled({ ...worktree, worktree: { finish: { ...finish, hasRemote: false } } })).toEqual([true, true, true, false, true]);
    expect(enabled(CHAT)).toEqual([false, false, false, false, false]);
    // Hand off moves only to the other place, and only while the chat is idle
    expect([entry(worktree, MENU_IDS.chatHandOffToWorktree)?.enabled, entry(worktree, MENU_IDS.chatHandOffToProjectFolder)?.enabled]).toEqual([false, true]);
    expect(entry({ ...worktree, handOff: { canHandOff: false, place: 'worktree' } }, MENU_IDS.chatHandOffToProjectFolder)?.enabled).toBe(false);
    expect(entry({ ...CHAT, handOff: { canHandOff: true, place: 'project' } }, MENU_IDS.chatHandOffToWorktree)?.enabled).toBe(true);
    calls.length = 0;
    palette().run(MENU_IDS.worktreeDelete, worktree);
    palette().run(MENU_IDS.chatHandOffToProjectFolder, worktree);
    expect(calls).toEqual(['worktreeFinish:delete', 'handOff:project']);
  });

  it('runs each through the editor command or the action main carries out', () => {
    calls.length = 0;
    palette().run(MENU_IDS.gitStageSelectedRanges, FILE);
    palette().run(MENU_IDS.mergeAcceptAllIncoming, FILE);
    palette().run(MENU_IDS.gitToggleInlineBlame, FILE);
    palette().run(MENU_IDS.chatReviewChanges, { ...CHAT, selectedChatHasChanges: true });
    expect(calls).toEqual(['editorCommand:stageSelectedRanges', 'editorCommand:acceptAllIncoming', 'toggleInlineBlame', 'reviewChatChanges']);
  });
});

describe('remote commands', () => {
  it('exist in every build, in the palette and the File menu, and Disconnect Host needs a connected remote project', () => {
    const remote = { connectToHost: vi.fn(), disconnectHost: vi.fn(), openFolderOnHost: vi.fn(), forwardPort: vi.fn() };
    for (const platform of PLATFORMS) {
      const ids = palette(en, platform).list({ ...CHAT, remoteHostConnected: true, remoteHostSaved: true }).map((entry) => entry.id);
      expect(ids, platform).toEqual(expect.arrayContaining([MENU_IDS.connectToHost, MENU_IDS.openFolderOnHost, MENU_IDS.disconnectHost, MENU_IDS.forwardPort]));
      const file = menuItems(platform).find((item) => item.id === 'damocles.menu.file')!;
      const fileIds = (file.submenu as MenuItemConstructorOptions[]).map((item) => item.id);
      expect(fileIds, platform).toEqual(expect.arrayContaining([MENU_IDS.connectToHost, MENU_IDS.openFolderOnHost, MENU_IDS.disconnectHost, MENU_IDS.forwardPort]));
    }
    const byId = new Map(desktopCommands(PROJECTS, { ...({} as MenuActions), remote }, 'win32').map((command) => [command.id, command]));
    const disconnect = byId.get(MENU_IDS.disconnectHost)!;
    expect(isEnabled(disconnect, CHAT)).toBe(false);
    expect(isEnabled(disconnect, { ...CHAT, remoteHostConnected: true })).toBe(true);
    byId.get(MENU_IDS.connectToHost)!.run(CHAT, 'menu');
    expect(remote.connectToHost).toHaveBeenCalled();
  });

  it('lists Ports: Forward a Port... only while the selected project\'s host is connected, and runs the section\'s flow', () => {
    const remote = { connectToHost: vi.fn(), disconnectHost: vi.fn(), openFolderOnHost: vi.fn(), forwardPort: vi.fn() };
    const command = desktopCommands(PROJECTS, { ...({} as MenuActions), remote }, 'win32').find((candidate) => candidate.id === MENU_IDS.forwardPort)!;
    expect(command.title).toMatchObject({ message: 'Forward a Port...' });
    expect(command.category).toMatchObject({ message: 'Ports' });
    const connected = { ...CHAT, remoteHostConnected: true };
    expect(isEnabled(command, CHAT)).toBe(false);
    expect(command.palette!(CHAT)).toBe(false);
    expect(isEnabled(command, connected)).toBe(true);
    expect(command.palette!(connected)).toBe(true);
    command.run(connected, 'palette');
    expect(remote.forwardPort).toHaveBeenCalledOnce();
  });

  it('lists Remote: Open Folder on Host... only while a host is saved', () => {
    const remote = { connectToHost: vi.fn(), disconnectHost: vi.fn(), openFolderOnHost: vi.fn(), forwardPort: vi.fn() };
    const command = desktopCommands(PROJECTS, { ...({} as MenuActions), remote }, 'win32').find((candidate) => candidate.id === MENU_IDS.openFolderOnHost)!;
    expect(command.title).toMatchObject({ message: 'Open Folder on Host...' });
    expect(command.category).toMatchObject({ message: 'Remote' });
    const saved = { ...CHAT, remoteHostSaved: true };
    expect(isEnabled(command, CHAT)).toBe(false);
    expect(command.palette!(CHAT)).toBe(false);
    expect(isEnabled(command, saved)).toBe(true);
    expect(command.palette!(saved)).toBe(true);
    command.run(saved, 'palette');
    expect(remote.openFolderOnHost).toHaveBeenCalledOnce();
  });
});

describe('shell commands: the damocles command on PATH', () => {
  const remote = { connectToHost: vi.fn(), disconnectHost: vi.fn(), openFolderOnHost: vi.fn(), forwardPort: vi.fn() };
  const cliCommand = { install: vi.fn(), uninstall: vi.fn() };
  const shellCommands = (platform: NodeJS.Platform, withCli = true): string[] => new CommandPalette({
    commands: () => desktopCommands(PROJECTS, { ...({} as MenuActions), remote, ...(withCli ? { cliCommand } : {}) }, platform),
    l10n: en,
    english: en,
    platform,
    log: () => undefined,
  }).list(CHAT).filter((entry) => entry.category === 'Shell Command').map((entry) => entry.label).sort();

  it('offers Add and Remove on Windows, Install and Uninstall on macOS, and nothing on Linux', () => {
    expect(shellCommands('win32')).toEqual(['Shell Command: Add \'damocles\' command to PATH', 'Shell Command: Remove \'damocles\' command from PATH']);
    expect(shellCommands('darwin')).toEqual(['Shell Command: Install \'damocles\' command in PATH', 'Shell Command: Uninstall \'damocles\' command from PATH']);
    expect(shellCommands('linux')).toEqual([]);
  });

  it('offers none where main passes no cliCommand (a development build), and sits beside About in the app menu or Help', () => {
    for (const platform of PLATFORMS) expect(shellCommands(platform, false), platform).toEqual([]);
    const ids = (platform: NodeJS.Platform, withCli: boolean, menu: string): Array<string | undefined> => {
      installApplicationMenu(PROJECTS, { ...({} as MenuActions), remote, ...(withCli ? { cliCommand } : {}) }, en, CHAT, platform);
      return (electron.template.find((item) => item.id === menu)!.submenu as MenuItemConstructorOptions[]).map((item) => item.id ?? item.type);
    };
    expect(ids('win32', true, 'damocles.menu.help')).toEqual([MENU_IDS.about, MENU_IDS.releaseNotes, MENU_IDS.checkForUpdates, 'separator', MENU_IDS.installCliCommand, MENU_IDS.uninstallCliCommand]);
    expect(ids('darwin', true, 'damocles.menu.app').slice(0, 6)).toEqual([MENU_IDS.about, MENU_IDS.releaseNotes, MENU_IDS.checkForUpdates, 'separator', MENU_IDS.installCliCommand, MENU_IDS.uninstallCliCommand]);
    expect(ids('linux', true, 'damocles.menu.help')).toEqual([MENU_IDS.about, MENU_IDS.releaseNotes, MENU_IDS.checkForUpdates]);
    expect(ids('win32', false, 'damocles.menu.help')).toEqual([MENU_IDS.about, MENU_IDS.releaseNotes, MENU_IDS.checkForUpdates]);
  });

  it('runs the install or the removal, each named in Greek too', () => {
    const greek = new CommandPalette({ commands: () => desktopCommands(PROJECTS, { ...({} as MenuActions), remote, cliCommand }, 'win32'), l10n: el, english: en, platform: 'win32', log: () => undefined });
    expect(greek.list(CHAT).filter((entry) => entry.id === MENU_IDS.installCliCommand).map((entry) => entry.label)).toEqual(['Εντολή κελύφους: Προσθήκη της εντολής \'damocles\' στο PATH']);
    greek.run(MENU_IDS.installCliCommand, CHAT);
    greek.run(MENU_IDS.uninstallCliCommand, CHAT);
    expect(cliCommand.install).toHaveBeenCalledOnce();
    expect(cliCommand.uninstall).toHaveBeenCalledOnce();
  });
});

describe('Source Control: Show Pipeline', () => {
  const OPEN: MenuState = { ...CHAT, scm: { ...NO_SCM_MENU_STATE, available: true, openRepositoryCount: 1 } };
  const listed = (context: MenuState): boolean => palette().list(context).some((entry) => entry.id === MENU_IDS.forgeShowPipeline);

  it('is listed only while the selected repository\'s CI chip shows a pipeline, and asks the shell to open its job list', () => {
    expect(listed(CHAT)).toBe(false);
    expect(listed(OPEN)).toBe(false);
    const shown: MenuState = { ...OPEN, scm: { ...OPEN.scm, pipelineShown: true } };
    expect(listed(shown)).toBe(true);
    expect(palette().list(shown).find((entry) => entry.id === MENU_IDS.forgeShowPipeline)?.label).toBe('Source Control: Show Pipeline');
    palette().run(MENU_IDS.forgeShowPipeline, shown);
    expect(calls).toEqual(['forgeShowPipeline']);
  });
});

describe('Git hosting links, accounts and the clone picker', () => {
  const OPEN: MenuState = { ...CHAT, scm: { ...NO_SCM_MENU_STATE, available: true, openRepositoryCount: 1 } };
  const FILE: MenuState = { ...EDITOR, scm: OPEN.scm, editorKind: 'code', editorGit: 'file' };
  const label = (context: MenuState, id: string): string | undefined => palette().list(context).find((entry) => entry.id === id)?.label;

  it('lists Copy Permalink and Open File on Server for a file of an open repository, and runs them as editor commands', () => {
    expect(label(FILE, MENU_IDS.gitCopyPermalink)).toBe('Git: Copy Permalink');
    expect(label(FILE, MENU_IDS.gitOpenFileOnServer)).toBe('Git: Open File on Server');
    for (const context of [OPEN, { ...FILE, editorGit: null }, { ...FILE, scm: NO_SCM_MENU_STATE }]) {
      expect(label(context, MENU_IDS.gitCopyPermalink)).toBeUndefined();
      expect(label(context, MENU_IDS.gitOpenFileOnServer)).toBeUndefined();
    }
    calls.length = 0;
    palette().run(MENU_IDS.gitCopyPermalink, FILE);
    palette().run(MENU_IDS.gitOpenFileOnServer, FILE);
    expect(calls).toEqual(['editorCommand:copyPermalink', 'editorCommand:openFileOnServer']);
  });

  it('lists Open Commit on Server and Choose Account... while a repository is open', () => {
    expect(label(OPEN, MENU_IDS.gitOpenCommitOnServer)).toBe('Git: Open Commit on Server');
    expect(label(OPEN, MENU_IDS.forgeChooseAccount)).toBe('Source Control: Choose Account...');
    const closed: MenuState = { ...CHAT, scm: { ...NO_SCM_MENU_STATE, available: true } };
    expect(label(closed, MENU_IDS.gitOpenCommitOnServer)).toBeUndefined();
    expect(label(closed, MENU_IDS.forgeChooseAccount)).toBeUndefined();
    calls.length = 0;
    palette().run(MENU_IDS.gitOpenCommitOnServer, OPEN);
    palette().run(MENU_IDS.forgeChooseAccount, OPEN);
    expect(calls).toEqual(['forgeOpenCommitOnServer', 'forgeChooseAccount']);
  });

  it('lists Clone from Your Repositories... wherever git is found, an untrusted project included', () => {
    expect(label(CHAT, MENU_IDS.forgeCloneFromAccount)).toBeUndefined();
    const gitOnly: MenuState = { ...CHAT, scm: { ...NO_SCM_MENU_STATE, gitFound: true } };
    expect(label(gitOnly, MENU_IDS.forgeCloneFromAccount)).toBe('Git: Clone from Your Repositories...');
    calls.length = 0;
    palette().run(MENU_IDS.forgeCloneFromAccount, gitOnly);
    expect(calls).toEqual(['cloneFromAccount']);
  });
});
