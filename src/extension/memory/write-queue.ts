/**
 * Serializes all memory writes through one in-process promise chain (D3).
 *
 * MemoryService is a de-facto singleton shared by every panel, and dedup /
 * conflict-resolution are read-modify-write sequences. Running them under this
 * queue guarantees that the invariant re-check and the dependent mutations of
 * one operation complete before the next begins — the LLM call stays OUTSIDE
 * the queued callback; the callback itself does only synchronous DB work with
 * no `await` between dependent writes.
 */
export class MemoryWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` after all previously queued work settles. The callback should be
   * synchronous (re-check invariants, then mutate) so dependent writes are not
   * interleaved. A rejection in one callback does not break the chain for the
   * next, but is propagated to its own caller.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Resolves once all currently-queued work has settled. Used at dispose so the database is closed
   * only after in-flight writes finish — never mid-write against a closed handle.
   */
  drain(): Promise<void> {
    return this.tail.then(() => undefined, () => undefined);
  }
}
