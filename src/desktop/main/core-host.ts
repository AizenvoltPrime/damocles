import { bounded } from './shutdown';

export interface CoreHostDeps<C extends { dispose(): Promise<void> }> {
  // builds the core services and everything that listens to them
  readonly start: () => C;
  // restores the persisted tabs into the new core
  readonly openTabs: () => Promise<void>;
  // while set, a closing tab keeps its persisted state and selection
  readonly retainTabStates: (retain: boolean) => void;
  readonly log: (line: string) => void;
  // how long a reload waits for the requests running on the old core before it disposes that core anyway
  readonly drainTimeoutMs: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

interface NextCore<C> {
  readonly promise: Promise<C>;
  readonly resolve: (core: C) => void;
  readonly reject: (err: unknown) => void;
}

function nextCore<C>(): NextCore<C> {
  let resolve!: (core: C) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<C>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // A reload nobody waited on must not report an unhandled rejection; every waiter still sees it.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const stoppedForQuit = (): Error => new Error('Core services are stopped for the quit');

interface Request<C> {
  readonly label: string;
  readonly core: C;
}

/**
 * The running core services. A reload tears the core down and builds a new one; a second reload while one runs joins it,
 * and once the quit stopped the host a reload starts no core, so two cores never run side by side and none outlives the quit.
 */
export class CoreHost<C extends { dispose(): Promise<void> }> {
  private readonly deps: CoreHostDeps<C>;
  private core: C | undefined;
  private reloading: Promise<void> | undefined;
  // the core the reload under way starts; rejected when it starts none
  private next: NextCore<C> | undefined;
  private stopped = false;
  // each request run() runs, by the promise that settles with it
  private readonly running = new Map<Promise<void>, Request<C>>();
  // the reopening of the tabs under way outside a reload
  private readonly opening = new Set<Promise<void>>();

  constructor(deps: CoreHostDeps<C>) {
    this.deps = deps;
  }

  // undefined before start, while a reload rebuilds it, and after dispose; while a reload waits for requests, the old core
  current(): C | undefined {
    return this.core;
  }

  /** During a reload the core it starts, else the running core; rejects when there is none to wait for. */
  ready(): Promise<C> {
    if (this.next) return this.next.promise;
    if (this.core) return Promise.resolve(this.core);
    return Promise.reject(this.stopped ? stoppedForQuit() : new Error('Core services are not running'));
  }

  /** Runs work on ready()'s core, which a reload disposes only once work settled; work passes that core on, never asking ready() again. */
  run<T>(label: string, work: (core: C) => T | Promise<T>): Promise<T> {
    if (!this.next && this.core) return this.track(label, this.core, work);
    return this.ready().then((core) => this.track(label, core, work));
  }

  /** Reopens the persisted tabs into the running core; under a reload, that reload's own reopening. */
  openTabs(): Promise<void> {
    if (this.reloading) return this.reloading;
    const opening = this.deps.openTabs();
    const settled = opening.then(() => undefined, () => undefined);
    this.opening.add(settled);
    void settled.then(() => this.opening.delete(settled));
    return opening;
  }

  start(): C {
    if (this.core) throw new Error('The core services are already running');
    this.core = this.deps.start();
    return this.core;
  }

  reload(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.reloading ??= this.runReload().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  /** The quit can no longer be cancelled: a reload under way starts no core, and a request waiting for one is refused now. */
  stop(): void {
    this.stopped = true;
    this.next?.reject(stoppedForQuit());
  }

  // Waits for a reload in flight, then disposes the core it left; never rejects.
  async dispose(): Promise<void> {
    this.stop();
    await this.reloading?.catch(() => undefined);
    await this.disposeCore();
  }

  private track<T>(label: string, core: C, work: (core: C) => T | Promise<T>): Promise<T> {
    // The async wrapper calls work before returning, and turns what it throws into a rejection.
    const result = (async () => work(core))();
    const settled = result.then(() => undefined, () => undefined);
    this.running.set(settled, { label, core });
    void settled.then(() => this.running.delete(settled));
    return result;
  }

  // Waits for the requests running on core, for at most drainTimeoutMs, and logs those still running then (VS Code joins pending work before a shutdown).
  private async drain(core: C): Promise<void> {
    const onCore = [...this.running].filter(([, request]) => request.core === core).map(([settled]) => settled);
    await bounded(Promise.all(onCore), this.deps.drainTimeoutMs, () => {
      const labels = onCore.flatMap((settled) => this.running.get(settled)?.label ?? []);
      const count = labels.length === 1 ? 'a request' : `${labels.length} requests`;
      this.deps.log(`[core] reloading with ${count} still running on the old core after ${this.deps.drainTimeoutMs} ms: ${labels.join(', ')}`);
    });
  }

  private async runReload(): Promise<void> {
    // VS Code takes a reload only once the window restored; the tabs being reopened go back into the core they started on.
    if (this.opening.size > 0) await Promise.all(this.opening);
    if (this.stopped) return;
    const next = nextCore<C>();
    this.next = next;
    try {
      if (this.core) await this.drain(this.core);
      this.deps.retainTabStates(true);
      try {
        await this.disposeCore();
      } finally {
        // A quit that began meanwhile keeps the states retained for its own teardown.
        if (!this.stopped) this.deps.retainTabStates(false);
      }
      if (this.stopped) return;
      next.resolve(this.start());
    } catch (err) {
      next.reject(err);
      throw err;
    } finally {
      this.next = undefined;
    }
    await this.deps.openTabs();
  }

  // A core that fails to dispose is logged and dropped: the reload or quit that asked for it still goes ahead.
  private async disposeCore(): Promise<void> {
    const core = this.core;
    this.core = undefined;
    if (!core) return;
    try {
      await core.dispose();
    } catch (err) {
      this.deps.log(`[core] dispose failed: ${errorText(err)}`);
    }
  }
}
