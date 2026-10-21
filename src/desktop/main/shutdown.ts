export interface ShutdownSteps {
  // resolves once no window is left and every request its pages made has been answered
  readonly closeWindows: () => Promise<void>;
  readonly disposeCore: () => Promise<void>;
  // every store's writes, those the core's dispose queued included
  readonly flushStores: () => Promise<void>;
  readonly disposeTerminals: () => Promise<void>;
  // stops every file watch and settles once no native watcher work is running, which must not outlive the quit
  readonly closeWatchers: () => Promise<void>;
  // the share of timeoutMs closeWindows may take; the rest always goes to the dispose and the flush
  readonly closeTimeoutMs: number;
  readonly timeoutMs: number;
  readonly log: (line: string) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Settles with work, or once ms have passed, after onTimeout.
export async function bounded(work: Promise<unknown>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, ms);
  });
  try {
    await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The quit's teardown once nothing can cancel it. The windows close first, so no page can call into a service being
 * disposed (VS Code's onWillShutdown fires only after the last window closed, lifecycleMainService.ts); then the core, the
 * terminals and the file watchers, and the stores last. Both the teardown and its wait for the windows are bounded, so a
 * hung step cannot block quitting and a request that never settles cannot skip the dispose and the flush.
 */
export async function shutDown(steps: ShutdownSteps): Promise<void> {
  const closed = bounded(steps.closeWindows(), steps.closeTimeoutMs, () => steps.log(`[shutdown] the window's requests did not settle within ${steps.closeTimeoutMs} ms; disposing anyway`));
  const disposed = closed.then(() => Promise.all([steps.disposeCore().finally(() => steps.flushStores()), steps.disposeTerminals(), steps.closeWatchers()]));
  await bounded(disposed, steps.timeoutMs, () => steps.log(`[shutdown] teardown did not finish within ${steps.timeoutMs} ms; quitting anyway`));
}

// releasing: the quit asks about terminals and editors and can still be cancelled; disposing: it no longer can.
export type QuitPhase = 'running' | 'releasing' | 'disposing' | 'done';

export interface QuitApp {
  quit(): void;
  relaunch(): void;
  once(event: 'quit', listener: () => void): unknown;
  removeListener(event: 'quit', listener: () => void): unknown;
}

export interface QuitLifecycleDeps {
  readonly app: QuitApp;
  // asks about running terminals and unsaved editors; false when the user cancelled
  readonly release: () => Promise<boolean>;
  // the teardown once nothing can cancel the quit
  readonly dispose: () => Promise<void>;
  readonly log: (line: string) => void;
}

/**
 * The app's quit, which the user can cancel until its last question is answered. Every close and quit shares the
 * question under way, and every quit the quit under way, which resolves true when the user cancelled it, as VS Code's
 * lifecycle does (lifecycleMainService.ts:641 doQuit).
 */
export class QuitLifecycle {
  private readonly deps: QuitLifecycleDeps;
  private current: QuitPhase = 'running';
  private pendingQuit: Promise<boolean> | undefined;
  private pendingRelease: Promise<boolean> | undefined;

  constructor(deps: QuitLifecycleDeps) {
    this.deps = deps;
  }

  get phase(): QuitPhase {
    return this.current;
  }

  // true while a close or quit asks its questions
  get releasing(): boolean {
    return this.pendingRelease !== undefined;
  }

  /** Asks about the running terminals and unsaved editors, once for every caller while the question is open. */
  release(): Promise<boolean> {
    // deps.release starts on a later microtask, so a question it asks at once already sees releasing.
    this.pendingRelease ??= Promise.resolve().then(() => this.deps.release()).finally(() => {
      this.pendingRelease = undefined;
    });
    return this.pendingRelease;
  }

  onBeforeQuit(event: { preventDefault(): void }): void {
    if (this.current === 'done') return;
    event.preventDefault();
    this.pendingQuit ??= this.run();
  }

  /** Quits through app.quit(); resolves true when the user cancelled the quit, false once it tore everything down. */
  quit(): Promise<boolean> {
    if (this.current === 'done') return Promise.resolve(false);
    // app.quit() emits before-quit, which starts the quit.
    if (!this.pendingQuit) this.deps.app.quit();
    this.pendingQuit ??= this.run();
    return this.pendingQuit;
  }

  /** Relaunches after a quit nobody cancelled; a cancelled one leaves no relaunch armed (lifecycleMainService.ts:681). */
  async relaunch(): Promise<void> {
    const relaunch = (): void => this.deps.app.relaunch();
    this.deps.app.once('quit', relaunch);
    if (await this.quit()) this.deps.app.removeListener('quit', relaunch);
  }

  private async run(): Promise<boolean> {
    this.current = 'releasing';
    this.deps.log('[shutdown] quitting');
    let proceed = false;
    try {
      proceed = await this.release();
    } catch (err) {
      this.deps.log(`[shutdown] cancelled: the editors could not be released: ${errorText(err)}`);
    }
    if (!proceed) {
      this.deps.log('[shutdown] cancelled');
      this.current = 'running';
      this.pendingQuit = undefined;
      return true;
    }
    this.current = 'disposing';
    try {
      await this.deps.dispose();
    } catch (err) {
      this.deps.log(`[shutdown] the teardown failed: ${errorText(err)}`);
    }
    this.current = 'done';
    this.deps.log('[shutdown] disposed; quitting');
    // A quit started in native code (Cmd+Q, the Dock, logout, CDP Browser.close) stores this handler's prevented result
    // only after the handler's microtasks have run, which overwrites a quit made from them; macOS then keeps running.
    // Callers awaiting this quit run first, in microtasks, so the updater starts its installer before the app quits.
    setImmediate(() => this.deps.app.quit());
    return false;
  }
}
