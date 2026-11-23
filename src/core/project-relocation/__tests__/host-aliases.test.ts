import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { currentHostPathOf, foldAliases } from '../aliases';
import { RelocationStore } from '../store';

let dir: string;
let file: string;
let store: RelocationStore;

const open = (): RelocationStore => new RelocationStore({ file, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
const written = (): { hostAliases: unknown[]; relocations: unknown[] } => JSON.parse(fs.readFileSync(file, 'utf8')) as { hostAliases: unknown[]; relocations: unknown[] };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-aliases-'));
  file = path.join(dir, 'project-relocations.json');
  store = open();
});

afterEach(() => {
  store.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('host aliases in the relocation journal', () => {
  it('appends each move with the next seq, once however often the host part repeats it', async () => {
    await store.addHostAlias({ hostId: 'prod-1', from: '/home/dev/app', to: '/home/dev/app2' });
    await store.addHostAlias({ hostId: 'prod-1', from: '/home/dev/app', to: '/home/dev/app2' });
    await store.addHostAlias({ hostId: 'staging', from: 'C:\\work\\app', to: 'C:\\work\\renamed' });
    expect(written().hostAliases).toEqual([
      { hostId: 'prod-1', from: '/home/dev/app', to: '/home/dev/app2', seq: 1 },
      { hostId: 'staging', from: 'C:\\work\\app', to: 'C:\\work\\renamed', seq: 2 },
    ]);
    expect(store.hostAliases()).toHaveLength(2);
  });

  it('holds a host id that starts or ends with - or _, as the host store draws them in base64url', async () => {
    for (const hostId of ['gzb_kmN38m8-', '_Tq3xY0aBcDe', '-Tq3xY0aBcDe']) await store.addHostAlias({ hostId, from: '/home/dev/acme', to: '/home/dev/acme-moved' });
    store.dispose();
    store = open();
    expect(store.hostAliases().map((alias) => alias.hostId)).toEqual(['gzb_kmN38m8-', '_Tq3xY0aBcDe', '-Tq3xY0aBcDe']);
  });

  it('appends a move again after the folder moved back, and skips a repeat once a later move took the folder on', async () => {
    await store.addHostAlias({ hostId: 'h', from: '/a', to: '/b' });
    await store.addHostAlias({ hostId: 'h', from: '/b', to: '/c' });
    // a late repeat of the first move's host part
    await store.addHostAlias({ hostId: 'h', from: '/a', to: '/b' });
    expect(store.hostAliases().map((alias) => alias.seq)).toEqual([1, 2]);
    expect(currentHostPathOf(foldAliases([], store.hostAliases()), 'h', '/a')).toBe('/c');
    await store.addHostAlias({ hostId: 'h', from: '/c', to: '/a' });
    await store.addHostAlias({ hostId: 'h', from: '/a', to: '/b' });
    expect(store.hostAliases().map((alias) => alias.seq)).toEqual([1, 2, 3, 4]);
    expect(currentHostPathOf(foldAliases([], store.hostAliases()), 'h', '/a')).toBe('/b');
  });

  it('writes an entry this version cannot read back unchanged, beside the relocations', async () => {
    const foreign = { hostId: 'h', from: '/a', to: '/b', seq: 1, via: 'a later version' };
    const unreadable = { hostId: '../escape', from: '/a', to: '/b', seq: 2 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, relocations: [], hostAliases: [foreign, unreadable] }));
    store.reload();
    expect(store.hostAliases()).toEqual([{ hostId: 'h', from: '/a', to: '/b', seq: 1 }]);
    await store.addHostAlias({ hostId: 'h', from: '/x', to: '/y' });
    expect(written()).toEqual({ version: 1, id: expect.any(String), relocations: [], hostAliases: [foreign, unreadable, { hostId: 'h', from: '/x', to: '/y', seq: 2 }] });
  });

  it('keeps the host aliases through a relocation record write', async () => {
    await store.addHostAlias({ hostId: 'h', from: '/a', to: '/b' });
    await store.add((seq) => ({ id: 'r1', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: path.join(dir, 'old'), to: path.join(dir, 'new') }], chats: 0, state: 'coreDone', steps: { checkpoints: { state: 'done' }, sessions: { state: 'done' }, worktrees: { state: 'done' }, repair: { state: 'done' }, memory: { state: 'done' }, compass: { state: 'done' }, hostState: { state: 'done' } }, startedAt: 1, finishedAt: 2 }));
    expect(written().hostAliases).toEqual([{ hostId: 'h', from: '/a', to: '/b', seq: 1 }]);
    expect(written().relocations).toHaveLength(1);
  });

  it('refuses a host id that is no single path segment, and a journal that does not parse', async () => {
    await expect(store.addHostAlias({ hostId: '../x', from: '/a', to: '/b' })).rejects.toThrow('host id');
    fs.writeFileSync(file, '{ not json');
    store.reload();
    await expect(store.addHostAlias({ hostId: 'h', from: '/a', to: '/b' })).rejects.toThrow('not valid JSON');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('folds each host apart, comparing its paths exactly as the host wrote them', () => {
    const aliases = foldAliases([], [
      { hostId: 'h1', from: '/srv/App', to: '/srv/app2', seq: 1 },
      { hostId: 'h2', from: '/srv/App', to: '/srv/other', seq: 2 },
    ]);
    expect(currentHostPathOf(aliases, 'h1', '/srv/App')).toBe('/srv/app2');
    expect(currentHostPathOf(aliases, 'h2', '/srv/App')).toBe('/srv/other');
    expect(currentHostPathOf(aliases, 'h1', '/srv/app')).toBe('/srv/app');
    expect(aliases.moves).toEqual([]);
  });

  it('records the host relocation\'s start, skips a repeat of the same relocation, and maps a reused folder by time', async () => {
    await store.addHostAlias({ hostId: 'h', from: '/a', to: '/b', startedAt: 100 });
    await store.addHostAlias({ hostId: 'h', from: '/a', to: '/b', startedAt: 100 });
    await store.addHostAlias({ hostId: 'h', from: '/c', to: '/a', startedAt: 200 });
    expect(written().hostAliases).toEqual([
      { hostId: 'h', from: '/a', to: '/b', seq: 1, startedAt: 100 },
      { hostId: 'h', from: '/c', to: '/a', seq: 2, startedAt: 200 },
    ]);
    const aliases = foldAliases([], store.hostAliases());
    expect(currentHostPathOf(aliases, 'h', '/a', 50)).toBe('/b');
    expect(currentHostPathOf(aliases, 'h', '/c', 50)).toBe('/a');
    expect(currentHostPathOf(aliases, 'h', '/a', 300)).toBe('/a');
  });
});
