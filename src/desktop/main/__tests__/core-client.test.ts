import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type ChatEntry, type FolderTargetEntry } from '../../core-protocol';
import { CoreClient } from '../core-client';
import { LOCAL_PROJECT_KEYS } from '../remote/remote-project-keys';

const PROJECT = path.resolve('/projects/a');
const WORKING = path.resolve('/worktrees/a-1');
const project: FolderTargetEntry = { key: 'a', fsPath: PROJECT, name: 'a', label: 'a', projectScope: true, branch: 'main' };
const working: FolderTargetEntry = { key: 'w', fsPath: WORKING, name: 'a-1', label: 'a', projectScope: true, ownerKey: 'a' };
const chat: ChatEntry = {
  panelId: 'host-1',
  viewId: 'view-1',
  sessionId: 's1',
  hasConversation: true,
  folder: working,
  permissions: { permissionMode: 'default', dangerouslySkipPermissions: false },
};

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function connect(answersMissingPages = true): { client: CoreClient; core: ReturnType<typeof createCoreEndpoint> } {
  const { main, core } = createLoopback();
  const mainEnd = createMainEndpoint(main, () => undefined);
  const coreEnd = createCoreEndpoint(core, () => undefined);
  const client = new CoreClient(mainEnd, (_view, attach) => attach(), LOCAL_PROJECT_KEYS, true, true, answersMissingPages);
  closers.push(() => {
    client.dispose();
    mainEnd.close('closed');
    coreEnd.close('closed');
  });
  return { client, core: coreEnd };
}

describe('CoreClient', () => {
  it('asks design.previewAnswer of a core that lists design.infoMissing, and design.info of an older one', async () => {
    const answered = connect(true);
    answered.core.serve('design.previewAnswer', async () => ({ missing: true as const }));
    answered.core.serve('design.info', async () => { throw new Error('an older request'); });
    expect(await answered.client.designInfo('d1', 'screens/S1.html')).toEqual({ missing: true });

    const older = connect(false);
    older.core.serve('design.info', async () => undefined);
    expect(await older.client.designInfo('d1', 'screens/S1.html')).toBeUndefined();
  });

  it('reads the chats and folder targets core published, and drops a chat core closed', () => {
    const { client, core } = connect();
    const foldersChanged = vi.fn();
    client.onFoldersChanged(foldersChanged);
    expect(client.defaultTarget()).toBeUndefined();
    core.publish('folderTargets', { defaultKey: 'a', targets: [project, working] });
    core.publish('chats', { panelId: 'host-1', entry: chat });
    expect(foldersChanged).toHaveBeenCalledTimes(1);
    expect(client.defaultTarget()).toEqual(project);
    expect(client.projectOf('w')).toEqual(project);
    expect(client.branchOf('a')).toBe('main');
    expect(client.chat('host-1')).toEqual(chat);
    expect(client.chatOfView('view-1')).toEqual(chat);
    core.publish('chats', { panelId: 'host-1' });
    expect(client.chat('host-1')).toBeUndefined();
    expect(client.chatOfView('view-1')).toBeUndefined();
  });

  it("tells when a chat's entry names another session than the entry before it, and not for its first entry or its removal", () => {
    const { client, core } = connect();
    const changed = vi.fn();
    client.onChatSessionChanged(changed);
    core.publish('chats', { panelId: 'host-1', entry: chat });
    core.publish('chats', { panelId: 'host-1', entry: { ...chat, hasConversation: false } });
    expect(changed).not.toHaveBeenCalled();
    core.publish('chats', { panelId: 'host-1', entry: { ...chat, sessionId: 's2' } });
    expect(changed.mock.calls).toEqual([['view-1', 's2']]);
    const { sessionId: _sessionId, ...fresh } = chat;
    core.publish('chats', { panelId: 'host-1', entry: fresh });
    expect(changed.mock.calls).toEqual([['view-1', 's2'], ['view-1', undefined]]);
    core.publish('chats', { panelId: 'host-1' });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  // docs/invariants.md "Worktree chats", Ownership: a chat of project a works in its worktree w, which is open as a project itself.
  it('keeps a folder open as a project apart from the same folder held as a working folder, as core resolves it', () => {
    const { client, core } = connect();
    const opened: FolderTargetEntry = { key: 'w', fsPath: WORKING, name: 'a-1', label: 'a-1', projectScope: true, branch: 'damocles/x' };
    core.publish('folderTargets', { defaultKey: 'a', targets: [project, opened, working] });
    core.publish('chats', { panelId: 'host-1', entry: chat });
    expect(client.resolve('w')).toEqual(opened);
    expect(client.project('w')).toEqual(opened);
    expect(client.projectOf('w')).toEqual(opened);
    expect(client.branchOf('w')).toBe('damocles/x');
    expect(client.chat('host-1')?.folder).toEqual(working);
    core.publish('folderTargets', { defaultKey: 'a', targets: [project, working] });
    expect(client.resolve('w')).toEqual(working);
    expect(client.project('w')).toBeUndefined();
    expect(client.projectOf('w')).toEqual(project);
  });

  it('sees the mirror delta core sent before the event that depends on it', () => {
    const { client, core } = connect();
    const seen: Array<string | undefined> = [];
    client.onActivity((panelId) => seen.push(client.chat(panelId)?.sessionId));
    core.publish('chats', { panelId: 'host-1', entry: chat });
    core.emit('chat.activity', { panelId: 'host-1', activity: { state: 'idle', pendingKinds: [], pendingPrompts: [], background: false } });
    expect(seen).toEqual(['s1']);
  });

  it('holds a worktree for a finish action through core, runs the action under that hold, and release settles once core let go of it', async () => {
    const { client, core } = connect();
    const ended = vi.fn();
    core.serve('worktree.beginFinish', ({ worktreeId }) => (worktreeId === 'busy' ? undefined : `hold-${worktreeId}`));
    core.serve('worktree.endFinish', ({ hold }) => ended(hold));
    core.serve('worktrees.call', ({ method, args }) => ({ method, args }));
    expect(await client.beginWorktreeFinish('busy', 'merge', () => false)).toBeUndefined();
    const hold = await client.beginWorktreeFinish('w1', 'merge', () => false);
    expect(await hold?.mergeInto('msg')).toEqual({ method: 'mergeInto', args: ['w1', 'hold-w1', 'msg'] });
    expect(await hold?.mergeInto(undefined)).toEqual({ method: 'mergeInto', args: ['w1', 'hold-w1'] });
    await hold?.release();
    expect(ended).toHaveBeenCalledWith('hold-w1');
  });

  it('hands core the permissions a restore carries, and none for a restore without them', async () => {
    const { client, core } = connect();
    const restores: unknown[] = [];
    core.serve('chats.restore', (params) => void restores.push(params));
    const view = { panelId: 'view-1' } as Parameters<CoreClient['restoreChat']>[0];
    await client.restoreChat(view, 'a', chat.permissions);
    await client.restoreChat(view, undefined);
    expect(restores).toEqual([{ viewId: 'view-1', folderKey: 'a', permissions: chat.permissions }, { viewId: 'view-1' }]);
  });

  it('offers a chat\'s review reads only while core lists it as loaded', () => {
    const { client, core } = connect();
    expect(client.reviewSession('host-1')).toBeUndefined();
    core.publish('chats', { panelId: 'host-1', entry: chat });
    expect(client.reviewSession('host-1')).toBeDefined();
  });
});
