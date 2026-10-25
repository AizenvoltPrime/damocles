import { bounded } from './shutdown';

/** A core main runs: it is handed to callers once it is ready, and dispose ends it. */
export interface HostedCore {
  // settles once the core is ready; rejects when it ended first
  readonly ready: Promise<void>;
  isReady(): boolean;
  // its process ended, whether it was ever ready or not; it never runs again
  hasEnded(): boolean;
  dispose(): Promise<void>;
}

export interface CoreHostDeps<C extends HostedCore> {
  // builds the core services and everything that listens to them
  readonly start: () => C;
  // restores the persisted tabs into the new core; afterRestart: a reload's own reopening, into the core that replaced one
  readonly openTabs: (afterRestart: boolean) => Promise<void>;
  // while set, a closing tab keeps its persisted state and selection
  readonly retainTabStates: (retain: boolean) => void;
  readonly log: (line: string) => void;
  // how long a reload waits for the requests running on the old core before it disposes that core anyway
  readonly drainTimeoutMs: number;
  // halted() changed
  readonly haltedChanged: () => void;
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
const notRunning = (): Error => new Error('The Damocles engine is not running');

interface Request<C> {
  readonly label: string;
  readonly core: C;
}

/**
 * The running core services. A reload tears the core down and builds a new one; a second reload while one runs joins it
 * until it starts its core and runs after it from then on, and once the quit stopped the host a reload starts no core, so two
 * cores never run side by side and none outlives the quit.
 * A core reaches callers only once its ready settles.
 */
export class CoreHost<C extends HostedCore> {
  private readonly deps: CoreHostDeps<C>;
  private core: C | undefined;
  private reloading: Promise<void> | undefined;
  // the reload under way started its core, so a reload asked for from now on cannot join it
  private reloadStarted = false;
  // the reload asked for after the one under way started its core, which runs once that one settles
  private queuedReload: Promise<void> | undefined;
  // The core the reload under way starts, rejected when it starts none. A reload whose core ended before it was ready leaves
  // it to the crash path, whose restart resolves it and whose halt refuses it.
  private next: NextCore<C> | undefined;
  // the reload under way stopped handing out the running core: it waited for the tabs reopening and now replaces it
  private replacing = false;
  private stopped = false;
  // a halt left no core, and no reload has started since
  private haltedNow = false;
  private readonly stopping: Promise<void>;
  private signalStop!: () => void;
  // each request run() runs, by the promise that settles with it
  private readonly running = new Map<Promise<void>, Request<C>>();
  // the reopening of the tabs under way outside a reload
  private readonly opening = new Set<Promise<void>>();

  constructor(deps: CoreHostDeps<C>) {
    this.deps = deps;
    this.stopping = new Promise((resolve) => (this.signalStop = resolve));
  }

  // undefined before the core is ready, while a reload rebuilds it, after a halt and after dispose; while a reload waits for
  // requests, the old core
  current(): C | undefined {
    return this.core?.isReady() ? this.core : undefined;
  }

  /** A halt ended the engine and no reload has started since; false during a restart or reload, and once the quit stopped the host. */
  halted(): boolean {
    return this.haltedNow && !this.stopped;
  }

  /** The core started last, ready, running or ended, until it is disposed. */
  started(): C | undefined {
    return this.core;
  }

  /**
   * During a reload the core it starts, else the running core once ready, else, for a core that ended (before it was ready
   * too), the core the crash path starts in its place; rejects when there is none to wait for.
   */
  ready(): Promise<C> {
    const core = this.core;
    const live = core !== undefined && !core.hasEnded();
    if (this.next && (this.replacing || !live)) return this.next.promise;
    if (core && live) return core.isReady() ? Promise.resolve(core) : core.ready.then(() => core, (err: unknown) => this.replacementOf(err));
    return Promise.reject(this.stopped ? stoppedForQuit() : notRunning());
  }

  /** Runs work on ready()'s core, which a reload disposes only once work settled; work passes that core on, never asking ready() again. */
  run<T>(label: string, work: (core: C) => T | Promise<T>): Promise<T> {
    const core = this.current();
    if (!this.replacing && core) return this.track(label, core, work);
    return this.ready().then((ready) => this.track(label, ready, work));
  }

  /**
   * run() for work that is safe to repeat, such as a list: work whose core ended under it runs once more on the core that
   * replaces it, which main has already begun starting by the time work sees its core's channel close.
   */
  read<T>(label: string, work: (core: C) => T | Promise<T>): Promise<T> {
    let ranOn: C | undefined;
    return this.run(label, (core) => {
      ranOn = core;
      return work(core);
    }).catch((err: unknown) => {
      if (ranOn === undefined || !ranOn.hasEnded()) throw err;
      return this.run(label, work);
    });
  }

  /** Reopens the persisted tabs into the running core; under a reload, that reload's own reopening. */
  openTabs(): Promise<void> {
    if (this.reloading) return this.reloading;
    const opening = this.deps.openTabs(false);
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

  /**
   * Joins the reload under way until it starts its core, since that core is built from what holds then; one asked for later
   * runs once that reload settles, and every request meanwhile joins it (VS Code's Throttler).
   */
  reload(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.setHalted(false);
    if (this.reloading && this.reloadStarted) {
      this.queuedReload ??= this.reloading.catch(() => undefined).then(() => {
        this.queuedReload = undefined;
        return this.reload();
      });
      return this.queuedReload;
    }
    this.reloading ??= this.runReload().finally(() => {
      this.reloading = undefined;
      this.reloadStarted = false;
    });
    return this.reloading;
  }

  /**
   * Replaces a core that crashed: once any reload under way settled, a reload, unless that reload already started a core
   * other than the crashed one.
   */
  restart(crashed: C): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // at once when no reload runs, so a request made from here on waits for the new core
    if (!this.reloading) return this.reload();
    return this.reloading.catch(() => undefined).then(() => {
      if (this.stopped || (this.core !== undefined && this.core !== crashed)) return undefined;
      return this.reload();
    });
  }

  /** Ends the running core and starts none until the next reload: the tabs keep their states for it. */
  async halt(): Promise<void> {
    if (this.stopped) return;
    await this.reloading?.catch(() => undefined);
    if (!this.reloading) {
      this.next?.reject(notRunning());
      this.next = undefined;
    }
    if (this.core) await this.drain(this.core);
    this.deps.retainTabStates(true);
    try {
      await this.disposeCore();
    } finally {
      if (!this.stopped) this.deps.retainTabStates(false);
    }
    if (!this.stopped && !this.reloading && this.core === undefined) this.setHalted(true);
  }

  /** The quit can no longer be cancelled: a reload under way starts no core, and a request waiting for one is refused now. */
  stop(): void {
    this.stopped = true;
    this.signalStop();
    this.next?.reject(stoppedForQuit());
  }

  // Waits for a reload in flight, then disposes the core it left; never rejects.
  async dispose(): Promise<void> {
    this.stop();
    await this.reloading?.catch(() => undefined);
    await this.disposeCore();
  }

  private setHalted(halted: boolean): void {
    if (this.haltedNow === halted) return;
    this.haltedNow = halted;
    this.deps.haltedChanged();
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

  // A core that ended before it was ready: the core the crash path started in its place, else that core's failure.
  private replacementOf(err: unknown): Promise<C> {
    return this.next ? this.next.promise : Promise.reject(err);
  }

  private async runReload(): Promise<void> {
    // Set at once, so a request made from here on waits for the new core when the running one already ended (a crash).
    const next = this.next ?? nextCore<C>();
    this.next = next;
    // the crash path of a core that ended before it was ready settles next
    let leftToCrashPath = false;
    try {
      // VS Code takes a reload only once the window restored; the tabs being reopened go back into the core they started on.
      if (this.opening.size > 0) await Promise.all(this.opening);
      if (this.stopped) return;
      this.replacing = true;
      if (this.core) await this.drain(this.core);
      this.deps.retainTabStates(true);
      try {
        await this.disposeCore();
      } finally {
        // A quit that began meanwhile keeps the states retained for its own teardown.
        if (!this.stopped) this.deps.retainTabStates(false);
      }
      if (this.stopped) return;
      this.reloadStarted = true;
      const core = this.start();
      // the quit disposes a core that is not ready yet instead of waiting for it
      await Promise.race([core.ready, this.stopping]);
      if (this.stopped) return;
      next.resolve(core);
    } catch (err) {
      leftToCrashPath = this.core?.hasEnded() === true && !this.stopped;
      if (!leftToCrashPath) next.reject(err);
      throw err;
    } finally {
      this.replacing = false;
      if (!leftToCrashPath) this.next = undefined;
    }
    await this.deps.openTabs(true);
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
