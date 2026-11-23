// A see-through chat view takes its slot only once it has painted (docs/invariants.md "Desktop themes"): a view shown for the
// first time, or again after it was hidden, paints nothing until its page renders a frame, and over a wallpaper that empty frame
// is the wallpaper alone. The new view is shown parked with one corner pixel inside the window, so its page renders while the
// previous view stays in place, then the two swap in one task.

// How long a switch waits for the new view's first frame before it swaps anyway.
export const REVEAL_TIMEOUT_MS = 500;

export interface RevealSteps {
  // shows the new view parked, all but one corner pixel outside the window
  park(): void;
  // settles once the new view's page has rendered a frame
  painted(): Promise<unknown>;
  // whether this switch is still the newest one
  current(): boolean;
  // moves the new view onto its slot and hides every other chat view, in one task
  swap(): void;
}

/** Runs one switch; true when it swapped, false when a newer switch took over meanwhile. */
export async function revealAfterPaint(steps: RevealSteps, timeoutMs: number = REVEAL_TIMEOUT_MS): Promise<boolean> {
  steps.park();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([steps.painted().catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (!steps.current()) return false;
  steps.swap();
  return true;
}

/** The parked rectangle: the slot's size, placed so only its top-left pixel is inside a window of `width` x `height`. */
export function parkedBounds(slot: { readonly width: number; readonly height: number }, window: { readonly width: number; readonly height: number }): { x: number; y: number; width: number; height: number } {
  return { x: Math.max(0, window.width - 1), y: Math.max(0, window.height - 1), width: slot.width, height: slot.height };
}
