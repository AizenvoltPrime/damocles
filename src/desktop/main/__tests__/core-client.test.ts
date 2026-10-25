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

function connect(): { client: CoreClient; core: ReturnType<typeof createCoreEndpoint> } {
  const { main, core } = createLoopback();
  const mainEnd = createMainEndpoint(main, () => undefined);
  const coreEnd = createCoreEndpoint(core, () => undefined);
  const client = new CoreClient(mainEnd, (_view, attach) => attach(), LOCAL_PROJECT_KEYS);
  closers.push(() => {
    client.dispose();
    mainEnd.close('closed');
    coreEnd.close('closed');
  });
  return { client, core: coreEnd };
}

describe('CoreClient', () => {
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

  it('sees the mirror delta core sent before the event that depends on it', () => {
    const { client, core } = connect();
    const seen: Array<string | undefined> = [];
    client.onActivity((panelId) => seen.push(client.chat(panelId)?.sessionId));
    core.publish('chats', { panelId: 'host-1', entry: chat });
    core.emit('chat.activity', { panelId: 'host-1', activity: { state: 'idle', pendingKinds: [], pendingPrompts: [], background: false } });
    expect(seen).toEqual(['s1']);
  });

  it('holds a worktree for a finish action through core, runs the action under that hold, and lets go of it on dispose', async () => {
    const { client, core } = connect();
    const ended = vi.fn();
    core.serve('worktree.beginFinish', ({ worktreeId }) => (worktreeId === 'busy' ? undefined : `hold-${worktreeId}`));
    core.serve('worktree.endFinish', ({ hold }) => ended(hold));
    core.serve('worktrees.call', ({ method, args }) => ({ method, args }));
    expect(await client.beginWorktreeFinish('busy', 'merge', () => false)).toBeUndefined();
    const hold = await client.beginWorktreeFinish('w1', 'merge', () => false);
    expect(await hold?.mergeInto('msg')).toEqual({ method: 'mergeInto', args: ['w1', 'hold-w1', 'msg'] });
    expect(await hold?.mergeInto(undefined)).toEqual({ method: 'mergeInto', args: ['w1', 'hold-w1'] });
    hold?.dispose();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith('hold-w1'));
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
