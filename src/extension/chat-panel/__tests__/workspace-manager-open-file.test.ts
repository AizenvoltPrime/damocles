import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

const { stat, getWorkspaceFolder } = vi.hoisted(() => ({
  stat: vi.fn<(uri: unknown) => Promise<{ type: number }>>(),
  getWorkspaceFolder: vi.fn<(uri: unknown) => unknown>(),
}));

// The shared mock has no `fs.stat`, `getWorkspaceFolder` or `FileType`.
vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<{ workspace: object }>();
  return {
    ...actual,
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: { ...actual.workspace, fs: { stat }, getWorkspaceFolder },
  };
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
import type { WebviewHost } from '../types';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import { folderKey } from '../../workspace-folders/folder-key';

const FILE = 1;
const DIRECTORY = 2;
const SYMLINKED_DIRECTORY = DIRECTORY | 64;

const folder: FolderTarget = { key: folderKey('/ws'), fsPath: '/ws', name: 'ws', label: 'ws', projectScope: true };
const host = {} as WebviewHost;

function makeManager(): WorkspaceManager {
  return new WorkspaceManager({ postMessage: () => {}, getPanels: () => new Map() });
}

beforeEach(() => {
  vi.restoreAllMocks();
  stat.mockReset();
  getWorkspaceFolder.mockReset();
});

describe('WorkspaceManager.openFile', () => {
  it('opens a relative path with the default editor, resolved against the folder', async () => {
    stat.mockResolvedValue({ type: FILE });
    const exec = vi.spyOn(vscode.commands, 'executeCommand');

    await makeManager().openFile('src/a.png', undefined, folder);

    const uri = vscode.Uri.file(path.resolve('/ws', 'src/a.png'));
    expect(stat).toHaveBeenCalledWith(uri);
    expect(exec).toHaveBeenCalledWith('vscode.open', uri, undefined);
  });

  it('passes a zero-based selection for a line', async () => {
    stat.mockResolvedValue({ type: FILE });
    const exec = vi.spyOn(vscode.commands, 'executeCommand');

    await makeManager().openFile('/ws/a.ts', 12, folder);

    expect(exec).toHaveBeenCalledWith('vscode.open', vscode.Uri.file('/ws/a.ts'), {
      selection: new vscode.Range(11, 0, 11, 0),
    });
  });

  it('shows the error toast and opens nothing when the path does not exist', async () => {
    stat.mockRejectedValue(new Error('ENOENT'));
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    const toast = vi.spyOn(vscode.window, 'showErrorMessage');

    await makeManager().handleOpenFile(host, 'missing.png', undefined, folder);

    expect(toast).toHaveBeenCalledWith('Could not open file: missing.png');
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    ['a folder', DIRECTORY],
    ['a symlinked folder', SYMLINKED_DIRECTORY],
  ])('reveals %s inside the workspace in the Explorer', async (_label, type) => {
    stat.mockResolvedValue({ type });
    getWorkspaceFolder.mockReturnValue({ uri: vscode.Uri.file('/ws') });
    const exec = vi.spyOn(vscode.commands, 'executeCommand');

    await makeManager().openFile('src', undefined, folder);

    const uri = vscode.Uri.file(path.resolve('/ws', 'src'));
    expect(getWorkspaceFolder).toHaveBeenCalledWith(uri);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('revealInExplorer', uri);
  });

  it('shows the error toast for a folder outside the workspace', async () => {
    stat.mockResolvedValue({ type: DIRECTORY });
    getWorkspaceFolder.mockReturnValue(undefined);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    const toast = vi.spyOn(vscode.window, 'showErrorMessage');

    await makeManager().handleOpenFile(host, '/elsewhere', undefined, folder);

    expect(toast).toHaveBeenCalledWith('Could not open file: /elsewhere');
    expect(exec).not.toHaveBeenCalled();
  });
});
