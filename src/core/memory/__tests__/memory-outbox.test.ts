import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbHolder = vi.hoisted(() => ({ path: '' }));

vi.mock('../database', async (importActual) => {
  const actual = await importActual<typeof import('../database')>();
  return {
    ...actual,
    openDatabaseAsync: vi.fn(async () => {
      const raw = new DatabaseSync(dbHolder.path, { timeout: 5000, enableForeignKeyConstraints: true });
      raw.exec('PRAGMA journal_mode = WAL');
      const db = actual.createDatabaseWrapper(raw);
      actual.runMigrations(db);
      return { db };
    }),
  };
});

const expansion = vi.hoisted(() => ({ expandQuery: vi.fn(async () => [] as string[]) }));
vi.mock('../query-expansion', async (importActual) => ({ ...(await importActual<typeof import('../query-expansion')>()), expandQuery: expansion.expandQuery }));

const subcalls = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: () => ({ run: subcalls.run }),
  describeMemorySubCallModel: () => null,
}));

import { MemoryOutbox } from '../memory-outbox';
import { GlobalMemoryRelay } from '../global-memory-relay';
import { MemoryService } from '../index';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installPlatform } from '../../platform-host';
import { runPinnedTurn } from '../../client-snapshots';
import { createTestDbPath } from './test-helpers';
import { copyDurableRows, openAndMigrate } from '../database';
import { QUALITY_AUDIT_FORGET_REASON } from '../../../shared/types/memory-audit';
import { CREDENTIAL_CLIENT_ABSENT, MAX_GLOBAL_MEMORY_APPLY_BYTES, MAX_GLOBAL_MEMORY_LABEL_CHARS, MAX_GLOBAL_MEMORY_TAGS, MAX_RELAYED_MEMORIES, MAX_STANDING_GLOBALS, type GlobalMemoryWrite } from '../../../shared/remote-user';
import { LocalizedError } from '../../../shared/localized-text';
import { CORE_TO_MAIN, MAIN_TO_CORE } from '../../../desktop/core-protocol/messages';
import { INVALID } from '../../../desktop/core-protocol/schema';
import { CORE_MAX_MESSAGE_BYTES } from '../../../desktop/core-protocol/attached-transport';
import { globalMemoryId } from '../global-memory-relay';
import { globalMemoryClosedReason } from '../../user-scope';

let dir: string;
let outbox: MemoryOutbox;
let fake: ReturnType<typeof createFakeRemoteHost>;
let relay: GlobalMemoryRelay;

const write = (n: number): GlobalMemoryWrite => ({ uuid: `uuid-${n}`, kind: 'fact', content: `fact ${n}` });
const contents = (clientId: string) => outbox.read(clientId).then((read) => read.entries.map((entry) => entry.write.uuid));

// lets file work and promise turns run until `check` holds, without a timer, so a test's fake clock stays where it is
const until = async (check: () => boolean | Promise<boolean>): Promise<void> => {
  for (const start = Date.now(); Date.now() - start < 5_000;) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the condition never held');
};

const applied = (): string[][] => vi.mocked(fake.remote.memoryApply).mock.calls.map(([, entries]) => entries.map((entry) => entry.write.uuid));

beforeEach(() => {
  subcalls.run.mockReset();
  subcalls.run.mockImplementation(async () => ({ value: null, failure: 'no-model' as const }));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  outbox = new MemoryOutbox(dir);
  fake = createFakeRemoteHost();
  installPlatform({ ...createFakePlatform(), remote: fake.remote });
  relay = new GlobalMemoryRelay(fake.remote, outbox);
});

afterEach(async () => {
  // the outbox lock its work holds must be released before the folder goes and the next test fakes timers
  await relay.dispose();
  installPlatform(createFakePlatform());
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the memory outbox', () => {
  it('keeps the entries in the order they were appended, in a 0600 file', async () => {
    for (const n of [1, 2, 3]) await outbox.append('client-a', write(n));
    expect(await contents('client-a')).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
    if (process.platform !== 'win32') expect(fs.statSync(outbox.file('client-a')).mode & 0o777).toBe(0o600);
  });

  it('removes only the acknowledged prefix', async () => {
    for (const n of [1, 2, 3]) await outbox.append('client-a', write(n));
    const { entries } = await outbox.read('client-a');
    await outbox.acknowledge('client-a', entries[1]!.end, 'uuid-2');
    expect(await contents('client-a')).toEqual(['uuid-3']);
    await outbox.acknowledge('client-a', (await outbox.read('client-a')).end, 'uuid-3');
    expect(fs.existsSync(outbox.file('client-a'))).toBe(false);
  });

  it('skips a line a crash cut short, and the next append starts a line of its own', async () => {
    await outbox.append('client-a', write(1));
    fs.appendFileSync(outbox.file('client-a'), '{"uuid":"cut');
    await outbox.append('client-a', write(2));
    expect(await contents('client-a')).toEqual(['uuid-1', 'uuid-2']);
  });

  it('refuses a client id that is not one path segment', () => {
    expect(() => outbox.file('../client')).toThrow();
  });

  it('skips a line past the apply contract\'s bounds, so it cannot fail every drain after it', async () => {
    await outbox.append('client-a', write(1));
    const tooManyTags = { ...write(2), tags: Array.from({ length: MAX_GLOBAL_MEMORY_TAGS + 1 }, (_, n) => `tag-${n}`) };
    fs.appendFileSync(outbox.file('client-a'), `${JSON.stringify(tooManyTags)}\n`);
    await outbox.append('client-a', write(3));
    expect(await contents('client-a')).toEqual(['uuid-1', 'uuid-3']);
    await relay.drain('client-a');
    expect(vi.mocked(fake.remote.memoryApply).mock.calls.map(([, entries]) => entries.map((entry) => entry.write.uuid))).toEqual([['uuid-1', 'uuid-3']]);
    expect(fs.existsSync(outbox.file('client-a'))).toBe(false);
  });

  it('syncs what an acknowledgement keeps before it replaces the outbox', async () => {
    for (const n of [1, 2]) await outbox.append('client-a', write(n));
    const { entries } = await outbox.read('client-a');
    const order: string[] = [];
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.rest')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          order.push('sync');
          await sync();
        };
      }
      return handle;
    });
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      order.push('rename');
      await rename(from, to);
    });
    try {
      await outbox.acknowledge('client-a', entries[0]!.end, 'uuid-1');
    } finally {
      vi.restoreAllMocks();
    }
    expect(order).toEqual(['sync', 'rename']);
    expect(await contents('client-a')).toEqual(['uuid-2']);
  });
});

describe('what the relay sends a client', () => {
  const sentParams = (method: 'user.memory.apply' | 'user.memory.resolve' | 'user.memory.search', params: unknown): boolean => CORE_TO_MAIN.requests[method].params(params) !== INVALID;

  it('names at most MAX_RELAYED_MEMORIES ids in one resolve, however many live globals a context holds', async () => {
    const ids = Array.from({ length: MAX_RELAYED_MEMORIES * 2 + 1 }, (_, n) => globalMemoryId('client-a', `g${n}`));
    vi.mocked(fake.remote.memoryResolve).mockImplementation(async (_clientId, own) => own.map((id) => ({ id, gone: true as const, byUser: false })));
    const resolved = await relay.resolve([...ids, ids[0]!]);
    const calls = vi.mocked(fake.remote.memoryResolve).mock.calls;
    expect(calls.map(([, own]) => own.length)).toEqual([MAX_RELAYED_MEMORIES, MAX_RELAYED_MEMORIES, 1]);
    for (const [clientId, own] of calls) expect(sentParams('user.memory.resolve', { clientId, ids: own })).toBe(true);
    expect(resolved.size).toBe(ids.length);
  });

  it('asks a search for each tier once and for no more rows than the table takes', async () => {
    await relay.search('kiwi', 100, ['global', 'global', 'note']);
    const [clientId, query, k, tiers] = vi.mocked(fake.remote.memorySearch).mock.calls[0]!;
    expect([k, tiers]).toEqual([MAX_RELAYED_MEMORIES, ['global', 'note']]);
    expect(sentParams('user.memory.search', { clientId, query, k, tiers })).toBe(true);
  });

  it('answers a search the client left during as away', async () => {
    vi.mocked(fake.remote.memorySearch).mockRejectedValueOnce(new Error(CREDENTIAL_CLIENT_ABSENT));
    await expect(relay.search('kiwi', 5, ['global'])).resolves.toEqual({ unreachable: globalMemoryClosedReason() });
  });

  it('sends a write\'s tags each once and at most MAX_GLOBAL_MEMORY_TAGS of them, applied or queued', async () => {
    const tags = [...Array.from({ length: MAX_GLOBAL_MEMORY_TAGS + 5 }, (_, n) => `tag-${n}`), 'tag-0', 'tag-1'];
    fake.setActing('client-a');
    await runPinnedTurn(fake.remote, 'panel-1', () => relay.write({ kind: 'fact', content: 'applied now', tags }));
    const [clientId, entries] = vi.mocked(fake.remote.memoryApply).mock.calls[0]!;
    expect(entries[0]!.write.tags).toEqual(tags.slice(0, MAX_GLOBAL_MEMORY_TAGS));
    expect(sentParams('user.memory.apply', { clientId, entries })).toBe(true);
    fake.set('clientAuth', 'client-a', undefined);
    await runPinnedTurn(fake.remote, 'panel-1', () => relay.write({ kind: 'fact', content: 'queued', tags }));
    expect((await outbox.read('client-a')).entries[0]!.write.tags).toEqual(tags.slice(0, MAX_GLOBAL_MEMORY_TAGS));
  });

  it('refuses a write that cannot fit the apply contract, sending and queuing nothing', async () => {
    fake.setActing('client-a');
    const huge = { kind: 'fact' as const, content: 'fact', title: 'x'.repeat(MAX_GLOBAL_MEMORY_LABEL_CHARS + 1) };
    await expect(runPinnedTurn(fake.remote, 'panel-1', () => relay.write(huge))).rejects.toThrow(LocalizedError);
    fake.set('clientAuth', 'client-a', undefined);
    await expect(runPinnedTurn(fake.remote, 'panel-1', () => relay.write(huge))).rejects.toThrow(LocalizedError);
    expect(fake.remote.memoryApply).not.toHaveBeenCalled();
    expect(fs.existsSync(outbox.file('client-a'))).toBe(false);
  });

  it('names the client\'s row a write landed in, a duplicate it folded into included', async () => {
    fake.setActing('client-a');
    vi.mocked(fake.remote.memoryApply).mockResolvedValueOnce({ through: 0, ids: ['existing-row'] });
    const outcome = await runPinnedTurn(fake.remote, 'panel-1', () => relay.write({ kind: 'fact', content: 'already known' }));
    expect(outcome).toMatchObject({ queued: false, id: 'existing-row' });
  });
});

describe('the drain at attach', () => {
  const pinnedTo = <T>(clientId: string | undefined, body: () => T): T => {
    fake.setActing(clientId);
    return runPinnedTurn(fake.remote, 'panel-1', body);
  };

  it('holds a write in the turn\'s pinned client\'s outbox while it is away, and drains it in order when it attaches', async () => {
    fake.set('clientAuth', 'client-a', undefined);
    await pinnedTo('client-a', () => relay.write({ kind: 'fact', content: 'first' }));
    await pinnedTo('client-a', () => relay.write({ kind: 'note', content: 'second' }));
    expect(fake.remote.memoryApply).not.toHaveBeenCalled();
    fake.set('clientAuth', 'client-a', { providers: {} });
    await vi.waitFor(() => expect(fs.existsSync(outbox.file('client-a'))).toBe(false));
    const [[clientId, entries]] = vi.mocked(fake.remote.memoryApply).mock.calls as unknown as [[string, Array<{ write: GlobalMemoryWrite }>]];
    expect(clientId).toBe('client-a');
    expect(entries.map((entry) => entry.write.content)).toEqual(['first', 'second']);
  });

  it('holds a write for the device that owns it in that device\'s outbox, whoever acts now', async () => {
    fake.set('clientAuth', 'client-b', undefined);
    fake.setActing('client-a');
    await relay.write({ kind: 'fact', content: 'from device b\'s turn' }, 'client-b');
    expect(fake.remote.memoryApply).not.toHaveBeenCalled();
    expect(await contents('client-b')).toHaveLength(1);
    expect(await contents('client-a')).toEqual([]);
  });

  it('drains an outbox only to its own client', async () => {
    fake.set('clientAuth', 'client-a', undefined);
    await pinnedTo('client-a', () => relay.write({ kind: 'fact', content: 'device a\'s' }));
    fake.set('clientAuth', 'client-b', { providers: {} });
    fake.setActing('client-b');
    await relay.drain('client-b');
    expect(fake.remote.memoryApply).not.toHaveBeenCalled();
    expect(await contents('client-a')).toHaveLength(1);
  });

  it('sends the same uuids again when the drain was cut between apply and acknowledge', async () => {
    for (const n of [1, 2]) await outbox.append('client-a', write(n));
    vi.mocked(fake.remote.memoryApply).mockRejectedValueOnce(new Error(CREDENTIAL_CLIENT_ABSENT));
    await relay.drain('client-a');
    expect(await contents('client-a')).toEqual(['uuid-1', 'uuid-2']);
    await relay.drain('client-a');
    const sent = vi.mocked(fake.remote.memoryApply).mock.calls.map(([, entries]) => entries.map((entry) => entry.write.uuid));
    expect(sent).toEqual([['uuid-1', 'uuid-2'], ['uuid-1', 'uuid-2']]);
    expect(fs.existsSync(outbox.file('client-a'))).toBe(false);
  });

  it('keeps an entry appended during the drain for the next one', async () => {
    await outbox.append('client-a', write(1));
    vi.mocked(fake.remote.memoryApply).mockImplementationOnce(async (_clientId, entries) => {
      await outbox.append('client-a', write(2));
      return { through: entries.at(-1)!.end };
    });
    await relay.drain('client-a');
    expect(await contents('client-a')).toEqual(['uuid-2']);
  });

  it('removes only the prefix the client acknowledged', async () => {
    for (const n of [1, 2, 3]) await outbox.append('client-a', write(n));
    vi.mocked(fake.remote.memoryApply).mockImplementationOnce(async (_clientId, entries) => ({ through: entries[0]!.end }));
    await relay.drain('client-a');
    expect(await contents('client-a')).toEqual(['uuid-2', 'uuid-3']);
  });
});

describe('the drain in batches', () => {
  const sentApply = (clientId: string, entries: unknown): boolean => CORE_TO_MAIN.requests['user.memory.apply'].params({ clientId, entries }) !== INVALID;

  it('drains an outbox larger than one apply in batches the apply table takes, in order, while the client takes each whole', async () => {
    const total = MAX_RELAYED_MEMORIES * 2 + 1;
    for (let n = 0; n < total; n++) await outbox.append('client-a', write(n));
    await relay.drain('client-a');
    const calls = vi.mocked(fake.remote.memoryApply).mock.calls;
    expect(calls.map(([, entries]) => entries.length)).toEqual([MAX_RELAYED_MEMORIES, MAX_RELAYED_MEMORIES, 1]);
    for (const [clientId, entries] of calls) expect(sentApply(clientId, entries)).toBe(true);
    expect(applied().flat()).toEqual(Array.from({ length: total }, (_, n) => `uuid-${n}`));
    expect(fs.existsSync(outbox.file('client-a'))).toBe(false);
  });

  it('sends at most MAX_GLOBAL_MEMORY_APPLY_BYTES of writes in one apply, far below the core channel\'s bound, and a larger write alone', async () => {
    expect(MAX_GLOBAL_MEMORY_APPLY_BYTES * 4).toBeLessThanOrEqual(CORE_MAX_MESSAGE_BYTES);
    const sized = (n: number, share: number): GlobalMemoryWrite => ({ uuid: `uuid-${n}`, kind: 'fact', content: 'x'.repeat(Math.floor(MAX_GLOBAL_MEMORY_APPLY_BYTES * share)) });
    for (const entry of [sized(1, 0.4), sized(2, 0.4), sized(3, 0.4), sized(4, 1.05), sized(5, 0.1)]) await outbox.append('client-a', entry);
    await relay.drain('client-a');
    expect(applied()).toEqual([['uuid-1', 'uuid-2'], ['uuid-3'], ['uuid-4'], ['uuid-5']]);
    expect(fs.existsSync(outbox.file('client-a'))).toBe(false);
  });

  it('stops after a batch the client applied only in part, leaving the rest for the next drain', async () => {
    const total = MAX_RELAYED_MEMORIES + 2;
    for (let n = 0; n < total; n++) await outbox.append('client-a', write(n));
    vi.mocked(fake.remote.memoryApply).mockImplementationOnce(async (_clientId, entries) => ({ through: entries[1]!.end }));
    await relay.drain('client-a');
    expect(applied().map((uuids) => uuids.length)).toEqual([MAX_RELAYED_MEMORIES]);
    expect(await contents('client-a')).toHaveLength(total - 2);
  });
});

describe('the drain and the writes of one device', () => {
  it('queues a write its client did not say it applied, and drains it', async () => {
    vi.mocked(fake.remote.memoryApply).mockResolvedValueOnce({ through: 0, ids: [] });
    const outcome = await relay.write({ kind: 'fact', content: 'unconfirmed' }, 'client-a');
    expect(outcome).toMatchObject({ queued: true, id: outcome.uuid });
    await until(() => !fs.existsSync(outbox.file('client-a')));
    expect(applied()).toEqual([[outcome.uuid], [outcome.uuid]]);
  });

  it('tests an empty outbox by its size, parsing none of it, before it applies a write directly', async () => {
    const read = vi.spyOn(outbox, 'read');
    const outcome = await relay.write({ kind: 'fact', content: 'direct' }, 'client-a');
    expect(outcome.queued).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps one device\'s writes in the order they were made when the device leaves during the first', async () => {
    let leave!: () => void;
    vi.mocked(fake.remote.memoryApply).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      leave = () => reject(new Error(CREDENTIAL_CLIENT_ABSENT));
    }));
    const first = relay.write({ kind: 'fact', content: 'A' }, 'client-a');
    await until(() => vi.mocked(fake.remote.memoryApply).mock.calls.length === 1);
    fake.set('clientAuth', 'client-a', undefined);
    const second = relay.write({ kind: 'fact', content: 'B' }, 'client-a');
    // the second write would land in the outbox meanwhile if it did not wait for the first
    await new Promise((resolve) => setTimeout(resolve, 50));
    leave();
    await Promise.all([first, second]);
    expect((await outbox.read('client-a')).entries.map((entry) => entry.write.content)).toEqual(['A', 'B']);
  });

  it('starts a drain asked for just after the running one made its last check, so no appended entry waits for the next attach', async () => {
    for (let turns = 0; turns < 16; turns++) {
      await outbox.append('client-a', write(1));
      const acknowledge = outbox.acknowledge.bind(outbox);
      let late: Promise<void> | undefined;
      vi.spyOn(outbox, 'acknowledge').mockImplementationOnce(async (...args) => {
        await acknowledge(...args);
        await outbox.append('client-a', write(2));
        late = (async () => {
          for (let turn = 0; turn < turns; turn++) await null;
          await relay.drain('client-a');
        })();
      });
      await relay.drain('client-a');
      await late;
      expect(await contents('client-a')).toEqual([]);
    }
  });

  it('tries a failed drain again with a growing delay while its client stays attached, and stops when it leaves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await outbox.append('client-a', write(1));
      vi.mocked(fake.remote.memoryApply).mockRejectedValue(new Error('the client\'s store is busy'));
      const calls = (): number => vi.mocked(fake.remote.memoryApply).mock.calls.length;
      await relay.drain('client-a');
      expect(calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => calls() === 2);
      // the second failure waits twice as long
      await vi.advanceTimersByTimeAsync(9_999);
      expect(calls()).toBe(2);
      vi.mocked(fake.remote.memoryApply).mockImplementation(async (_clientId, entries) => ({ through: entries.at(-1)!.end }));
      await vi.advanceTimersByTimeAsync(1);
      // the retry timer's drain sends it, and joining that drain releases its lock before the next append, which would
      // otherwise wait on proper-lockfile's retry, a faked setTimeout
      await until(() => calls() === 3);
      await relay.drain('client-a');
      expect(fs.existsSync(outbox.file('client-a'))).toBe(false);
      expect(calls()).toBe(3);

      await outbox.append('client-a', write(2));
      vi.mocked(fake.remote.memoryApply).mockRejectedValue(new Error('the client\'s store is busy'));
      await relay.drain('client-a');
      expect(calls()).toBe(4);
      const drains = vi.spyOn(relay, 'drain');
      fake.set('clientAuth', 'client-a', undefined);
      // the detach stops the retry: no drain runs after it
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(drains).not.toHaveBeenCalled();
      expect(calls()).toBe(4);
      expect(await contents('client-a')).toEqual(['uuid-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves its dispose without waiting on a device, and starts no batch after it', async () => {
    await outbox.append('client-a', write(1));
    let answer!: () => void;
    vi.mocked(fake.remote.memoryApply).mockImplementationOnce((_clientId, entries) => new Promise((resolve) => (answer = () => resolve({ through: entries.at(-1)!.end }))));
    const draining = relay.drain('client-a');
    await until(() => vi.mocked(fake.remote.memoryApply).mock.calls.length === 1);
    await outbox.append('client-a', write(2));
    void relay.drain('client-a');
    await relay.dispose();
    answer();
    await draining;
    expect(vi.mocked(fake.remote.memoryApply)).toHaveBeenCalledTimes(1);
    expect(await contents('client-a')).toEqual(['uuid-2']);
  });


  it('keeps the profile of the latest attach when an older read lands after it', async () => {
    const profileOf = (text: string) => ({ profile: { static: text, dynamic: '' }, pinned: [], preferences: [] });
    let older!: (value: ReturnType<typeof profileOf>) => void;
    vi.mocked(fake.remote.memoryProfile)
      .mockImplementationOnce(() => new Promise((resolve) => { older = resolve; }))
      .mockResolvedValueOnce(profileOf('newer'));
    fake.set('clientAuth', 'client-a', undefined);
    fake.set('clientAuth', 'client-a', { providers: {} });
    fake.set('clientAuth', 'client-a', undefined);
    fake.set('clientAuth', 'client-a', { providers: {} });
    await until(() => relay.profile().static === 'newer');
    older(profileOf('older'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(relay.profile().static).toBe('newer');
  });

  it('cuts nothing when the line at the acknowledged offset is no longer the one its client applied', async () => {
    for (const n of [1, 2]) await outbox.append('client-a', write(n));
    const { entries } = await outbox.read('client-a');
    // another core's drain cut the first entry meanwhile, and a new write followed
    await outbox.acknowledge('client-a', entries[0]!.end, 'uuid-1');
    await outbox.append('client-a', write(3));
    await expect(outbox.acknowledge('client-a', entries[1]!.end, 'uuid-2')).rejects.toThrow('not the one its client acknowledged');
    expect(await contents('client-a')).toEqual(['uuid-2', 'uuid-3']);
  });
});

describe('held outboxes', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const lastSeen = (records: Record<string, number>): void => fs.writeFileSync(path.join(dir, 'last-seen.json'), JSON.stringify(records));
  const recorded = (): Record<string, number> => JSON.parse(fs.readFileSync(path.join(dir, 'last-seen.json'), 'utf8')) as Record<string, number>;
  const published = () => vi.mocked(fake.remote.heldMemoryChanged).mock.calls.at(-1)?.[0];

  it('holds the outbox of a device away for 30 days, with its entry count and when it was last seen, never an attached device\'s', async () => {
    const old = Date.now() - 31 * DAY;
    for (const n of [1, 2, 3]) await outbox.append('client-old', write(n));
    await outbox.append('client-recent', write(4));
    await outbox.append('client-a', write(5));
    lastSeen({ 'client-old': old, 'client-recent': Date.now() - 2 * DAY, 'client-a': old });
    // the attached device's drain is still running, so its outbox is there to list
    vi.mocked(fake.remote.memoryApply).mockImplementation(() => new Promise(() => undefined));
    relay.start();
    await until(() => vi.mocked(fake.remote.heldMemoryChanged).mock.calls.length === 2);
    expect(published()).toEqual([{ queueId: 'client-old', count: 3, lastSeen: old }]);
    expect(CORE_TO_MAIN.mirrors.heldMemory({ queues: published() })).not.toBe(INVALID);
    expect(await contents('client-a')).toEqual(['uuid-5']);
  });

  it('starts the 30 days of an outbox whose device has no record yet at the time this core first sees it', async () => {
    await outbox.append('client-legacy', write(1));
    const before = Date.now();
    relay.start();
    await until(() => published() !== undefined);
    expect(published()).toEqual([]);
    expect(recorded()['client-legacy']).toBeGreaterThanOrEqual(before);
  });

  it('resolves the relay\'s dispose once a held listing under way has ended', async () => {
    await outbox.append('client-old', write(1));
    lastSeen({ 'client-old': Date.now() - 40 * DAY });
    relay.start();
    await relay.dispose();
    expect(vi.mocked(fake.remote.heldMemoryChanged)).not.toHaveBeenCalled();
    // the listing ran to its end: it records the attached device as seen
    expect(recorded()['client-a']).toBeDefined();
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.lock'))).toEqual([]);
  });

  it('records when a device leaves', async () => {
    const before = Date.now();
    fake.set('clientAuth', 'client-a', undefined);
    await until(() => fs.existsSync(path.join(dir, 'last-seen.json')) && recorded()['client-a'] !== undefined);
    expect(recorded()['client-a']).toBeGreaterThanOrEqual(before);
  });

  it('delivers a held outbox to the asking device after what it already holds, drains it there, and lists it no more', async () => {
    for (const n of [1, 2]) await outbox.append('client-old', write(n));
    lastSeen({ 'client-old': Date.now() - 40 * DAY });
    fake.setActor('client-a');
    expect(await relay.deliverHeld('client-old')).toBe(true);
    await until(() => !fs.existsSync(outbox.file('client-a')));
    expect(fs.existsSync(outbox.file('client-old'))).toBe(false);
    expect(vi.mocked(fake.remote.memoryApply).mock.calls.map(([clientId, entries]) => [clientId, entries.map((entry) => entry.write.uuid)])).toEqual([['client-a', ['uuid-1', 'uuid-2']]]);
    await until(() => Array.isArray(published()) && published()!.length === 0);
    expect(await relay.deliverHeld('client-old')).toBe(false);
  });

  it('discards a held outbox, and takes or discards no outbox that is not held', async () => {
    await outbox.append('client-old', write(1));
    await outbox.append('client-recent', write(2));
    lastSeen({ 'client-old': Date.now() - 40 * DAY, 'client-recent': Date.now() });
    fake.setActor('client-a');
    expect(await relay.discardHeld('client-recent')).toBe(false);
    expect(await relay.deliverHeld('client-recent')).toBe(false);
    expect(await relay.discardHeld('client-old')).toBe(true);
    expect(fs.existsSync(outbox.file('client-old'))).toBe(false);
    expect(await contents('client-recent')).toEqual(['uuid-2']);
    expect(fake.remote.memoryApply).not.toHaveBeenCalled();
  });

  it('moves nothing when the held device comes back after the listing, and its outbox drains to it alone', async () => {
    for (const n of [1, 2]) await outbox.append('client-old', write(n));
    lastSeen({ 'client-old': Date.now() - 40 * DAY });
    fake.setActor('client-a');
    const transfer = outbox.transfer.bind(outbox);
    vi.spyOn(outbox, 'transfer').mockImplementationOnce(async (...args) => {
      // the held device attaches between the listing and the move
      fake.set('clientAuth', 'client-old', { providers: {} });
      return transfer(...args);
    });
    expect(await relay.deliverHeld('client-old')).toBe(false);
    await until(() => !fs.existsSync(outbox.file('client-old')));
    expect(vi.mocked(fake.remote.memoryApply).mock.calls.map(([clientId, entries]) => [clientId, entries.map((entry) => entry.write.uuid)])).toEqual([['client-old', ['uuid-1', 'uuid-2']]]);
    expect(fs.existsSync(outbox.file('client-a'))).toBe(false);
  });

  it('discards nothing when the held device comes back after the listing, and its outbox drains to it', async () => {
    await outbox.append('client-old', write(1));
    lastSeen({ 'client-old': Date.now() - 40 * DAY });
    const discard = outbox.discard.bind(outbox);
    vi.spyOn(outbox, 'discard').mockImplementationOnce(async (...args) => {
      fake.set('clientAuth', 'client-old', { providers: {} });
      return discard(...args);
    });
    expect(await relay.discardHeld('client-old')).toBe(false);
    await until(() => !fs.existsSync(outbox.file('client-old')));
    expect(applied()).toEqual([['uuid-1']]);
  });

  it('gives a held outbox only to an attached device that asks', async () => {
    await outbox.append('client-old', write(1));
    lastSeen({ 'client-old': Date.now() - 40 * DAY });
    fake.setActor(undefined);
    await expect(relay.deliverHeld('client-old')).rejects.toThrow('Only an attached device');
    expect(await contents('client-old')).toEqual(['uuid-1']);
  });
});

describe('applying relayed writes on the client', () => {
  let service: MemoryService;

  beforeEach(async () => {
    dbHolder.path = createTestDbPath();
    installPlatform(createFakePlatform());
    service = new MemoryService(createFakePlatform());
    await service.ensureInitialized();
  });

  afterEach(async () => {
    await service.dispose();
  });

  const globals = (): Array<{ id: string; content: string }> => {
    const raw = new DatabaseSync(dbHolder.path);
    try {
      return raw.prepare("SELECT id, content FROM memories WHERE scope = 'global' ORDER BY created_at, content").all() as Array<{ id: string; content: string }>;
    } finally {
      raw.close();
    }
  };

  it('applies each uuid once, a repeat skipped, keeping the uuid as the row id', async () => {
    expect(await service.applyRelayedWrites([write(1), write(2)])).toEqual({ applied: 2, ids: ['uuid-1', 'uuid-2'] });
    expect(await service.applyRelayedWrites([write(1), write(2), write(3)])).toEqual({ applied: 3, ids: ['uuid-1', 'uuid-2', 'uuid-3'] });
    expect(globals()).toEqual([{ id: 'uuid-1', content: 'fact 1' }, { id: 'uuid-2', content: 'fact 2' }, { id: 'uuid-3', content: 'fact 3' }]);
  });

  it('answers the existing row a write folded into as a duplicate, on its apply and on a repeat of it', async () => {
    const existing = await service.saveMemory({ content: 'The user is on call on Fridays.', kind: 'fact', scope: 'global' });
    const duplicate: GlobalMemoryWrite = { uuid: 'uuid-dup', kind: 'fact', content: 'The user is on call on Fridays.' };
    expect(await service.applyRelayedWrites([duplicate])).toEqual({ applied: 1, ids: [existing!.id] });
    expect(await service.applyRelayedWrites([duplicate])).toEqual({ applied: 1, ids: [existing!.id] });
  });

  it('holds each write once when a drain is cut after the client applied it and before its acknowledgement', async () => {
    for (const n of [1, 2]) await outbox.append('client-a', write(n));
    let cut = true;
    vi.mocked(fake.remote.memoryApply).mockImplementation(async (_clientId, entries) => {
      const { applied, ids } = await service.applyRelayedWrites(entries.map((entry) => entry.write));
      if (cut) {
        cut = false;
        throw new Error(CREDENTIAL_CLIENT_ABSENT);
      }
      return { through: entries[applied - 1]!.end, ids };
    });
    await relay.drain('client-a');
    expect(await contents('client-a')).toEqual(['uuid-1', 'uuid-2']);
    await relay.drain('client-a');
    expect(fs.existsSync(outbox.file('client-a'))).toBe(false);
    expect(globals()).toEqual([{ id: 'uuid-1', content: 'fact 1' }, { id: 'uuid-2', content: 'fact 2' }]);
    const raw = new DatabaseSync(dbHolder.path);
    try {
      expect(raw.prepare("SELECT source_count FROM memories WHERE scope = 'global' ORDER BY id").all()).toEqual([{ source_count: 1 }, { source_count: 1 }]);
    } finally {
      raw.close();
    }
  });

  it('answers a remote core with its global profile, its pinned globals and its global preferences, never a project row', async () => {
    const preference = await service.saveMemory({ content: 'The user prefers tabs.', kind: 'preference', scope: 'global' });
    const fact = await service.saveMemory({ content: 'The user is on call on Fridays.', kind: 'fact', scope: 'global' });
    await service.pinMemory(fact!.id);
    await service.saveMemory({ content: 'The project prefers spaces.', kind: 'preference', scope: 'project', workspace: '/ws' });
    const answer = await service.relayProfile();
    expect(answer.pinned.map((memory) => memory.content)).toEqual(['The user is on call on Fridays.']);
    expect(answer.preferences.map((memory) => [memory.id, memory.content])).toEqual([[preference!.id, 'The user prefers tabs.']]);
  });

  const insertGlobal = (raw: DatabaseSync, id: string, fields: { kind?: string; pinned?: number; source_count?: number; updated_at: number; forget_after?: number }): void => {
    raw.prepare(`INSERT INTO memories (id, kind, scope, content, content_hash, created_at, updated_at, pinned, source_count, forget_after)
      VALUES (?, ?, 'global', ?, ?, 1, ?, ?, ?, ?)`).run(id, fields.kind ?? 'fact', `memory ${id}`, `hash-${id}`, fields.updated_at, fields.pinned ?? 0, fields.source_count ?? 1, fields.forget_after ?? null);
  };

  it('ranks the pinned globals newest first and the preferences as the local injection does, live rows only', async () => {
    const raw = new DatabaseSync(dbHolder.path);
    try {
      insertGlobal(raw, 'p-old', { pinned: 1, updated_at: 1000 });
      insertGlobal(raw, 'p-new', { pinned: 1, updated_at: 2000 });
      insertGlobal(raw, 'p-expired', { kind: 'episode', pinned: 1, updated_at: 3000, forget_after: Date.now() - 60_000 });
      insertGlobal(raw, 'pref-old', { kind: 'preference', updated_at: 50 });
      insertGlobal(raw, 'pref-recent', { kind: 'preference', updated_at: 3000 });
      insertGlobal(raw, 'pref-sourced', { kind: 'preference', source_count: 5, updated_at: 100 });
      insertGlobal(raw, 'pref-pinned', { kind: 'preference', pinned: 1, updated_at: 100 });
    } finally {
      raw.close();
    }
    const answer = await service.relayProfile();
    expect(answer.pinned.map((memory) => memory.id)).toEqual(['p-new', 'p-old', 'pref-pinned']);
    expect(answer.preferences.map((memory) => memory.id)).toEqual(['pref-pinned', 'pref-sourced', 'pref-recent', 'pref-old']);
  });

  it('bounds each standing list at MAX_STANDING_GLOBALS', async () => {
    const raw = new DatabaseSync(dbHolder.path);
    try {
      for (let n = 0; n <= MAX_STANDING_GLOBALS; n++) {
        insertGlobal(raw, `pin-${n}`, { pinned: 1, updated_at: 10_000 + n });
        insertGlobal(raw, `pref-${n}`, { kind: 'preference', updated_at: n });
      }
    } finally {
      raw.close();
    }
    const answer = await service.relayProfile();
    expect([answer.pinned.length, answer.preferences.length]).toEqual([MAX_STANDING_GLOBALS, MAX_STANDING_GLOBALS]);
  });

  it('answers a remote core\'s injection search with its injection gate over its own global rows, never the expanded search', async () => {
    const own = await service.saveMemory({ content: 'zorbex deploys run nightly', kind: 'fact', scope: 'global' });
    await service.saveMemory({ content: 'The user keeps a cat.', kind: 'fact', scope: 'global', tags: ['zorbex'] });
    await service.saveMemory({ content: 'zorbex builds live in this repository', kind: 'fact', scope: 'project', workspace: '/ws' });
    await service.addNote('zorbex notes');
    expansion.expandQuery.mockClear();
    const answer = await service.relaySearch('how do zorbex deploys run', 8, ['global'], true);
    expect(answer.map((memory) => [memory.id, memory.fullAllowed, memory.matchedTerms])).toEqual([[own!.id, true, expect.arrayContaining(['zorbex'])]]);
    expect(expansion.expandQuery).not.toHaveBeenCalled();
    expect(MAIN_TO_CORE.requests['user.memory.search'].result(answer)).not.toBe(INVALID);
  });

  it('renders a coverage match of general words compact for a remote core, as its own injection does', async () => {
    const raw = new DatabaseSync(dbHolder.path);
    try {
      for (let n = 0; n < 30; n++) insertGlobal(raw, `filler-${n}`, { updated_at: n });
      raw.prepare("UPDATE memories SET content = 'nightly deploys run after the backup window closes' WHERE id = 'filler-0'").run();
    } finally {
      raw.close();
    }
    const answer = await service.relaySearch('when do nightly deploys run after backup', 8, ['global'], true);
    expect(answer.find((memory) => memory.id === 'filler-0')?.fullAllowed).toBe(false);
  });

  it('answers within the user.memory tables\' bounds however many tags or how long a title its row holds', async () => {
    const raw = new DatabaseSync(dbHolder.path);
    try {
      insertGlobal(raw, 'tagged', { updated_at: 1 });
      const tags = [...Array.from({ length: MAX_GLOBAL_MEMORY_TAGS + 6 }, (_, n) => `tag-${n}`), 'tag-0'];
      raw.prepare('UPDATE memories SET tags = ?, title = ? WHERE id = ?').run(JSON.stringify(tags), 'x'.repeat(MAX_GLOBAL_MEMORY_LABEL_CHARS + 10), 'tagged');
    } finally {
      raw.close();
    }
    const answer = await service.relayResolve(['tagged']);
    expect(MAIN_TO_CORE.requests['user.memory.resolve'].result(answer)).not.toBe(INVALID);
    expect(CORE_TO_MAIN.requests['user.memory.resolve'].result(answer)).not.toBe(INVALID);
    const resolved = answer[0]!;
    if (!('memory' in resolved)) throw new Error('the row was expected to resolve');
    const { tags = [], title = '' } = resolved.memory;
    expect([tags.length, new Set(tags).size, title.length]).toEqual([MAX_GLOBAL_MEMORY_TAGS, MAX_GLOBAL_MEMORY_TAGS, MAX_GLOBAL_MEMORY_LABEL_CHARS]);
  });

  it('records the device a turn candidate came from', async () => {
    service.enqueueTurnCandidate({ sessionId: 's1', promptIndex: 0, userText: 'q', assistantText: 'a', files: [], workspace: '/ws', clientId: 'client-b' });
    await vi.waitFor(() => {
      const raw = new DatabaseSync(dbHolder.path);
      try {
        expect(raw.prepare('SELECT client_id FROM memory_candidates').all()).toEqual([{ client_id: 'client-b' }]);
      } finally {
        raw.close();
      }
    });
  });

  it('records the uuid in the transaction that applies the write', async () => {
    const raw = new DatabaseSync(dbHolder.path);
    raw.exec("CREATE TRIGGER fail_note BEFORE INSERT ON memories WHEN NEW.content = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    raw.close();
    await expect(service.applyRelayedWrites([{ uuid: 'uuid-boom', kind: 'note', content: 'boom' }])).rejects.toThrow('boom');
    const check = new DatabaseSync(dbHolder.path);
    try {
      expect(check.prepare("SELECT count(*) AS n FROM memory_applied_writes WHERE uuid = 'uuid-boom'").get()).toEqual({ n: 0 });
    } finally {
      check.close();
    }
  });
});

describe('what this computer\'s core answers a remote core', () => {
  let service: MemoryService;

  beforeEach(async () => {
    dbHolder.path = createTestDbPath();
    installPlatform(createFakePlatform());
    service = new MemoryService(createFakePlatform());
    await service.ensureInitialized();
  });

  afterEach(async () => {
    await service.dispose();
  });

  const raw = <T>(use: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(dbHolder.path);
    try {
      return use(db);
    } finally {
      db.close();
    }
  };
  const insert = (id: string, fields: { kind?: string; created_at?: number; forgotten?: number; forget_reason?: string | null } = {}): void => raw((db) => {
    db.prepare(`INSERT INTO memories (id, kind, scope, content, content_hash, created_at, updated_at, forgotten, forget_reason)
      VALUES (?, ?, 'global', ?, ?, ?, ?, ?, ?)`).run(id, fields.kind ?? 'fact', `memory ${id}`, `hash-${id}`, fields.created_at ?? 1, fields.created_at ?? 1, fields.forgotten ?? 0, fields.forget_reason ?? null);
  });

  it('answers an id the user forgot in the quality audit as forgotten by the user, as its own notices name it', async () => {
    insert('audited', { forgotten: 1, forget_reason: QUALITY_AUDIT_FORGET_REASON });
    insert('decayed', { forgotten: 1, forget_reason: 'episode_decay' });
    expect(await service.relayResolve(['audited', 'decayed'])).toEqual([{ id: 'audited', gone: true, byUser: true }, { id: 'decayed', gone: true, byUser: false }]);
  });

  it('answers a merged id with the row it was folded into, and none for a merge recorded without an edge', async () => {
    insert('primary');
    insert('merged', { forgotten: 1, forget_reason: 'merged' });
    insert('unlinked', { forgotten: 1, forget_reason: 'merged' });
    raw((db) => db.prepare("INSERT INTO memory_edges (id, kind, source_id, target_id, created_at) VALUES ('edge-1', 'SUPERSEDES', 'primary', 'merged', 1)").run());
    const answers = await service.relayResolve(['merged', 'unlinked']);
    expect(answers).toEqual([{ id: 'merged', memory: expect.objectContaining({ id: 'primary', content: 'memory primary' }) }]);
    expect(CORE_TO_MAIN.requests['user.memory.resolve'].result(answers)).not.toBe(INVALID);
  });

  it('soft-merges a relayed fact with a near-duplicate it already holds, as its own extraction does', async () => {
    const existing = await service.saveMemory({ content: 'The deploy pipeline runs every Friday at noon UTC', kind: 'fact', scope: 'global' });
    subcalls.run.mockImplementation(async (request: { purpose: string }) => (request.purpose === 'merge'
      ? { value: { content: 'The deploy pipeline runs every Friday at noon UTC.', merged_ids: [existing!.id] } }
      : { value: null, failure: 'no-model' as const }));
    expect(await service.applyRelayedWrites([{ uuid: 'uuid-near', kind: 'fact', content: 'The deploy pipeline runs every Friday at noon in UTC' }])).toEqual({ applied: 1, ids: ['uuid-near'] });
    expect(subcalls.run.mock.calls.map(([request]) => (request as { purpose: string }).purpose)).toContain('merge');
    expect(raw((db) => db.prepare('SELECT id, forgotten, forget_reason FROM memories ORDER BY id').all())).toEqual([
      { id: existing!.id, forgotten: 1, forget_reason: 'merged' },
      { id: 'uuid-near', forgotten: 0, forget_reason: null },
    ].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it('keeps the uuids it applied through a salvage, so a note sent again after it is skipped', async () => {
    const note: GlobalMemoryWrite = { uuid: 'uuid-note', kind: 'note', content: 'a relayed note' };
    await service.applyRelayedWrites([note]);
    await service.dispose();
    const salvaged = createTestDbPath();
    const { db } = openAndMigrate(salvaged);
    try {
      copyDurableRows(dbHolder.path, db);
    } finally {
      db.close();
    }
    dbHolder.path = salvaged;
    service = new MemoryService(createFakePlatform());
    await service.ensureInitialized();
    expect(await service.applyRelayedWrites([note])).toEqual({ applied: 1, ids: ['uuid-note'] });
    expect(raw((db) => db.prepare("SELECT count(*) AS n FROM memories WHERE scope = 'global'").get())).toEqual({ n: 1 });
  });

  it('applies a remote search\'s date filters and forgotten rows to its global rows, a query-less one answered by the filters alone', async () => {
    insert('early', { created_at: 1_000 });
    insert('middle', { created_at: 2_000 });
    insert('late', { created_at: 3_000 });
    insert('gone', { created_at: 2_500, forgotten: 1, forget_reason: 'user_forget' });
    const ids = (found: readonly { id: string }[]): string[] => found.map((memory) => memory.id).sort();
    expect(ids(await service.relaySearch('', 10, ['global'], false, { since: 1_500, until: 2_800 }))).toEqual(['middle']);
    expect(ids(await service.relaySearch('', 10, ['global'], false, { since: 1_500, until: 2_800, includeForgotten: true }))).toEqual(['gone', 'middle']);
    expect(ids(await service.relaySearch('', 10, ['global']))).toEqual(['early', 'late', 'middle']);
    expect(MAIN_TO_CORE.requests['user.memory.search'].params({ query: '', k: 10, tiers: ['global'], since: 1_500, until: 2_800, includeForgotten: true })).not.toBe(INVALID);
  });
});