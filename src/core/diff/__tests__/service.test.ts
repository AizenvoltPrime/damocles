import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { LineDiffJob } from '../protocol';
import { buildDiffWorker } from './worker-bundle';
import { DIFF_WATCHDOG_GRACE_MS, type DiffService } from '../service';

// Every worker the lanes start, and every request posted to one with its time, in order; failStarts makes that many
// constructor calls throw as Node's does when it cannot start a thread.
const threads = vi.hoisted(() => ({ started: [] as Worker[], posted: [] as unknown[], postedAt: [] as number[], failStarts: 0 }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class CountedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (threads.failStarts > 0) {
        threads.failStarts--;
        throw Object.assign(new Error('Worker initialization failure'), { code: 'ERR_WORKER_INIT_FAILED' });
      }
      super(...args);
      threads.started.push(this);
    }

    override postMessage(value: unknown, transferList?: readonly import('node:worker_threads').Transferable[]): void {
      threads.posted.push(value);
      threads.postedAt.push(performance.now());
      super.postMessage(value, transferList);
    }
  }
  return { ...actual, Worker: CountedWorker };
});

// The test setup loaded the service before this file's mock, so the lanes and the logger are imported again under it.
let createThreadDiffService: typeof import('../service').createThreadDiffService;
let installLogSink: typeof import('../../logger').installLogSink;

beforeAll(async () => {
  vi.resetModules();
  ({ createThreadDiffService } = await import('../service'));
  ({ installLogSink } = await import('../../logger'));
});

let logged: string[];
const services: DiffService[] = [];

beforeEach(() => {
  logged = [];
  threads.started.length = 0;
  threads.posted.length = 0;
  threads.postedAt.length = 0;
  threads.failStarts = 0;
  installLogSink({ appendLine: (line) => logged.push(line), show: () => undefined, dispose: () => undefined });
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  installLogSink({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined });
});

// The lanes run the worker bundle, so they are tested through it.
let workDir: string;
let bundle: string;
// posts ready and never answers
let silent: string;
// the real worker, except that a job whose before is 'crash' ends its thread
let crashing: string;

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-diff-worker-'));
  bundle = await buildDiffWorker(workDir);
  silent = path.join(workDir, 'silent-worker.js');
  fs.writeFileSync(silent, "const { parentPort } = require('node:worker_threads');\nparentPort.on('message', () => {});\nparentPort.postMessage({ type: 'ready' });\n");
  crashing = path.join(workDir, 'crashing-worker.js');
  fs.writeFileSync(crashing, "const { parentPort } = require('node:worker_threads');\nparentPort.on('message', (request) => { if (request.job.before === 'crash') process.exit(3); });\nrequire('./diff-worker.js');\n");
}, 60_000);

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function service(entry: string, options: { graceMs?: number; idleMs?: number; heapMb?: number } = {}): DiffService {
  const made = createThreadDiffService(entry, options);
  services.push(made);
  return made;
}

const job = (before: string, after: string, timeoutMs = 3_000): LineDiffJob => ({ kind: 'lineDiff', before, after, context: 3, maxEditLength: 1_000_000_000, timeoutMs });
const lines = (count: number, prefix: string): string => Array.from({ length: count }, (_, i) => `${prefix}${i}\n`).join('');
// every line differs, so jsdiff runs until its deadline
const slow = (timeoutMs: number): LineDiffJob => job(lines(20_000, 'a'), lines(20_000, 'b'), timeoutMs);
// jsdiff's line arrays for this pair alone pass the heap, so the worker runs out of memory well before the budget
const OOM_HEAP_MB = 16;
const OOM_JOB = job(lines(400_000, 'a'), lines(400_000, 'b'));
const exited = (worker: Worker): Promise<void> => vi.waitFor(() => expect(worker.threadId).toBe(-1), { timeout: 5_000 });

describe('the thread diff service', () => {
  it('answers jobs in order with their hunks and counts, on one worker', async () => {
    const diff = service(bundle);
    const order: number[] = [];
    const answers = await Promise.all([
      diff.lineDiff(job('a\nb\nc\n', 'a\nB\nc\n')).then((answer) => (order.push(1), answer)),
      diff.lineDiff(job('', 'x\ny\n')).then((answer) => (order.push(2), answer)),
      diff.lineDiff(job('same\n', 'same\n')).then((answer) => (order.push(3), answer)),
    ]);
    expect(order).toEqual([1, 2, 3]);
    expect(answers[0]).toEqual({ kind: 'diff', added: 1, removed: 1, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }] });
    expect(answers[1]).toMatchObject({ kind: 'diff', added: 2, removed: 0 });
    expect(answers[2]).toEqual({ kind: 'diff', added: 0, removed: 0, hunks: [] });
    expect(threads.started).toHaveLength(1);
  });

  it('runs a tool patch on its own lane, answered while a review diff runs to its budget', async () => {
    const diff = service(bundle);
    const review = diff.lineDiff(slow(2_000)).then((answer) => ({ answer, at: performance.now() }));
    await vi.waitFor(() => expect(threads.posted).toHaveLength(1));
    const patch = await diff.filePatch('f.txt', 'a\nb\n', 'a\nB\n');
    const patchedAt = performance.now();
    expect(patch).toEqual({ patch: '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n' });
    const { answer, at } = await review;
    expect(answer).toEqual({ kind: 'tooLarge' });
    expect(patchedAt).toBeLessThan(at);
    expect(threads.started).toHaveLength(2);
  }, 20_000);

  it('runs an Edit\'s patch on the tool lane, sending only the lines around its replacement', async () => {
    const diff = service(bundle);
    const base = lines(2_000, 'line ');
    const next = base.replace('line 1000\n', 'LINE 1000\n');
    const patch = await diff.editPatch('f.txt', base, next, [{ matchIndex: base.indexOf('line 1000'), matchLength: 9, newText: 'LINE 1000' }]);
    expect(patch).toEqual({ patch: '--- f.txt\n+++ f.txt\n@@ -997,9 +997,9 @@\n line 996\n line 997\n line 998\n line 999\n-line 1000\n+LINE 1000\n line 1001\n line 1002\n line 1003\n line 1004\n' });
    const [posted] = threads.posted as Array<{ job: { kind: string; windows: Array<{ oldText: string; oldLine: number }> } }>;
    expect(posted!.job.kind).toBe('editPatch');
    expect(posted!.job.windows.map((window) => [window.oldLine, window.oldText.split('\n').length - 1])).toEqual([[968, 65]]);
  });

  it('answers a binary or oversized patch on the calling thread, without a worker', async () => {
    const diff = service(bundle);
    expect(await diff.filePatch('f.bin', 'a\0b', 'c')).toEqual({ patchOmitted: 'binary' });
    expect(threads.started).toHaveLength(0);
  });

  it('answers tooLarge once jsdiff passes the job\'s time budget, and runs the next job on a fresh worker', async () => {
    const diff = service(bundle);
    expect(await diff.lineDiff(slow(300))).toEqual({ kind: 'tooLarge' });
    // from the post, so the worker's start is not counted; the watchdog would answer at the budget plus the grace
    const elapsed = performance.now() - threads.postedAt[0]!;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(300 + DIFF_WATCHDOG_GRACE_MS);
    await exited(threads.started[0]!);
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toMatchObject({ kind: 'diff', added: 1, removed: 1 });
    expect(await diff.lineDiff(job('a\n', 'c\n'))).toMatchObject({ kind: 'diff', added: 1, removed: 1 });
    expect(threads.started).toHaveLength(2);
    expect(logged).toEqual([]);
  }, 20_000);

  it('stops a worker that does not answer within the budget plus the grace, answers tooLarge and runs the next job on a fresh worker', async () => {
    const diff = service(silent, { graceMs: 100 });
    const start = performance.now();
    expect(await diff.lineDiff(job('a\n', 'b\n', 100))).toEqual({ kind: 'tooLarge' });
    expect(performance.now() - start).toBeGreaterThanOrEqual(190);
    await exited(threads.started[0]!);
    expect(logged.filter((line) => line.includes('ran past 200 ms; the worker was stopped'))).toHaveLength(1);
    expect(await diff.lineDiff(job('a\n', 'b\n', 100))).toEqual({ kind: 'tooLarge' });
    expect(threads.started).toHaveLength(2);
  });

  it('answers the job a crash ended tooLarge, and the jobs behind it run on a fresh worker', async () => {
    const diff = service(crashing);
    const [crashed, behind] = await Promise.all([diff.lineDiff(job('crash', 'x')), diff.lineDiff(job('a\n', 'b\n'))]);
    expect(crashed).toEqual({ kind: 'tooLarge' });
    expect(behind).toMatchObject({ kind: 'diff', added: 1, removed: 1 });
    expect(threads.started).toHaveLength(2);
    expect(logged.filter((line) => line.includes('the review worker stopped during a lineDiff job (exit code 3)'))).toHaveLength(1);
  });

  it('rejects a job that throws, which is a bug, and keeps the worker', async () => {
    const diff = service(bundle);
    await expect(diff.lineDiff({ ...job('a\n', 'b\n'), before: null as unknown as string })).rejects.toThrow(/the lineDiff diff job failed/);
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toMatchObject({ kind: 'diff' });
    expect(threads.started).toHaveLength(1);
  });

  it('stops an idle worker and starts another for the next job', async () => {
    const diff = service(bundle, { idleMs: 100 });
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toMatchObject({ kind: 'diff' });
    await exited(threads.started[0]!);
    expect(await diff.lineDiff(job('a\n', 'c\n'))).toMatchObject({ kind: 'diff' });
    expect(threads.started).toHaveLength(2);
    expect(logged).toEqual([]);
  });

  it('switches off after three workers in a row exit before ready, with one log line, and answers every job tooLarge', async () => {
    const diff = service(path.join(workDir, 'missing-worker.js'));
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toEqual({ kind: 'tooLarge' });
    expect(threads.started).toHaveLength(3);
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toEqual({ kind: 'tooLarge' });
    expect(threads.started).toHaveLength(3);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('failed to start 3 times in a row');
  });

  it('answers an aborted queued job tooLarge at once and never posts it', async () => {
    const diff = service(bundle);
    const running = diff.lineDiff(slow(1_000));
    const abort = new AbortController();
    const queued = diff.lineDiff(job('a\n', 'b\n'), { signal: abort.signal });
    let runningDone = false;
    void running.then(() => (runningDone = true));
    abort.abort();
    expect(await queued).toEqual({ kind: 'tooLarge' });
    expect(runningDone).toBe(false);
    expect(await running).toEqual({ kind: 'tooLarge' });
    expect(threads.posted).toHaveLength(1);
    expect(await diff.lineDiff(job('a\n', 'b\n'), { signal: abort.signal })).toEqual({ kind: 'tooLarge' });
    expect(threads.posted).toHaveLength(1);
  }, 20_000);

  it('listens once to a signal many queued jobs share, and its abort answers them all tooLarge', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      const diff = service(bundle);
      const running = diff.lineDiff(slow(1_000));
      const abort = new AbortController();
      const queued = Array.from({ length: 20 }, () => diff.lineDiff(job('a\n', 'b\n'), { signal: abort.signal }));
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1);
      // Node emits MaxListenersExceededWarning on a later tick
      await new Promise((resolve) => setImmediate(resolve));
      abort.abort();
      expect(await Promise.all(queued)).toEqual(Array.from({ length: 20 }, () => ({ kind: 'tooLarge' })));
      expect(await running).toEqual({ kind: 'tooLarge' });
      expect(threads.posted).toHaveLength(1);
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings.map((warning) => warning.name)).not.toContain('MaxListenersExceededWarning');
  }, 20_000);

  it('removes the signal\'s listener once its last queued job leaves the queue', async () => {
    const diff = service(bundle);
    const abort = new AbortController();
    const answers = Array.from({ length: 3 }, () => diff.lineDiff(job('a\n', 'b\n'), { signal: abort.signal }));
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1);
    expect(await Promise.all(answers)).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ kind: 'diff' })));
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('answers a tool patch whose signal aborted tooLarge, without a worker', async () => {
    const diff = service(bundle);
    const signal = AbortSignal.abort();
    expect(await diff.filePatch('f.txt', 'a\n', 'b\n', { signal })).toEqual({ patchOmitted: 'tooLarge' });
    expect(await diff.editPatch('f.txt', 'a\n', 'b\n', [{ matchIndex: 0, matchLength: 1, newText: 'b' }], { signal })).toEqual({ patchOmitted: 'tooLarge' });
    expect(threads.started).toHaveLength(0);
  });

  it('counts a worker constructor that throws as a start failure: the job answers tooLarge and the next runs', async () => {
    const diff = service(bundle);
    threads.failStarts = 1;
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toEqual({ kind: 'tooLarge' });
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toMatchObject({ kind: 'diff', added: 1, removed: 1 });
    expect(threads.started).toHaveLength(1);
    expect(logged).toEqual([]);
  });

  it('switches off after three worker constructors in a row throw, answering every queued job tooLarge', async () => {
    const diff = service(bundle);
    threads.failStarts = 3;
    const answers = await Promise.all(Array.from({ length: 5 }, () => diff.lineDiff(job('a\n', 'b\n'))));
    expect(answers).toEqual(Array.from({ length: 5 }, () => ({ kind: 'tooLarge' })));
    expect(threads.failStarts).toBe(0);
    expect(threads.started).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('failed to start 3 times in a row (Worker initialization failure)');
  });

  it('resets the start-failure count when a worker starts', async () => {
    const diff = service(bundle, { idleMs: 100 });
    threads.failStarts = 2;
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toEqual({ kind: 'tooLarge' });
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toEqual({ kind: 'tooLarge' });
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toMatchObject({ kind: 'diff' });
    await exited(threads.started[0]!);
    threads.failStarts = 2;
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toEqual({ kind: 'tooLarge' });
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toEqual({ kind: 'tooLarge' });
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toMatchObject({ kind: 'diff' });
    expect(threads.started).toHaveLength(2);
    expect(logged).toEqual([]);
  });

  it('switching off answers both lanes\' queued jobs tooLarge, with one log line', async () => {
    const diff = service(path.join(workDir, 'missing-worker.js'));
    const answers = await Promise.all([
      diff.lineDiff(job('a\n', 'b\n')),
      diff.lineDiff(job('a\n', 'c\n')),
      diff.filePatch('f.txt', 'a\n', 'b\n'),
      diff.filePatch('g.txt', 'a\n', 'c\n'),
    ]);
    expect(answers).toEqual([{ kind: 'tooLarge' }, { kind: 'tooLarge' }, { patchOmitted: 'tooLarge' }, { patchOmitted: 'tooLarge' }]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('failed to start 3 times in a row');
    const started = threads.started.length;
    expect(await diff.filePatch('h.txt', 'a\n', 'b\n')).toEqual({ patchOmitted: 'tooLarge' });
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toEqual({ kind: 'tooLarge' });
    expect(threads.started).toHaveLength(started);
  });

  it('answers a job that runs its worker out of memory tooLarge, logs it, and runs the next job on a fresh worker', async () => {
    const diff = service(bundle, { heapMb: OOM_HEAP_MB });
    expect(await diff.lineDiff(OOM_JOB)).toEqual({ kind: 'tooLarge' });
    expect(logged.some((line) => line.includes('ERR_WORKER_OUT_OF_MEMORY'))).toBe(true);
    expect(logged.some((line) => line.includes('the review worker stopped during a lineDiff job'))).toBe(true);
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toMatchObject({ kind: 'diff', added: 1, removed: 1 });
    expect(threads.started).toHaveLength(2);
  }, 20_000);

  it('close answers the running and queued jobs tooLarge, stops the worker and answers later jobs at once', async () => {
    const diff = service(bundle);
    const running = diff.lineDiff(slow(5_000));
    const queued = diff.lineDiff(job('a\n', 'b\n'));
    await vi.waitFor(() => expect(threads.posted).toHaveLength(1));
    await diff.close();
    expect(await running).toEqual({ kind: 'tooLarge' });
    expect(await queued).toEqual({ kind: 'tooLarge' });
    expect(threads.started[0]!.threadId).toBe(-1);
    expect(await diff.lineDiff(job('a\n', 'b\n'))).toEqual({ kind: 'tooLarge' });
    expect(threads.started).toHaveLength(1);
  });
});
