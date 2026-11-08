import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserRelays, type LocalUserScope } from '../user-relays';
import { GLOBAL_MEMORY_APPLY_TIMEOUT_MS, GLOBAL_MEMORY_READ_TIMEOUT_MS, MAX_GLOBAL_MEMORY_LIST_BYTES, MAX_RELAYED_MEMORIES, type GlobalMemoryListPage, type GlobalMemoryListRequest, type ListedGlobalMemory } from '../../../../shared/remote-user';

const relays = (local: Partial<LocalUserScope>) => new UserRelays({
  resolveCredential: async () => ({ type: 'none' }),
  clientAuth: async () => ({ providers: {} }),
  voice: false,
  homedir: '/home/u',
  userSettingKeys: () => [],
  userValue: () => undefined,
  hostPolicy: () => ({ allowBypass: false }),
  local: local as LocalUserScope,
  log: () => undefined,
});

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe('a remote core\'s global memory relays through main', () => {
  it('passes a search\'s filters to this computer\'s core', async () => {
    const memorySearch = vi.fn(async () => []);
    await relays({ memorySearch }).memorySearch('ssh+h', '', 5, ['global'], false, { since: 1, until: 2, includeForgotten: true });
    expect(memorySearch).toHaveBeenCalledWith('', 5, ['global'], false, { since: 1, until: 2, includeForgotten: true });
  });

  it('fails a read this computer\'s core leaves unanswered once GLOBAL_MEMORY_READ_TIMEOUT_MS pass', async () => {
    vi.useFakeTimers();
    const user = relays({ memorySearch: never, memoryProfile: never, memoryResolve: never });
    const reads = [user.memorySearch('ssh+h', 'kiwi', 5, ['global']), user.memoryProfile(), user.memoryResolve(['g1'])];
    const outcomes = reads.map((read) => read.then(() => 'answered', (err: Error) => err.message));
    await vi.advanceTimersByTimeAsync(GLOBAL_MEMORY_READ_TIMEOUT_MS - 1);
    let settled = 0;
    for (const outcome of outcomes) void outcome.then(() => settled++);
    await Promise.resolve();
    expect(settled).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all(outcomes)).toEqual([
      `This computer's core did not answer user.memory.search within ${GLOBAL_MEMORY_READ_TIMEOUT_MS} ms`,
      `This computer's core did not answer user.memory.profile within ${GLOBAL_MEMORY_READ_TIMEOUT_MS} ms`,
      `This computer's core did not answer user.memory.resolve within ${GLOBAL_MEMORY_READ_TIMEOUT_MS} ms`,
    ]);
  });

  it('gives an apply GLOBAL_MEMORY_APPLY_TIMEOUT_MS, longer than a read, before it fails', async () => {
    vi.useFakeTimers();
    const user = relays({ memoryApply: never });
    const outcome = user.memoryApply('ssh+h', [{ end: 10, write: { uuid: 'u1', kind: 'fact', content: 'c' } }]).then(() => 'answered', (err: Error) => err.message);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(GLOBAL_MEMORY_APPLY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe(`This computer's core did not answer user.memory.apply within ${GLOBAL_MEMORY_APPLY_TIMEOUT_MS} ms`);
  });

  it('answers as soon as this computer\'s core does, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const user = relays({ memoryResolve: async () => [{ id: 'g1', gone: true, byUser: false }] });
    expect(await user.memoryResolve(['g1'])).toEqual([{ id: 'g1', gone: true, byUser: false }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a remote core's notes list through main", () => {
  const row = (id: string, createdAt: number, fields: Partial<ListedGlobalMemory> = {}): ListedGlobalMemory => ({ id, kind: 'note', content: `note ${id}`, contentHash: `h-${id}`, createdAt, updatedAt: createdAt, ...fields });
  const list = (page: GlobalMemoryListPage, request: GlobalMemoryListRequest = { kinds: ['note'] }) => relays({ memoryList: async () => page }).memoryList('ssh+h', request);

  it("passes a page that is what was asked, after asking this computer's core exactly that", async () => {
    const page = { rows: [row('b', 5, { tags: ['Work'] }), row('a', 5, { tags: ['x', 'work'] }), row('c', 4, { tags: ['WORK'] })], next: { createdAt: 4, id: 'c' } };
    const memoryList = vi.fn(async () => page);
    const request = { kinds: ['note' as const], tags: ['work'], cursor: { createdAt: 6, id: 'z' } };
    expect(await relays({ memoryList }).memoryList('ssh+h', request)).toBe(page);
    expect(memoryList).toHaveBeenCalledWith(request);
  });

  it('refuses more rows than the bound', async () => {
    const rows = Array.from({ length: MAX_RELAYED_MEMORIES + 1 }, (_, index) => row(`n${String(index).padStart(3, '0')}`, 1000 - index));
    await expect(list({ rows })).rejects.toThrow('over its bound');
  });

  it('refuses a row that is not a note or has none of the tags asked for', async () => {
    await expect(list({ rows: [row('f', 1, { kind: 'fact' })] })).rejects.toThrow('not a note');
    await expect(list({ rows: [row('n', 1, { tags: ['home'] })] }, { kinds: ['note'], tags: ['work'] })).rejects.toThrow('without a tag');
    await expect(list({ rows: [row('n', 1)] }, { kinds: ['note'], tags: ['work'] })).rejects.toThrow('without a tag');
  });

  it('refuses a page over the byte budget unless it is one row', async () => {
    const half = 'x'.repeat(Math.ceil(MAX_GLOBAL_MEMORY_LIST_BYTES / 2));
    await expect(list({ rows: [row('b', 2, { content: half }), row('a', 1, { content: half })] })).rejects.toThrow('over its budget');
    const alone = { rows: [row('a', 1, { content: 'y'.repeat(MAX_GLOBAL_MEMORY_LIST_BYTES + 1) })] };
    expect(await list(alone)).toBe(alone);
  });

  it('refuses rows not strictly after the cursor and the row before them', async () => {
    const cursor = { createdAt: 5, id: 'm' };
    await expect(list({ rows: [row('m', 5)] }, { kinds: ['note'], cursor })).rejects.toThrow('out of order');
    await expect(list({ rows: [row('n', 5)] }, { kinds: ['note'], cursor })).rejects.toThrow('out of order');
    await expect(list({ rows: [row('a', 6)] }, { kinds: ['note'], cursor })).rejects.toThrow('out of order');
    await expect(list({ rows: [row('a', 3), row('b', 3)] })).rejects.toThrow('out of order');
    await expect(list({ rows: [row('a', 3), row('a', 3)] })).rejects.toThrow('out of order');
    await expect(list({ rows: [row('a', 2), row('b', 3)] })).rejects.toThrow('out of order');
    expect((await list({ rows: [row('l', 5), row('b', 4)] }, { kinds: ['note'], cursor })).rows).toHaveLength(2);
    // ids compare by their UTF-8 bytes, as SQLite orders them: U+FFFD sorts after an emoji in UTF-16 code units, before it in UTF-8
    expect((await list({ rows: [row(String.fromCodePoint(0x1f600), 3), row(String.fromCodePoint(0xfffd), 3)] })).rows).toHaveLength(2);
  });

  it("refuses a next that is not the last row's key, so the remote core's paging always advances", async () => {
    await expect(list({ rows: [], next: { createdAt: 1, id: 'a' } })).rejects.toThrow('is not its last row');
    await expect(list({ rows: [row('b', 2), row('a', 1)], next: { createdAt: 2, id: 'b' } })).rejects.toThrow('is not its last row');
    await expect(list({ rows: [row('a', 1)], next: { createdAt: 2, id: 'a' } })).rejects.toThrow('is not its last row');
    expect((await list({ rows: [row('b', 2), row('a', 1)], next: { createdAt: 1, id: 'a' } })).next).toEqual({ createdAt: 1, id: 'a' });
  });

  it("fails a list this computer's core leaves unanswered once GLOBAL_MEMORY_READ_TIMEOUT_MS pass", async () => {
    vi.useFakeTimers();
    const outcome = relays({ memoryList: never }).memoryList('ssh+h', { kinds: ['note'] }).then(() => 'answered', (err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(GLOBAL_MEMORY_READ_TIMEOUT_MS);
    expect(await outcome).toBe(`This computer's core did not answer user.memory.list within ${GLOBAL_MEMORY_READ_TIMEOUT_MS} ms`);
  });
});
