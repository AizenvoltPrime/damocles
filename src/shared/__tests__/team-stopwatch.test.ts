import { describe, expect, it } from 'vitest';
import { runStopwatch, runsStopwatch, stopStopwatch, stopwatchElapsedMs } from '../team-stopwatch';

describe('the team stopwatch', () => {
  it('adds the open segment to the closed ones, and holds still while stopped', () => {
    expect(stopwatchElapsedMs({ activeMs: 5_000, runningSince: 100_000 }, 103_000)).toBe(8_000);
    expect(stopwatchElapsedMs({ activeMs: 5_000, runningSince: null }, 999_000)).toBe(5_000);
  });

  it('never runs backwards when the clock reads before the segment opened', () => {
    expect(stopwatchElapsedMs({ activeMs: 5_000, runningSince: 100_000 }, 90_000)).toBe(5_000);
  });

  it('stops at the given time, and stopping a stopped one changes nothing', () => {
    const stopped = stopStopwatch({ activeMs: 1_000, runningSince: 10_000 }, 12_500);
    expect(stopped).toEqual({ activeMs: 3_500, runningSince: null });
    expect(stopStopwatch(stopped, 50_000)).toEqual(stopped);
  });

  it('times a run from its start to its end, or from its start while it runs', () => {
    expect(runStopwatch({ startTime: 1_000, endTime: 4_000 })).toEqual({ activeMs: 3_000, runningSince: null });
    expect(runStopwatch({ startTime: 1_000, endTime: null })).toEqual({ activeMs: 0, runningSince: 1_000 });
  });

  it('sums a team runs with no gap between them, the live run still open', () => {
    const runs = [{ startTime: 0, endTime: 600_000 }, { startTime: 5_340_000, endTime: 5_400_000 }, { startTime: 9_000_000, endTime: null }];
    expect(runsStopwatch(runs)).toEqual({ activeMs: 660_000, runningSince: 9_000_000 });
    expect(stopwatchElapsedMs(runsStopwatch(runs), 9_010_000)).toBe(670_000);
    expect(runsStopwatch([])).toEqual({ activeMs: 0, runningSince: null });
  });
});
