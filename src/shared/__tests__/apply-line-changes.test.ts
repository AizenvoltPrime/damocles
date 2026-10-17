import { describe, expect, it } from 'vitest';
import { applyLineChanges, intersectDiffWithRange, invertLineChange, lineCountOf, selectedLineChanges, touchesModifiedSide, type LineChange } from '../scm/apply-line-changes';

const change = (os: number, oe: number, ms: number, me: number): LineChange => ({ originalStartLineNumber: os, originalEndLineNumber: oe, modifiedStartLineNumber: ms, modifiedEndLineNumber: me });

describe('applyLineChanges', () => {
  it('applies an insertion in the middle and at the start', () => {
    expect(applyLineChanges('a\nb\n', 'a\nx\nb\n', [change(1, 0, 2, 2)])).toBe('a\nx\nb\n');
    expect(applyLineChanges('a\nb\n', 'x\na\nb\n', [change(0, 0, 1, 1)])).toBe('x\na\nb\n');
  });

  it('applies a deletion in the middle, at the start and of the last line', () => {
    expect(applyLineChanges('a\nb\nc\n', 'a\nc\n', [change(2, 2, 1, 0)])).toBe('a\nc\n');
    expect(applyLineChanges('a\nb\nc\n', 'b\nc\n', [change(1, 1, 0, 0)])).toBe('b\nc\n');
    // the last line has no line break, so the deletion takes the break before it (microsoft/vscode#59670)
    expect(applyLineChanges('a\nb', 'a', [change(2, 2, 1, 0)])).toBe('a');
  });

  it('applies a change of one line into two', () => {
    expect(applyLineChanges('a\nb\nc\n', 'a\nB1\nB2\nc\n', [change(2, 2, 2, 3)])).toBe('a\nB1\nB2\nc\n');
  });

  it('applies only the changes given, so one of two adjacent hunks stages alone', () => {
    const original = 'a\nb\nc\nd\n';
    const modified = 'A\nb\nc\nD\n';
    const changes = [change(1, 1, 1, 1), change(4, 4, 4, 4)];
    expect(applyLineChanges(original, modified, changes)).toBe(modified);
    expect(applyLineChanges(original, modified, [changes[0]!])).toBe('A\nb\nc\nd\n');
    expect(applyLineChanges(original, modified, [changes[1]!])).toBe('a\nb\nc\nD\n');
    // touching hunks: lines 2 and 3 changed as two separate changes
    expect(applyLineChanges('a\nb\nc\nd\n', 'a\nB\nC\nd\n', [change(2, 2, 2, 2), change(3, 3, 3, 3)])).toBe('a\nB\nC\nd\n');
    expect(applyLineChanges('a\nb\nc\nd\n', 'a\nB\nC\nd\n', [change(3, 3, 3, 3)])).toBe('a\nb\nC\nd\n');
  });

  it('keeps a missing final newline on either side', () => {
    // appending after a last line that has no break takes the break from the modified side
    expect(applyLineChanges('a\nb', 'a\nb\nc', [change(2, 0, 3, 3)])).toBe('a\nb\nc');
    // changing the unterminated last line keeps it unterminated
    expect(applyLineChanges('a\nb', 'a\nB', [change(2, 2, 2, 2)])).toBe('a\nB');
    // adding the final newline is a change of the last line
    expect(applyLineChanges('a\nb', 'a\nb\n', [change(2, 2, 2, 3)])).toBe('a\nb\n');
  });

  it('keeps each side\'s own line breaks', () => {
    // a CRLF index with a CRLF buffer
    expect(applyLineChanges('a\r\nb\r\nc\r\n', 'a\r\nX\r\nc\r\n', [change(2, 2, 2, 2)])).toBe('a\r\nX\r\nc\r\n');
    // an LF index (autocrlf=true) with a CRLF buffer: the staged line brings its CRLF, which hash-object normalizes
    expect(applyLineChanges('a\nb\nc\n', 'a\r\nX\r\nc\r\n', [change(2, 2, 2, 2)])).toBe('a\nX\r\nc\n');
    // a lone CR is a line break too, as in Monaco
    expect(lineCountOf('a\rb\r\nc\nd')).toBe(4);
    expect(applyLineChanges('a\rb\rc', 'a\rB\rc', [change(2, 2, 2, 2)])).toBe('a\rB\rc');
  });

  it('unstages by applying HEAD → index changes inverted onto the index', () => {
    const head = 'a\nb\nc\n';
    const index = 'a\nB\nc\nd\n';
    const headToIndex = [change(2, 2, 2, 2), change(3, 0, 4, 4)];
    expect(applyLineChanges(index, head, headToIndex.map(invertLineChange))).toBe(head);
    expect(applyLineChanges(index, head, [invertLineChange(headToIndex[1]!)])).toBe('a\nB\nc\n');
  });
});

describe('selected ranges', () => {
  it('cuts a change with equal line counts line by line', () => {
    const hunk = change(2, 4, 2, 4);
    expect(intersectDiffWithRange(hunk, { startLineNumber: 3, endLineNumber: 3 }, 6)).toEqual(change(3, 3, 3, 3));
    expect(applyLineChanges('a\nb\nc\nd\ne\n', 'a\nB\nC\nD\ne\n', [intersectDiffWithRange(hunk, { startLineNumber: 3, endLineNumber: 3 }, 6)!])).toBe('a\nb\nC\nd\ne\n');
  });

  it('keeps the whole original side of a change with unequal counts', () => {
    expect(intersectDiffWithRange(change(2, 2, 2, 4), { startLineNumber: 3, endLineNumber: 9 }, 6)).toEqual(change(2, 2, 3, 4));
  });

  it('takes a deletion whole when the selection holds a line beside it', () => {
    const deletion = change(3, 4, 2, 0);
    expect(touchesModifiedSide(deletion, { startLineNumber: 2, endLineNumber: 2 }, 5)).toBe(true);
    expect(touchesModifiedSide(deletion, { startLineNumber: 3, endLineNumber: 3 }, 5)).toBe(true);
    expect(touchesModifiedSide(deletion, { startLineNumber: 4, endLineNumber: 5 }, 5)).toBe(false);
    expect(intersectDiffWithRange(deletion, { startLineNumber: 1, endLineNumber: 2 }, 5)).toBe(deletion);
    // at the start of the file it sits on line 1, at the end on the last line
    expect(touchesModifiedSide(change(1, 1, 0, 0), { startLineNumber: 1, endLineNumber: 1 }, 3)).toBe(true);
    expect(touchesModifiedSide(change(4, 4, 3, 0), { startLineNumber: 3, endLineNumber: 3 }, 3)).toBe(true);
  });

  it('selects each change through the first range that touches it', () => {
    const changes = [change(1, 1, 1, 1), change(5, 6, 5, 6), change(9, 9, 9, 9)];
    expect(selectedLineChanges(changes, [{ startLineNumber: 6, endLineNumber: 10 }], 10)).toEqual([change(6, 6, 6, 6), change(9, 9, 9, 9)]);
    expect(selectedLineChanges(changes, [{ startLineNumber: 2, endLineNumber: 4 }], 10)).toEqual([]);
  });
});
