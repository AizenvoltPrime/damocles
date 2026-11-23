import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIME_ZONE_TICK_MS, watchTimeZone } from '../themes/time-zone';

afterEach(() => {
  vi.useRealTimers();
});

describe('watchTimeZone', () => {
  it('reports the zone at load and, from its tick, each time it changes', () => {
    vi.useFakeTimers();
    let zone = 'Europe/Athens';
    const reports: string[] = [];
    const stop = watchTimeZone((reported) => reports.push(reported), () => zone);
    expect(reports).toEqual(['Europe/Athens']);
    vi.advanceTimersByTime(TIME_ZONE_TICK_MS);
    expect(reports).toEqual(['Europe/Athens']);
    zone = 'America/New_York';
    vi.advanceTimersByTime(TIME_ZONE_TICK_MS);
    expect(reports).toEqual(['Europe/Athens', 'America/New_York']);
    stop();
    zone = 'Asia/Kolkata';
    vi.advanceTimersByTime(TIME_ZONE_TICK_MS);
    expect(reports).toHaveLength(2);
  });

  it('reads the zone Intl resolves by default', () => {
    const reports: string[] = [];
    watchTimeZone((reported) => reports.push(reported))();
    expect(reports).toEqual([Intl.DateTimeFormat().resolvedOptions().timeZone]);
  });
});
