// The pty learns a size only once it has held, so a pane gliding open resizes the pty, and redraws the shell's prompt, once;
// input flushes a waiting size first, so the shell reads the user's keys at the width on screen.
// Adapted from VS Code's TerminalResizeDebouncer (src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts, MIT).

export interface PtySize {
  readonly cols: number;
  readonly rows: number;
}

// VS Code's DebounceResizeXDelay.
export const PTY_RESIZE_SETTLE_MS = 100;

export interface PtyResize {
  /** The size xterm was just fitted to; the pty gets it once no other size follows within the settle time. */
  request(size: PtySize): void;
  /** Sends a waiting size now; the view calls it before input reaches the pty. */
  flush(): void;
  /** Forgets the size the pty has, as a restarted process starts without one. */
  reset(): void;
  dispose(): void;
}

const same = (a: PtySize | undefined, b: PtySize | undefined): boolean => a?.cols === b?.cols && a?.rows === b?.rows;

export function createPtyResize(send: (size: PtySize) => void, settleMs = PTY_RESIZE_SETTLE_MS): PtyResize {
  let applied: PtySize | undefined;
  let pending: PtySize | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = (): void => {
    cancel();
    if (!pending) return;
    applied = pending;
    pending = undefined;
    send(applied);
  };
  return {
    request(size) {
      if (same(size, pending)) return;
      cancel();
      pending = same(size, applied) ? undefined : size;
      if (pending) timer = setTimeout(flush, settleMs);
    },
    flush,
    reset() {
      applied = undefined;
    },
    dispose() {
      cancel();
      pending = undefined;
    },
  };
}
