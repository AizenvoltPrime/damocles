import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { installPlatform } from '../../../core/platform-host';
import { initPiLoader } from '../../../core/pi-session/pi-loader';
import { PiRuntime } from '../../../core/pi-session/pi-runtime';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { worktreeFolderFor } from '../../../core/worktrees/records';
import { WorktreeRegistry } from '../../../core/worktrees/registry';
import { createCoreEndpoint, createLoopback, type CoreInit } from '../../core-protocol';
import { createTrustMirror } from '../platform/mirrored';

const inert = { dispose: () => undefined };
const watchers: FileWatcherFactory = {
  watch: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  watchWorkspace: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  onDidRenameFiles: () => inert,
};

describe('a folder runtime at a chat worktree\'s working folder follows the registry', () => {
  const made: string[] = [];
  const opened: Array<{ dispose(): void }> = [];

  beforeAll(async () => {
    if (!(await initPiLoader())) throw new Error('pi failed to load');
  }, 60_000);

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    for (const disposable of opened.splice(0)) disposable.dispose();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('turns its project layer on when a live record of a trusted project names it, and off when the record is deleted', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-wf-layer-')));
    made.push(base);
    const root = path.join(base, 'worktrees');
    const project = path.join(base, 'project');
    const id = 'aaaaaaaa';
    const workingFolder = worktreeFolderFor(root, project, id);
    fs.mkdirSync(path.join(workingFolder, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(workingFolder, '.pi', 'settings.json'), JSON.stringify({ shellPath: '/probe/shell' }));

    const registry = new WorktreeRegistry({ rootDir: root, watcherFactory: watchers, log: () => undefined });
    const trust = createTrustMirror(createCoreEndpoint(createLoopback().core, () => undefined), { mirrors: { trust: { keys: [folderKey(project)] } } } as unknown as CoreInit);
    opened.push(registry, trust);
    trust.followRegistry(registry);
    installPlatform({ ...createFakePlatform(), trust });

    const folder = await PiRuntime.get(path.join(base, 'agent')).folder(workingFolder);
    const settings = folder.services.settingsManager;
    expect(settings.isProjectTrusted()).toBe(false);
    expect(settings.getShellPath()).toBeUndefined();

    await registry.addChat({ id, kind: 'chat', projectPath: project, repositoryRoot: project, worktreeRoot: workingFolder, workingFolder, branch: `damocles/${id}`, baseCommit: 'a'.repeat(40), createdAt: 1 });
    expect(settings.isProjectTrusted()).toBe(true);
    await vi.waitFor(() => expect(folder.services.settingsManager.getShellPath()).toBe('/probe/shell'), { timeout: 10_000 });

    await registry.markDeleted(id);
    expect(folder.services.settingsManager.isProjectTrusted()).toBe(false);
    expect(folder.services.settingsManager.getShellPath()).toBeUndefined();
  }, 60_000);
});
