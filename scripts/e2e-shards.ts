/**
 * The dev desktop suite's shards, balanced by run time: spec files go longest first to the shard with the least time so far,
 * by the target's recorded seconds per file in e2e/desktop/shard-timings.json. A file with no record counts its tests at the
 * median seconds per test of the recorded files, or at one each when the target has no record. Whole files keep a file's
 * serial tests together (docs/release.md "Desktop end-to-end suite").
 *
 *   node scripts/e2e-shards.ts plan --shard 2/7 --target mac-arm64 --out <file>   # that shard's files, as a --test-list
 *   node scripts/e2e-shards.ts timings --target mac-arm64 <report.json>...       # records the seconds of the reports' files
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.ts';
import { DESKTOP_TARGETS } from './release-targets.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TIMINGS_FILE = join(ROOT, 'e2e', 'desktop', 'shard-timings.json');
const PROJECT = 'dev';

export interface SpecFile {
  readonly file: string;
  readonly tests: number;
}

// by target, the seconds each spec file's tests took
export type Timings = Record<string, Record<string, number>>;

interface ReportSpec {
  readonly file: string;
  readonly tests: ReadonlyArray<{ readonly results?: ReadonlyArray<{ readonly duration: number; readonly status?: string }> }>;
}

interface ReportSuite {
  readonly specs?: readonly ReportSpec[];
  readonly suites?: readonly ReportSuite[];
}

/** A Playwright JSON report, or the --list of one. */
export interface Report {
  readonly suites: readonly ReportSuite[];
}

function specsOf(report: Report): ReportSpec[] {
  const specs: ReportSpec[] = [];
  const walk = (suite: ReportSuite): void => {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  return specs;
}

/** Each spec file of a report with its test count. */
export function specFiles(report: Report): SpecFile[] {
  const counts = new Map<string, number>();
  for (const spec of specsOf(report)) counts.set(spec.file, (counts.get(spec.file) ?? 0) + spec.tests.length);
  return [...counts].map(([file, tests]) => ({ file, tests }));
}

/**
 * The seconds each file's tests took in a run, every attempt counted, as the shard's clock counts them. A file with a test
 * that never started or was cut short (globalTimeout ended the run) is left out, since its time is not known.
 */
export function fileSeconds(report: Report): Record<string, number> {
  const seconds: Record<string, number> = {};
  const unknown = new Set<string>();
  for (const spec of specsOf(report)) {
    const results = spec.tests.map((test) => test.results ?? []);
    if (results.some((attempts) => attempts.length === 0 || attempts.some((result) => result.status === 'interrupted'))) unknown.add(spec.file);
    const ms = results.flat().reduce((sum, result) => sum + result.duration, 0);
    seconds[spec.file] = (seconds[spec.file] ?? 0) + ms / 1000;
  }
  for (const file of unknown) delete seconds[file];
  return seconds;
}

/**
 * `total` lists of files of about equal estimated time, each in name order; a file always goes to the same shard. Throws when a
 * shard would be empty, since Playwright passes a run of an empty test list.
 */
export function planShards(files: readonly SpecFile[], seconds: Readonly<Record<string, number>>, total: number): string[][] {
  const perTest = files.filter((spec) => seconds[spec.file] !== undefined && spec.tests > 0).map((spec) => seconds[spec.file]! / spec.tests).sort((a, b) => a - b);
  const median = perTest.length === 0 ? 1 : perTest[Math.floor(perTest.length / 2)]!;
  const weighted = files.map((spec) => ({ file: spec.file, weight: seconds[spec.file] ?? spec.tests * median }))
    .sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : 1));
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] as string[] }));
  for (const { file, weight } of weighted) {
    const least = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    least.files.push(file);
    least.load += weight;
  }
  if (files.length < total) throw new Error(`${total} shards for ${files.length} spec files would leave a shard with no tests`);
  return shards.map((shard) => shard.files.sort());
}

/** A --test-list naming whole files of the dev project. */
export const testList = (files: readonly string[]): string => files.map((file) => `[${PROJECT}] › ${file}\n`).join('');

export function parseShard(value: string | undefined): { readonly current: number; readonly total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || current < 1 || current > total) throw new Error(`--shard takes <current>/<total>, 1 <= current <= total, not ${value}`);
  return { current, total };
}

const readTimings = (): Timings => JSON.parse(readFileSync(TIMINGS_FILE, 'utf8')) as Timings;

function listedFiles(): SpecFile[] {
  // with this set, the json reporter writes the listing to that file instead of stdout
  const env = { ...process.env };
  delete env['PLAYWRIGHT_JSON_OUTPUT_FILE'];
  const cli = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  const listed = spawnSync(process.execPath, [cli, 'test', '--config', 'playwright.desktop.config.ts', `--project=${PROJECT}`, '--list', '--reporter=json'], {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error(`Listing the suite failed (${listed.error?.message ?? `exit ${listed.status}`}): ${listed.stderr}`);
  return specFiles(JSON.parse(listed.stdout) as Report);
}

const option = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

/** A desktop target of release-targets.ts, whose times the timings file keeps under its name. */
export function desktopTarget(value: string | undefined): string {
  if (value === undefined || !Object.hasOwn(DESKTOP_TARGETS, value)) throw new Error(`--target takes a desktop target (${Object.keys(DESKTOP_TARGETS).join(', ')}), not ${value}`);
  return value;
}

function plan(args: readonly string[]): void {
  const { current, total } = parseShard(option(args, '--shard'));
  const target = desktopTarget(option(args, '--target'));
  const out = option(args, '--out');
  if (!out) throw new Error('Usage: e2e-shards.ts plan --shard <n>/<total> --target <target> --out <file>');
  const seconds = readTimings()[target] ?? {};
  const files = listedFiles();
  const shards = planShards(files, seconds, total);
  const mine = shards[current - 1]!;
  writeFileSync(out, testList(mine));
  const recorded = files.filter((spec) => seconds[spec.file] !== undefined).length;
  console.log(`Shard ${current} of ${total} on ${target}: ${mine.length} of ${files.length} spec files, balanced by ${recorded} recorded file times`);
}

function timings(args: readonly string[]): void {
  const target = desktopTarget(option(args, '--target'));
  const reports = args.filter((arg, at) => !arg.startsWith('--') && args[at - 1] !== '--target');
  if (reports.length === 0) throw new Error('Usage: e2e-shards.ts timings --target <target> <report.json>...');
  const all = readTimings();
  const recorded = { ...all[target] };
  for (const report of reports) {
    for (const [file, seconds] of Object.entries(fileSeconds(JSON.parse(readFileSync(report, 'utf8')) as Report))) recorded[file] = Math.round(seconds * 10) / 10;
  }
  all[target] = Object.fromEntries(Object.entries(recorded).sort(([a], [b]) => (a < b ? -1 : 1)));
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(TIMINGS_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`${TIMINGS_FILE}: ${Object.keys(recorded).length} files for ${target}`);
}

if (isEntryPoint(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'plan') plan(args);
    else if (command === 'timings') timings(args);
    else throw new Error('Usage: e2e-shards.ts plan|timings ...');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
