import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { CheckpointService, clampSetting, type CheckpointHost, type CheckpointProducer, type CheckpointTreeReader } from '../checkpoint-service';
import { setCheckpointGitAvailability, type CheckpointEntry, type CheckpointRecord, type NotRewindableParams, type PreRewindRecord, type RestoreResult, type StoredCheckpointRecord } from '../checkpoints';
import { DAMOCLES_CHECKPOINT_ENTRY } from '../session-store/constants';

beforeAll(() => setCheckpointGitAvailability({ available: true }));

function userEntry(id: string, text = 'p'): SessionEntry {
  return { type: 'message', id, parentId: null, timestamp: '', message: { role: 'user', content: [{ type: 'text', text }] } } as unknown as SessionEntry;
}

function checkpointEntry(userEntryId: string): SessionEntry {
  return {
    type: 'custom',
    id: `cp-${userEntryId}`,
    parentId: null,
    timestamp: '',
    customType: DAMOCLES_CHECKPOINT_ENTRY,
    data: {
      v: 2, kind: 'checkpoint', turnId: 't', userEntryId, beforeCommit: 'aaa', afterCommit: 'bbb',
      prompt: 'p', fileCount: 0, fileChanges: [], createdAt: '2026-01-01T00:00:00.000Z',
    },
  } as unknown as SessionEntry;
}

function treeReader(entries: SessionEntry[]): CheckpointTreeReader {
  return {
    getBranch: () => entries,
    getLeafId: () => entries[entries.length - 1]?.id ?? null,
    getSessionFile: () => '/sessions/x.jsonl',
    getEntries: () => entries,
  };
}

function entryFor(userEntryId: string): CheckpointEntry {
  return {
    v: 3, kind: 'checkpoint', repo: 'folder', folderId: 'f', turnId: 't', userEntryId, beforeCommit: 'a', afterCommit: 'b',
    prompt: 'p', fileCount: 0, fileChanges: [], createdAt: '', skipped: NOTHING_SKIPPED,
  } as CheckpointEntry;
}

const NOTHING_SKIPPED = { totalCount: 0, totalBytes: 0, byReason: {}, patterns: [], manifest: null };

function preRewind(id: string): PreRewindRecord {
  return {
    v: 3, kind: 'pre-rewind', id, folderId: '0123456789abcdef', commit: 'c'.repeat(40), skipped: NOTHING_SKIPPED,
    target: { kind: 'turn', userEntryId: 'u1' }, createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A producer whose baselines resolve only when the test releases them, recording every call in order. */
function fakeProducer() {
  const calls: string[] = [];
  const releases = new Map<string, () => void>();
  const marked = new Map<string, NotRewindableParams>();
  let pending: string | null = null;
  const producer: CheckpointProducer = {
    turnStart: vi.fn(async ({ userEntryId }: { userEntryId: string; prompt: string }) => {
      calls.push(`turnStart:${userEntryId}`);
      pending = userEntryId;
      await new Promise<void>((resolve) => releases.set(userEntryId, resolve));
      return { ok: true as const, entries: [] };
    }),
    markNotRewindable: vi.fn((userEntryId: string, reason: string, params: NotRewindableParams) => {
      calls.push(`mark:${userEntryId}:${reason}`);
      marked.set(userEntryId, params);
      return true;
    }),
    finalizeRun: vi.fn(async () => {
      const id = pending;
      pending = null;
      if (!id) return { ok: false as const };
      calls.push(`finalize:${id}`);
      const record: CheckpointRecord = marked.has(id)
        ? { v: 3, kind: 'not-rewindable', userEntryId: id, reason: 'baseline-timeout', params: marked.get(id)!, createdAt: '' }
        : entryFor(id);
      return { ok: true as const, record };
    }),
    snapshot: vi.fn(async (id: string) => {
      calls.push(`snapshot:${id}`);
      return { ok: true as const, entry: entryFor(id) as never };
    }),
    restore: vi.fn(async (entry: CheckpointEntry): Promise<RestoreResult> => {
      calls.push(`restore:${entry.userEntryId}`);
      return { ok: true, preRewind: preRewind(`rw-${entry.userEntryId}`) };
    }),
    restorePreRewind: vi.fn(async (record: PreRewindRecord): Promise<RestoreResult> => {
      calls.push(`undo:${record.id}`);
      return { ok: true, preRewind: preRewind(`rw-undo-${record.id}`) };
    }),
    dispose: vi.fn(() => {
      calls.push('dispose');
      return pending;
    }),
  } as unknown as CheckpointProducer;
  return { producer, calls, release: (id: string) => releases.get(id)?.(), released: (id: string) => releases.has(id) };
}

function makeService(overrides: Partial<CheckpointHost> = {}) {
  const fake = fakeProducer();
  const ready: string[] = [];
  const persisted: StoredCheckpointRecord[] = [];
  const notices: number[] = [];
  const host: CheckpointHost = {
    cwd: '/cwd',
    sessionId: 'S',
    onCheckpointReady: (id) => ready.push(id),
    persist: (record) => { persisted.push(record); return true; },
    onBaselineTimeout: (ms) => notices.push(ms),
    baselineWaitMs: () => 40,
    maxFileSizeBytes: () => 25 * 1024 * 1024,
    createProducer: () => fake.producer,
    ...overrides,
  };
  return { service: new CheckpointService(host), fake, ready, persisted, notices };
}

const never = new AbortController().signal;

/** 'settled' when `promise` settles within `ms`, else 'pending'. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<'settled' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); }),
  ]);
  clearTimeout(timer);
  return outcome;
}

describe('CheckpointService.hydrate', () => {
  it('surfaces persisted checkpoint user entry ids to the host (resume rehydration)', () => {
    const { service, ready } = makeService();
    service.hydrate(treeReader([userEntry('u1'), checkpointEntry('u1'), userEntry('u2'), checkpointEntry('u2')]));
    expect(ready).toEqual(['u1', 'u2']);
  });
});

describe('CheckpointService off the stream path', () => {
  it('starts a baseline and returns before any git work finishes', async () => {
    const { service, fake } = makeService();
    const sm = treeReader([userEntry('u1')]);
    expect(service.onMessageStart({ role: 'assistant' }, sm)).toBeUndefined();
    service.onSettled();
    service.onSessionCompact('c1', sm);
    await vi.waitFor(() => expect(fake.calls).toEqual(['turnStart:u1']));
    // The baseline is still running; finalize and the compaction snapshot queue behind it.
    fake.release('u1');
    await vi.waitFor(() => expect(fake.calls).toEqual(['turnStart:u1', 'finalize:u1', 'snapshot:c1']));
  });

  it('ignores non-assistant messages', async () => {
    const { service, fake } = makeService();
    service.onMessageStart({ role: 'user' }, treeReader([userEntry('u1')]));
    service.onMessageStart({ role: 'toolResult' }, treeReader([userEntry('u1')]));
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.calls).toEqual([]);
  });

  it('starts one baseline per turn however many assistant messages it has', async () => {
    const { service, fake } = makeService();
    const sm = treeReader([userEntry('u1')]);
    service.startTurn(sm, 'u1', 'p');
    service.onMessageStart({ role: 'assistant' }, sm);
    service.onMessageStart({ role: 'assistant' }, sm);
    await vi.waitFor(() => expect(fake.calls).toEqual(['turnStart:u1']));
    fake.release('u1');
  });

  it('starts nothing for a run keyed on a finalized or recorded turn, and its waiters return at once', async () => {
    const { service, fake, persisted } = makeService({ baselineWaitMs: () => 60_000 });
    const sm = treeReader([userEntry('u0'), checkpointEntry('u0'), userEntry('u1')]);
    service.hydrate(sm);
    service.startTurn(sm, 'u1', 'p');
    service.onSettled();
    await vi.waitFor(() => expect(fake.released('u1')).toBe(true));
    fake.release('u1');
    await vi.waitFor(() => expect(persisted.map((r) => (r as CheckpointRecord).userEntryId)).toEqual(['u1']));

    // A run opened without a new user entry is keyed on u1 again; u0 already had a record on resume.
    service.onMessageStart({ role: 'assistant' }, sm);
    service.startTurn(sm, 'u0', 'p');
    expect(await settlesWithin(service.awaitBaseline(never, 'Edit'), 2_000)).toBe('settled');
    service.onSettled();
    await service.drain(2_000);
    expect(fake.calls).toEqual(['turnStart:u1', 'finalize:u1']);
  });

  it('persists the finalized record and marks the turn rewindable', async () => {
    const { service, fake, persisted, ready } = makeService();
    service.startTurn(treeReader([userEntry('u1')]), 'u1', 'p');
    service.onSettled();
    await vi.waitFor(() => expect(fake.released('u1')).toBe(true));
    fake.release('u1');
    await vi.waitFor(() => expect(persisted.map((r) => (r as CheckpointRecord).userEntryId)).toEqual(['u1']));
    expect(ready).toEqual(['u1']);
  });

  it('does not mark a turn rewindable when the session refused its record', async () => {
    const { service, fake, ready } = makeService({ persist: () => false });
    service.startTurn(treeReader([userEntry('u1')]), 'u1', 'p');
    service.onSettled();
    await vi.waitFor(() => expect(fake.released('u1')).toBe(true));
    fake.release('u1');
    await vi.waitFor(() => expect(fake.calls).toContain('finalize:u1'));
    await new Promise((r) => setTimeout(r, 5));
    expect(ready).toEqual([]);
  });
});

describe('CheckpointService.awaitBaseline', () => {
  it('resolves at once with no turn in progress', async () => {
    const { service } = makeService();
    await expect(service.awaitBaseline(never, 'Edit')).resolves.toBeUndefined();
  });

  it('resolves when the turn baseline lands', async () => {
    const { service, fake, notices } = makeService({ baselineWaitMs: () => 60_000 });
    service.startTurn(treeReader([userEntry('u1')]), 'u1', 'p');
    let done = false;
    const wait = service.awaitBaseline(never, 'Edit').then(() => { done = true; });
    await vi.waitFor(() => expect(fake.calls).toEqual(['turnStart:u1']));
    expect(done).toBe(false);
    fake.release('u1');
    await wait;
    expect(notices).toEqual([]);
  });

  it('proceeds past the limit, marks the turn not rewindable once, notices once, and never waits again that turn', async () => {
    let waitMs = 40;
    const { service, fake, notices, persisted, ready } = makeService({ baselineWaitMs: () => waitMs });
    const sm = treeReader([userEntry('u1')]);
    service.startTurn(sm, 'u1', 'p');
    await vi.waitFor(() => expect(fake.calls).toEqual(['turnStart:u1']));

    const started = Date.now();
    // Two parallel file-changing calls time out together: one mark, one notice.
    await Promise.all([service.awaitBaseline(never, 'Edit'), service.awaitBaseline(never, 'Write')]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(fake.calls).toEqual(['turnStart:u1', 'mark:u1:baseline-timeout']);
    expect(notices).toEqual([40]);

    // A later sub-turn of the same turn returns at once and starts no second, mid-turn baseline. The
    // baseline is still held and the limit is a minute away, so only the timed-out turn can release it.
    waitMs = 60_000;
    expect(await settlesWithin(service.awaitBaseline(never, 'Bash'), 2_000)).toBe('settled');
    service.onMessageStart({ role: 'assistant' }, sm);
    expect(notices).toEqual([40]);

    // The late baseline completes in the background and the turn finalizes as not rewindable.
    service.onSettled();
    fake.release('u1');
    await vi.waitFor(() => expect(persisted).toHaveLength(1));
    expect(persisted[0]).toMatchObject({ kind: 'not-rewindable', userEntryId: 'u1', reason: 'baseline-timeout' });
    expect((persisted[0] as { params: NotRewindableParams }).params).toEqual({ tool: 'Edit', waitSeconds: 0 });
    expect(ready).toEqual([]);
    expect(fake.calls.filter((c) => c.startsWith('turnStart'))).toEqual(['turnStart:u1']);
  });

  it('marks a turn whose baseline had not reached the producer when the wait ran out', async () => {
    const { service, fake, notices } = makeService();
    const sm = treeReader([userEntry('u1'), userEntry('u2')]);
    // u2's baseline queues behind u1's finalize, which waits on u1's still-running baseline.
    service.startTurn(sm, 'u1', 'p');
    service.onSettled();
    service.startTurn(sm, 'u2', 'p');
    await service.awaitBaseline(never, 'Edit');
    expect(fake.calls).toEqual(['turnStart:u1']);
    expect(notices).toEqual([40]);
    fake.release('u1');
    await vi.waitFor(() => expect(fake.calls).toEqual(['turnStart:u1', 'finalize:u1', 'turnStart:u2', 'mark:u2:baseline-timeout']));
    fake.release('u2');
  });

  it('releases the waiter the moment the turn aborts, with no mark and no notice', async () => {
    const { service, fake, notices } = makeService({ baselineWaitMs: () => 60_000 });
    service.startTurn(treeReader([userEntry('u1')]), 'u1', 'p');
    const abort = new AbortController();
    const wait = service.awaitBaseline(abort.signal, 'Edit');
    await vi.waitFor(() => expect(fake.calls).toEqual(['turnStart:u1']));
    // The baseline is held and the limit is a minute away, so only the abort can release the waiter.
    expect(await settlesWithin(wait, 20)).toBe('pending');
    abort.abort();
    expect(await settlesWithin(wait, 2_000)).toBe('settled');
    expect(notices).toEqual([]);
    expect(fake.calls).toEqual(['turnStart:u1']);
    fake.release('u1');
  });

  it('releases the waiter on dispose, which stops the producer first and drops late records', async () => {
    const { service, fake, persisted } = makeService({ baselineWaitMs: () => 60_000 });
    service.startTurn(treeReader([userEntry('u1')]), 'u1', 'p');
    const wait = service.awaitBaseline(never, 'Edit');
    await vi.waitFor(() => expect(fake.calls).toEqual(['turnStart:u1']));
    service.onSettled();
    service.dispose();
    await wait;
    expect(fake.calls).toEqual(['turnStart:u1', 'dispose']);
    fake.release('u1');
    await new Promise((r) => setTimeout(r, 5));
    expect(persisted).toEqual([]);
    expect(fake.calls).not.toContain('finalize:u1');
  });
});

describe('clampSetting', () => {
  it('holds a value to its declared range and reads a non-number as the default', () => {
    expect(clampSetting(1, 5, 600, 30)).toBe(5);
    expect(clampSetting(9000, 5, 600, 30)).toBe(600);
    expect(clampSetting(45, 5, 600, 30)).toBe(45);
    expect(clampSetting('fast', 5, 600, 30)).toBe(30);
    expect(clampSetting(Number.NaN, 1, 2048, 25)).toBe(25);
  });
});

describe('CheckpointService.drain', () => {
  it('waits for queued work, and gives up at its bound so a long baseline cannot hold a switch or close', async () => {
    const { service, fake, persisted } = makeService();
    service.startTurn(treeReader([userEntry('u1')]), 'u1', 'p');
    service.onSettled();
    await vi.waitFor(() => expect(fake.released('u1')).toBe(true));

    const bounded = Date.now();
    await service.drain(40);
    expect(Date.now() - bounded).toBeGreaterThanOrEqual(35);
    expect(persisted).toEqual([]);

    const drained = service.drain(60_000);
    fake.release('u1');
    await drained;
    expect(persisted.map((r) => (r as CheckpointRecord).userEntryId)).toEqual(['u1']);
  });
});

describe('CheckpointService restore and undo', () => {
  it('restores after the queued work, then persists the pre-rewind record through the session', async () => {
    const { service, fake, persisted } = makeService();
    const sm = treeReader([userEntry('u1')]);
    service.startTurn(sm, 'u1', 'p');
    const restored = service.restore(entryFor('u1'), sm, never);
    await vi.waitFor(() => expect(fake.calls).toEqual(['turnStart:u1']));
    fake.release('u1');
    expect(await restored).toMatchObject({ ok: true, preRewind: { kind: 'pre-rewind', id: 'rw-u1' } });
    expect(fake.calls).toEqual(['turnStart:u1', 'restore:u1']);
    expect(persisted).toEqual([expect.objectContaining({ kind: 'pre-rewind', id: 'rw-u1' })]);

    expect(await service.restorePreRewind(preRewind('rw-u1'), sm, never)).toMatchObject({ ok: true, preRewind: { id: 'rw-undo-rw-u1' } });
    expect(fake.calls.at(-1)).toBe('undo:rw-u1');
    expect(persisted.map((r) => (r as PreRewindRecord).id)).toEqual(['rw-u1', 'rw-undo-rw-u1']);
  });

  it('keeps the pre-rewind record when the restore and its rollback both fail', async () => {
    const { service, fake, persisted } = makeService();
    vi.mocked(fake.producer.restore).mockResolvedValueOnce({
      ok: false, reason: 'checkout-failed', error: 'read-tree failed', rollbackError: 'clean failed', preRewind: preRewind('rw-kept'),
    });
    const result = await service.restore(entryFor('u1'), treeReader([userEntry('u1')]), never);
    expect(result).toMatchObject({ ok: false, reason: 'checkout-failed', rollbackError: 'clean failed' });
    expect(persisted).toEqual([expect.objectContaining({ kind: 'pre-rewind', id: 'rw-kept' })]);
  });

  it('gives up at once when the wait is aborted in the queue, and never restores later', async () => {
    const { service, fake } = makeService();
    const sm = treeReader([userEntry('u1')]);
    service.startTurn(sm, 'u1', 'p');
    await vi.waitFor(() => expect(fake.calls).toEqual(['turnStart:u1']));
    const abort = new AbortController();
    const restored = service.restore(entryFor('u1'), sm, abort.signal);
    // The baseline still holds the chain, so only the abort can settle the restore.
    expect(await settlesWithin(restored, 20)).toBe('pending');
    abort.abort();
    expect(await restored).toEqual({ ok: false, reason: 'aborted', preRewind: null });
    fake.release('u1');
    await service.drain(2_000);
    expect(fake.calls).toEqual(['turnStart:u1']);
  });

  it('tells a disposed service apart from missing git', async () => {
    const disposed = makeService();
    disposed.service.dispose();
    expect(await disposed.service.restore(entryFor('u1'), treeReader([userEntry('u1')]), never)).toEqual({ ok: false, reason: 'service-unavailable', preRewind: null });
  });
});

describe('CheckpointService without git', () => {
  afterEach(() => setCheckpointGitAvailability({ available: true }));

  it('creates no producer, records nothing, never holds a waiter, and reports git missing on restore', async () => {
    setCheckpointGitAvailability({ available: false, reason: 'spawn git ENOENT' });
    const createProducer = vi.fn(() => fakeProducer().producer);
    const { service, persisted, ready } = makeService({ createProducer, baselineWaitMs: () => 60_000 });
    const sm = treeReader([userEntry('u1')]);
    service.startTurn(sm, 'u1', 'p');
    expect(await settlesWithin(service.awaitBaseline(never, 'Edit'), 2_000)).toBe('settled');
    service.onSettled();
    service.onSessionCompact('c1', sm);
    expect(await service.restore(entryFor('u1'), sm, never)).toEqual({ ok: false, reason: 'git-unavailable', error: 'spawn git ENOENT', preRewind: null });
    expect(createProducer).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
    expect(ready).toEqual([]);
  });
});
