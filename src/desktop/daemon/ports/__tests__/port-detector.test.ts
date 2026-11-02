import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPortDetector, MAX_REPORTED_URLS, MIN_SCAN_INTERVAL_MS, URL_REPEAT_MS } from '../port-detector';
import type { PortCandidate } from '../ports-messages';

const candidate = (port: number): PortCandidate => ({ port, bindAddress: '0.0.0.0', family: 4, host: '127.0.0.1' });

afterEach(() => {
  vi.useRealTimers();
});

describe('the port detector', () => {
  it('scans only while a client is connected, on its own timer, every max(20 x the average scan, 2 s)', async () => {
    vi.useFakeTimers();
    let clock = 0;
    let scanCost = 0;
    const scans: number[] = [];
    const detector = createPortDetector({
      scan: async () => {
        scans.push(clock);
        clock += scanCost;
        return [];
      },
      now: () => clock,
      log: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scans).toEqual([]);
    detector.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(scans).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MIN_SCAN_INTERVAL_MS - 1);
    expect(scans).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scans).toHaveLength(2);
    // slow scans stretch the interval to twenty times their average
    scanCost = 600;
    await vi.advanceTimersByTimeAsync(MIN_SCAN_INTERVAL_MS);
    expect(scans).toHaveLength(3);
    const average = (0 + 0 + 600) / 3;
    await vi.advanceTimersByTimeAsync(20 * average - 1);
    expect(scans).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(scans).toHaveLength(4);
    detector.setActive(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scans).toHaveLength(4);
    detector.dispose();
  });

  it('reports the list when it changes, and a later client gets only a scan made while it is connected', async () => {
    let found: PortCandidate[] = [candidate(8000)];
    const detector = createPortDetector({ scan: async () => found, log: () => undefined });
    const lists: number[][] = [];
    detector.onList((candidates) => lists.push(candidates.map((entry) => entry.port)));
    detector.setActive(true);
    await vi.waitFor(() => expect(lists).toEqual([[8000]]));
    expect(detector.current()?.map((entry) => entry.port)).toEqual([8000]);
    detector.setActive(false);
    expect(detector.current()).toBeUndefined();
    found = [candidate(8000), candidate(5173)];
    detector.setActive(true);
    await vi.waitFor(() => expect(lists).toEqual([[8000], [5173, 8000]]));
    detector.dispose();
  });

  it('reports a printed URL once per window per source, and finds one split across a terminal\'s chunks', async () => {
    let clock = 0;
    let scans = 0;
    const detector = createPortDetector({ scan: async () => { scans++; return []; }, now: () => clock, log: () => undefined });
    const seen: string[] = [];
    detector.onUrl(({ host, port, source }) => seen.push(`${source} ${host}:${port}`));
    detector.setActive(true);
    await vi.waitFor(() => expect(scans).toBe(1));
    detector.terminalOutput('t1', 'Local: http://local');
    detector.terminalOutput('t1', 'host:5173/\n');
    detector.terminalOutput('t1', 'Local: http://localhost:5173/\n');
    detector.agentShellUrl({ host: 'localhost', port: 5173 });
    clock += URL_REPEAT_MS;
    detector.terminalOutput('t1', 'again http://localhost:5173/\n');
    expect(seen).toEqual(['terminal localhost:5173', 'agentShell localhost:5173', 'terminal localhost:5173']);
    detector.terminalEnded('t1');
    detector.dispose();
  });

  // output is hostile: a URL per port must not cost a walk over every URL still remembered
  it('remembers printed URLs in linear time and at most MAX_REPORTED_URLS of them, forgetting the oldest first', () => {
    let clock = 0;
    const detector = createPortDetector({ scan: async () => [], now: () => clock, log: () => undefined });
    let reports = 0;
    detector.onUrl(() => { reports++; });
    const started = performance.now();
    for (let port = 1; port <= 65535; port++) detector.agentShellUrl({ host: 'localhost', port });
    expect(performance.now() - started).toBeLessThan(500);
    expect(reports).toBe(65535);
    // the newest are still remembered, the oldest were forgotten
    detector.agentShellUrl({ host: 'localhost', port: 65535 });
    expect(reports).toBe(65535);
    detector.agentShellUrl({ host: 'localhost', port: 65535 - MAX_REPORTED_URLS });
    expect(reports).toBe(65536);
    // past the window every URL reports again
    clock += URL_REPEAT_MS;
    detector.agentShellUrl({ host: 'localhost', port: 65535 });
    expect(reports).toBe(65537);
    detector.dispose();
  });

  it(`scans soon after printed URLs, starting at most once per ${MIN_SCAN_INTERVAL_MS} ms however many arrive`, async () => {
    vi.useFakeTimers();
    const started: number[] = [];
    // a 200 ms scan stretches the timer's interval to 4 s, so only a URL asks for the scans in between
    const detector = createPortDetector({
      scan: () => {
        started.push(Date.now());
        return new Promise((resolve) => setTimeout(() => resolve([]), 200));
      },
      now: () => Date.now(),
      log: () => undefined,
    });
    const origin = Date.now();
    const at = (): number[] => started.map((when) => when - origin);
    const print = (from: number): void => {
      for (let port = from; port < from + 50; port++) detector.agentShellUrl({ host: 'localhost', port });
    };
    detector.setActive(true);
    await vi.advanceTimersByTimeAsync(200);
    print(3000);
    await vi.advanceTimersByTimeAsync(MIN_SCAN_INTERVAL_MS - 201);
    expect(at()).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(at()).toEqual([0, MIN_SCAN_INTERVAL_MS]);
    // URLs printed while a scan runs wait for the interval after that scan began
    print(4000);
    await vi.advanceTimersByTimeAsync(MIN_SCAN_INTERVAL_MS - 1);
    expect(at()).toEqual([0, MIN_SCAN_INTERVAL_MS]);
    await vi.advanceTimersByTimeAsync(1);
    expect(at()).toEqual([0, MIN_SCAN_INTERVAL_MS, 2 * MIN_SCAN_INTERVAL_MS]);
    // a URL long after the last scan scans at once
    await vi.advanceTimersByTimeAsync(3000);
    print(5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(at()).toEqual([0, MIN_SCAN_INTERVAL_MS, 2 * MIN_SCAN_INTERVAL_MS, 2 * MIN_SCAN_INTERVAL_MS + 3000]);
    detector.dispose();
  });
});
