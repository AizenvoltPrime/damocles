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
