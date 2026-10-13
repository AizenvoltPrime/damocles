import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Memento } from '../../../platform/key-value-state';
import { COMMIT_HISTORY_KEY, COMMIT_HISTORY_LIMIT, COMMIT_HISTORY_ROOT_BYTES, COMMIT_HISTORY_ROOTS, commitHistory, recordCommitMessage } from '../commit-history';
import { updateSerially } from '../serial-update';

class MapMemento implements Memento {
  readonly map = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.map.has(key) ? structuredClone(this.map.get(key)) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
}

// As desktop's KeyValueState: the value changes only once the write has landed.
class SlowMemento extends MapMemento {
  override async update(key: string, value: unknown): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await super.update(key, value);
  }
}

const root = path.resolve('/work/repo');
const other = path.resolve('/work/other');

describe('commit message history', () => {
  it('lists messages newest first and moves a repeated message to the front instead of keeping it twice', async () => {
    const state = new MapMemento();
    for (const message of ['one', 'two', 'three', 'one']) await recordCommitMessage(state, root, message);
    expect(commitHistory(state, root)).toEqual(['one', 'three', 'two']);
  });

  it('keeps at most the limit, dropping the oldest', async () => {
    const state = new MapMemento();
    for (let index = 0; index <= COMMIT_HISTORY_LIMIT; index++) await recordCommitMessage(state, root, `m${index}`);
    const history = commitHistory(state, root);
    expect(history).toHaveLength(COMMIT_HISTORY_LIMIT);
    expect(history[0]).toBe(`m${COMMIT_HISTORY_LIMIT}`);
    expect(history).not.toContain('m0');
  });

  it('keeps one history per repository root and skips blank messages', async () => {
    const state = new MapMemento();
    await recordCommitMessage(state, root, 'here');
    await recordCommitMessage(state, other, 'there');
    await recordCommitMessage(state, root, '  \n');
    expect(commitHistory(state, root)).toEqual(['here']);
    expect(commitHistory(state, other)).toEqual(['there']);
    expect(commitHistory(state, path.resolve('/work/none'))).toEqual([]);
  });

  it('drops the root committed to longest ago past the root bound', async () => {
    const state = new MapMemento();
    for (let index = 0; index <= COMMIT_HISTORY_ROOTS; index++) await recordCommitMessage(state, path.resolve(`/work/r${index}`), 'x');
    expect(Object.keys(state.get<Record<string, unknown>>(COMMIT_HISTORY_KEY, {}))).toHaveLength(COMMIT_HISTORY_ROOTS);
    expect(commitHistory(state, path.resolve('/work/r0'))).toEqual([]);
    expect(commitHistory(state, path.resolve(`/work/r${COMMIT_HISTORY_ROOTS}`))).toEqual(['x']);
  });

  it('drops the oldest messages past the root\'s byte budget, and keeps no message that alone exceeds it', async () => {
    const state = new MapMemento();
    const long = (index: number): string => `${index} ${'x'.repeat(4_000)}`;
    for (let index = 0; index < 8; index++) await recordCommitMessage(state, root, long(index));
    const history = commitHistory(state, root);
    expect(history[0]).toBe(long(7));
    expect(history.length).toBeLessThan(8);
    expect(history.every((message) => message.length === long(0).length)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(state.get(COMMIT_HISTORY_KEY, {})))).toBeLessThanOrEqual(COMMIT_HISTORY_ROOT_BYTES + 10);
    await recordCommitMessage(state, root, 'y'.repeat(COMMIT_HISTORY_ROOT_BYTES));
    expect(commitHistory(state, root)[0]).toBe(long(7));
  });

  it('stays near 2 MB with every root at its budget', async () => {
    const state = new MapMemento();
    for (let index = 0; index < COMMIT_HISTORY_ROOTS + 5; index++) {
      for (let message = 0; message < 6; message++) await recordCommitMessage(state, path.resolve(`/work/r${index}`), `${message} ${'é'.repeat(2_000)}`);
    }
    expect(Buffer.byteLength(JSON.stringify(state.get(COMMIT_HISTORY_KEY, {})))).toBeLessThanOrEqual(COMMIT_HISTORY_ROOTS * COMMIT_HISTORY_ROOT_BYTES + 1_000);
  });

  it('loses no message when two commits write the history at once', async () => {
    const state = new SlowMemento();
    await Promise.all([recordCommitMessage(state, root, 'here'), recordCommitMessage(state, other, 'there'), recordCommitMessage(state, root, 'again')]);
    expect(commitHistory(state, root)).toEqual(['again', 'here']);
    expect(commitHistory(state, other)).toEqual(['there']);
  });

  it('runs read-modify-write updates of one key one after another, and goes on after one fails', async () => {
    const state = new SlowMemento();
    const add = (value: number): Promise<void> => updateSerially(state, 'k', (current) => [...(Array.isArray(current) ? current : []), value]);
    const failing = updateSerially(state, 'k', () => {
      throw new Error('bad update');
    });
    await Promise.all([add(1), failing.catch(() => undefined), add(2), add(3)]);
    await expect(failing).rejects.toThrow('bad update');
    expect(state.get('k', [])).toEqual([1, 2, 3]);
  });

  it('reads a malformed stored value as no history', () => {
    const state = new MapMemento();
    state.map.set(COMMIT_HISTORY_KEY, ['not', 'a', 'record']);
    expect(commitHistory(state, root)).toEqual([]);
  });
});
