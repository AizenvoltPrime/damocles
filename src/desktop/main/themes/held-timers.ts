// Timers a desktop end-to-end test fires itself instead of waiting for the clock (the keep-changes countdown). Main builds
// one only in an unpackaged run with DAMOCLES_E2E_HOOKS=1; until `hold` is called it is setTimeout and clearTimeout.

export class HeldTimers {
  private atLeastMs: number | undefined;
  private readonly waiting = new Map<object, () => void>();

  /** From now on a timer of at least `ms` waits for `fire` instead of the clock; a shorter one runs as usual. */
  hold(ms: number): void {
    this.atLeastMs = ms;
  }

  /** Runs every waiting timer now, in the order they were set; how many ran. */
  fire(): number {
    const due = [...this.waiting.values()];
    this.waiting.clear();
    for (const callback of due) callback();
    return due.length;
  }

  readonly setTimer = (callback: () => void, ms: number): unknown => {
    if (this.atLeastMs === undefined || ms < this.atLeastMs) return setTimeout(callback, ms);
    const handle = {};
    this.waiting.set(handle, callback);
    return handle;
  };

  readonly clearTimer = (handle: unknown): void => {
    if (typeof handle === 'object' && handle !== null && this.waiting.delete(handle)) return;
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  };
}
