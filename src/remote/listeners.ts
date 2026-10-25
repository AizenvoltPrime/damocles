import type { Disposable } from './persistent-protocol';

export interface Listeners<A extends unknown[]> {
  add(listener: (...args: A) => void): Disposable;
  fire(...args: A): void;
}

// With log, each listener runs on its own and a throw is logged; without it a throw reaches the caller, and a throw inside a
// message's handling ends that connection.
export function listeners<A extends unknown[]>(log?: (line: string) => void): Listeners<A> {
  const set = new Set<(...args: A) => void>();
  return {
    add: (listener) => {
      set.add(listener);
      return { dispose: () => { set.delete(listener); } };
    },
    fire: (...args) => {
      for (const listener of [...set]) {
        if (!log) {
          listener(...args);
          continue;
        }
        try {
          listener(...args);
        } catch (err) {
          log(`[wire] a listener threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
    },
  };
}
