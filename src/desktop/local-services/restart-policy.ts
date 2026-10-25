// Damocles Core's restart policy (docs/invariants.md "Desktop host", VS Code's extension host policy), shared by desktop
// main and the daemon.

export const RESTART_LIMIT = 3;
export const RESTART_WINDOW_MS: number = 5 * 60 * 1000;

export type RestartDecision =
  | { readonly restart: true; readonly crashes: readonly number[]; readonly count: number }
  | { readonly restart: false; readonly crashes: readonly number[] };

/**
 * A crash at `now` given the earlier crashes' times: core restarts while fewer than RESTART_LIMIT restarts happened in the
 * rolling RESTART_WINDOW_MS, and stays down past that. `count` is this restart's place among them.
 */
export function restartDecision(crashes: readonly number[], now: number): RestartDecision {
  const recent = crashes.filter((at) => now - at < RESTART_WINDOW_MS);
  const next = [...recent, now];
  return recent.length < RESTART_LIMIT ? { restart: true, crashes: next, count: recent.length + 1 } : { restart: false, crashes: next };
}
