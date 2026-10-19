import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mainProcessProfiler, StallMonitor, startV8Profile, summarizeStall, type CpuProfile, type ProfileHandle } from '../stall-monitor';

const frame = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0 });

// root → main → readSessions → openSync, and root → (idle); times in µs
const profile: CpuProfile = {
  nodes: [
    { id: 1, callFrame: frame('(root)'), children: [2, 5] },
    { id: 2, callFrame: frame('main', 'file:///app/dist/desktop/main.js', 9), children: [3] },
    { id: 3, callFrame: frame('readSessions', 'file:///app/dist/desktop/main.js', 41), children: [4] },
    { id: 4, callFrame: frame('openSync', 'node:fs', 619) },
    { id: 5, callFrame: frame('(idle)') },
  ],
  startTime: 1_000_000,
  endTime: 1_060_000,
  samples: [5, 4, 4, 4, 3, 5],
  timeDeltas: [0, 10_000, 10_000, 10_000, 10_000, 10_000],
};

// root → main → blockTheLoop, and root → (idle), (program) and (garbage collector)
const NODES: CpuProfile['nodes'] = [
  { id: 1, callFrame: frame('(root)'), children: [2, 4, 5, 6] },
  { id: 2, callFrame: frame('main', 'file:///app/dist/desktop/main.js', 9), children: [3] },
  { id: 3, callFrame: frame('blockTheLoop', 'file:///app/dist/desktop/main.js', 99) },
  { id: 4, callFrame: frame('(idle)') },
  { id: 5, callFrame: frame('(program)') },
  { id: 6, callFrame: frame('(garbage collector)') },
];
const [BUSY, IDLE, PROGRAM, GC] = [3, 4, 5, 6];

/** A profile on the test clock (ms) that took `samples` at the given times, ending at `endMs`. */
function profileOf(startMs: number, endMs: number, samples: ReadonlyArray<readonly [atMs: number, node: number]>): CpuProfile {
  let previous = startMs;
  return {
    nodes: NODES,
    startTime: startMs * 1000,
    endTime: endMs * 1000,
    samples: samples.map(([, node]) => node),
    timeDeltas: samples.map(([at]) => {
      const delta = (at - previous) * 1000;
      previous = at;
      return delta;
    }),
  };
}

/** Samples of `node` every 10 ms from `fromMs` up to, not including, `toMs`. */
function every10ms(fromMs: number, toMs: number, node: number): Array<[number, number]> {
  const samples: Array<[number, number]> = [];
  for (let at = fromMs; at < toMs; at += 10) samples.push([at, node]);
  return samples;
}

describe('summarizeStall', () => {
  it('weighs the stacks sampled inside the window, innermost frame first, and counts idle samples apart', () => {
    const summary = summarizeStall(profile, 1005, 1060);
    expect(summary.sampledMs).toBe(40);
    expect(summary.idleMs).toBe(10);
    expect(summary.stacks).toEqual([
      { frames: ['openSync node:fs:620', 'readSessions desktop/main.js:42', 'main desktop/main.js:10'], ms: 30 },
      { frames: ['readSessions desktop/main.js:42', 'main desktop/main.js:10'], ms: 10 },
    ]);
  });

  it('leaves out samples outside the window', () => {
    expect(summarizeStall(profile, 1035, 1060).stacks).toEqual([
      { frames: ['readSessions desktop/main.js:42', 'main desktop/main.js:10'], ms: 10 },
    ]);
  });

  it('counts time in native code with no JavaScript on the stack, and in the garbage collector, under their own labels', () => {
    const summary = summarizeStall(profileOf(0, 100, [...every10ms(0, 60, PROGRAM), ...every10ms(60, 90, GC), [90, IDLE]]), 0, 100);
    expect(summary.sampledMs).toBe(90);
    expect(summary.idleMs).toBe(10);
    expect(summary.stacks).toEqual([
      { frames: ['(program) native code, no JavaScript on the stack'], ms: 60 },
      { frames: ['(garbage collector)'], ms: 30 },
    ]);
  });

  it('counts a sample followed by a gap the profiler took no samples in for no more than a few sampling intervals', () => {
    const summary = summarizeStall(profileOf(0, 5000, [[0, BUSY], [4990, BUSY]]), 0, 5000);
    expect(summary.sampledMs).toBe(50);
  });
});

describe('StallMonitor', () => {
  let monitor: StallMonitor | undefined;
  let dir: string;
  let lines: string[];
  let now: number;
  let events: string[];
  let started: number;
  // What the profile started n-th returns when stopped; its clock is the test clock.
  let profileFor: (n: number) => CpuProfile;
  let startProfile: () => ProfileHandle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-monitor-'));
    lines = [];
    now = 1000;
    events = [];
    started = 0;
    profileFor = () => profileOf(0, 0, []);
    startProfile = () => {
      const n = started++;
      events.push(`start ${n}`);
      return {
        stop: () => {
          events.push(`stop ${n}`);
          return JSON.stringify(profileFor(n));
        },
      };
    };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    monitor?.dispose();
    monitor = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const create = (): StallMonitor => (monitor = new StallMonitor({ dir, log: (line) => lines.push(line), startProfile: () => startProfile() }));
  // Main's event loop runs no tick for `ms`, then the next tick fires.
  const blockFor = (ms: number): void => {
    now += ms;
    vi.advanceTimersByTime(100);
  };
  const tickOnTime = (count = 1): void => {
    for (let i = 0; i < count; i++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }
  };
  const profiles = (): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.cpuprofile')).sort() : []);
  const parsedProfile = (name: string): CpuProfile | undefined => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as CpuProfile;
    } catch {
      return undefined;
    }
  };

  it('starts the next segment before stopping the running one, and keeps no profile from a segment that ends without a stall', () => {
    create();
    tickOnTime(600);
    expect(events).toEqual(['start 0', 'start 1', 'stop 0']);
    tickOnTime(600);
    expect(events).toEqual(['start 0', 'start 1', 'stop 0', 'start 2', 'stop 1']);
    expect(lines).toEqual([]);
    expect(profiles()).toEqual([]);
  });

  it('reports the stall from the segment that ran through it, on the clock read before that segment started', async () => {
    // A first start walks the heap; V8 stamps the profile's start before that walk.
    startProfile = ((inner) => () => {
      const handle = inner();
      if (started === 1) now += 300;
      return handle;
    })(startProfile);
    profileFor = (n) => (n === 0 ? profileOf(1000, 3000, [...every10ms(1000, 1400, IDLE), ...every10ms(1400, 2900, BUSY), [2900, IDLE]]) : profileOf(0, 0, []));
    create();
    tickOnTime();
    blockFor(1500);
    expect(events).toEqual(['start 0', 'start 1', 'stop 0']);
    expect(lines[0]).toMatch(/^\[stall\] the main process was blocked for 1400 ms; 1500 ms sampled, 0 ms idle\n {2}1500 ms {2}blockTheLoop desktop\/main\.js:100 < main desktop\/main\.js:10\n {2}profile: .*stall-.*-1400ms\.cpuprofile$/);
    await expect.poll(() => profiles().map(parsedProfile)).toEqual([profileFor(0)]);
  });

  it('keeps no profile for a gap in which the profiler saw main busy for almost no time, and says so', async () => {
    profileFor = () => profileOf(1000, 6200, [[1000, IDLE], [1100, IDLE], [6100, IDLE]]);
    create();
    tickOnTime();
    blockFor(5000);
    expect(lines).toEqual([
      '[stall] the main process was blocked for 4900 ms, but the profiler saw it busy for only 0 ms (40 ms idle), as when the machine sleeps, the process is paused or a native loop runs outside JavaScript; no profile kept',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(profiles()).toEqual([]);
  });

  it('reports no stall across a suspend, and starts a new segment on resume', () => {
    create();
    tickOnTime();
    monitor!.suspend();
    blockFor(60_000);
    tickOnTime();
    monitor!.resume();
    expect(events).toEqual(['start 0', 'start 1', 'stop 0']);
    tickOnTime();
    expect(lines).toEqual([]);
  });

  it('keeps the newest profiles, deletes only its own files and removes a profile a quit left half written', async () => {
    const old = Array.from({ length: 25 }, (_, i) => `stall-2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z-1200ms.cpuprofile`);
    for (const name of old) fs.writeFileSync(path.join(dir, name), '{}');
    const unrelated = ['notes.txt', 'other.cpuprofile', 'stall-notes.txt'];
    for (const name of unrelated) fs.writeFileSync(path.join(dir, name), 'keep');
    fs.writeFileSync(path.join(dir, `${old[24]!.replace('-00-24-', '-00-25-')}.partial`), '{"nodes":[');
    profileFor = () => profileOf(1000, 2700, every10ms(1100, 2600, BUSY));
    create();
    tickOnTime();
    blockFor(1500);
    const fresh = /^stall-\d{4}-.*-1400ms\.cpuprofile$/;
    await expect.poll(() => profiles().filter((name) => fresh.test(name) && !name.startsWith('stall-2020') && parsedProfile(name) !== undefined)).toHaveLength(1);
    const left = fs.readdirSync(dir).sort();
    expect(left.filter((name) => name.startsWith('stall-2020'))).toEqual(old.slice(6));
    expect(left.filter((name) => name.endsWith('.partial'))).toEqual([]);
    expect(left.filter((name) => fresh.test(name) || name.startsWith('stall-2020'))).toHaveLength(20);
    for (const name of unrelated) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('keep');
  });

  it('never leaves a half-written profile under a profile name', async () => {
    const writeFile = fs.promises.writeFile;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data) => {
      await writeFile(file, String(data).slice(0, 10));
      throw new Error('ENOSPC: no space left on device');
    });
    profileFor = () => profileOf(1000, 2700, every10ms(1100, 2600, BUSY));
    create();
    tickOnTime();
    blockFor(1500);
    await expect.poll(() => lines.some((line) => line.includes('ENOSPC'))).toBe(true);
    expect(profiles()).toEqual([]);
  });

  it('stops and logs once when the profiler fails during a tick', () => {
    startProfile = ((inner) => () => {
      if (started === 1) throw new Error('There are too many CPU profiles');
      return inner();
    })(startProfile);
    create();
    tickOnTime(1200);
    expect(lines).toEqual(['[stall] the stall monitor stopped: There are too many CPU profiles']);
    expect(events).toEqual(['start 0', 'stop 0']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops and logs once when the profiler fails on resume, without throwing into the power monitor', () => {
    create();
    startProfile = () => {
      throw new Error('profiler gone');
    };
    monitor!.suspend();
    expect(() => monitor!.resume()).not.toThrow();
    expect(lines).toEqual(['[stall] the stall monitor stopped: profiler gone']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves nothing running when the profiler cannot start', () => {
    startProfile = () => {
      throw new Error('no profiler');
    };
    expect(() => create()).toThrow('no profiler');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the running profile on dispose', () => {
    create();
    monitor!.dispose();
    expect(events).toEqual(['start 0', 'stop 0']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('without a profiler logs how long main was blocked, keeps no profile and stops cleanly', async () => {
    monitor = new StallMonitor({ dir, log: (line) => lines.push(line), startProfile: null });
    tickOnTime(700);
    blockFor(1500);
    monitor.suspend();
    blockFor(60_000);
    monitor.resume();
    tickOnTime();
    expect(lines).toEqual(['[stall] the main process was blocked for 1400 ms; main is not sampled on this platform, so no profile']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(profiles()).toEqual([]);
    monitor.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('mainProcessProfiler', () => {
  it('samples main with V8 on Windows and Linux, and not on macOS', () => {
    expect(mainProcessProfiler('win32')).toBe(startV8Profile);
    expect(mainProcessProfiler('linux')).toBe(startV8Profile);
    expect(mainProcessProfiler('darwin')).toBeNull();
  });
});

describe('StallMonitor on V8\'s profiler', () => {
  let monitor: StallMonitor | undefined;
  let dir: string | undefined;
  afterEach(() => {
    monitor?.dispose();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names the function that blocked the event loop and writes its profile', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-monitor-'));
    const lines: string[] = [];
    monitor = new StallMonitor({ dir, log: (line) => lines.push(line), startProfile: startV8Profile });
    await new Promise((resolve) => setTimeout(resolve, 150));
    function blockTheLoop(): number {
      const end = performance.now() + 1300;
      let x = 0;
      while (performance.now() < end) x += Math.sqrt(x + 1);
      return x;
    }
    blockTheLoop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const report = lines.find((line) => line.startsWith('[stall]'));
    expect(report).toMatch(/blocked for 1\d{3} ms/);
    expect(report).toContain('blockTheLoop');
    // The profile is renamed into place last, so one that parses is fully saved.
    await expect.poll(() => fs.readdirSync(dir!).filter((name) => {
      if (!name.endsWith('.cpuprofile')) return false;
      try {
        return Array.isArray((JSON.parse(fs.readFileSync(path.join(dir!, name), 'utf8')) as CpuProfile).nodes);
      } catch {
        return false;
      }
    }).length).toBe(1);
  });
});
