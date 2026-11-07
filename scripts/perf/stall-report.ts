// Usage: node scripts/perf/stall-report.ts <logsDir> [--callers <n>]
//
// Groups the [stall] entries of the desktop logs in <logsDir> (Damocles.log, Damocles_Core.log and their rotated
// copies) by cause and prints, per cause, the count and the blocked time's total, median, p90 and max. A cause is the
// heaviest stack's outermost Node API frame (spawn, existsSync, appendFileSync...) and its nearest <n> named callers in
// bundled code (default 2). A stall with no sampled stack is "no samples", with the monitor's reading when it logged one.
// The monitor's own segment stops over 50 ms are counted apart.
import * as fs from 'node:fs';
import * as path from 'node:path';

const LOG_FILE = /^Damocles(_Core)?(\.\d+)?\.log$/;
const ENTRY = /^\[(?<at>[^\]]+)\] \[stall\] the (?<proc>\w+) process was blocked for (?<ms>\d+) ms(?<rest>.*)$/;
const SEGMENT_STOP = /^\[(?<at>[^\]]+)\] \[stall-monitor\] segment stop took (?<ms>\d+) ms/;
const STACK = /^ {2}(?<ms>\d+) ms {2}(?<frames>.+)$/;
// a frame in bundled or package code has a .js/.mjs/.cjs location; Node's builtins have none
const BUNDLED = /\.[cm]?js:\d+$/;

type Proc = 'main' | 'core';
interface StallEntry {
  proc: Proc;
  at: string;
  ms: number;
  cause: string;
}
interface SegmentStop {
  proc: Proc;
  ms: number;
}
interface LogEntries {
  files: string[];
  entries: StallEntry[];
  stops: SegmentStop[];
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('Usage: node scripts/perf/stall-report.ts <logsDir> [--callers <n>]');
  process.exit(1);
}

function parseArgs(argv: string[]): { dir: string; callers: number } {
  let dir: string | undefined;
  let callers = 2;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--callers') callers = Number(argv[++i]);
    else if (!dir) dir = argv[i];
    else usage(`unexpected argument ${argv[i]}`);
  }
  if (!dir) usage();
  if (!Number.isInteger(callers) || callers < 0) usage('--callers takes a whole number');
  return { dir, callers };
}

const frameName = (label: string): string => label.split(' ')[0] ?? label;
const isNamed = (label: string): boolean => !label.startsWith('(anonymous)');

/** The cause of a stack given innermost frame first: its outermost Node API frame and its nearest named bundled callers. */
function causeOf(frames: string[], callers: number): string {
  const firstBundled = frames.findIndex((label) => BUNDLED.test(label));
  if (firstBundled === -1) return frames.slice(0, 2).map(frameName).join(' < ');
  const api = frames.slice(0, firstBundled).filter(isNamed).at(-1) ?? frames[0] ?? '';
  const named = frames.slice(firstBundled).filter((label) => BUNDLED.test(label) && isNamed(label)).slice(0, callers);
  return [api, ...named].map(frameName).join(' < ');
}

function noSamplesCause(rest: string): string {
  if (rest.includes('the process was not scheduled')) return 'no samples: process not scheduled';
  if (rest.includes('native work on the UI thread')) return 'no samples: native work on the UI thread';
  return 'no samples';
}

function readEntries(dir: string, callers: number): LogEntries {
  const files = fs.readdirSync(dir).filter((name) => LOG_FILE.test(name)).sort();
  const entries: StallEntry[] = [];
  const stops: SegmentStop[] = [];
  for (const name of files) {
    const proc: Proc = name.startsWith('Damocles_Core') ? 'core' : 'main';
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const stop = SEGMENT_STOP.exec(line)?.groups;
      if (stop) {
        stops.push({ proc, ms: Number(stop.ms) });
        continue;
      }
      const entry = ENTRY.exec(line)?.groups;
      if (!entry) continue;
      let heaviest: string[] | undefined;
      while (lines[i + 1]?.startsWith('  ')) {
        const frames = STACK.exec(lines[++i] ?? '')?.groups?.frames;
        if (frames && !heaviest) heaviest = frames.split(' < ');
      }
      const { at = '', ms, rest = '' } = entry;
      entries.push({ proc, at, ms: Number(ms), cause: heaviest ? causeOf(heaviest, callers) : noSamplesCause(rest) });
    }
  }
  return { files, entries, stops };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1).padStart(7);

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, total: sorted.reduce((sum, v) => sum + v, 0), median: percentile(sorted, 50), p90: percentile(sorted, 90), p99: percentile(sorted, 99), max: sorted.at(-1) ?? 0 };
}

function report({ files, entries, stops }: LogEntries): void {
  console.log(`files: ${files.join(', ') || '(none)'}`);
  for (const proc of ['main', 'core'] as const) {
    const mine = entries.filter((entry) => entry.proc === proc);
    const myStops = stops.filter((stop) => stop.proc === proc);
    if (mine.length === 0 && myStops.length === 0) continue;
    const ats = mine.map((entry) => entry.at).sort();
    const all = stats(mine.map((entry) => entry.ms));
    console.log(`\n${proc} process: ${all.count} stalls${ats.length ? ` from ${ats[0]} to ${ats.at(-1)}` : ''}`);
    if (all.count) console.log(`blocked: total ${seconds(all.total).trim()} s, median ${seconds(all.median).trim()} s, p90 ${seconds(all.p90).trim()} s, max ${seconds(all.max).trim()} s`);
    const byCause = new Map<string, number[]>();
    for (const entry of mine) byCause.set(entry.cause, [...(byCause.get(entry.cause) ?? []), entry.ms]);
    const rows = [...byCause].map(([cause, values]) => ({ cause, ...stats(values) })).sort((a, b) => b.count - a.count || b.total - a.total);
    if (rows.length) console.log('\n  count  total s median s   p90 s   max s  cause');
    for (const row of rows) console.log(`  ${String(row.count).padStart(5)} ${seconds(row.total)} ${seconds(row.median)} ${seconds(row.p90)} ${seconds(row.max)}  ${row.cause}`);
    if (myStops.length) {
      const stop = stats(myStops.map((s) => s.ms));
      console.log(`\nsegment stops over 50 ms: ${stop.count}, median ${stop.median} ms, p99 ${stop.p99} ms, max ${stop.max} ms`);
    }
  }
}

const { dir, callers } = parseArgs(process.argv.slice(2));
report(readEntries(dir, callers));
