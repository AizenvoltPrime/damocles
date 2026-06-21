import { describe, it, expect } from 'vitest';
import type { RewindHistoryItem } from '@shared/types/session';
import { getCompactionRewindItems, mergeRewindAnchorsNewestFirst } from '../rewind';

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
