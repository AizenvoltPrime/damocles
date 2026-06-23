import { describe, it, expect } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { CheckpointService, type CheckpointTreeReader } from '../checkpoint-service';
import { DAMOCLES_CHECKPOINT_ENTRY } from '../session-store/constants';

function checkpointEntry(userEntryId: string, turnId: string): SessionEntry {
  return {
    type: 'custom',
    id: `cp-${turnId}`,
    parentId: null,
    timestamp: '',
    customType: DAMOCLES_CHECKPOINT_ENTRY,
    data: {
      v: 2,
      kind: 'checkpoint',
      turnId,
      userEntryId,
      beforeCommit: 'aaa',
      afterCommit: 'bbb',
      prompt: 'p',
      fileCount: 0,
      fileChanges: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  } as unknown as SessionEntry;
}

function userEntry(id: string): SessionEntry {
  return { type: 'message', id, parentId: null, timestamp: '', message: { role: 'user', content: [] } } as unknown as SessionEntry;
}

function treeReader(entries: SessionEntry[]): CheckpointTreeReader {
  return {
    getBranch: () => entries,
    getLeafId: () => entries[entries.length - 1]?.id ?? null,
    getSessionFile: () => '/sessions/x.jsonl',
    getEntries: () => entries,
  };
}

describe('CheckpointService.hydrate', () => {
  it('surfaces persisted checkpoint user entry ids to the host (resume rehydration)', () => {
    const ready: string[] = [];
    const svc = new CheckpointService({ cwd: '/cwd', onCheckpointReady: (id) => ready.push(id) });
    svc.hydrate(treeReader([userEntry('u1'), checkpointEntry('u1', 't1'), userEntry('u2'), checkpointEntry('u2', 't2')]));
    expect(ready).toEqual(['u1', 'u2']);
  });

  it('is a no-op on a tree with no checkpoint entries', () => {
    const ready: string[] = [];
    const svc = new CheckpointService({ cwd: '/cwd', onCheckpointReady: (id) => ready.push(id) });
    svc.hydrate(treeReader([userEntry('u1')]));
    expect(ready).toEqual([]);
  });
});

describe('CheckpointService.onMessageStart', () => {
  it('ignores non-assistant messages without touching git', async () => {
    const svc = new CheckpointService({ cwd: '/cwd', onCheckpointReady: () => undefined });
    expect(await svc.onMessageStart({ role: 'user' }, treeReader([]))).toEqual([]);
    expect(await svc.onMessageStart({ role: 'toolResult' }, treeReader([]))).toEqual([]);
  });
});

describe('CheckpointService.deferNextFinalize (held-continuation turns)', () => {
  it('skips exactly one agent_end finalize, never touching the producer, then re-arms for the next', async () => {
    const ready: string[] = [];
    const svc = new CheckpointService({ cwd: '/cwd', onCheckpointReady: (id) => ready.push(id) });
    const sm = treeReader([]);

    // A held continuation (plan-mode nudge / background keep-alive) defers this agent_end's finalize.
    // With no producer ever bound, a finalize attempt would still be a no-op — but the point is that the
    // ONE-SHOT flag is consumed here and not on the next (real) end. We assert the one-shot semantics via
    // the flag's effect on a bound producer below; here we cover the no-producer early path.
    svc.deferNextFinalize();
    expect(await svc.onAgentEnd(sm)).toEqual([]);
    expect(ready).toEqual([]);

    // The flag is one-shot: a SECOND agent_end with no defer falls through to the normal (no-producer) path.
    expect(await svc.onAgentEnd(sm)).toEqual([]);
    expect(ready).toEqual([]);
  });

  it('keeps the single pending checkpoint across a deferred end, finalizing once when the turn truly ends', async () => {
    // Drive the real lifecycle through a stub repo so we can prove ONE checkpoint per logical turn even
    // when the turn is held across a continuation round (two agent_end events, one real prompt).
    const ready: string[] = [];
    const svc = new CheckpointService({ cwd: '/cwd', onCheckpointReady: (id) => ready.push(id) });

    let commitSeq = 0;
    const repo = {
      calls: [] as string[],
      async withLock<T>(fn: () => Promise<T>): Promise<T> { return fn(); },
      async ensureReady(): Promise<void> { this.calls.push('ensureReady'); },
      async checkpoint(): Promise<string> { return `commit-${++commitSeq}`; },
      async stageAll(): Promise<void> { this.calls.push('stageAll'); },
      async diffAgainst(): Promise<string> { return ''; }, // no file changes this turn
    };
    // Bypass git probing + repo binding by injecting our stub producer's repo.
    const { AutoCheckpointProducer } = await import('../checkpoints/auto-checkpoint');
    const producer = new AutoCheckpointProducer({
      repo: repo as unknown as import('../checkpoints/repo-manager').RepoManager,
      exclude: [],
      createTurnId: () => `turn-${commitSeq}`,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    (svc as unknown as { producer: unknown; gitAvailable: boolean }).producer = producer;
    (svc as unknown as { gitAvailable: boolean }).gitAvailable = true;

    const sm = treeReader([userEntry('u1')]);
    // turnStart for the user entry (fires on assistant message_start).
    await svc.onMessageStart({ role: 'assistant', content: [] }, sm);

    // First agent_end is a HELD continuation → deferred: no finalize, pending checkpoint survives.
    svc.deferNextFinalize();
    expect(await svc.onAgentEnd(sm)).toEqual([]);
    expect(ready).toEqual([]);

    // Real end of the turn → finalize exactly once for u1.
    const entries = await svc.onAgentEnd(sm);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.userEntryId).toBe('u1');
    expect(ready).toEqual(['u1']);

    // No second checkpoint was produced for the same user entry (the bug this fixes).
    expect(await svc.onAgentEnd(sm)).toEqual([]);
  });
});
