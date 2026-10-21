import type { DatabaseInstance } from './types';

/**
 * `ahead`: a newer Damocles migrated the store past this build's schema. `damaged`: the integrity check found damage.
 * `moved`: the store's path no longer names the file this process opened.
 */
export type ReadOnlyReason = 'ahead' | 'damaged' | 'moved';

const READ_ONLY_MESSAGES: Record<ReadOnlyReason, string> = {
  ahead: 'The memory database is read only: another Damocles app has updated it to a newer version.',
  damaged: 'The memory database is read only: it is damaged and is repaired the next time Damocles starts.',
  moved: 'The memory database is read only: its file was moved or replaced after Damocles opened it. Restart Damocles to use the new one.',
};

/** A queued write refused because the store is read only in this process. */
export class MemoryReadOnlyError extends Error {
  constructor(reason: ReadOnlyReason = 'ahead') {
    super(READ_ONLY_MESSAGES[reason]);
    this.name = 'MemoryReadOnlyError';
  }
}

export interface WriteQueueGuard {
  /** Reads the on-disk schema version; true when a newer Damocles has migrated the store past this build. */
  isAhead(): boolean;
  /** Runs once, when a write first finds the store ahead; from then on the queue refuses every write. */
  onAhead(): void;
  /**
   * True when the store's path names another file than the one this process opened. On macOS and Linux another app's
   * repair can move the file aside while this one holds it, and writes would land in the moved file.
   */
  isMoved(): Promise<boolean>;
  /** Runs once, when a write first finds the file moved; from then on the queue refuses every write. */
  onMoved(): void;
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
 * With a guard, each item first checks that the store's path still names the file this process opened, and each
 * transaction re-reads the schema version under the write lock, because a newer Damocles can migrate the shared
 * store while this one holds it open.
 */
export class MemoryWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly db: DatabaseInstance | undefined;
  private readonly guard: WriteQueueGuard | undefined;
  private readOnly: ReadOnlyReason | null;

  /** `db` is optional so tests can construct a queue without one (callbacks then run unwrapped). */
  constructor(db?: DatabaseInstance, guard?: WriteQueueGuard, readOnly: ReadOnlyReason | null = null) {
    this.db = db;
    this.guard = guard;
    this.readOnly = readOnly;
  }

  /** Refuses every write queued from now on, those already waiting included, without asking the guard. */
  markReadOnly(reason: ReadOnlyReason): void {
    this.readOnly ??= reason;
  }

  /**
   * Run `fn` after all queued work settles, inside one DB transaction. `fn` should be synchronous so
   * the transaction never spans an `await`. A rejection is propagated to its caller (and rolls back)
   * without breaking the chain for the next. A read-only store rejects with {@link MemoryReadOnlyError}.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.detectMoved();
      return this.runOne(fn);
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Like {@link run} but WITHOUT the `BEGIN IMMEDIATE…COMMIT` wrapper, for statements SQLite rejects
   * mid-transaction (notably `VACUUM`). Still chains onto the same serialization `tail`.
   */
  runOutsideTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.detectMoved();
      if (this.readOnly) throw new MemoryReadOnlyError(this.readOnly);
      if (this.detectAhead()) throw new MemoryReadOnlyError();
      return fn();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Holds every item queued after it until `fn` settles. `fn` writes nothing through this connection, so nothing refuses it. */
  hold<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Resolves once all queued work has settled, so dispose closes the DB only after writes finish. */
  drain(): Promise<void> {
    return this.tail.then(() => undefined, () => undefined);
  }

  private runOne<T>(fn: () => T | Promise<T>): T | Promise<T> {
    if (this.readOnly) throw new MemoryReadOnlyError(this.readOnly);
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

  private async detectMoved(): Promise<void> {
    if (this.readOnly || !this.guard || !(await this.guard.isMoved()) || this.readOnly) return;
    this.readOnly = 'moved';
    this.guard.onMoved();
  }

  private detectAhead(): boolean {
    if (!this.guard?.isAhead()) return false;
    this.enterReadOnly();
    return true;
  }

  private enterReadOnly(): void {
    this.readOnly = 'ahead';
    this.guard?.onAhead();
  }
}
