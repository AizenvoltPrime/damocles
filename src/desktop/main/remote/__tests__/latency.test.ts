import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_MEASUREMENT_MS, isSlow, LatencyMeter, MEASUREMENT_INTERVAL_MS, measuredLatency, PING_GAP_MS, PINGS } from '../latency';

const KEY = 'ssh+h1';

// pings answer after the round trip the test sets for each, on fake time
function meter(roundTrips: () => number) {
  const pings: number[] = [];
  const changes: string[] = [];
  const latency = new LatencyMeter({
    ping: async () => {
      pings.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, roundTrips()));
    },
    changed: (key) => changes.push(key),
    log: () => undefined,
    now: () => Date.now(),
  });
  return { latency, pings, changes };
}

// a connection whose close the test fires
function connection() {
  const listeners = new Set<(reason: string) => void>();
  return {
    onClose: (listener: (reason: string) => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    close: () => {
      for (const listener of [...listeners]) listener('closed');
    },
  };
}

// one whole measurement: PINGS pings PING_GAP_MS apart, each taking at most a second here
const MEASUREMENT_MS = PINGS * (PING_GAP_MS + 1000);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the latency rules', () => {
  it('keeps the smallest round trip, halved', () => {
    expect(measuredLatency([400, 90, 300, 76, 120])).toBe(38);
  });

  it('is slow above 1500 ms, or above 500 ms and more than twice the baseline', () => {
    expect(isSlow(1501, 2000)).toBe(true);
    expect(isSlow(1500, 2000)).toBe(false);
    expect(isSlow(620, 40)).toBe(true);
    expect(isSlow(620, 400)).toBe(false);
    expect(isSlow(500, 10)).toBe(false);
  });
});

describe('LatencyMeter', () => {
  it('measures 10 s after a connect with 5 pings 2 s apart and publishes once, when the measurement finishes', async () => {
    let next = [300, 90, 200, 76, 120];
    const { latency, pings, changes } = meter(() => next.shift()!);
    latency.setVisibleAuthorities([KEY]);
    const connectedAt = Date.now();
    latency.connected(KEY, connection());
    await vi.advanceTimersByTimeAsync(FIRST_MEASUREMENT_MS - 1);
    expect(pings).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings).toEqual([connectedAt + FIRST_MEASUREMENT_MS]);
    await vi.advanceTimersByTimeAsync(MEASUREMENT_MS);
    expect(pings).toHaveLength(5);
    expect(pings.slice(1).map((at, index) => at - pings[index]!)).toEqual([300 + 2000, 90 + 2000, 200 + 2000, 76 + 2000]);
    expect(changes).toEqual([KEY]);
    expect(latency.latency(KEY)).toEqual({ latencyMs: 38, slow: false, history: [38], measurements: 1 });
    next = [];
    latency.dispose();
  });

  it('sends no ping while no window shows the host, and measures once one does', async () => {
    const { latency, pings } = meter(() => 10);
    latency.connected(KEY, connection());
    await vi.advanceTimersByTimeAsync(10 * MEASUREMENT_INTERVAL_MS);
    expect(pings).toHaveLength(0);
    latency.setVisibleAuthorities([KEY]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pings).toHaveLength(1);
    // hidden again mid-measurement: the rest of it is never sent, and nothing is published
    latency.setVisibleAuthorities([]);
    await vi.advanceTimersByTimeAsync(10 * MEASUREMENT_INTERVAL_MS);
    expect(pings).toHaveLength(1);
    expect(latency.latency(KEY)).toBeUndefined();
    latency.dispose();
  });

  it('measures every 60 s while shown, the baseline being the first three measurements', async () => {
    const perMeasurement = [80, 100, 120, 1240, 100];
    let measurement = 0;
    let ping = 0;
    const { latency } = meter(() => {
      const value = perMeasurement[measurement]!;
      if (++ping === PINGS) {
        ping = 0;
        measurement++;
      }
      return value;
    });
    latency.setVisibleAuthorities([KEY]);
    latency.connected(KEY, connection());
    await vi.advanceTimersByTimeAsync(FIRST_MEASUREMENT_MS + MEASUREMENT_MS);
    expect(latency.latency(KEY)?.latencyMs).toBe(40);
    const slow: boolean[] = [];
    for (let index = 1; index < perMeasurement.length; index++) {
      await vi.advanceTimersByTimeAsync(MEASUREMENT_INTERVAL_MS + MEASUREMENT_MS);
      slow.push(latency.latency(KEY)!.slow);
    }
    // the baseline is 50 ms (40, 50, 60): 620 ms is above 500 and more than twice it, and 50 ms is not
    expect(latency.latency(KEY)?.history).toEqual([40, 50, 60, 620, 50]);
    expect(slow).toEqual([false, false, true, false]);
    latency.dispose();
  });

  it('turns slow above 500 ms and twice the baseline, and normal again at the next measurement', async () => {
    const perMeasurement = [40, 40, 40, 1240, 40];
    let measurement = 0;
    let ping = 0;
    const { latency, changes } = meter(() => {
      const value = perMeasurement[measurement]!;
      if (++ping === PINGS) {
        ping = 0;
        measurement++;
      }
      return value;
    });
    latency.setVisibleAuthorities([KEY]);
    latency.connected(KEY, connection());
    await vi.advanceTimersByTimeAsync(FIRST_MEASUREMENT_MS + MEASUREMENT_MS);
    await vi.advanceTimersByTimeAsync(2 * (MEASUREMENT_INTERVAL_MS + MEASUREMENT_MS));
    expect(latency.latency(KEY)).toMatchObject({ latencyMs: 20, slow: false });
    await vi.advanceTimersByTimeAsync(MEASUREMENT_INTERVAL_MS + MEASUREMENT_MS);
    expect(latency.latency(KEY)).toMatchObject({ latencyMs: 620, slow: true });
    await vi.advanceTimersByTimeAsync(MEASUREMENT_INTERVAL_MS + MEASUREMENT_MS);
    expect(latency.latency(KEY)).toMatchObject({ latencyMs: 20, slow: false });
    expect(changes).toHaveLength(5);
    latency.dispose();
  });

  it('is slow above 1500 ms whatever the baseline', async () => {
    const { latency } = meter(() => 3200);
    latency.setVisibleAuthorities([KEY]);
    latency.connected(KEY, connection());
    await vi.advanceTimersByTimeAsync(FIRST_MEASUREMENT_MS + PINGS * (PING_GAP_MS + 3200));
    expect(latency.latency(KEY)).toMatchObject({ latencyMs: 1600, slow: true });
    latency.dispose();
  });

  it('keeps the last 10 measurements and stops measuring once the connection is gone', async () => {
    const { latency, pings } = meter(() => 10);
    latency.setVisibleAuthorities([KEY]);
    latency.connected(KEY, connection());
    await vi.advanceTimersByTimeAsync(FIRST_MEASUREMENT_MS + 12 * (MEASUREMENT_INTERVAL_MS + MEASUREMENT_MS));
    expect(latency.latency(KEY)?.history).toHaveLength(10);
    // the full history of identical readings no longer changes, the count does
    const before = latency.latency(KEY)!;
    await vi.advanceTimersByTimeAsync(MEASUREMENT_INTERVAL_MS + MEASUREMENT_MS);
    expect(latency.latency(KEY)?.history).toEqual(before.history);
    expect(latency.latency(KEY)?.measurements).toBe(before.measurements + 1);
    latency.disconnected(KEY);
    const sent = pings.length;
    await vi.advanceTimersByTimeAsync(10 * MEASUREMENT_INTERVAL_MS);
    expect(pings).toHaveLength(sent);
    latency.dispose();
  });

  it('drops a measurement whose window hid during its last ping', async () => {
    const { latency, changes } = meter(() => 500);
    latency.setVisibleAuthorities([KEY]);
    latency.connected(KEY, connection());
    await vi.advanceTimersByTimeAsync(FIRST_MEASUREMENT_MS + (PINGS - 1) * (PING_GAP_MS + 500) + 100);
    latency.setVisibleAuthorities([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual([]);
    expect(latency.latency(KEY)).toBeUndefined();
    latency.dispose();
  });

  it('stops measuring a connection that closed without a drop, as after Disconnect Host', async () => {
    const { latency, pings } = meter(() => 10);
    const closing = connection();
    latency.setVisibleAuthorities([KEY]);
    latency.connected(KEY, closing);
    await vi.advanceTimersByTimeAsync(FIRST_MEASUREMENT_MS + MEASUREMENT_MS);
    expect(pings).toHaveLength(PINGS);
    closing.close();
    await vi.advanceTimersByTimeAsync(10 * MEASUREMENT_INTERVAL_MS);
    expect(pings).toHaveLength(PINGS);
    // the next connection is measured again
    latency.connected(KEY, connection());
    await vi.advanceTimersByTimeAsync(FIRST_MEASUREMENT_MS);
    expect(pings).toHaveLength(PINGS + 1);
    latency.dispose();
  });

  it('keeps the baseline to the first three measurements, so a lasting slowdown stays slow', async () => {
    const perMeasurement = [80, 80, 80, 1400, 1400, 1400];
    let measurement = 0;
    let ping = 0;
    const { latency } = meter(() => {
      const value = perMeasurement[measurement]!;
      if (++ping === PINGS) {
        ping = 0;
        measurement++;
      }
      return value;
    });
    latency.setVisibleAuthorities([KEY]);
    latency.connected(KEY, connection());
    await vi.advanceTimersByTimeAsync(FIRST_MEASUREMENT_MS + PINGS * (PING_GAP_MS + 1400));
    for (let index = 1; index < perMeasurement.length; index++) await vi.advanceTimersByTimeAsync(MEASUREMENT_INTERVAL_MS + PINGS * (PING_GAP_MS + 1400));
    expect(latency.latency(KEY)?.history).toEqual([40, 40, 40, 700, 700, 700]);
    expect(latency.latency(KEY)?.slow).toBe(true);
    latency.dispose();
  });
});
