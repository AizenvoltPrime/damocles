import { log } from '../logger';

/** Retries of an apply that failed or was cut short: one pending at a time, one per delay, until a reset. */
export interface ApplyRetry {
  /** The apply failed or was cut short: the next attempt is scheduled unless one is pending or the attempts ran out. */
  failed(): void;
  /** An apply succeeded, or a new change runs its own apply: the attempts start over and a pending one is cancelled. */
  reset(): void;
  dispose(): void;
}

export function createApplyRetry(label: string, delaysMs: readonly number[], attempt: () => void): ApplyRetry {
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    failed() {
      if (disposed || timer !== null) return;
      const delay = delaysMs[attempts];
      if (delay === undefined) {
        log('[ApplyRetry] %s: gave up after %d attempts; the next change or sync applies it', label, attempts);
        return;
      }
      attempts++;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) attempt();
      }, delay);
    },
    reset() {
      attempts = 0;
      cancel();
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
