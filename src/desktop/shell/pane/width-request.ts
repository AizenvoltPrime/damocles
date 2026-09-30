/** A requested pane width as main accepts it: a whole CSS px inside [min, max], or undefined when not a finite number. */
export function boundWidth(width: number, min: number, max: number): number | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  return Math.min(Math.max(Math.round(width), Math.ceil(min)), Math.max(Math.ceil(min), Math.floor(max)));
}

export interface WidthRequester {
  /** Queues a live width; only the latest one per animation frame is sent. */
  request(width: number): void;
  /** Sends the final width at once, marked for persisting, and drops any queued live width. */
  commit(width: number): void;
  dispose(): void;
}

export function createWidthRequester(
  send: (width: number, commit: boolean) => void,
  schedule: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
  cancel: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
): WidthRequester {
  let pending: number | undefined;
  let lastSent: number | undefined;
  let frame: number | undefined;

  const flush = (): void => {
    frame = undefined;
    const width = pending;
    pending = undefined;
    if (width === undefined || width === lastSent) return;
    lastSent = width;
    send(width, false);
  };

  const stop = (): void => {
    if (frame !== undefined) cancel(frame);
    frame = undefined;
    pending = undefined;
  };

  return {
    request(width) {
      pending = width;
      frame ??= schedule(flush);
    },
    commit(width) {
      stop();
      lastSent = width;
      send(width, true);
    },
    dispose: stop,
  };
}
