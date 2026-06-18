import { describe, it, expect, beforeEach } from 'vitest';
import { AutoCheckpointProducer } from '../auto-checkpoint';
import type { RepoManager } from '../repo-manager';

/**
 * A scriptable stand-in for `RepoManager` that records the call sequence and lets each test control
 * the commit hashes and the diff returned by `diffAgainst`. The producer only uses `withLock`,
 * `ensureReady`, `checkpoint`, `stageAll`, and `diffAgainst`.
 */
class FakeRepo {
  readonly calls: string[] = [];
  private commitCounter = 0;
  diffOutput = '';
  ensureReadyError: Error | null = null;
  checkpointError: Error | null = null;

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.calls.push('withLock');
    return fn();
  }

  async ensureReady(): Promise<void> {
    this.calls.push('ensureReady');
    if (this.ensureReadyError) throw this.ensureReadyError;
  }

  async checkpoint(entryId: string): Promise<string> {
    this.calls.push(`checkpoint:${entryId}`);
    if (this.checkpointError) throw this.checkpointError;
    return `commit-${++this.commitCounter}`;
  }

  async stageAll(): Promise<void> {
    this.calls.push('stageAll');
  }

  async diffAgainst(commit: string): Promise<string> {
    this.calls.push(`diffAgainst:${commit}`);
    return this.diffOutput;
  }
}

function makeProducer(repo: FakeRepo): { producer: AutoCheckpointProducer; turnIds: string[] } {
  const turnIds: string[] = [];
  let n = 0;
  const producer = new AutoCheckpointProducer({
    repo: repo as unknown as RepoManager,
    exclude: ['.git'],
    createTurnId: () => {
      const id = `turn-${++n}`;
      turnIds.push(id);
      return id;
    },
    now: () => new Date('2026-06-18T12:00:00.000Z'),
  });
  return { producer, turnIds };
}

describe('AutoCheckpointProducer', () => {
  let repo: FakeRepo;

  beforeEach(() => {
    repo = new FakeRepo();
  });

  it('turnStart captures a beforeCommit under the lock after ensureReady', async () => {
    const { producer } = makeProducer(repo);
    const result = await producer.turnStart({ userEntryId: 'u1', prompt: 'first' });
    expect(result).toEqual({ ok: true, entries: [] });
    expect(repo.calls).toEqual(['withLock', 'ensureReady', 'checkpoint:u1']);
  });

  it('dedups repeated turnStart for the same user entry id', async () => {
    const { producer } = makeProducer(repo);
    await producer.turnStart({ userEntryId: 'u1', prompt: 'first' });
    repo.calls.length = 0;
    const second = await producer.turnStart({ userEntryId: 'u1', prompt: 'first again' });
    expect(second).toEqual({ ok: true, entries: [] });
    expect(repo.calls).toEqual([]);
  });

  it('finalizes a pending turn when a new user entry starts', async () => {
    const { producer } = makeProducer(repo);
    await producer.turnStart({ userEntryId: 'u1', prompt: 'first' });
    repo.diffOutput = '1\t0\tfile.ts\n';
    const second = await producer.turnStart({ userEntryId: 'u2', prompt: 'second' });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.entries).toHaveLength(1);
      expect(second.entries[0]?.userEntryId).toBe('u1');
      expect(second.entries[0]?.afterCommit).not.toBe(second.entries[0]?.beforeCommit);
    }
  });

  it('turnEnd updates the prompt of the active turn', async () => {
    const { producer } = makeProducer(repo);
    await producer.turnStart({ userEntryId: 'u1', prompt: 'draft' });
    const end = await producer.turnEnd({ userEntryId: 'u1', prompt: 'final prompt' });
    expect(end).toEqual({ ok: true });
    repo.diffOutput = '';
    const finalized = await producer.finalizeRun();
    expect(finalized.ok).toBe(true);
    if (finalized.ok) expect(finalized.entry.prompt).toBe('final prompt');
  });

  it('turnEnd returns not-ok when no matching pending turn exists', async () => {
    const { producer } = makeProducer(repo);
    expect(await producer.turnEnd({ userEntryId: 'nope', prompt: 'x' })).toEqual({ ok: false });
  });

  it('finalizeRun with no changes sets afterCommit === beforeCommit and no extra checkpoint', async () => {
    const { producer } = makeProducer(repo);
    await producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    repo.calls.length = 0;
    repo.diffOutput = '';
    const finalized = await producer.finalizeRun();
    expect(finalized.ok).toBe(true);
    if (finalized.ok) {
      expect(finalized.entry.beforeCommit).toBe(finalized.entry.afterCommit);
      expect(finalized.entry.fileCount).toBe(0);
      expect(finalized.entry.fileChanges).toEqual([]);
    }
    expect(repo.calls).toEqual(['withLock', 'stageAll', 'diffAgainst:commit-1']);
  });

  it('finalizeRun with changes produces a distinct afterCommit and file changes', async () => {
    const { producer, turnIds } = makeProducer(repo);
    await producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    repo.diffOutput = '2\t1\tsrc/a.ts\n-\t-\tlogo.png\n';
    const finalized = await producer.finalizeRun();
    expect(finalized.ok).toBe(true);
    if (finalized.ok) {
      const e = finalized.entry;
      expect(e.v).toBe(2);
      expect(e.kind).toBe('checkpoint');
      expect(e.turnId).toBe(turnIds[0]);
      expect(e.beforeCommit).not.toBe(e.afterCommit);
      expect(e.fileCount).toBe(2);
      expect(e.fileChanges).toEqual([
        { path: 'src/a.ts', added: 2, removed: 1 },
        { path: 'logo.png', added: 0, removed: 0 },
      ]);
      expect(e.createdAt).toBe('2026-06-18T12:00:00.000Z');
    }
  });

  it('finalizeRun returns not-ok and clears state when nothing is pending', async () => {
    const { producer } = makeProducer(repo);
    expect(await producer.finalizeRun()).toEqual({ ok: false });
  });

  it('finalizeRun clears pending state even after producing an entry', async () => {
    const { producer } = makeProducer(repo);
    await producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    await producer.finalizeRun();
    expect(await producer.finalizeRun()).toEqual({ ok: false });
  });

  it('turnStart surfaces failure and resets pending state on error', async () => {
    const { producer } = makeProducer(repo);
    repo.checkpointError = new Error('git boom');
    const result = await producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('git boom');
    expect(await producer.finalizeRun()).toEqual({ ok: false });
  });

  it('discardRun discards an in-flight turn and returns its user entry id', async () => {
    const { producer } = makeProducer(repo);
    await producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    expect(producer.discardRun()).toBe('u1');
    expect(producer.discardRun()).toBeNull();
    expect(await producer.finalizeRun()).toEqual({ ok: false });
  });
});
