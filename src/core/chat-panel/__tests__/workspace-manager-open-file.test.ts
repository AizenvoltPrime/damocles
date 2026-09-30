import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger', () => ({ log: vi.fn() }));

import { WorkspaceManager } from '../workspace-manager';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import { folderKey } from '../../workspace-folders/folder-key';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';

let root: string;
let ws: string;
let folder: FolderTarget;
let platform: FakePlatform;

function makeManager(workspaceFolders: readonly string[] = []): WorkspaceManager {
  platform = createFakePlatform({ folders: workspaceFolders.map((fsPath) => ({ fsPath, name: path.basename(fsPath) })) });
  return new WorkspaceManager({ postMessage: () => {}, getPanels: () => new Map(), platform });
}

const opened = () => [...platform.editor.openedFiles, ...platform.shell.revealedPaths.map((p) => ({ revealed: p }))];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-open-file-'));
  ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'a.png'), '');
  fs.writeFileSync(path.join(ws, 'a.ts'), '');
  folder = { key: folderKey(ws), fsPath: ws, name: 'ws', label: 'ws', projectScope: true };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceManager.openFile', () => {
  it('opens a relative path with the default editor, resolved against the folder', async () => {
    const manager = makeManager();
    await manager.openFile('src/a.png', undefined, folder, 'host-1');

    expect(platform.editor.openedFiles).toEqual([{ path: path.resolve(ws, 'src/a.png'), options: { panelId: 'host-1' } }]);
  });

  it('passes the line for a line', async () => {
    const manager = makeManager();
    await manager.openFile(path.join(ws, 'a.ts'), 12, folder, 'host-1');

    expect(platform.editor.openedFiles).toEqual([{ path: path.join(ws, 'a.ts'), options: { line: 12, panelId: 'host-1' } }]);
  });

  it('shows the error toast and opens nothing when the path does not exist', async () => {
    const manager = makeManager();
    await manager.handleOpenFile('host-1', 'missing.png', undefined, folder);

    expect(platform.notifications.calls).toEqual([{ level: 'error', message: 'Could not open file: missing.png', actions: [] }]);
    expect(opened()).toEqual([]);
  });

  it.each([
    ['a folder', 'src'],
    ['a symlinked folder', 'linked'],
  ])('reveals %s inside the workspace in the Explorer', async (_label, name) => {
    // A junction needs no privilege on Windows; POSIX ignores the type.
    fs.symlinkSync(path.join(ws, 'src'), path.join(ws, 'linked'), 'junction');
    const manager = makeManager([ws]);
    await manager.openFile(name, undefined, folder, 'host-1');

    expect(opened()).toEqual([{ revealed: path.resolve(ws, name) }]);
  });

  it('shows the checkpoint text beside the file, titled for the checkpoint', async () => {
    const manager = makeManager();
    await manager.showRewindDiff(path.join(ws, 'a.ts'), 'before', 'host-1');

    const [view] = platform.editor.diffs;
    expect(platform.editor.diffs).toHaveLength(1);
    expect(view?.request).toMatchObject({
      title: 'a.ts (At checkpoint ↔ Current)',
      left: { content: 'before' },
      right: { path: path.join(ws, 'a.ts') },
      purpose: 'checkpoint',
      preview: true,
      panelId: 'host-1',
    });
    expect((view?.request.left as { name: string }).name).toMatch(/^[a-z0-9]+-[a-z0-9]+-a.ts$/);
  });

  it('shows the error toast for a folder outside the workspace', async () => {
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    const manager = makeManager([ws]);
    await manager.handleOpenFile('host-1', outside, undefined, folder);

    expect(platform.notifications.calls).toEqual([{ level: 'error', message: `Could not open file: ${outside}`, actions: [] }]);
    expect(opened()).toEqual([]);
  });
});
