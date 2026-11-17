import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { WorktreeRegistry, type ChatWorktreeRecord } from '../../worktrees/registry';
import { worktreeFolderFor } from '../../worktrees/records';
import type { WorktreeHostServices } from '../../worktrees/host';
import { folderKey } from '../../workspace-folders/folder-key';
import { createHarness, folderEntry, makeFakeHost, type Harness } from './panel-manager-harness';

const inert = { dispose: () => undefined };
const watchers: FileWatcherFactory = {
  watch: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  watchWorkspace: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  onDidRenameFiles: () => inert,
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(): Promise<{ h: Harness; project: string; registry: WorktreeRegistry; record: ChatWorktreeRecord }> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-start-wt-')));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  const registry = new WorktreeRegistry({ rootDir: path.join(base, 'worktrees'), watcherFactory: watchers, log: () => undefined });
  const worktreeRoot = worktreeFolderFor(registry.rootDir, project, 'aaaaaaaa');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const record = await registry.addChat({ id: 'aaaaaaaa', kind: 'chat', projectPath: project, repositoryRoot: project, worktreeRoot, workingFolder: worktreeRoot, branch: 'damocles/x', baseCommit: 'a'.repeat(40), createdAt: 1 });
  const h = createHarness([folderEntry(project)]);
  const platform = h.platform as unknown as { capabilities: { worktrees: boolean }; worktrees: WorktreeHostServices };
  platform.capabilities.worktrees = true;
  platform.worktrees = { registry, projectRepository: (p: string) => p, onDidChangeRefs: () => inert, onDidChangeProjectRepository: () => inert } as unknown as WorktreeHostServices;
  cleanups.push(() => {
    h.dispose();
    registry.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { h, project, registry, record };
}

describe('a new chat in a worktree: its first session starts in the working folder, never in the project first', () => {
  it('creates the panel\'s first session in the working folder, registered as owned by the project', async () => {
    const { h, project, record } = await setup();
    const panelId = await h.manager.startInWorktree(makeFakeHost(), folderKey(project), record.id);
    expect(h.sessions.map((s) => s.cwd)).toEqual([record.workingFolder]);
    expect(h.instance(panelId).folder).toMatchObject({ key: folderKey(record.workingFolder), ownerKey: folderKey(project) });
  });

  it('refuses a deleted worktree with no session created and no panel registered', async () => {
    const { h, project, registry, record } = await setup();
    await registry.markDeleted(record.id);
    await expect(h.manager.startInWorktree(makeFakeHost(), folderKey(project), record.id)).rejects.toThrow();
    expect(h.sessions).toEqual([]);
    expect(h.manager.getPanels().size).toBe(0);
  });

  it('releases the working folder when the session cannot start there, and leaves the worktree unused', async () => {
    const { h, project, registry, record } = await setup();
    h.failCreation.errors.push(new Error('no session'));
    await expect(h.manager.startInWorktree(makeFakeHost(), folderKey(project), record.id)).rejects.toThrow('no session');
    expect(h.manager.getPanels().size).toBe(0);
    expect(h.registry.resolve(folderKey(record.workingFolder))).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registry.get(record.id)).toMatchObject({ kind: 'chat' });
    expect((registry.get(record.id) as ChatWorktreeRecord).usedAt).toBeUndefined();
    await h.manager.startInWorktree(makeFakeHost(), folderKey(project), record.id);
    await vi.waitFor(() => expect((registry.get(record.id) as ChatWorktreeRecord).usedAt).toBeDefined());
  });
});

// docs/invariants.md "Worktree chats", Ownership: one folder in two roles, a project and its project's working folder.
describe('a chat worktree open as a project of its own beside a chat of its project working there', () => {
  it("keeps the project's chat in the worktree as the project's while the folder opens and closes, and moves only the folder's own chat off when it closes", async () => {
    const { h, project, record } = await setup();
    const worktreeKey = folderKey(record.workingFolder);
    const projects = await h.manager.startInWorktree(makeFakeHost(), folderKey(project), record.id);
    const projectsSession = h.instance(projects).session;
    h.setFolders([folderEntry(project), folderEntry(record.workingFolder)]);
    await vi.waitFor(() => expect(h.registry.resolve(worktreeKey)?.ownerKey).toBeUndefined());
    const own = await h.manager.initializeHost(makeFakeHost(), { initialFolderKey: worktreeKey });
    await vi.waitFor(() => expect(h.instance(projects).folder).toMatchObject({ key: worktreeKey, ownerKey: folderKey(project), label: 'project' }));
    expect(h.instance(own).folder).toMatchObject({ key: worktreeKey });
    expect(h.instance(own).folder.ownerKey).toBeUndefined();
    const ownSession = h.instance(own).session;

    h.setFolders([folderEntry(project)]);

    await vi.waitFor(() => expect(h.instance(own).folder.key).toBe(folderKey(project)));
    expect(h.instance(own).session).not.toBe(ownSession);
    expect(h.instance(projects).session).toBe(projectsSession);
    expect(h.instance(projects).folder).toMatchObject({ key: worktreeKey, ownerKey: folderKey(project) });
    expect(h.released).not.toContain(worktreeKey);
  });

  it("moves the project's chats in the worktree off with the project and keeps the folder's own chat where it is", async () => {
    const { h, project, record } = await setup();
    const worktreeKey = folderKey(record.workingFolder);
    h.setFolders([folderEntry(project), folderEntry(record.workingFolder)]);
    await vi.waitFor(() => expect(h.registry.resolve(worktreeKey)).toBeDefined());
    const projects = await h.manager.startInWorktree(makeFakeHost(), folderKey(project), record.id);
    expect(h.instance(projects).folder).toMatchObject({ key: worktreeKey, ownerKey: folderKey(project) });
    const own = await h.manager.initializeHost(makeFakeHost(), { initialFolderKey: worktreeKey });
    const ownSession = h.instance(own).session;
    const projectsSession = h.instance(projects).session;

    h.setFolders([folderEntry(record.workingFolder)]);

    await vi.waitFor(() => expect(h.instance(projects).session).not.toBe(projectsSession));
    expect(h.instance(projects).folder).toMatchObject({ key: worktreeKey });
    expect(h.instance(projects).folder.ownerKey).toBeUndefined();
    expect(h.instance(own).session).toBe(ownSession);
    expect(h.released).toContain(folderKey(project));
    expect(h.released).not.toContain(worktreeKey);
  });
});

describe('a chat that moves into its working folder (AD12 wrong-copy guard)', () => {
  it('drops the editor\'s project-folder file from its IDE context, and takes it again back in the project folder', async () => {
    const { h, project, record } = await setup();
    h.platform.editor.setActiveContext({ filePath: path.join(project, 'a.ts'), selection: undefined });
    const host = makeFakeHost();
    const panelId = await h.manager.initializeHost(host);
    const ide = () => h.instance(panelId).ideContextManager.getDisplayInfo(undefined);
    expect(ide()).toMatchObject({ filePath: path.join(project, 'a.ts') });
    const hold = h.registry.acquireOwned(record.workingFolder, folderKey(project));
    await h.manager.switchPanelFolder(panelId, folderKey(record.workingFolder), 'chatMove');
    expect(ide()).toBeNull();
    expect(host.posted.filter((m) => m.type === 'ideContextUpdate').at(-1)).toEqual({ type: 'ideContextUpdate', context: null });
    await h.manager.switchPanelFolder(panelId, folderKey(project), 'chatMove');
    expect(ide()).toMatchObject({ filePath: path.join(project, 'a.ts') });
    hold.dispose();
  });
});

describe('a fork of a chat working in its worktree', () => {
  it('holds the working folder itself, so closing its source releases nothing while the fork works there', async () => {
    const { h, project, record } = await setup();
    const sourceHost = makeFakeHost();
    const source = await h.manager.startInWorktree(sourceHost, folderKey(project), record.id);
    const forked = await h.manager.showForked({ sourcePanelId: source, sourceSdkSessionId: 's1', forkAtUuid: 'u1' } as never);
    expect(forked?.folder).toMatchObject({ key: folderKey(record.workingFolder), ownerKey: folderKey(project) });

    sourceHost.closeFromUser();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.released).not.toContain(folderKey(record.workingFolder));
    expect(h.registry.resolve(folderKey(record.workingFolder))).toBeDefined();
  });
});

describe('closing the panel manager', () => {
  it('lets go of every working folder its chats held without releasing their services, which core disposes itself', async () => {
    const { h, project, record } = await setup();
    await h.manager.startInWorktree(makeFakeHost(), folderKey(project), record.id);
    await h.manager.dispose();
    expect(h.registry.resolve(folderKey(record.workingFolder))).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.released).not.toContain(folderKey(record.workingFolder));
  });
});
