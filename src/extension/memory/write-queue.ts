import type { DatabaseInstance } from './types';

/**
 * Serializes all memory writes through one in-process promise chain, so the invariant re-check and
 * dependent mutations of one read-modify-write operation complete before the next begins. The LLM
 * call stays outside the queued callback; the callback does only synchronous DB work.
 *
 * Each callback runs inside a single DB transaction (when a database is supplied), so the sequence
 * commits atomically against another process's interleaving writes and the DB is written once at
 * commit rather than per statement. A read-only callback opens and commits an empty transaction.
 */
export class MemoryWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly db: DatabaseInstance | undefined;

  /** `db` is optional so tests can construct a queue without one (callbacks then run unwrapped). */
  constructor(db?: DatabaseInstance) {
    this.db = db;
  }

  /**
   * Run `fn` after all queued work settles, inside one DB transaction. `fn` should be synchronous so
   * the transaction never spans an `await`. A rejection is propagated to its caller (and rolls back)
   * without breaking the chain for the next.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const wrapped = this.db ? (): T | Promise<T> => this.db!.transaction(fn as () => T) : fn;
    const result = this.tail.then(() => wrapped());
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Like {@link run} but WITHOUT the `BEGIN IMMEDIATE…COMMIT` wrapper, for statements SQLite rejects
   * mid-transaction (notably `VACUUM`). Still chains onto the same serialization `tail`.
   */
  runOutsideTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Resolves once all queued work has settled, so dispose closes the DB only after writes finish. */
  drain(): Promise<void> {
    return this.tail.then(() => undefined, () => undefined);
  }
}
