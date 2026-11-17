import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectPresences, type CheckedProject } from '../../project-presence';
import { keptChatFate, type KeptChatProjects } from '../kept-remote-chats';
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
