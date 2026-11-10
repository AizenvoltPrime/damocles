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

vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: () => ({ run: vi.fn(async () => ({ value: null, failure: 'no-model' as const })) }),
  describeMemorySubCallModel: () => null,
}));

import { MemoryService } from '../index';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installPlatform } from '../../platform-host';
import { emptyLiveInjections, type LiveInjections } from '../injection/details';
import { globalMemoryId, parseGlobalMemoryId } from '../global-memory-relay';
import { createTestDbPath } from './test-helpers';
import { CLIENT_FEATURE_MISSING, CLIENT_MEMORY_OFF, CREDENTIAL_CLIENT_ABSENT, MAX_GLOBAL_MEMORY_LABEL_CHARS, MAX_GLOBAL_MEMORY_TAGS, type ListedGlobalMemory, type RelayedGlobalMemory } from '../../../shared/remote-user';
import { englishText, LocalizedError } from '../../../shared/localized-text';
import { globalMemoryClosedReason, globalMemoryListOutdatedReason, globalMemoryOffReason } from '../../user-scope';

const WORKSPACE = '/srv/app';
let service: MemoryService;
let fake: ReturnType<typeof createFakeRemoteHost>;
let outboxDir: string;

const globalOf = (id: string, content: string, contentHash = `hash-${id}`): RelayedGlobalMemory => ({ id, kind: 'fact', content, contentHash, createdAt: 1, updatedAt: 1 });

beforeEach(async () => {
  dbHolder.path = createTestDbPath();
  fake = createFakeRemoteHost();
  const platform = { ...createFakePlatform(), remote: fake.remote };
  installPlatform(platform);
  outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  service = new MemoryService({ ...platform, outboxDir });
  service.setWorkspaceRoots([WORKSPACE]);
  await service.ensureInitialized();
});

afterEach(async () => {
  await service.dispose();
  installPlatform(createFakePlatform());
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

const inject = (prompt: string, live: LiveInjections = emptyLiveInjections()) =>
  service.buildInjectionContext({ sessionId: null, workspace: WORKSPACE, activeFile: null, prompt, live, promptIndex: 1 });

describe('global memory ids', () => {
  it('name the client a global memory came from', () => {
    expect(parseGlobalMemoryId(globalMemoryId('client-a', 'abc'))).toEqual({ clientId: 'client-a', id: 'abc' });
    expect(parseGlobalMemoryId('abc')).toBeUndefined();
  });
});

describe('global memory in a daemon core\'s injection', () => {
  it('ranks the client\'s globals against this host\'s project memories by fused rank', async () => {
    await service.saveMemory({ content: 'kiwi deploys run through the staging pipeline', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    await service.saveMemory({ content: 'kiwi releases are tagged by hand', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    vi.mocked(fake.remote.memorySearch).mockResolvedValue([globalOf('g1', 'the user prefers kiwi deploys at night'), globalOf('g2', 'kiwi is the user\'s cat')]);
    const result = await inject('how do kiwi deploys work');
    expect(fake.remote.memorySearch).toHaveBeenCalledWith('client-a', 'how do kiwi deploys work', expect.any(Number), ['global'], true);
    const added = result!.display.added.map((memory) => memory.content);
    expect(added).toContain('the user prefers kiwi deploys at night');
    // reciprocal rank fusion interleaves the two lists by position: this host's first, the client's first, ...
    const order = added.filter((content) => content.includes('kiwi'));
    expect(order.indexOf('the user prefers kiwi deploys at night')).toBe(1);
    expect(result!.details!.memories.map((memory) => memory.id)).toContain(globalMemoryId('client-a', 'g1'));
  });

  it('renders a client\'s global full only where that client\'s gate allows it, with the terms it matched', async () => {
    vi.mocked(fake.remote.memorySearch).mockResolvedValue([
      { ...globalOf('g1', 'zorbex deploys run at night'), fullAllowed: true, matchedTerms: ['zorbex'] },
      { ...globalOf('g2', 'zorbex and the night shift'), fullAllowed: false, matchedTerms: ['night'] },
    ]);
    const result = await inject('when do zorbex deploys run');
    const tiers = new Map(result!.display.added.map((memory) => [memory.id, [memory.tier, memory.reasons]]));
    expect(tiers.get(globalMemoryId('client-a', 'g1'))).toEqual(['full', [{ kind: 'matched', terms: ['zorbex'] }]]);
    expect(tiers.get(globalMemoryId('client-a', 'g2'))).toEqual(['compact', [{ kind: 'matched', terms: ['night'] }]]);
  });

  it('keeps an injected global unchanged and announces nothing while no client is attached', async () => {
    fake.set('clientAuth', 'client-a', undefined);
    const live = emptyLiveInjections();
    live.memories.set(globalMemoryId('client-a', 'g1'), { hash: 'hash-g1', tier: 'full', promptIndex: 0 });
    const result = await inject('anything at all');
    const withLive = await inject('anything at all', live);
    expect(result?.text ?? '').toBe('');
    expect(withLive?.display.notices ?? []).toEqual([]);
    expect(fake.remote.memoryResolve).not.toHaveBeenCalled();
    expect(fake.remote.memorySearch).not.toHaveBeenCalled();
  });

  it('announces an injected global as forgotten only when its client says so', async () => {
    const live = emptyLiveInjections();
    const id = globalMemoryId('client-a', 'g1');
    live.memories.set(id, { hash: 'hash-g1', tier: 'full', promptIndex: 0 });
    vi.mocked(fake.remote.memoryResolve).mockResolvedValueOnce([{ id: 'g1', memory: globalOf('g1', 'still here') }]);
    expect((await inject('unrelated words', live))?.display.notices ?? []).toEqual([]);
    vi.mocked(fake.remote.memoryResolve).mockResolvedValueOnce([{ id: 'g1', gone: true, byUser: true }]);
    const result = await inject('unrelated words', live);
    expect(result!.display.notices).toEqual([expect.objectContaining({ kind: 'forgotten', id })]);
    expect(fake.remote.memoryResolve).toHaveBeenCalledWith('client-a', ['g1']);
  });

  it('shows an edited global with its new text', async () => {
    const live = emptyLiveInjections();
    live.memories.set(globalMemoryId('client-a', 'g1'), { hash: 'old-hash', tier: 'full', promptIndex: 0 });
    vi.mocked(fake.remote.memoryResolve).mockResolvedValueOnce([{ id: 'g1', memory: globalOf('g1', 'the edited text', 'new-hash') }]);
    const result = await inject('unrelated words', live);
    expect(result!.display.notices).toEqual([expect.objectContaining({ kind: 'edited' })]);
    expect(result!.text).toContain('the edited text');
  });

  it('includes the client\'s global profile', async () => {
    vi.mocked(fake.remote.memoryProfile).mockResolvedValue({ profile: { static: 'Works on embedded systems.', dynamic: '' }, pinned: [], preferences: [] });
    fake.set('clientAuth', 'client-a', undefined);
    fake.set('clientAuth', 'client-a', { providers: {} });
    await vi.waitFor(() => expect(service.getProfile('global', '')).toEqual({ static: 'Works on embedded systems.', dynamic: '' }));
    expect((await inject('anything'))!.text).toContain('Works on embedded systems.');
  });

  it('injects the client\'s pinned globals and global preferences once per context, whatever the prompt says, as a local chat does', async () => {
    const pinned = { ...globalOf('p1', 'Always answer in British English.'), kind: 'fact' as const };
    // newer than this host's project preference, which still ranks first
    const preference = { ...globalOf('pref1', 'The user wants commit messages in the imperative mood.'), kind: 'preference' as const, updatedAt: Date.now() + 60_000 };
    const project = await service.saveMemory({ content: 'This repository indents with tabs.', kind: 'preference', scope: 'project', workspace: WORKSPACE });
    vi.mocked(fake.remote.memoryProfile).mockResolvedValue({ profile: { static: '', dynamic: '' }, pinned: [pinned], preferences: [preference] });
    fake.set('clientAuth', 'client-a', undefined);
    fake.set('clientAuth', 'client-a', { providers: {} });
    let first: Awaited<ReturnType<typeof inject>> = null;
    await vi.waitFor(async () => {
      first = await inject('unrelated words entirely');
      expect(first!.text).toContain('Always answer in British English.');
    });
    expect(first!.text).toContain(`<memory id="${globalMemoryId('client-a', 'p1')}" kind="fact" scope="global" pinned="true">Always answer in British English.</memory>`);
    expect(first!.text).toContain('The user wants commit messages in the imperative mood.');
    expect(first!.display.added.map((memory) => [memory.id, memory.reasons[0]?.kind])).toEqual([
      [globalMemoryId('client-a', 'p1'), 'pinned'],
      [project!.id, 'preference'],
      [globalMemoryId('client-a', 'pref1'), 'preference'],
    ]);
    // once per context: a context that already holds them gets neither again
    const live = emptyLiveInjections();
    for (const memory of first!.details!.memories) live.memories.set(memory.id, { hash: memory.hash, tier: memory.tier, promptIndex: 1 });
    vi.mocked(fake.remote.memoryResolve).mockResolvedValue([{ id: 'p1', memory: pinned }, { id: 'pref1', memory: preference }]);
    expect((await inject('unrelated words entirely', live))?.text ?? '').toBe('');
  });

  it('counts a client-pinned global the context holds against the pinned budget, as a pinned row of this store', async () => {
    // each about 300 tokens of the default 500-token pinned budget
    const held = { ...globalOf('p1', `Held pinned rule. ${'alpha '.repeat(200)}`), kind: 'fact' as const };
    const fresh = { ...globalOf('p2', `Fresh pinned rule. ${'beta '.repeat(240)}`), kind: 'fact' as const };
    vi.mocked(fake.remote.memoryProfile).mockResolvedValue({ profile: { static: '', dynamic: '' }, pinned: [held, fresh], preferences: [] });
    vi.mocked(fake.remote.memoryResolve).mockResolvedValue([{ id: 'p1', memory: held }]);
    fake.set('clientAuth', 'client-a', undefined);
    fake.set('clientAuth', 'client-a', { providers: {} });
    await vi.waitFor(async () => expect((await inject('unrelated words entirely'))!.text).toContain('Held pinned rule.'));
    const live = emptyLiveInjections();
    live.memories.set(globalMemoryId('client-a', 'p1'), { hash: held.contentHash, tier: 'full', promptIndex: 0 });
    const result = await inject('unrelated words entirely', live);
    expect(result?.text ?? '').not.toContain('Fresh pinned rule.');
    expect(result?.display.gate.overBudget).toBe(1);
  });
});

describe('a daemon\'s core starting with clients attached', () => {
  it('reads the profile and drains the outbox of every attached client, not only the acting one', async () => {
    fake.set('clientAuth', 'client-b', { providers: {} });
    vi.mocked(fake.remote.memoryProfile).mockClear();
    const platform = { ...createFakePlatform(), remote: fake.remote };
    const restarted = new MemoryService({ ...platform, outboxDir });
    try {
      await vi.waitFor(() => expect(vi.mocked(fake.remote.memoryProfile).mock.calls.map(([clientId]) => clientId).sort()).toEqual(['client-a', 'client-b']));
    } finally {
      await restarted.dispose();
    }
  });
});

describe('global memory search on a daemon\'s core', () => {
  it('fuses the client\'s ranked results with this host\'s by rank', async () => {
    await service.saveMemory({ content: 'mango build cache lives in /tmp', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    await service.saveMemory({ content: 'mango deploys run nightly', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    vi.mocked(fake.remote.memorySearch).mockResolvedValue([globalOf('g1', 'mango is the user\'s editor theme')]);
    const results = await service.searchMemories({ query: 'mango', workspace: WORKSPACE });
    // each list's first result outranks either list's second
    expect(results.map((result) => [result.tier, result.rank])).toEqual([['project', 1], ['global', 2], ['project', 3]]);
    expect(results[1]!.id).toBe(globalMemoryId('client-a', 'g1'));
  });

  it('answers a mixed search with this host\'s rows when the client leaves during it, and a global-only one with the reason', async () => {
    await service.saveMemory({ content: 'mango deploys run nightly', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    vi.mocked(fake.remote.memorySearch).mockRejectedValue(new Error(CREDENTIAL_CLIENT_ABSENT));
    const mixed = await service.searchMemories({ query: 'mango', workspace: WORKSPACE });
    expect(mixed.map((result) => result.tier)).toEqual(['project']);
    await expect(service.searchMemories({ query: 'mango', workspace: WORKSPACE, tiers: ['global'] })).rejects.toThrow(englishText(globalMemoryClosedReason()));
  });

  it('answers a mixed search with this host\'s rows while memory is off on the client, and a global-only one with the memory-off reason', async () => {
    await service.saveMemory({ content: 'mango deploys run nightly', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    vi.mocked(fake.remote.memorySearch).mockRejectedValue(new Error(CLIENT_MEMORY_OFF));
    const mixed = await service.searchMemories({ query: 'mango', workspace: WORKSPACE });
    expect(mixed.map((result) => result.tier)).toEqual(['project']);
    await expect(service.searchMemories({ query: 'mango', workspace: WORKSPACE, tiers: ['note'] })).rejects.toThrow(englishText(globalMemoryOffReason()));
  });

  it('names a saved global by the client\'s row that holds it, an earlier duplicate there included', async () => {
    vi.mocked(fake.remote.memoryApply).mockResolvedValueOnce({ through: 0, ids: ['existing-row'] });
    const saved = await service.saveMemory({ content: 'The user is on call on Fridays.', kind: 'fact', scope: 'global' });
    expect(saved!.id).toBe(globalMemoryId('client-a', 'existing-row'));
  });

  it('reads a global memory\'s details from its client', async () => {
    vi.mocked(fake.remote.memoryResolve).mockResolvedValue([{ id: 'g1', memory: globalOf('g1', 'from the client') }]);
    const details = await service.getMemoryDetails([globalMemoryId('client-a', 'g1')]);
    expect(details.map((entry) => [entry.id, entry.content])).toEqual([[globalMemoryId('client-a', 'g1'), 'from the client']]);
  });
});

describe('a client\'s global memory in a prompt\'s injection, failing or slow', () => {
  it('injects this host\'s memories when the client\'s search and resolve fail, treating the client as away', async () => {
    await service.saveMemory({ content: 'kiwi deploys run through the staging pipeline', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    vi.mocked(fake.remote.memorySearch).mockRejectedValue(new Error('The global memory search answered a row of a tier it was not asked for'));
    vi.mocked(fake.remote.memoryResolve).mockRejectedValue(new Error('the client core failed'));
    const live = emptyLiveInjections();
    live.memories.set(globalMemoryId('client-a', 'g1'), { hash: 'hash-g1', tier: 'full', promptIndex: 0 });
    const result = await inject('how do kiwi deploys work', live);
    expect(result!.text).toContain('kiwi deploys run through the staging pipeline');
    expect(result!.display.notices).toEqual([]);
  });

  it('stops waiting on the client at a Stop of the run, treating it as away', async () => {
    await service.saveMemory({ content: 'kiwi releases are tagged by hand', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(fake.remote.memorySearch).mockImplementation(() => new Promise(() => undefined));
      const stop = new AbortController();
      const pending = service.buildInjectionContext({
        sessionId: null, workspace: WORKSPACE, activeFile: null, prompt: 'how are kiwi releases tagged', live: emptyLiveInjections(), promptIndex: 1, abortSignal: stop.signal,
      });
      for (const start = Date.now(); vi.mocked(fake.remote.memorySearch).mock.calls.length === 0;) {
        if (Date.now() - start > 5_000) throw new Error('the client was never asked');
        await new Promise((resolve) => setImmediate(resolve));
      }
      stop.abort();
      const result = await pending;
      expect(result!.text).toContain('kiwi releases are tagged by hand');
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks the client to resolve and to search at once, and waits for neither past the 2 s client-ask cap', async () => {
    await service.saveMemory({ content: 'kiwi releases are tagged by hand', kind: 'fact', scope: 'project', workspace: WORKSPACE });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(fake.remote.memorySearch).mockImplementation(() => new Promise(() => undefined));
      vi.mocked(fake.remote.memoryResolve).mockImplementation(() => new Promise(() => undefined));
      const live = emptyLiveInjections();
      live.memories.set(globalMemoryId('client-a', 'g1'), { hash: 'hash-g1', tier: 'full', promptIndex: 0 });
      let settled = false;
      const pending = inject('how are kiwi releases tagged', live).then((result) => {
        settled = true;
        return result;
      });
      // turns of real work only, so the fake clock stays where it is
      for (const start = Date.now(); !(vi.mocked(fake.remote.memoryResolve).mock.calls.length === 1 && vi.mocked(fake.remote.memorySearch).mock.calls.length === 1);) {
        if (Date.now() - start > 5_000) throw new Error('the client was never asked');
        await new Promise((resolve) => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result!.text).toContain('kiwi releases are tagged by hand');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the client\'s order among its global preferences, whatever their age or evidence here', async () => {
    const preference = (id: string, content: string, updatedAt: number) => ({ ...globalOf(id, content), kind: 'preference' as const, updatedAt });
    const now = Date.now();
    // the client ranks a well-evidenced older preference first
    vi.mocked(fake.remote.memoryProfile).mockResolvedValue({ profile: { static: '', dynamic: '' }, pinned: [], preferences: [preference('first', 'The user wants answers in British English.', now - 86_400_000), preference('second', 'The user wants short commit subjects.', now)] });
    fake.set('clientAuth', 'client-a', undefined);
    fake.set('clientAuth', 'client-a', { providers: {} });
    let result: Awaited<ReturnType<typeof inject>> = null;
    await vi.waitFor(async () => {
      result = await inject('unrelated words entirely');
      expect(result!.text).toContain('British English');
    });
    expect(result!.display.added.map((memory) => memory.id)).toEqual([globalMemoryId('client-a', 'first'), globalMemoryId('client-a', 'second')]);
  });
});

describe('a daemon core\'s search filters on its client\'s global rows', () => {
  it('forwards since, until and forgotten rows, and answers a query-less global search by the filters alone', async () => {
    vi.mocked(fake.remote.memorySearch).mockResolvedValue([globalOf('g1', 'from the client')]);
    const results = await service.searchMemories({ tiers: ['global'], since: 1_000, until: 2_000, includeForgotten: true });
    expect(fake.remote.memorySearch).toHaveBeenCalledWith('client-a', '', 20, ['global'], false, { since: 1_000, until: 2_000, includeForgotten: true });
    expect(results.map((result) => result.id)).toEqual([globalMemoryId('client-a', 'g1')]);
  });
});
describe("a daemon core's notes list on its client", () => {
  const noteOf = (id: string, createdAt: number): ListedGlobalMemory => ({ id, kind: 'note', content: `note ${id}`, contentHash: `hash-${id}`, createdAt, updatedAt: createdAt });

  it('pages through the acting client with each next as the cursor, ids qualified', async () => {
    vi.mocked(fake.remote.memoryList)
      .mockResolvedValueOnce({ rows: [noteOf('b', 5), noteOf('a', 5)], next: { createdAt: 5, id: 'a' } })
      .mockResolvedValueOnce({ rows: [noteOf('c', 3)] });
    expect((await service.listNotes(['work', 'work'])).map((note) => note.id)).toEqual(['global:client-a:b', 'global:client-a:a', 'global:client-a:c']);
    expect(vi.mocked(fake.remote.memoryList).mock.calls).toEqual([
      ['client-a', { kinds: ['note'], tags: ['work'] }],
      ['client-a', { kinds: ['note'], tags: ['work'], cursor: { createdAt: 5, id: 'a' } }],
    ]);
  });

  it('stops at a next that does not advance past the cursor, never asking for the same page again', async () => {
    vi.mocked(fake.remote.memoryList)
      .mockResolvedValueOnce({ rows: [noteOf('b', 5)], next: { createdAt: 5, id: 'b' } })
      .mockResolvedValueOnce({ rows: [noteOf('b', 5)], next: { createdAt: 5, id: 'b' } });
    await expect(service.listNotes()).rejects.toThrow('does not advance');
    expect(fake.remote.memoryList).toHaveBeenCalledTimes(2);
  });

  it('answers the closed reason with no client attached, and when the client leaves part way', async () => {
    fake.set('clientAuth', 'client-a', undefined);
    await expect(service.listNotes()).rejects.toThrow(englishText(globalMemoryClosedReason()));
    expect(fake.remote.memoryList).not.toHaveBeenCalled();
    fake.set('clientAuth', 'client-a', { providers: {} });
    vi.mocked(fake.remote.memoryList)
      .mockResolvedValueOnce({ rows: [noteOf('b', 5)], next: { createdAt: 5, id: 'b' } })
      .mockRejectedValueOnce(new Error(CREDENTIAL_CLIENT_ABSENT));
    await expect(service.listNotes()).rejects.toThrow(englishText(globalMemoryClosedReason()));
  });

  it("answers the outdated reason when the client's attach did not list user.memory.list", async () => {
    vi.mocked(fake.remote.memoryList).mockRejectedValueOnce(new Error(CLIENT_FEATURE_MISSING));
    await expect(service.listNotes()).rejects.toThrow(englishText(globalMemoryListOutdatedReason()));
  });

  it('answers the memory-off reason, never an empty list, while memory is off on the client', async () => {
    vi.mocked(fake.remote.memoryList).mockRejectedValueOnce(new Error(CLIENT_MEMORY_OFF));
    const listed = service.listNotes();
    await expect(listed).rejects.toBeInstanceOf(LocalizedError);
    await expect(listed).rejects.toThrow(englishText(globalMemoryOffReason()));
  });

  it('refuses a tag list the wire cannot carry before asking the client', async () => {
    await expect(service.listNotes(Array.from({ length: MAX_GLOBAL_MEMORY_TAGS + 1 }, (_, index) => `tag-${index}`))).rejects.toThrow('at most');
    await expect(service.listNotes(['x'.repeat(MAX_GLOBAL_MEMORY_LABEL_CHARS + 1)])).rejects.toThrow('at most');
    expect(fake.remote.memoryList).not.toHaveBeenCalled();
  });
});
