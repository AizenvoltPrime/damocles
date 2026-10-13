import type { Memento } from '../../platform/key-value-state';

const chains = new WeakMap<Memento, Map<string, Promise<void>>>();

/**
 * A read-modify-write of one key of state, run after every earlier one on that key has landed, so no update reads a value
 * another is still writing. The returned promise rejects with the update's own failure; the chain goes on regardless.
 */
export function updateSerially(state: Memento, key: string, next: (current: unknown) => unknown): Promise<void> {
  let keys = chains.get(state);
  if (!keys) {
    keys = new Map();
    chains.set(state, keys);
  }
  const run = (keys.get(key) ?? Promise.resolve()).then(() => state.update(key, next(state.get<unknown>(key))));
  keys.set(key, run.catch(() => undefined));
  return run;
}
