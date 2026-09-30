/** Coalesce window for live shell output frames. Wider than pi's 100ms because each frame crosses postMessage as a structured clone of a partial result pi has already capped at its own `DEFAULT_MAX_BYTES` (50KB). */
export const TOOL_OUTPUT_COALESCE_MS = 250;

/**
 * Rate-limit per-tool-call frames to one per window, keeping only the latest. Dropping intermediate
 * frames is lossless because a partial result is a replacement snapshot, not a delta.
 */
export class ToolOutputCoalescer<T> {
  private readonly emit: (payload: T) => void;
  private readonly windowMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly latest = new Map<string, () => T>();
  private disposed = false;

  constructor(emit: (payload: T) => void, windowMs: number = TOOL_OUTPUT_COALESCE_MS) {
    this.emit = emit;
    this.windowMs = windowMs;
  }

  /**
   * Leading edge on the first frame for an id, trailing edge with the latest payload thereafter.
   *
   * The payload is a thunk so anything read from the clock, such as elapsed time, is computed when the
   * frame is emitted rather than when it was pushed; a held frame would otherwise report a stale timer.
   */
  push(toolCallId: string, payload: () => T): void {
    if (this.disposed) return;
    if (this.timers.has(toolCallId)) {
      this.latest.set(toolCallId, payload);
      return;
    }
    this.emit(payload());
    this.openWindow(toolCallId);
  }

  /** Drop any pending frame for this id so a late partial cannot land after the terminal event. */
  cancel(toolCallId: string): void {
    const timer = this.timers.get(toolCallId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(toolCallId);
    this.latest.delete(toolCallId);
  }

  /** Drop every pending frame and leave the instance usable, for an owner that detaches but lives on. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.latest.clear();
  }

  /** Retire the coalescer for good. A torn-down owner must never fire into a dead panel, so a push
   *  arriving after this is dropped rather than opening a fresh window. */
  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private openWindow(toolCallId: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(toolCallId);
      const payload = this.latest.get(toolCallId);
      this.latest.delete(toolCallId);
      // An expiry with nothing stored closes the window, so the next push is a leading edge again.
      if (payload === undefined) return;
      this.emit(payload());
      this.openWindow(toolCallId);
    }, this.windowMs);
    this.timers.set(toolCallId, timer);
  }
}
