// Deadlines count ticks of main's own timer, not wall-clock time: a stall of main's event loop costs one tick, and a message
// that arrived during it is handled before the next.
const DEADLINE_TICK_MS = 250;

/** Runs `expire` after ceil(deadlineMs / DEADLINE_TICK_MS) ticks; the returned function cancels it. */
export function tickDeadline(deadlineMs: number, expire: () => void): () => void {
  let ticksLeft = Math.ceil(deadlineMs / DEADLINE_TICK_MS);
  const timer = setInterval(() => {
    ticksLeft--;
    if (ticksLeft > 0) return;
    clearInterval(timer);
    expire();
  }, DEADLINE_TICK_MS);
  return () => clearInterval(timer);
}
