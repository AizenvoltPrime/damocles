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
import { WorkspaceManager } from '../workspace-manager';
import { BUILTIN_SLASH_COMMANDS } from '../../../shared/slashCommands';
import type { SlashCommandItem } from '../../../shared/types/commands';

const realIsTrusted = vscode.workspace.isTrusted;

let ws = '';
let manager: WorkspaceManager | null = null;

function setTrusted(trusted: boolean): void {
  vscode.__setTrusted(trusted);
}

function makeManager(projectPath: string | null = ws): WorkspaceManager {
  manager = new WorkspaceManager({
    workspacePath: ws,
    projectPath,
    postMessage: () => {},
    broadcastToAllPanels: () => {},
  });
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
    const items = await makeManager().getCustomSlashCommands();
    for (const builtin of BUILTIN_SLASH_COMMANDS) {
      expect(rowsNamed(items, builtin.name)).toHaveLength(1);
    }
  });

  // The intercept runs the builtin whichever row the user picks, so a second row for the same name
  // offers a choice that does not exist.
  it('drops a custom command colliding with a builtin name', async () => {
    writeCommand(ws, '.damocles/commands', 'compact', 'shadowing attempt');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(), 'compact');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('builtin');
  });

  it('drops a skill colliding with a builtin name', async () => {
    writeSkill(ws, '.damocles/skills', 'init', 'shadowing attempt');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(), 'init');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('builtin');
  });

  it('drops a colliding custom name that differs only in case', async () => {
    writeCommand(ws, '.damocles/commands', 'Compact', 'shadowing attempt');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(), 'compact');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('builtin');
  });

  // The badge says the entry is withheld, while the builtin behind it runs regardless.
  it('shows no untrusted badge for a builtin name claimed by an untrusted project file', async () => {
    writeCommand(ws, '.damocles/commands', 'compact', 'shadowing attempt');
    setTrusted(false);

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(), 'compact');
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('untrusted');
  });

  it('keeps a custom command whose name no builtin claims', async () => {
    writeCommand(ws, '.damocles/commands', 'deploy', 'a real command');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(), 'deploy');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('project');
  });

  it('keeps a user-scope command whose name no builtin claims', async () => {
    writeCommand(H.home, '.damocles/commands', 'deploy', 'a real command');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(), 'deploy');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('user');
  });

  // The de-dup is scoped to builtin collisions. A command and a skill sharing a name stay two rows,
  // and the intercept resolves which one runs.
  it('keeps both rows when a command and a skill share a name', async () => {
    writeCommand(ws, '.damocles/commands', 'deploy', 'the command');
    writeSkill(ws, '.damocles/skills', 'deploy', 'the skill');

    const rows = rowsNamed(await makeManager().getCustomSlashCommands(), 'deploy');
    expect(rows).toHaveLength(2);
  });

  it('sorts the whole menu by name', async () => {
    writeCommand(ws, '.damocles/commands', 'aardvark', 'first');
    writeCommand(ws, '.damocles/commands', 'zebra', 'last');

    const names = (await makeManager().getCustomSlashCommands()).map((i) => i.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('scans only the user scope when no folder is open', async () => {
    writeCommand(ws, '.damocles/commands', 'projectcmd', 'project version');
    writeCommand(H.home, '.damocles/commands', 'usercmd', 'user version');

    const items = await makeManager(null).getCustomSlashCommands();
    expect(rowsNamed(items, 'projectcmd')).toHaveLength(0);
    expect(rowsNamed(items, 'usercmd')).toHaveLength(1);
    expect(rowsNamed(items, 'usercmd')[0]?.source).toBe('user');
  });
});
