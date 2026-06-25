import type { DatabaseInstance } from './types';

/**
 * Serializes all memory writes through one in-process promise chain (D3).
 *
 * MemoryService is a de-facto singleton shared by every panel, and dedup /
 * conflict-resolution are read-modify-write sequences. Running them under this
 * queue guarantees that the invariant re-check and the dependent mutations of
 * one operation complete before the next begins — the LLM call stays OUTSIDE
 * the queued callback; the callback itself does only synchronous DB work with
 * no `await` between dependent writes.
 *
 * Each callback runs inside a single DB transaction (when a database is supplied):
 * the whole read-modify-write sequence commits atomically and the on-disk image is
 * written exactly ONCE at commit — never once per statement. This both keeps the
 * sequence atomic against another process's interleaving writes (reload-before-write
 * is suppressed mid-transaction) and avoids serializing the multi-MB DB on every row
 * of a multi-statement operation (e.g. a near-duplicate merge loop or the search-term
 * backfill). A read-only callback simply opens and commits an empty transaction.
 */
export class MemoryWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly db: DatabaseInstance | undefined;

  /**
   * @param db Database whose `transaction` wraps each callback. Optional so tests/legacy callers can
   *   construct a queue without one (then callbacks run unwrapped, persisting per statement as before).
   */
  constructor(db?: DatabaseInstance) {
    this.db = db;
  }

  /**
   * Run `fn` after all previously queued work settles, inside one DB transaction. The callback should
   * be synchronous (re-check invariants, then mutate) so dependent writes are not interleaved and the
   * transaction never spans an `await`. A rejection in one callback does not break the chain for the
   * next, but is propagated to its own caller (and rolls back its transaction).
   */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const wrapped = this.db ? (): T | Promise<T> => this.db!.transaction(fn as () => T) : fn;
    const result = this.tail.then(() => wrapped());
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
