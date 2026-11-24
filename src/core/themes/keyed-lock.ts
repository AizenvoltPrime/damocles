// One body at a time per key, in arrival order. A waiter whose signal aborts leaves the queue with the abort reason. Not re-entrant.

export interface KeyedLock {
  run<T>(key: string, signal: AbortSignal | undefined, body: () => Promise<T>): Promise<T>;
  // keys with a running body or a waiter
  size(): number;
}

export function createKeyedLock(): KeyedLock {
  // each key's tail: settles once the last body queued on it is done
  const tails = new Map<string, Promise<void>>();
  return {
    async run(key, signal, body) {
      signal?.throwIfAborted();
      const before = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => { release = resolve; });
      const tail = before.then(() => mine);
      tails.set(key, tail);
      // a key goes once its last queued body is done, never while an earlier one still runs
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => reject(signal!.reason);
          signal?.addEventListener('abort', onAbort, { once: true });
          void before.then(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
        });
        signal?.throwIfAborted();
        return await body();
      } finally {
        release();
      }
    },
    size: () => tails.size,
  };
}
