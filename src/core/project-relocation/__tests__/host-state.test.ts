import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_ALIASES } from '../aliases';
import { runHostStateStep } from '../steps/host-state';
import type { RelocationFolder } from '../types';
import { folderKey } from '../../workspace-folders/folder-key';
import { createProjectsStore } from '../../themes/characters';
import { createProjectLooks } from '../../themes/project-looks';
import { createWriteLane } from '../../themes/write-lane';

// The hostState step re-keys this core's path-keyed state: MCP toggles, Git hosting bindings and the desktop themes' project
// looks and character pins, each by the project folder's key and idempotently.

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-host-state-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const FROM = path.resolve('/work/site');
const TO = path.resolve('/work/site-moved');
const WORKTREE = path.resolve('/work/.damocles-worktrees/site/wt-1');
const LOOK = { mode: 'touches', accent: '#3a86ff' };

describe('the hostState step', () => {
  it("moves the project's look and character pins to its new key with the bindings, and leaves a chat worktree's alone", async () => {
    const projectsFile = path.join(root, 'projects.json');
    fs.writeFileSync(projectsFile, JSON.stringify({
      version: 1,
      pins: { [folderKey(FROM)]: { byTheme: { 'damocles-arcade': 'Pip' } }, [folderKey(WORKTREE)]: { byTheme: { 'damocles-arcade': 'Bolt' } } },
      looks: { [folderKey(FROM)]: LOOK },
    }));
    const themes = createProjectLooks({
      projects: createProjectsStore(root, async (file, text) => fs.writeFileSync(file, text)),
      lane: createWriteLane(root),
      changed: () => undefined,
      relocations: () => ({ aliases: NO_ALIASES, pendingKeys: new Set() }),
    });
    const relocateThemes = vi.spyOn(themes, 'relocateProject');
    const forge = { relocateProject: vi.fn(async () => undefined) };
    const mcp = { relocateFolders: vi.fn(async () => undefined) };
    const folders: RelocationFolder[] = [{ kind: 'project', from: FROM, to: TO }, { kind: 'worktree', from: WORKTREE, to: WORKTREE, worktreeId: 'wt-1' }];

    expect(await runHostStateStep(folders, { mcp, forge, themes })).toEqual({ kind: 'done' });
    expect(forge.relocateProject).toHaveBeenCalledWith(folderKey(FROM), folderKey(TO));
    expect(relocateThemes).toHaveBeenCalledTimes(1);
    expect(relocateThemes).toHaveBeenCalledWith(folderKey(FROM), folderKey(TO));
    const moved = JSON.parse(fs.readFileSync(projectsFile, 'utf8')) as Record<string, unknown>;
    expect(moved['looks']).toEqual({ [folderKey(TO)]: LOOK });
    expect(moved['pins']).toEqual({ [folderKey(WORKTREE)]: { byTheme: { 'damocles-arcade': 'Bolt' } }, [folderKey(TO)]: { byTheme: { 'damocles-arcade': 'Pip' } } });

    // projects.applyHostState runs the step again in a core that did not run the relocation: nothing changes
    await runHostStateStep(folders, { mcp, forge, themes });
    expect(JSON.parse(fs.readFileSync(projectsFile, 'utf8'))).toEqual(moved);
  });

  it('runs on a core that keeps no themes, as a daemon\'s or VS Code\'s', async () => {
    const mcp = { relocateFolders: vi.fn(async () => undefined) };
    expect(await runHostStateStep([{ kind: 'project', from: FROM, to: TO }], { mcp })).toEqual({ kind: 'done' });
    expect(mcp.relocateFolders).toHaveBeenCalledWith([{ from: FROM, to: TO }]);
  });
});
