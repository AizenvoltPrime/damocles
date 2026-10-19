// Finds what blocks the main process, whose stalls freeze every window: a sampling profile runs continuously, and a late
// heartbeat cuts the stalled stretch out of it. V8 samples a synchronous native call under its JS caller.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as v8 from 'node:v8';
import type { Disposable } from '../../platform/disposable';

const TICK_MS = 100;
// A late tick past this is a stall: one frame is 16 ms, and Windows marks a window Not Responding after 5 s.
const STALL_MS = 1000;
// How far back a stall profile reaches; the segment that ran through the stall is the profile.
const SEGMENT_MS = 60_000;
const SAMPLE_INTERVAL_US = 10_000;
// The profiler takes no samples while the machine sleeps or the process is paused, so one sample stands for at most this.
const MAX_SAMPLE_MS = (4 * SAMPLE_INTERVAL_US) / 1000;
// A stall with less busy time sampled than this was a sleep, a pause or a native loop outside JS, and keeps no profile.
const MIN_SAMPLED_MS = 100;
// The monitor's own work in one tick past this is logged.
const SLOW_TICK_MS = 50;
const KEPT_PROFILES = 20;
const PARTIAL_SUFFIX = '.partial';
const SUMMARY_STACKS = 4;
const SUMMARY_FRAMES = 6;

export interface ProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number; readonly columnNumber: number };
  readonly children?: readonly number[];
}

export interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly startTime: number;
  readonly endTime: number;
  readonly samples?: readonly number[];
  readonly timeDeltas?: readonly number[];
}

export interface StallStack {
  // innermost frame first
  readonly frames: readonly string[];
  readonly ms: number;
}

export interface StallSummary {
  // every sample but (idle)
  readonly sampledMs: number;
  readonly idleMs: number;
  readonly stacks: readonly StallStack[];
}

/** A running profile; `stop` returns it as `.cpuprofile` JSON. */
export interface ProfileHandle {
  stop(): string;
}

// V8's meta frames are (root), (idle), (program) and (garbage collector); a (program) sample has no JS on the stack.
const META_LABELS: Readonly<Record<string, string>> = {
  '(program)': '(program) native code, no JavaScript on the stack',
};

function frameLabel(node: ProfileNode): string {
  const { functionName, url, lineNumber } = node.callFrame;
  const meta = META_LABELS[functionName];
  if (meta) return meta;
  const file = url ? url.replace(/^file:\/\/\/?/, '').split(/[\\/]/).slice(-2).join('/') : '';
  return file ? `${functionName || '(anonymous)'} ${file}:${lineNumber + 1}` : functionName || '(anonymous)';
}

/**
 * The heaviest stacks sampled between `fromMs` and `toMs`, in the profile's own clock in ms. Stacks are cut to their
 * innermost frames, so one blocking call reached from many places still adds up.
 */
export function summarizeStall(profile: CpuProfile, fromMs: number, toMs: number): StallSummary {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const weights = new Map<string, StallStack>();
  let sampledMs = 0;
  let idleMs = 0;
  let at = profile.startTime;
  for (let i = 0; i < samples.length; i++) {
    at += deltas[i] ?? 0;
    const next = i + 1 < samples.length ? at + (deltas[i + 1] ?? 0) : profile.endTime;
    const ms = Math.min((next - at) / 1000, MAX_SAMPLE_MS);
    const atMs = at / 1000;
    if (atMs < fromMs || atMs >= toMs) continue;
    const leaf = nodes.get(samples[i] ?? -1);
    if (!leaf || leaf.callFrame.functionName === '(root)') continue;
    if (leaf.callFrame.functionName === '(idle)') {
      idleMs += ms;
      continue;
    }
    const frames: string[] = [];
    for (let id: number | undefined = leaf.id; id !== undefined && frames.length < SUMMARY_FRAMES; id = parents.get(id)) {
      const node = nodes.get(id);
      if (!node || node.callFrame.functionName === '(root)') break;
      frames.push(frameLabel(node));
    }
    const key = frames.join('\n');
    const prior = weights.get(key);
    weights.set(key, { frames, ms: (prior?.ms ?? 0) + ms });
    sampledMs += ms;
  }
  const stacks = [...weights.values()].sort((a, b) => b.ms - a.ms).slice(0, SUMMARY_STACKS);
  return { sampledMs, idleMs, stacks };
}

export function formatStall(blockedMs: number, summary: StallSummary, profileFile: string | undefined): string {
  const lines = [`[stall] the main process was blocked for ${Math.round(blockedMs)} ms; ${Math.round(summary.sampledMs)} ms sampled, ${Math.round(summary.idleMs)} ms idle`];
  for (const stack of summary.stacks) lines.push(`  ${Math.round(stack.ms)} ms  ${stack.frames.join(' < ')}`);
  if (profileFile) lines.push(`  profile: ${profileFile}`);
  return lines.join('\n');
}

function formatUnsampled(blockedMs: number, summary: StallSummary): string {
  return `[stall] the main process was blocked for ${Math.round(blockedMs)} ms, but the profiler saw it busy for only ${Math.round(summary.sampledMs)} ms (${Math.round(summary.idleMs)} ms idle), as when the machine sleeps, the process is paused or a native loop runs outside JavaScript; no profile kept`;
}

// Electron starts V8 with --no-freeze-flags-after-init, without which this aborts; Node's profiler reads it when created.
// The flag is process-wide, so a DevTools profile of main that sets no interval of its own also samples at this one.
export function startV8Profile(): ProfileHandle {
  v8.setFlagsFromString(`--cpu-profiler-sampling-interval=${SAMPLE_INTERVAL_US}`);
  return v8.startCpuProfile();
}

/** The profiler that samples main on `platform`; null on macOS, where main has hung inside a child process spawn while V8 sampled it. */
export function mainProcessProfiler(platform: NodeJS.Platform): (() => ProfileHandle) | null {
  return platform === 'darwin' ? null : startV8Profile;
}

function formatUnprofiled(blockedMs: number): string {
  return `[stall] the main process was blocked for ${Math.round(blockedMs)} ms; main is not sampled on this platform, so no profile`;
}

/** The running profile and the profiler that started it. */
interface Sampling {
  readonly start: () => ProfileHandle;
  profile: ProfileHandle;
  // performance.now() just before the running segment started; the profile's startTime is that moment in V8's clock
  segmentStart: number;
}

const isProfile = (name: string): boolean => name.startsWith('stall-') && name.endsWith('.cpuprofile');
const isPartialProfile = (name: string): boolean => name.startsWith('stall-') && name.endsWith(`.cpuprofile${PARTIAL_SUFFIX}`);

export interface StallMonitorOptions {
  // where stall profiles are written, newest KEPT_PROFILES kept
  readonly dir: string;
  readonly log: (line: string) => void;
  // null times stalls without sampling main
  readonly startProfile: (() => ProfileHandle) | null;
}

export class StallMonitor implements Disposable {
  private readonly options: StallMonitorOptions;
  private readonly sampling: Sampling | undefined;
  private lastTick: number;
  private readonly timer: NodeJS.Timeout;
  private suspended = false;
  private disposed = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(options: StallMonitorOptions) {
    this.options = options;
    const start = options.startProfile;
    if (start) {
      const segmentStart = performance.now();
      this.sampling = { start, profile: start(), segmentStart };
    }
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.guarded(() => this.tick()), TICK_MS);
    this.timer.unref();
  }

  // A sleeping machine runs no ticks; that gap is not a stall.
  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.guarded(() => {
      this.suspended = false;
      if (this.sampling) this.rollOver(this.sampling);
      this.lastTick = performance.now();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    try {
      this.sampling?.profile.stop();
    } catch (err) {
      this.options.log(`[stall] stopping the profiler failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A failure is logged once and ends the monitor, so it neither repeats every tick nor escapes a powerMonitor handler.
  private guarded(work: () => void): void {
    if (this.disposed) return;
    try {
      work();
    } catch (err) {
      this.options.log(`[stall] the stall monitor stopped: ${err instanceof Error ? err.message : String(err)}`);
      this.dispose();
    }
  }

  // The next segment starts before the running one stops: a profiler left with no profile is torn down, and starting
  // one afresh walks the whole heap on this thread, measured at about 2.5 ms per MB in Electron's main process.
  private rollOver(sampling: Sampling): { json: string; segmentStart: number } {
    const segmentStart = sampling.segmentStart;
    const start = performance.now();
    const next = sampling.start();
    const stopped = sampling.profile;
    sampling.profile = next;
    sampling.segmentStart = start;
    return { json: stopped.stop(), segmentStart };
  }

  private tick(): void {
    const now = performance.now();
    const blockedMs = now - this.lastTick - TICK_MS;
    const stallFrom = this.lastTick;
    this.lastTick = now;
    if (this.suspended) return;
    const sampling = this.sampling;
    if (!sampling) {
      if (blockedMs >= STALL_MS) this.options.log(formatUnprofiled(blockedMs));
      return;
    }
    if (blockedMs >= STALL_MS) this.report(this.rollOver(sampling), stallFrom, now, blockedMs);
    else if (now - sampling.segmentStart >= SEGMENT_MS) this.rollOver(sampling);
    else return;
    this.lastTick = performance.now();
    const spentMs = this.lastTick - now;
    if (spentMs >= SLOW_TICK_MS) this.options.log(`[stall] the stall monitor held the main process for ${Math.round(spentMs)} ms`);
  }

  private report(stopped: { json: string; segmentStart: number }, fromPerf: number, toPerf: number, blockedMs: number): void {
    const profile = JSON.parse(stopped.json) as CpuProfile;
    const toProfileMs = (perfMs: number): number => profile.startTime / 1000 + (perfMs - stopped.segmentStart);
    const summary = summarizeStall(profile, toProfileMs(fromPerf), toProfileMs(toPerf));
    if (summary.sampledMs < MIN_SAMPLED_MS) {
      this.options.log(formatUnsampled(blockedMs, summary));
      return;
    }
    const file = path.join(this.options.dir, `stall-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.round(blockedMs)}ms.cpuprofile`);
    this.options.log(formatStall(blockedMs, summary, file));
    this.saving = this.saving.then(() => this.save(file, stopped.json));
  }

  // Saves run one at a time, so any partial file but this save's own was left by a quit. The rename comes last, so a
  // profile under its final name is whole and its save is over.
  private async save(file: string, json: string): Promise<void> {
    const { dir } = this.options;
    const partial = `${file}${PARTIAL_SUFFIX}`;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(partial, json);
      const names = await fs.promises.readdir(dir);
      const kept = names.filter(isProfile).sort();
      const stale = [...kept.slice(0, Math.max(0, kept.length - (KEPT_PROFILES - 1))), ...names.filter((name) => isPartialProfile(name) && name !== path.basename(partial))];
      await Promise.all(stale.map((name) => fs.promises.rm(path.join(dir, name), { force: true })));
      await fs.promises.rename(partial, file);
    } catch (err) {
      this.options.log(`[stall] writing ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
