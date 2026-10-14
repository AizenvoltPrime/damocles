import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Memento } from '../../../platform/key-value-state';
import { recordWorktreeRoot, worktreeRoot, WORKTREE_ROOTS_KEY, WORKTREE_ROOTS_LIMIT } from '../worktree-roots';

class MapMemento implements Memento {
  readonly map = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.map.has(key) ? structuredClone(this.map.get(key)) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
}

const root = path.resolve('/work/repo');
const other = path.resolve('/work/other');
const trees = path.resolve('/work/trees');

describe('worktree folder memory', () => {
  it('remembers the folder of the first worktree a root creates, and the latest one after that', async () => {
    const state = new MapMemento();
    expect(worktreeRoot(state, root)).toBeUndefined();
    await recordWorktreeRoot(state, root, trees);
    expect(worktreeRoot(state, root)).toBe(trees);
    await recordWorktreeRoot(state, root, path.resolve('/elsewhere'));
    expect(worktreeRoot(state, root)).toBe(path.resolve('/elsewhere'));
    expect(worktreeRoot(state, other)).toBeUndefined();
  });

  it('keeps at most the root limit, dropping the root that created a worktree longest ago', async () => {
    const state = new MapMemento();
    for (let index = 0; index <= WORKTREE_ROOTS_LIMIT; index++) await recordWorktreeRoot(state, path.resolve(`/work/r${index}`), trees);
    expect(Object.keys(state.get<Record<string, unknown>>(WORKTREE_ROOTS_KEY, {}))).toHaveLength(WORKTREE_ROOTS_LIMIT);
    expect(worktreeRoot(state, path.resolve('/work/r0'))).toBeUndefined();
    expect(worktreeRoot(state, path.resolve(`/work/r${WORKTREE_ROOTS_LIMIT}`))).toBe(trees);
    // writing a kept root again makes it the newest, so the next eviction takes another
    await recordWorktreeRoot(state, path.resolve('/work/r1'), trees);
    await recordWorktreeRoot(state, root, trees);
    expect(worktreeRoot(state, path.resolve('/work/r1'))).toBe(trees);
    expect(worktreeRoot(state, path.resolve('/work/r2'))).toBeUndefined();
  });

  it('reads nothing from a stored value of the wrong shape', () => {
    const state = new MapMemento();
    state.map.set(WORKTREE_ROOTS_KEY, ['not', 'a', 'record']);
    expect(worktreeRoot(state, root)).toBeUndefined();
    state.map.set(WORKTREE_ROOTS_KEY, { [root]: 3 });
    expect(worktreeRoot(state, root)).toBeUndefined();
  });
});
