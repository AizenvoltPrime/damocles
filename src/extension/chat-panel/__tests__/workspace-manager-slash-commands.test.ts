import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as nodeOs from 'os';
import * as path from 'path';

// User-scope dirs resolve through `os.homedir()`. Redirect it to a temp dir so a developer's real
// `~/.claude/commands` cannot add rows to the menu under assertion.
const H = vi.hoisted(() => ({ home: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => (H.home !== '' ? H.home : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../logger', () => ({ log: vi.fn() }));

// The rewind diff provider registers a text-document content provider and a tab listener, neither of
// which the shared vscode mock implements.
vi.mock('../rewind-diff-provider', () => ({
  RewindDiffProvider: class {
    dispose(): void {}
  },
}));

import * as vscode from 'vscode';
import { __trustEmitter } from 'vscode';
import { WorkspaceManager } from '../workspace-manager';
import { BUILTIN_SLASH_COMMANDS } from '../../../shared/slashCommands';
import type { SlashCommandItem } from '../../../shared/types/commands';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { HostInstance, WebviewHost } from '../types';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import { folderKey } from '../../workspace-folders/folder-key';

const realIsTrusted = vscode.workspace.isTrusted;

let ws = '';
let manager: WorkspaceManager | null = null;

function setTrusted(trusted: boolean): void {
  vscode.__setTrusted(trusted);
}

function folder(fsPath: string, projectScope = true): FolderTarget {
  const name = path.basename(fsPath);
  return { key: folderKey(fsPath), fsPath, name, label: name, projectScope };
}

function makeManager(
  panels: Map<string, HostInstance> = new Map(),
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void = () => {},
): WorkspaceManager {
  manager = new WorkspaceManager({ postMessage, getPanels: () => panels });
  return manager;
}

/** Write `<root>/<rel>/<name>/SKILL.md`. */
function writeSkill(root: string, rel: string, name: string, description: string): void {
  const dir = path.join(root, ...rel.split('/'), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    'utf8',
  );
}

/** Write `<root>/<rel>/<name>.md`. */
function writeCommand(root: string, rel: string, name: string, description: string): void {
  const dir = path.join(root, ...rel.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\ndescription: ${description}\n---\n\nbody\n`, 'utf8');
}

function rowsNamed(items: SlashCommandItem[], name: string): SlashCommandItem[] {
  return items.filter((i) => i.name.toLowerCase() === name.toLowerCase());
}

describe('WorkspaceManager slash-command menu', () => {
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'wm-ws-'));
    H.home = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'wm-home-'));
    setTrusted(true);
  });

  afterEach(() => {
    manager?.dispose();
    manager = null;
    vscode.__setTrusted(realIsTrusted);
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(H.home, { recursive: true, force: true });
    H.home = '';
  });

  it('lists every builtin', async () => {
    const items = await makeManager().getCustomSlashCommands(folder(ws));
    for (const builtin of BUILTIN_SLASH_COMMANDS) {
      expect(rowsNamed(items, builtin.name)).toHaveLength(1);
    }
  });

  // The intercept runs the builtin whichever row the user picks, so a second row for the same name
  // offers a choice that does not exist.
  it('drops a custom command colliding with a builtin name', async () => {
    writeCommand(ws, '.damocles/commands', 'compact', 'shadowing attempt');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(folder(ws)), 'compact');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('builtin');
  });

  it('drops a skill colliding with a builtin name', async () => {
    writeSkill(ws, '.damocles/skills', 'init', 'shadowing attempt');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(folder(ws)), 'init');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('builtin');
  });

  it('drops a colliding custom name that differs only in case', async () => {
    writeCommand(ws, '.damocles/commands', 'Compact', 'shadowing attempt');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(folder(ws)), 'compact');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('builtin');
  });

  // The badge says the entry is withheld, while the builtin behind it runs regardless.
  it('shows no untrusted badge for a builtin name claimed by an untrusted project file', async () => {
    writeCommand(ws, '.damocles/commands', 'compact', 'shadowing attempt');
    setTrusted(false);

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(folder(ws)), 'compact');
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('untrusted');
  });

  it('keeps a custom command whose name no builtin claims', async () => {
    writeCommand(ws, '.damocles/commands', 'deploy', 'a real command');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(folder(ws)), 'deploy');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('project');
  });

  it('keeps a user-scope command whose name no builtin claims', async () => {
    writeCommand(H.home, '.damocles/commands', 'deploy', 'a real command');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(folder(ws)), 'deploy');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('user');
  });

  // The de-dup is scoped to builtin collisions. A command and a skill sharing a name stay two rows,
  // and the intercept resolves which one runs.
  it('keeps both rows when a command and a skill share a name', async () => {
    writeCommand(ws, '.damocles/commands', 'deploy', 'the command');
    writeSkill(ws, '.damocles/skills', 'deploy', 'the skill');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(folder(ws)), 'deploy');
    expect(rows).toHaveLength(2);
  });

  it('sorts the whole menu by name', async () => {
    writeCommand(ws, '.damocles/commands', 'aardvark', 'first');
    writeCommand(ws, '.damocles/commands', 'zebra', 'last');

    const names = (await makeManager().getCustomSlashCommands(folder(ws))).map((i) => i.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('scans only the user scope when no folder is open', async () => {
    writeCommand(ws, '.damocles/commands', 'projectcmd', 'project version');
    writeCommand(H.home, '.damocles/commands', 'usercmd', 'user version');

    const items = await makeManager().getCustomSlashCommands(folder(H.home, false));
    expect(rowsNamed(items, 'projectcmd')).toHaveLength(0);
    expect(rowsNamed(items, 'usercmd')).toHaveLength(1);
    expect(rowsNamed(items, 'usercmd')[0]?.source).toBe('user');
  });
});

describe('WorkspaceManager per-folder state', () => {
  let a = '';
  let b = '';

  beforeEach(() => {
    a = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'wm-a-'));
    b = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'wm-b-'));
    H.home = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'wm-home-'));
    setTrusted(true);
    __trustEmitter.clear();
  });

  afterEach(() => {
    manager?.dispose();
    manager = null;
    __trustEmitter.clear();
    vscode.__setTrusted(realIsTrusted);
    for (const dir of [a, b, H.home]) fs.rmSync(dir, { recursive: true, force: true });
    H.home = '';
  });

  it("gives each folder its own menu: A's command is absent from B's", async () => {
    writeCommand(a, '.damocles/commands', 'onlya', 'folder A');
    writeCommand(b, '.damocles/commands', 'onlyb', 'folder B');
    const wm = makeManager();

    const menuB = await wm.getCustomSlashCommands(folder(b));
    expect(rowsNamed(menuB, 'onlyb')).toHaveLength(1);
    expect(rowsNamed(menuB, 'onlya')).toHaveLength(0);
    expect(await wm.findCommand('onlya', folder(b))).toBeUndefined();
    expect(await wm.findCommand('onlya', folder(a))).toBeDefined();
  });

  it("refreshes a folder's menu only in the panels that target that folder", async () => {
    writeCommand(a, '.damocles/commands', 'onlya', 'folder A');
    writeCommand(b, '.damocles/commands', 'onlyb', 'folder B');
    const hostA = { name: 'A' } as unknown as WebviewHost;
    const hostB = { name: 'B' } as unknown as WebviewHost;
    const panels = new Map<string, HostInstance>([
      ['pa', { host: hostA, folder: folder(a) } as unknown as HostInstance],
      ['pb', { host: hostB, folder: folder(b) } as unknown as HostInstance],
    ]);
    const posted: Array<{ host: WebviewHost; message: ExtensionToWebviewMessage }> = [];
    const wm = makeManager(panels, (host, message) => posted.push({ host, message }));
    await wm.getCustomSlashCommands(folder(a));
    await wm.getCustomSlashCommands(folder(b));

    // A trust grant invalidates every service's cache, and each one re-publishes to its own folder.
    __trustEmitter.fire();
    await vi.waitFor(() => expect(posted).toHaveLength(2));

    const toA = posted.filter((p) => p.host === hostA).map((p) => p.message);
    const toB = posted.filter((p) => p.host === hostB).map((p) => p.message);
    expect(toA).toHaveLength(1);
    expect(toB).toHaveLength(1);
    const namesOf = (m: ExtensionToWebviewMessage | undefined) =>
      m?.type === 'customSlashCommands' ? m.commands.map((c) => c.name) : [];
    expect(namesOf(toA[0])).toContain('onlya');
    expect(namesOf(toA[0])).not.toContain('onlyb');
    expect(namesOf(toB[0])).toContain('onlyb');
    expect(namesOf(toB[0])).not.toContain('onlya');
  });

  it("disposing a removed folder releases its service, so a later lookup rescans", async () => {
    writeCommand(a, '.damocles/commands', 'first', 'before');
    const wm = makeManager();
    expect(await wm.findCommand('first', folder(a))).toBeDefined();

    wm.disposeFolder(folderKey(a));
    fs.rmSync(path.join(a, '.damocles'), { recursive: true, force: true });

    expect(await wm.findCommand('first', folder(a))).toBeUndefined();
  });

  // Rewind diffs read and restore a file, so the path must sit inside the panel's own folder.
  it('contains a rewind path in the panel folder and refuses one in another open folder', () => {
    const wm = makeManager();
    expect(wm.resolveWorkspaceFilePath('src/x.ts', folder(b))).toBe(path.resolve(b, 'src/x.ts'));
    expect(wm.resolveWorkspaceFilePath(path.join(b, 'y.ts'), folder(b))).toBe(path.join(b, 'y.ts'));
    expect(wm.resolveWorkspaceFilePath(path.join(a, 'y.ts'), folder(b))).toBeNull();
    expect(wm.resolveWorkspaceFilePath(`..${path.sep}${path.basename(a)}${path.sep}y.ts`, folder(b))).toBeNull();
  });
});
