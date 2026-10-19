let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs a write that reads a list or object setting and writes it back after every one queued before it in this
 * process, so each reads what the previous one wrote: the stores change what they read only once a write has
 * landed. Every such writer (the settings panel's setters and the runtime's migrations) shares this one chain.
 * A write must not queue another and await it, which would wait on itself.
 */
export function serializeSettingWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = tail.then(write);
  // The chain only orders writes; each caller handles its own failure.
  tail = run.catch(() => undefined);
  return run;
}
