// The double-click interval a page cannot read from the OS: Chromium's default where it has none, and Firefox's
// security.notification_enable_delay.
export const SHOWN_HOLD_MS = 500;

/** Runs `done` once a card has been shown for `SHOWN_HOLD_MS`; the answer cancels the wait. */
export function afterShownHold(done: () => void): () => void {
  const timer = setTimeout(done, SHOWN_HOLD_MS);
  return () => clearTimeout(timer);
}
