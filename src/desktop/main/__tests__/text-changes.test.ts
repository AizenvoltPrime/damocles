import { describe, expect, it } from 'vitest';
import { applyTextChanges } from '../documents/text-changes';
import type { EditorTextChange } from '../../preload/shell-channels';

// The reference: each change sliced into the text the ones before it left.
const sequential = (text: string, changes: readonly EditorTextChange[]): string =>
  changes.reduce((current, change) => current.slice(0, change.offset) + change.text + current.slice(change.offset + change.length), text);

describe('applyTextChanges', () => {
  it('applies changes in order, each against the text the ones before it left', () => {
    const changes = [{ offset: 3, length: 0, text: 'd' }, { offset: 4, length: 0, text: 'e' }, { offset: 0, length: 1, text: '' }];
    expect(applyTextChanges('abc', changes, 100)).toBe('bcde');
  });

  it("applies one Monaco edit's changes in the order Monaco gives them, from the bottom up, as a replace all", () => {
    // TextModel's _doApplyEdits sorts an edit's operations descending by offset and reports them in that order.
    const changes = [{ offset: 3, length: 1, text: '--' }, { offset: 1, length: 1, text: '--' }];
    expect(applyTextChanges('aXbXc', changes, 100)).toBe('a--b--c');
  });

  it('replaces across text an earlier change inserted, and deletes everything', () => {
    const changes = [{ offset: 5, length: 0, text: ', dear' }, { offset: 3, length: 8, text: 'p' }];
    expect(applyTextChanges('hello world', changes, 100)).toBe('help world');
    expect(applyTextChanges('abc', [{ offset: 0, length: 3, text: '' }, { offset: 0, length: 0, text: 'x' }], 100)).toBe('x');
  });

  it('refuses a batch with a change past the end, applying none of it', () => {
    expect(applyTextChanges('abc', [{ offset: 0, length: 1, text: 'x' }, { offset: 3, length: 1, text: '' }], 100)).toBeUndefined();
    expect(applyTextChanges('abc', [{ offset: 4, length: 0, text: 'x' }], 100)).toBeUndefined();
    expect(applyTextChanges('abc', [{ offset: 3, length: 0, text: 'd' }], 100)).toBe('abcd');
  });

  it('refuses a result longer than the bound', () => {
    expect(applyTextChanges('abc', [{ offset: 3, length: 0, text: 'de' }], 4)).toBeUndefined();
    expect(applyTextChanges('abc', [{ offset: 3, length: 0, text: 'de' }, { offset: 0, length: 1, text: '' }], 4)).toBe('bcde');
  });

  it('agrees with slicing each change in turn on random batches', () => {
    let seed = 7;
    const random = (below: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % below;
    };
    for (let round = 0; round < 500; round++) {
      let text = 'x'.repeat(random(40));
      const start = text;
      const changes: EditorTextChange[] = [];
      for (let count = random(8); count > 0; count--) {
        const offset = random(text.length + 1);
        const change = { offset, length: random(text.length - offset + 1), text: 'abcdefgh'.slice(0, random(9)) };
        changes.push(change);
        text = sequential(text, [change]);
      }
      expect(applyTextChanges(start, changes, 1000)).toBe(text);
    }
  });

  it('costs one rebuild of a 64 MiB text per batch', () => {
    const big = 'a'.repeat(64 * 1024 * 1024 - 20_000);
    const times: number[] = [];
    let text = big;
    for (let keystroke = 0; keystroke < 10; keystroke++) {
      const started = performance.now();
      text = applyTextChanges(text, [{ offset: 1000 + keystroke, length: 0, text: 'x' }], 64 * 1024 * 1024)!;
      times.push(performance.now() - started);
    }
    const replaceAll = Array.from({ length: 10_000 }, (_, index) => ({ offset: (9_999 - index) * 4096, length: 1, text: 'bb' }));
    const started = performance.now();
    const replaced = applyTextChanges(text, replaceAll, 64 * 1024 * 1024)!;
    const replaceAllMs = performance.now() - started;
    expect(replaced.length).toBe(text.length + 10_000);
    expect(Math.max(...times)).toBeLessThan(250);
    expect(replaceAllMs).toBeLessThan(500);
  });
});
