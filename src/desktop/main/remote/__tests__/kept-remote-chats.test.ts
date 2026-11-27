import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectPresences, type CheckedProject } from '../../project-presence';
import { keptChatFate, oncePerConversation, openThenRestore, reopenKeptChat, type KeptChatProjects } from '../kept-remote-chats';
import { RemoteState, type RemoteChatRecord } from '../remote-state';

const AUTHORITY = 'ssh+h1';
const APP = { key: `${AUTHORITY}|/srv/app`, fsPath: '/srv/app' };
const GONE = { key: `${AUTHORITY}|/srv/gone`, fsPath: '/srv/gone' };
const MOVED = { key: `${AUTHORITY}|/srv/moved`, fsPath: '/srv/moved' };

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-kept-chats-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const chat = (panelToken: string, projectKey?: string): RemoteChatRecord => ({ authority: AUTHORITY, sessionId: `s-${panelToken}`, panelToken, ...(projectKey !== undefined ? { projectKey } : {}) });

// main's remote presences over the listed projects, each folder there unless named missing
async function projects(listed: readonly CheckedProject[], missing: readonly string[], moved: readonly string[] = []): Promise<KeptChatProjects> {
  const presences = new ProjectPresences({ presence: async ({ key }) => (missing.includes(key) ? 'missing' : 'present'), changed: () => undefined });
  await presences.sync(listed);
  return { known: (key) => listed.some((project) => project.key === key) || moved.includes(key), absent: (key) => presences.absent(key) };
}

describe('a kept remote chat at its host\'s attach', () => {
  it('reopens in a listed folder that is there, stays closed while its folder is missing, and reopens when it names no project', async () => {
    const listed = await projects([APP, GONE], [GONE.key]);
    expect(keptChatFate(APP.key, listed)).toBe('open');
    expect(keptChatFate(GONE.key, listed)).toBe('closed');
    expect(keptChatFate(undefined, listed)).toBe('open');
  });

  it('reopens in the new folder of a move whose host part re-keyed it before the list names the folder', async () => {
    expect(keptChatFate(MOVED.key, await projects([APP], [], [MOVED.key]))).toBe('open');
  });

  it('of a project removed while its folder was missing does not reopen, and the next save leaves its record out', async () => {
    const kept = await RemoteState.open(userData, () => undefined);
    await kept.setChats(AUTHORITY, [chat('a1', APP.key), chat('b2', GONE.key)], null);
    // Remove Project took the missing folder's project out of the list; the relaunch's attach reads the records
    const state = await RemoteState.open(userData, () => undefined);
    const listed = await projects([APP], []);
    const fates = state.chats(AUTHORITY).map((record) => ({ record, fate: keptChatFate(record.projectKey, listed) }));
    expect(fates.filter(({ fate }) => fate === 'open').map(({ record }) => record.panelToken)).toEqual(['a1']);
    await state.setChats(AUTHORITY, fates.filter(({ fate }) => fate !== 'dropped').map(({ record }) => record), null);
    expect((await RemoteState.open(userData, () => undefined)).chats(AUTHORITY)).toEqual([chat('a1', APP.key)]);
  });
});

describe('a kept remote chat reopening on its host\'s core', () => {
  // the core answers the join with whether a panel was found
  const opening = (joined: boolean) => ({
    join: vi.fn(async (_viewKey: string | undefined, _sessionId: string | undefined) => joined),
    restoreJoining: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
  });

  it('under a new epoch joins the panel another device restored its conversation into, by that conversation, and creates no panel', async () => {
    const open = opening(true);
    await reopenKeptChat(chat('a1'), false, open);
    expect(open.join).toHaveBeenCalledWith(undefined, 's-a1');
    expect(open.restoreJoining).not.toHaveBeenCalled();
    expect(open.restore).not.toHaveBeenCalled();
  });

  it('under a new epoch restores its conversation into the view when no panel holds it', async () => {
    const open = opening(false);
    await reopenKeptChat(chat('a1'), false, open);
    expect(open.join).toHaveBeenCalledWith(undefined, 's-a1');
    expect(open.restoreJoining).toHaveBeenCalledTimes(1);
    expect(open.restore).not.toHaveBeenCalled();
  });

  it('under a new epoch restores a chat with no conversation at once, since no panel can hold it', async () => {
    const open = opening(true);
    await reopenKeptChat({ panelToken: 'n1' }, false, open);
    expect(open.join).not.toHaveBeenCalled();
    expect(open.restore).toHaveBeenCalledTimes(1);
  });

  it('under the epoch it was open in rejoins its panel by its page token, else restores it', async () => {
    const open = opening(false);
    await reopenKeptChat(chat('a1'), true, open);
    expect(open.join).toHaveBeenCalledWith('a1', 's-a1');
    expect(open.restoreJoining).toHaveBeenCalledTimes(1);
    expect(open.restore).not.toHaveBeenCalled();
  });

  it('opens every chat\'s view before the first restore settles, so a selection meanwhile finds its chat, then restores them one after another', async () => {
    const trail: string[] = [];
    const settle = new Map<string, () => void>();
    const reopened = openThenRestore([chat('a1'), chat('b2')], (record) => {
      trail.push(`open:${record.panelToken}`);
      return record.panelToken;
    }, (view) => {
      trail.push(`restore:${view}`);
      return new Promise<void>((resolve) => settle.set(view, resolve));
    });
    expect(trail).toEqual(['open:a1', 'open:b2']);
    expect(reopened.map((each) => each.view)).toEqual(['a1', 'b2']);
    await vi.waitFor(() => expect(trail).toEqual(['open:a1', 'open:b2', 'restore:a1']));
    settle.get('a1')!();
    await reopened[0]!.restored;
    await vi.waitFor(() => expect(trail).toEqual(['open:a1', 'open:b2', 'restore:a1', 'restore:b2']));
    settle.get('b2')!();
    await reopened[1]!.restored;
  });

  it('restores the next chat after one whose restore failed, and that one\'s promise rejects', async () => {
    const restored: string[] = [];
    const reopened = openThenRestore([chat('a1'), chat('b2')], (record) => record.panelToken, async (view) => {
      if (view === 'a1') throw new Error('core refused a1');
      restored.push(view);
    });
    await expect(reopened[0]!.restored).rejects.toThrow('core refused a1');
    await reopened[1]!.restored;
    expect(restored).toEqual(['b2']);
  });

  it('reopens one chat per conversation, and none of a conversation the window already shows', () => {
    const records = [chat('a1'), { ...chat('b2'), sessionId: 's-a1' }, chat('c3'), { authority: AUTHORITY, panelToken: 'n1' }, { authority: AUTHORITY, panelToken: 'n2' }];
    expect(oncePerConversation(records, ['s-c3']).map((record) => record.panelToken)).toEqual(['a1', 'n1', 'n2']);
    // the record of the chat selected when the core went is the one kept, so it is selected again
    expect(oncePerConversation(records, [], 'b2').map((record) => record.panelToken)).toEqual(['b2', 'c3', 'n1', 'n2']);
  });
});
