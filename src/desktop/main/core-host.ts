export interface CoreHostDeps<C extends { dispose(): Promise<void> }> {
  // builds the core services and everything that listens to them
  readonly start: () => C;
  // restores the persisted tabs into the new core
  readonly openTabs: () => Promise<void>;
  // while set, a closing tab keeps its persisted state and selection
  readonly retainTabStates: (retain: boolean) => void;
  readonly log: (line: string) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

/**
 * The running core services. A reload tears the core down and builds a new one; a second reload while one runs joins it,
 * and once disposal began a reload does nothing, so two cores never run side by side and none outlives the quit.
 */
export class CoreHost<C extends { dispose(): Promise<void> }> {
  private readonly deps: CoreHostDeps<C>;
  private core: C | undefined;
  private reloading: Promise<void> | undefined;
  private stopped = false;

  constructor(deps: CoreHostDeps<C>) {
    this.deps = deps;
  }

  // undefined before start, while a reload rebuilds it, and after dispose
  current(): C | undefined {
    return this.core;
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

  // Waits for a reload in flight, then disposes the core it left; never rejects.
  async dispose(): Promise<void> {
    this.stopped = true;
    await this.reloading?.catch(() => undefined);
    await this.disposeCore();
  }

  private async runReload(): Promise<void> {
    this.deps.retainTabStates(true);
    try {
      await this.disposeCore();
    } finally {
      // A quit that began meanwhile keeps the states retained for its own teardown.
      if (!this.stopped) this.deps.retainTabStates(false);
    }
    if (this.stopped) return;
    this.start();
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
