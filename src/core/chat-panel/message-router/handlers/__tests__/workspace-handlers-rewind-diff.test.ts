import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createWorkspaceHandlers } from '../workspace-handlers';
import { WorkspaceManager } from '../../../workspace-manager';

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

const PROJECT = path.resolve('/ws');
const DESIGN = path.resolve('/home/.damocles/designs/contacts-abcd1234');

function setup(designChat: boolean) {
  const resolver = Object.create(WorkspaceManager.prototype) as WorkspaceManager;
  const workspaceManager = {
    resolveWorkspaceFilePath: resolver.resolveWorkspaceFilePath.bind(resolver),
    resolveFileWithin: resolver.resolveFileWithin.bind(resolver),
    showRewindDiff: vi.fn(async () => undefined),
    handleOpenFile: vi.fn(async () => undefined),
  };
  const getFileCheckpointContent = vi.fn(async () => 'before');
  const deps = { postMessage: () => undefined, workspaceManager, historyManager: { getFileCheckpointContent } } as unknown as Parameters<typeof createWorkspaceHandlers>[0];
  const ctx = {
    folder: { key: PROJECT, fsPath: PROJECT, name: 'ws', label: 'ws', projectScope: true },
    session: { currentSessionId: 's1', design: { role: () => (designChat ? { folder: DESIGN } : undefined) }, checkpointFolder: () => (designChat ? DESIGN : PROJECT) },
    panelId: 'host-1',
  } as never;
  const open = (filePath: string) => createWorkspaceHandlers(deps).openRewindDiff!({ type: 'openRewindDiff', filePath, userMessageId: 'u1' } as never, ctx);
  return { open, workspaceManager, getFileCheckpointContent };
}

describe('openRewindDiff in a design chat (PD-39)', () => {
  it('opens a design file, read from the checkpoint by its path in the design folder', async () => {
    const { open, workspaceManager, getFileCheckpointContent } = setup(true);
    const file = path.join(DESIGN, 'screens', 'S1.html');
    await open(file);
    expect(getFileCheckpointContent).toHaveBeenCalledWith(PROJECT, 's1', 'u1', file, DESIGN);
    expect(workspaceManager.showRewindDiff).toHaveBeenCalledWith(file, 'before', 'host-1');
  });

  it('refuses a path outside the design folder, the project included', async () => {
    const { open, workspaceManager, getFileCheckpointContent } = setup(true);
    await open(path.join(PROJECT, 'src', 'a.ts'));
    await open(path.join(DESIGN, '..', 'other', 'x.html'));
    expect(getFileCheckpointContent).not.toHaveBeenCalled();
    expect(workspaceManager.showRewindDiff).not.toHaveBeenCalled();
  });

  it('keeps a normal chat to its panel folder', async () => {
    const { open, getFileCheckpointContent } = setup(false);
    await open(path.join(DESIGN, 'design.md'));
    expect(getFileCheckpointContent).not.toHaveBeenCalled();
    await open(path.join(PROJECT, 'src', 'a.ts'));
    expect(getFileCheckpointContent).toHaveBeenCalledWith(PROJECT, 's1', 'u1', path.join(PROJECT, 'src', 'a.ts'), PROJECT);
  });
});
