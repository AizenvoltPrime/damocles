import { describe, expect, it } from 'vitest';
import { ChatWorkQueue, chatsToUnload, isActiveActivity, RETAINED_IDLE_CHATS, type PooledChat } from '../chat-pool';

function chat(id: string, lastViewed: number, overrides: Partial<PooledChat> = {}): PooledChat {
  return { id, selected: false, active: false, restoring: false, hasSession: true, empty: false, lastViewed, ...overrides };
}

describe('chatsToUnload', () => {
  it('keeps the selected chat and the 3 most recently viewed idle chats of 6 stored ones', () => {
    const chats = [1, 2, 3, 4, 5, 6].map((n) => chat(`c${n}`, n, { selected: n === 6 }));
    expect(RETAINED_IDLE_CHATS).toBe(3);
    expect(chatsToUnload(chats).sort()).toEqual(['c1', 'c2']);
  });

  it('never unloads an active chat however long ago it was viewed, and does not count it against the idle budget', () => {
    const chats = [
      chat('running', 1, { active: true }),
      chat('pages', 2, { active: true }),
      chat('a', 3),
      chat('b', 4),
      chat('c', 5),
      chat('d', 6),
      chat('selected', 7, { selected: true }),
    ];
    expect(chatsToUnload(chats)).toEqual(['a']);
  });

  it('keeps an active chat through 4 other selections', () => {
    let chats = [chat('busy', 0, { active: true }), ...[1, 2, 3, 4].map((n) => chat(`c${n}`, 0))];
    for (let viewed = 1; viewed <= 4; viewed++) {
      chats = chats.map((entry) => (entry.id === `c${viewed}` ? { ...entry, selected: true, lastViewed: viewed } : { ...entry, selected: false }));
      expect(chatsToUnload(chats)).not.toContain('busy');
    }
  });

  it('never unloads a chat with no session file that has a conversation', () => {
    const chats = [chat('unwritten', 1, { hasSession: false }), chat('a', 2), chat('b', 3), chat('c', 4), chat('sel', 5, { selected: true })];
    expect(chatsToUnload(chats)).toEqual([]);
  });

  it('drops an empty new chat once it is no longer selected, but not while it is', () => {
    expect(chatsToUnload([chat('empty', 9, { empty: true, hasSession: false, selected: true })])).toEqual([]);
    expect(chatsToUnload([chat('empty', 9, { empty: true, hasSession: false }), chat('sel', 10, { selected: true })])).toEqual(['empty']);
  });

  it('keeps an empty chat that is active', () => {
    expect(chatsToUnload([chat('empty', 1, { empty: true, hasSession: false, active: true }), chat('sel', 2, { selected: true })])).toEqual([]);
  });

  it('keeps every chat still restoring its saved session, outside the idle budget, and applies the budget once they are bound', () => {
    const chats = [...[1, 2, 3, 4, 5].map((n) => chat(`r${n}`, n, { restoring: true })), chat('sel', 6, { selected: true })];
    expect(chatsToUnload(chats)).toEqual([]);
    expect(chatsToUnload([...chats, chat('a', 7), chat('b', 8), chat('c', 9)])).toEqual([]);
    expect(chatsToUnload(chats.map((entry) => ({ ...entry, restoring: false }))).sort()).toEqual(['r1', 'r2']);
  });

  it('never drops a restoring chat as empty, even while core reports no conversation for it', () => {
    expect(chatsToUnload([chat('restoring', 1, { restoring: true, empty: true, hasSession: false }), chat('sel', 2, { selected: true })])).toEqual([]);
  });
});

describe('isActiveActivity', () => {
  it('counts a running or waiting chat and one with background work as active until an event clears it', () => {
    expect(isActiveActivity({ state: 'running', background: false })).toBe(true);
    expect(isActiveActivity({ state: 'requires_action', background: false })).toBe(true);
    expect(isActiveActivity({ state: 'idle', background: true })).toBe(true);
    expect(isActiveActivity({ state: 'idle', background: false })).toBe(false);
    expect(isActiveActivity(undefined)).toBe(false);
  });
});

describe('ChatWorkQueue', () => {
  it('runs one chat\'s work in order and lets other chats run meanwhile', async () => {
    const queue = new ChatWorkQueue();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = queue.run('a', async () => {
      await held;
      order.push('a1');
    });
    const second = queue.run('a', async () => {
      order.push('a2');
    });
    await queue.run('b', async () => {
      order.push('b1');
    });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['b1', 'a1', 'a2']);
  });

  it('runs the next work after a failed one and hands the failure to its own caller', async () => {
    const queue = new ChatWorkQueue();
    const failed = queue.run('a', async () => {
      throw new Error('boom');
    });
    const next = queue.run('a', async () => 'ran');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ran');
  });
});
