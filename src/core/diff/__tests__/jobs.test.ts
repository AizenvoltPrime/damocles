import { describe, expect, it } from 'vitest';
import { diffLines } from 'diff';
import { runDiffJob } from '../jobs';

// A seeded generator, so a failing pair can be found again.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lines from a small alphabet, so pairs share lines; some lines open with a hunk mark or are empty, and the last line
// may lack its newline.
function randomText(random: () => number): string {
  const alphabet = ['a', 'b', 'c', '', '+x', '-y', ' z', '\\ n', 'd'];
  const count = Math.floor(random() * 30);
  const lines = Array.from({ length: count }, () => alphabet[Math.floor(random() * alphabet.length)]!);
  const text = lines.join('\n');
  return count > 0 && random() < 0.7 ? `${text}\n` : text;
}

// diffLines' added and removed line counts.
function diffLinesCounts(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of diffLines(before, after)) {
    if (change.added) added += change.count;
    else if (change.removed) removed += change.count;
  }
  return { added, removed };
}

describe('the lineDiff job', () => {
  it('counts the same added and removed lines as diffLines over random pairs', () => {
    const random = mulberry32(20261118);
    for (let i = 0; i < 2_000; i++) {
      const before = randomText(random);
      const after = randomText(random);
      const answer = runDiffJob({ kind: 'lineDiff', before, after, context: 3, maxEditLength: 20_000, timeoutMs: 3_000 });
      expect(answer.kind, JSON.stringify({ before, after })).toBe('diff');
      if (answer.kind !== 'diff') continue;
      expect({ added: answer.added, removed: answer.removed }, JSON.stringify({ before, after })).toEqual(diffLinesCounts(before, after));
    }
  });

  it('answers tooLarge past the edit bound', () => {
    expect(runDiffJob({ kind: 'lineDiff', before: 'a\nb\nc\n', after: 'x\ny\nz\n', context: 3, maxEditLength: 2, timeoutMs: 3_000 })).toEqual({ kind: 'tooLarge' });
  });
});
