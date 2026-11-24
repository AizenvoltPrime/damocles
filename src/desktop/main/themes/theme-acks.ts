// The theme revisions the window's pages painted (docs/invariants.md "Desktop themes"): a draft capture waits on them, so it
// captures the window only once the shell and the chat view on screen show the draft, never after a fixed delay.

// Past it a capture refuses with `timeout`: a wallpaper or font that has not drawn by then is not waited for.
export const THEME_APPLIED_TIMEOUT_MS = 5_000;

export interface ThemeAcksDeps {
  // the revision of what renderers get now (theme.ts currentThemeRevision); no page can have painted a newer one
  revision(): number;
  // the wait's timer; a desktop end-to-end run passes ones it holds (held-timers.ts)
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export class ThemeAcks {
  // by page (the shell's or a chat view's webContents), the newest revision its current document acknowledged
  private readonly applied = new WeakMap<object, number>();
  private readonly waiters = new Set<() => void>();
  private readonly deps: ThemeAcksDeps;

  constructor(deps: ThemeAcksDeps) {
    this.deps = deps;
  }

  /** The page painted `revision`; an older acknowledgement arriving late, or one of a revision main never sent, changes nothing. */
  acknowledged(page: object, revision: number): void {
    if (revision > this.deps.revision() || revision <= (this.applied.get(page) ?? -1)) return;
    this.applied.set(page, revision);
    for (const waiter of [...this.waiters]) waiter();
  }

  /** The page's document is going (a main-frame navigation started, or its renderer ended): what it painted goes with it. */
  forget(page: object): void {
    this.applied.delete(page);
  }

  /**
   * Whether every page painted the revision current at each check within `timeoutMs`: a paint can start reads that change the
   * look again (a wallpaper's dim), which the same wait then covers. Rejects when `signal` aborts.
   */
  until(pages: readonly object[], signal: AbortSignal, timeoutMs: number = THEME_APPLIED_TIMEOUT_MS): Promise<boolean> {
    signal.throwIfAborted();
    const done = (): boolean => {
      const revision = this.deps.revision();
      return pages.every((page) => (this.applied.get(page) ?? -1) >= revision);
    };
    if (done()) return Promise.resolve(true);
    const setTimer = this.deps.setTimer ?? setTimeout;
    const clearTimer = this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    return new Promise<boolean>((resolve, reject) => {
      const end = (): void => {
        clearTimer(timer);
        this.waiters.delete(check);
        signal.removeEventListener('abort', aborted);
      };
      const check = (): void => {
        if (!done()) return;
        end();
        resolve(true);
      };
      const aborted = (): void => {
        end();
        reject(signal.reason as Error);
      };
      const timer = setTimer(() => {
        end();
        resolve(false);
      }, timeoutMs);
      this.waiters.add(check);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
}
