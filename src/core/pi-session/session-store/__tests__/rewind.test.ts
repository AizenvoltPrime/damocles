import * as path from 'path';
import { describe, it, expect } from 'vitest';
import type { RewindHistoryItem } from '@shared/types/session';
import type { FileChange } from '../../checkpoints';
import { getCompactionRewindItems, mergeRewindAnchorsNewestFirst, partitionCheckpointRows, type CheckpointRow } from '../rewind';

function userMsg(id: string): unknown {
  return { id, type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
}
function compaction(id: string, summary: string, timestamp: string): unknown {
  return { id, type: 'compaction', summary, tokensBefore: 1234, timestamp };
}

describe('getCompactionRewindItems', () => {
  it('maps each compaction entry to a compaction rewind anchor (id, summary, timestamp)', () => {
    const branch = [
      userMsg('u1'),
      compaction('comp-1', 'first summary', '2026-06-20T20:00:00.000Z'),
      userMsg('u2'),
      compaction('comp-2', 'second summary', '2026-06-20T21:00:00.000Z'),
    ];
    const items = getCompactionRewindItems(branch);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'compaction',
      messageId: 'comp-1',
      content: 'first summary',
      timestamp: Date.parse('2026-06-20T20:00:00.000Z'),
      filesAffected: 0,
    });
    expect(items[1]!.messageId).toBe('comp-2');
  });

  it('returns no items when the branch has no compaction entries', () => {
    expect(getCompactionRewindItems([userMsg('u1'), userMsg('u2')])).toEqual([]);
  });

  it('tolerates a malformed compaction entry (missing summary/timestamp)', () => {
    const items = getCompactionRewindItems([{ id: 'comp-x', type: 'compaction' }]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'compaction', messageId: 'comp-x', content: '', timestamp: 0 });
  });

  it('skips a compaction entry with no string id', () => {
    expect(getCompactionRewindItems([{ type: 'compaction', summary: 's', timestamp: '2026-06-20T20:00:00.000Z' }])).toEqual([]);
  });

  it('enriches a compaction item from a checkpoint-diff map (files cwd-resolved, linesChanged)', () => {
    const cwd = path.resolve('/repo');
    const branch = [compaction('comp-1', 'summary', '2026-06-20T20:00:00.000Z')];
    const changes: FileChange[] = [
      { path: 'src/a.ts', added: 3, removed: 1 },
      { path: 'src/b.ts', added: 0, removed: 2 },
    ];
    const map = new Map<string, readonly FileChange[]>([['comp-1', changes]]);
    const items = getCompactionRewindItems(branch, cwd, map);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'compaction',
      messageId: 'comp-1',
      filesAffected: 2,
      linesChanged: { added: 3, removed: 3 },
    });
    expect(items[0]!.files).toEqual([
      { path: path.resolve(cwd, 'src/a.ts'), displayName: 'src/a.ts' },
      { path: path.resolve(cwd, 'src/b.ts'), displayName: 'src/b.ts' },
    ]);
  });

  it('omits files when the map has the id but no cwd is provided', () => {
    const branch = [compaction('comp-1', 'summary', '2026-06-20T20:00:00.000Z')];
    const map = new Map<string, readonly FileChange[]>([['comp-1', [{ path: 'src/a.ts', added: 1, removed: 0 }]]]);
    const items = getCompactionRewindItems(branch, undefined, map);

    expect(items[0]).toMatchObject({ filesAffected: 1, linesChanged: { added: 1, removed: 0 } });
    expect(items[0]!.files).toBeUndefined();
  });

  it('omits linesChanged when a mapped checkpoint changed no lines', () => {
    const branch = [compaction('comp-1', 'summary', '2026-06-20T20:00:00.000Z')];
    const map = new Map<string, readonly FileChange[]>([['comp-1', [{ path: 'src/a.ts', added: 0, removed: 0 }]]]);
    const items = getCompactionRewindItems(branch, path.resolve('/repo'), map);

    expect(items[0]!.filesAffected).toBe(1);
    expect(items[0]!.linesChanged).toBeUndefined();
  });

  it('keeps filesAffected:0 and no files for a legacy compaction absent from the map', () => {
    const cwd = path.resolve('/repo');
    const branch = [compaction('comp-legacy', 'summary', '2026-06-20T20:00:00.000Z')];
    const map = new Map<string, readonly FileChange[]>([['comp-other', [{ path: 'x.ts', added: 1, removed: 0 }]]]);
    const items = getCompactionRewindItems(branch, cwd, map);

    expect(items[0]).toMatchObject({ kind: 'compaction', messageId: 'comp-legacy', filesAffected: 0 });
    expect(items[0]!.files).toBeUndefined();
    expect(items[0]!.linesChanged).toBeUndefined();
  });

  it('behaves identically to the legacy call when no extra args are passed', () => {
    const branch = [compaction('comp-1', 'summary', '2026-06-20T20:00:00.000Z')];
    expect(getCompactionRewindItems(branch)).toEqual([
      {
        kind: 'compaction',
        messageId: 'comp-1',
        content: 'summary',
        timestamp: Date.parse('2026-06-20T20:00:00.000Z'),
        filesAffected: 0,
      },
    ]);
  });
});

describe('mergeRewindAnchorsNewestFirst', () => {
  const prompt = (id: string, ts: number): RewindHistoryItem => ({ kind: 'prompt', messageId: id, content: id, timestamp: ts, filesAffected: 0 });
  const comp = (id: string, ts: number): RewindHistoryItem => ({ kind: 'compaction', messageId: id, content: '', timestamp: ts, filesAffected: 0 });

  it('interleaves prompt and compaction anchors strictly newest-first', () => {
    const prompts = [prompt('p3', 300), prompt('p1', 100)]; // already newest-first
    const comps = [comp('c2', 200), comp('c4', 400)];
    const merged = mergeRewindAnchorsNewestFirst(prompts, comps);

    expect(merged.map((m) => m.messageId)).toEqual(['c4', 'p3', 'c2', 'p1']);
  });

  it('returns only prompt items when there are no compactions', () => {
    const prompts = [prompt('p2', 200), prompt('p1', 100)];
    expect(mergeRewindAnchorsNewestFirst(prompts, []).map((m) => m.messageId)).toEqual(['p2', 'p1']);
  });

  it('keeps the prompt before the compaction on an equal timestamp (stable tie-break)', () => {
    // A compaction shares its parent turn's timestamp closely; on an exact tie the prompt (passed
    // first) must precede the compaction, so the user sees the turn anchor above its compaction point.
    const merged = mergeRewindAnchorsNewestFirst([prompt('p', 200)], [comp('c', 200)]);
    expect(merged.map((m) => m.messageId)).toEqual(['p', 'c']);
  });
});

describe('partitionCheckpointRows', () => {
  const cwd = path.resolve('/repo');
  const row = (userEntryId: string, changes: FileChange[], overrides: Partial<CheckpointRow> = {}): CheckpointRow => ({
    userEntryId,
    changes,
    prompt: `prompt-${userEntryId}`,
    createdAt: '2026-06-20T20:00:00.000Z',
    ...overrides,
  });

  it('routes a compaction-keyed checkpoint into the diff map, not a phantom prompt row', () => {
    const rows = [row('u1', [{ path: 'a.ts', added: 1, removed: 0 }]), row('comp-1', [{ path: 'b.ts', added: 2, removed: 0 }])];
    const { promptItemsOldestFirst, checkpointDiffsMap } = partitionCheckpointRows(rows, new Set(['comp-1']), new Map(), cwd);

    expect(promptItemsOldestFirst.map((p) => p.messageId)).toEqual(['u1']);
    expect(checkpointDiffsMap.has('comp-1')).toBe(true);
    expect(checkpointDiffsMap.get('comp-1')).toEqual([{ path: 'b.ts', added: 2, removed: 0 }]);
  });

  it('last checkpoint per compaction id wins (matches getPiFileCheckpointContent reverse().find)', () => {
    // Two snapshots keyed to one compaction entry (e.g. a re-fired session_compact): oldest→newest
    // iteration means the LAST one must overwrite in the map, so the anchor reflects the newest snapshot.
    const rows = [
      row('comp-1', [{ path: 'old.ts', added: 1, removed: 0 }]),
      row('comp-1', [{ path: 'new.ts', added: 9, removed: 9 }]),
    ];
    const { promptItemsOldestFirst, checkpointDiffsMap } = partitionCheckpointRows(rows, new Set(['comp-1']), new Map(), cwd);

    expect(promptItemsOldestFirst).toHaveLength(0);
    expect(checkpointDiffsMap.get('comp-1')).toEqual([{ path: 'new.ts', added: 9, removed: 9 }]);
  });

  it('builds a prompt anchor with cwd-resolved files and summed linesChanged', () => {
    const rows = [row('u1', [{ path: 'src/a.ts', added: 3, removed: 1 }, { path: 'src/b.ts', added: 0, removed: 2 }])];
    const { promptItemsOldestFirst } = partitionCheckpointRows(rows, new Set(), new Map(), cwd);

    expect(promptItemsOldestFirst[0]).toMatchObject({
      kind: 'prompt',
      messageId: 'u1',
      content: 'prompt-u1',
      filesAffected: 2,
      linesChanged: { added: 3, removed: 3 },
    });
    expect(promptItemsOldestFirst[0]!.files).toEqual([
      { path: path.resolve(cwd, 'src/a.ts'), displayName: 'src/a.ts' },
      { path: path.resolve(cwd, 'src/b.ts'), displayName: 'src/b.ts' },
    ]);
  });

  it('prefers a recorded original input over the checkpoint prompt', () => {
    const { promptItemsOldestFirst } = partitionCheckpointRows([row('u1', [])], new Set(), new Map([['u1', '/compact focus on auth']]), cwd);
    expect(promptItemsOldestFirst[0]!.content).toBe('/compact focus on auth');
  });

  it('omits files and linesChanged for a prompt anchor that changed nothing', () => {
    const { promptItemsOldestFirst } = partitionCheckpointRows([row('u1', [])], new Set(), new Map(), cwd);
    expect(promptItemsOldestFirst[0]).toMatchObject({ messageId: 'u1', filesAffected: 0 });
    expect(promptItemsOldestFirst[0]!.files).toBeUndefined();
    expect(promptItemsOldestFirst[0]!.linesChanged).toBeUndefined();
  });
});
