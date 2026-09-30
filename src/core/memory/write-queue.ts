import type { DatabaseInstance } from './types';

/** A queued write refused because a newer Damocles has migrated the store past this build's schema. */
export class MemoryReadOnlyError extends Error {
  constructor() {
    super('The memory database is read only: another Damocles app has updated it to a newer version.');
    this.name = 'MemoryReadOnlyError';
  }
}

export interface WriteQueueSchemaGuard {
  /** Reads the on-disk schema version; true when a newer Damocles has migrated the store past this build. */
  isAhead(): boolean;
  /** Runs once, when a write first finds the store ahead; from then on the queue refuses every write. */
  onAhead(): void;
}

/**
 * Serializes all memory writes through one in-process promise chain, so the invariant re-check and
 * dependent mutations of one read-modify-write operation complete before the next begins. The LLM
 * call stays outside the queued callback; the callback does only synchronous DB work.
 *
 * Each callback runs inside a single DB transaction (when a database is supplied), so the sequence
 * commits atomically against another process's interleaving writes and the DB is written once at
 * commit rather than per statement. A read-only callback opens and commits an empty transaction.
 *
 * With a schema guard, each transaction first re-reads the schema version under the write lock, because
 * a newer Damocles can migrate the shared store while this one holds it open.
 */
export class MemoryWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly db: DatabaseInstance | undefined;
  private readonly guard: WriteQueueSchemaGuard | undefined;
  private readOnly: boolean;

  /** `db` is optional so tests can construct a queue without one (callbacks then run unwrapped). */
  constructor(db?: DatabaseInstance, guard?: WriteQueueSchemaGuard, readOnly = false) {
    this.db = db;
    this.guard = guard;
    this.readOnly = readOnly;
  }

  /**
   * Run `fn` after all queued work settles, inside one DB transaction. `fn` should be synchronous so
   * the transaction never spans an `await`. A rejection is propagated to its caller (and rolls back)
   * without breaking the chain for the next. A read-only store rejects with {@link MemoryReadOnlyError}.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.runOne(fn));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Like {@link run} but WITHOUT the `BEGIN IMMEDIATE…COMMIT` wrapper, for statements SQLite rejects
   * mid-transaction (notably `VACUUM`). Still chains onto the same serialization `tail`.
   */
  runOutsideTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.readOnly || this.detectAhead()) throw new MemoryReadOnlyError();
      return fn();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Resolves once all queued work has settled, so dispose closes the DB only after writes finish. */
  drain(): Promise<void> {
    return this.tail.then(() => undefined, () => undefined);
  }

  private runOne<T>(fn: () => T | Promise<T>): T | Promise<T> {
    if (this.readOnly) throw new MemoryReadOnlyError();
    const db = this.db;
    if (!db) return fn();
    let ahead = false;
    // The refusal commits the empty transaction rather than throwing through it, which would count as a persist failure.
    const result = db.transaction(() => {
      ahead = this.guard?.isAhead() ?? false;
      return ahead ? undefined : (fn as () => T)();
    });
    if (ahead) {
      this.enterReadOnly();
      throw new MemoryReadOnlyError();
    }
    return result as T;
  }

  private detectAhead(): boolean {
    if (!this.guard?.isAhead()) return false;
    this.enterReadOnly();
    return true;
  }

  private enterReadOnly(): void {
    this.readOnly = true;
    this.guard?.onAhead();
  }
}
