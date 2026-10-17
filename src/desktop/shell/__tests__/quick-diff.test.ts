import { describe, expect, it } from 'vitest';
import { applyLineChanges } from '@shared/scm/apply-line-changes';
import {
  bufferToOriginalLine,
  changesKeptByRevert,
  computeQuickDiff,
  createQuickDiffHandler,
  diffLineChanges,
  nextChangeIndex,
  previousChangeIndex,
  QUICK_DIFF_MAX_EDIT_LENGTH,
  selectionLineRanges,
  stagedChangesFor,
} from '../editor/quick-diff/quick-diff-compute';

const lines = (...text: string[]): string => `${text.join('\n')}\n`;

describe('quick diff line changes', () => {
  it('reports insertions, deletions and modifications as VS Code LineChanges', () => {
    const base = lines('a', 'b', 'c', 'd', 'e');
    expect(diffLineChanges(base, lines('a', 'x', 'b', 'c', 'd', 'e'))).toEqual([{ originalStartLineNumber: 1, originalEndLineNumber: 0, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 }]);
    expect(diffLineChanges(base, lines('a', 'c', 'd', 'e'))).toEqual([{ originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 }]);
    expect(diffLineChanges(base, lines('a', 'B', 'c', 'd', 'E'))).toEqual([
      { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
      { originalStartLineNumber: 5, originalEndLineNumber: 5, modifiedStartLineNumber: 5, modifiedEndLineNumber: 5 },
    ]);
    // a deletion before the first line follows line 0
    expect(diffLineChanges(base, lines('b', 'c', 'd', 'e'))).toEqual([{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 }]);
  });

  it('compares lines, so an index blob in LF against a CRLF buffer marks nothing', () => {
    expect(diffLineChanges('a\nb\nc\n', 'a\r\nb\r\nc\r\n')).toEqual([]);
  });

  it('round-trips through applyLineChanges: every change applied to the original gives the modified text', () => {
    const original = lines('one', 'two', 'three', 'four', 'five', 'six');
    const modified = lines('zero', 'one', 'TWO', 'three', 'five', 'six', 'seven');
    expect(applyLineChanges(original, modified, diffLineChanges(original, modified)!)).toBe(modified);
  });

  it('gives up past the edit length, so a huge rewrite shows no marks', () => {
    const count = QUICK_DIFF_MAX_EDIT_LENGTH + 10;
    const original = Array.from({ length: count }, (_, index) => `a${index}`).join('\n');
    const modified = Array.from({ length: count }, (_, index) => `b${index}`).join('\n');
    expect(diffLineChanges(original, modified)).toBeNull();
    expect(computeQuickDiff({ indexText: original, headText: null }, modified).primary).toBeNull();
  });
});

describe('computeQuickDiff', () => {
  it('has no secondary diff without staged changes, and blame maps through the primary one', () => {
    const result = computeQuickDiff({ indexText: lines('a', 'b'), headText: null }, lines('a', 'B'));
    expect(result.secondary).toEqual([]);
    expect(result.head).toBe(result.primary);
  });

  it('shows a staged change as secondary, and hides one a primary change touches', () => {
    // HEAD → index staged line 2; the buffer also edits line 4 (unstaged) and line 2 again (unstaged over staged)
    const head = lines('a', 'b', 'c', 'd', 'e');
    const index = lines('a', 'B', 'c', 'd', 'e');
    const staged = computeQuickDiff({ indexText: index, headText: head }, index);
    expect(staged.primary).toEqual([]);
    expect(staged.secondary).toEqual([{ originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 }]);
    expect(staged.staged).toEqual(staged.secondary);

    const both = computeQuickDiff({ indexText: index, headText: head }, lines('a', 'BB', 'c', 'D', 'e'));
    expect(both.primary?.map((change) => change.modifiedStartLineNumber)).toEqual([2, 4]);
    expect(both.secondary).toEqual([]);
  });

  it('maps a secondary mark to the staged changes in the index lines under it', () => {
    const head = lines('a', 'b', 'c', 'd');
    const index = lines('a', 'b', 'c', 'D');
    // one unstaged line inserted above shifts the staged change down by one in the buffer
    const result = computeQuickDiff({ indexText: index, headText: head }, lines('new', 'a', 'b', 'c', 'D'));
    expect(result.secondary).toEqual([{ originalStartLineNumber: 4, originalEndLineNumber: 4, modifiedStartLineNumber: 5, modifiedEndLineNumber: 5 }]);
    expect(stagedChangesFor(result.secondary[0]!, result.primary!, result.staged)).toEqual([{ originalStartLineNumber: 4, originalEndLineNumber: 4, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 }]);
  });
});

describe('the worker contract', () => {
  it('diffs only against a base it holds, answers each diff with its id, and forgets a dropped key', () => {
    const handle = createQuickDiffHandler();
    expect(handle({ kind: 'diff', key: 'm1', id: 1, buffer: 'x\n' })).toEqual({ key: 'm1', id: 1, result: null });
    expect(handle({ kind: 'base', key: 'm1', base: { indexText: 'a\n', headText: null } })).toBeUndefined();
    const reply = handle({ kind: 'diff', key: 'm1', id: 2, buffer: 'b\n' });
    expect(reply?.id).toBe(2);
    expect(reply?.result?.primary).toEqual([{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 }]);
    expect(handle({ kind: 'diff', key: 'm2', id: 3, buffer: 'b\n' })?.result).toBeNull();
    handle({ kind: 'drop', key: 'm1' });
    expect(handle({ kind: 'diff', key: 'm1', id: 4, buffer: 'b\n' })?.result).toBeNull();
  });

  it('diffs HEAD against the index once per base, not on every keystroke', () => {
    const handle = createQuickDiffHandler();
    handle({ kind: 'base', key: 'm1', base: { indexText: 'a\nB\n', headText: 'a\nb\n' } });
    const first = handle({ kind: 'diff', key: 'm1', id: 1, buffer: 'A\nB\n' })?.result;
    const second = handle({ kind: 'diff', key: 'm1', id: 2, buffer: 'A\nB\nc\n' })?.result;
    expect(first?.staged).toEqual([{ originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 }]);
    expect(second?.staged).toBe(first?.staged);
  });
});

describe('change navigation and line mapping', () => {
  const changes = [
    { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 3 },
    { originalStartLineNumber: 9, originalEndLineNumber: 9, modifiedStartLineNumber: 9, modifiedEndLineNumber: 0 },
  ];

  it('finds the next and previous change, wrapping as VS Code does', () => {
    expect(nextChangeIndex(changes, 1, false)).toBe(0);
    expect(nextChangeIndex(changes, 2, false)).toBe(1);
    expect(nextChangeIndex(changes, 20, false)).toBe(0);
    expect(previousChangeIndex(changes, 20, false)).toBe(1);
    expect(previousChangeIndex(changes, 5, false)).toBe(0);
    expect(previousChangeIndex(changes, 1, false)).toBe(1);
  });

  it('maps a buffer line to the original line through additions and deletions (blame.ts)', () => {
    // line 2 became two lines; a line after 9 was removed
    expect(bufferToOriginalLine(1, changes)).toBe(1);
    expect(bufferToOriginalLine(2, changes)).toBeNull();
    expect(bufferToOriginalLine(4, changes)).toBe(3);
    expect(bufferToOriginalLine(9, changes)).toBe(8);
    expect(bufferToOriginalLine(10, changes)).toBe(10);
  });
});

describe('selected ranges', () => {
  it('merges selections into whole line ranges', () => {
    expect(selectionLineRanges([{ startLineNumber: 5, endLineNumber: 6 }, { startLineNumber: 1, endLineNumber: 2 }, { startLineNumber: 3, endLineNumber: 3 }])).toEqual([
      { startLineNumber: 1, endLineNumber: 3 },
      { startLineNumber: 5, endLineNumber: 6 },
    ]);
    // a selection that ends at the start of a line leaves that line out
    expect(selectionLineRanges([{ startLineNumber: 7, endLineNumber: 8, endColumn: 1 }])).toEqual([{ startLineNumber: 7, endLineNumber: 7 }]);
  });

  it('reverts every change a selection touches and keeps the rest', () => {
    const original = lines('a', 'b', 'c', 'd', 'e');
    const buffer = lines('a', 'B', 'c', 'D', 'e');
    const changes = diffLineChanges(original, buffer)!;
    const kept = changesKeptByRevert(changes, [{ startLineNumber: 2, endLineNumber: 2 }], 6);
    expect(applyLineChanges(original, buffer, kept)).toBe(lines('a', 'b', 'c', 'D', 'e'));
  });
});
