import { describe, expect, it } from 'vitest';
import { LastChats, openProjectChat } from '../last-chats';
import type { PersistedSelection } from '../panel-state-store';
import type { RemoteSelection } from '../remote/remote-state';

const P = 'c:\\work\\p';
const Q = 'c:\\work\\q';
const REMOTE = 'ssh+h1|/srv/app';

function lastChats() {
  const local: (readonly PersistedSelection[])[] = [];
  const remote: [string, readonly RemoteSelection[]][] = [];
  const chats = new LastChats({
    writeLocal: (entries) => local.push(entries),
    writeRemote: (authority, entries) => remote.push([authority, entries]),
  });
  return { chats, local, remote };
}

describe('LastChats', () => {
  it('writes each project\'s chat to its own file, a local new chat by its panel and a remote one as gone', () => {
    const { chats, local, remote } = lastChats();
    chats.remember(P, 's-1');
    chats.remember(Q, 'new:panel-q');
    chats.remember(REMOTE, 's-r');
    chats.remember(REMOTE, 'new:panel-r');
    chats.remember(P, 's-1');
    expect(local).toEqual([[{ projectKey: P, sessionId: 's-1' }], [{ projectKey: P, sessionId: 's-1' }, { projectKey: Q, panelId: 'panel-q' }]]);
    expect(remote).toEqual([['ssh+h1', [{ projectKey: REMOTE, sessionId: 's-r' }]], ['ssh+h1', [{ projectKey: REMOTE }]]]);
  });

  it('seeds from both files without writing, the first entry of a project winning and one naming no chat as gone', () => {
    const { chats, local, remote } = lastChats();
    chats.seed([{ projectKey: P, sessionId: 's-1' }, { projectKey: Q, panelId: 'panel-q' }, { projectKey: P, sessionId: 's-2' }, { projectKey: REMOTE, sessionId: 's-r' }, { projectKey: 'c:\\work\\none' }]);
    expect([P, Q, REMOTE, 'c:\\work\\none', 'c:\\work\\never'].map((key) => chats.remembered(key))).toEqual(['s-1', 'new:panel-q', 's-r', null, undefined]);
    expect(chats.get('c:\\work\\none')).toBeUndefined();
    expect(local).toEqual([]);
    expect(remote).toEqual([]);
  });

  it('a delete marks the chat gone in every project that remembered it, and only that chat', () => {
    const { chats, local } = lastChats();
    chats.seed([{ projectKey: P, sessionId: 's-1' }, { projectKey: Q, sessionId: 's-2' }]);
    chats.forgetChat('s-1');
    expect(chats.remembered(P)).toBeNull();
    expect(chats.get(P)).toBeUndefined();
    expect(chats.get(Q)).toBe('s-2');
    expect(local).toEqual([[{ projectKey: P }, { projectKey: Q, sessionId: 's-2' }]]);
    chats.forgetChat('s-gone');
    expect(local).toHaveLength(1);
  });

  it('a move marks the chat gone in every other project and keeps it where it works now', () => {
    const { chats, local } = lastChats();
    chats.seed([{ projectKey: P, sessionId: 's-1' }, { projectKey: Q, sessionId: 's-2' }]);
    chats.chatMoved('s-1', Q);
    expect(chats.remembered(P)).toBeNull();
    expect(chats.get(Q)).toBe('s-2');
    chats.chatMoved('s-2', Q);
    expect(chats.get(Q)).toBe('s-2');
    expect(local).toEqual([[{ projectKey: P }, { projectKey: Q, sessionId: 's-2' }]]);
  });

  it('removing a project drops its entry, and Forget host drops the host\'s from memory alone', () => {
    const { chats, local, remote } = lastChats();
    chats.seed([{ projectKey: P, sessionId: 's-1' }, { projectKey: Q, sessionId: 's-2' }, { projectKey: REMOTE, sessionId: 's-r' }]);
    chats.forgetProject(P);
    expect(chats.projects()).toEqual([Q, REMOTE]);
    expect(local).toEqual([[{ projectKey: Q, sessionId: 's-2' }]]);
    chats.forgetAuthority('ssh+h1');
    expect(chats.projects()).toEqual([Q]);
    expect(remote).toEqual([]);
  });

  it('a new chat\'s first write renames its entry to the stored id, which keeps the entry', () => {
    const { chats, local } = lastChats();
    chats.remember(P, 'new:panel-a');
    chats.renamed('new:panel-a', 's-a');
    expect(chats.get(P)).toBe('s-a');
    expect(local.at(-1)).toEqual([{ projectKey: P, sessionId: 's-a' }]);
    chats.renamed('new:panel-b', 's-b');
    expect(local).toHaveLength(2);
  });
});

describe('selecting a project', () => {
  // A project's chats: the loaded and stored ones open, in the Chats list's order.
  function project(remembered: string | null | undefined, chats: readonly string[]) {
    const opened: string[] = [];
    let created = 0;
    return {
      opened,
      created: () => created,
      select: () => openProjectChat({
        remembered,
        open: async (chatId) => {
          if (!chats.includes(chatId)) return false;
          opened.push(chatId);
          return true;
        },
        topOfList: async () => chats[0],
        newChat: async () => {
          created += 1;
        },
      }),
    };
  }

  it('opens the remembered chat while it exists', async () => {
    const selection = project('s-b', ['s-a', 's-b']);
    await selection.select();
    expect(selection.opened).toEqual(['s-b']);
    expect(selection.created()).toBe(0);
  });

  it('with its remembered chat deleted, selecting the project opens the top of its Chats list, and an empty list opens a New chat', async () => {
    const listed = project('s-deleted', ['s-a', 's-b']);
    await listed.select();
    expect(listed.opened).toEqual(['s-a']);
    expect(listed.created()).toBe(0);

    const gone = project(null, ['s-a']);
    await gone.select();
    expect(gone.opened).toEqual(['s-a']);

    const empty = project('s-deleted', []);
    await empty.select();
    expect(empty.opened).toEqual([]);
    expect(empty.created()).toBe(1);
  });

  // Another device's chats on a remote host are not this device's history: attaching opens a New chat beside them.
  it('a project never viewed here opens a New chat, though its Chats list has chats', async () => {
    const never = project(undefined, ['s-a']);
    await never.select();
    expect(never.opened).toEqual([]);
    expect(never.created()).toBe(1);
  });
});
