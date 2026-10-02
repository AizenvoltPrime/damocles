import type { TeamAgent, TeamRunSummary } from './types/team';

/**
 * A team agent's active time in its current attempt: the closed segments plus the open one's start.
 * Segments open at the agent's launch or resume entry and close when its run settles or the team stops.
 */
export type Stopwatch = Pick<TeamAgent, 'activeMs' | 'runningSince'>;

export function stopwatchElapsedMs(sw: Stopwatch, now: number): number {
  return sw.activeMs + (sw.runningSince === null ? 0 : Math.max(0, now - sw.runningSince));
}

/** Closing an already-closed stopwatch leaves it as it is. */
export function stopStopwatch(sw: Stopwatch, at: number): Stopwatch {
  return { activeMs: stopwatchElapsedMs(sw, at), runningSince: null };
}

export function runStopwatch(run: Pick<TeamRunSummary, 'startTime' | 'endTime'>): Stopwatch {
  return run.endTime === null
    ? { activeMs: 0, runningSince: run.startTime }
    : { activeMs: Math.max(0, run.endTime - run.startTime), runningSince: null };
}

/** A team's time across its runs: the ended runs' durations plus the live run's open span, so no gap between runs counts. */
export function runsStopwatch(runs: ReadonlyArray<Pick<TeamRunSummary, 'startTime' | 'endTime'>>): Stopwatch {
  return runs.map(runStopwatch).reduce<Stopwatch>(
    (sum, sw) => ({ activeMs: sum.activeMs + sw.activeMs, runningSince: sw.runningSince ?? sum.runningSince }),
    { activeMs: 0, runningSince: null },
  );
}
