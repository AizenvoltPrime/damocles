import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { build, type BuildOptions, type Plugin } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../__mocks__/spawn-budget';
import { createLauncherPool, LauncherWorkerDiedError, type LaunchedProcess, type Launcher } from '../index';
import { MAX_UNACKED_BYTES, type LauncherEvent } from '../protocol';
import { lockThreadSpawns, spawnLock } from '../spawn-lock';
import { createLauncherHost } from '../worker';

// Matches fixtures/blocking-worker.ts.
const BLOCK_ARG = '--damocles-test-block-start';
const BLOCK_MS = 3000;
const NODE = process.execPath;

// koffi finds its native module beside its own files, so the bundles require it from the repository.
const koffiExternal: Plugin = {
  name: 'koffi-external',
  setup(b) {
    const resolved = createRequire(import.meta.url).resolve('koffi');
    b.onResolve({ filter: /^koffi$/ }, () => ({ path: resolved, external: true }));
  },
};

let root: string;
let workerPath: string;
let blockingPath: string;
const pools: Launcher[] = [];

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-launcher-'));
  workerPath = path.join(root, 'process-launcher-worker.js');
  blockingPath = path.join(root, 'blocking-worker.js');
  const options: BuildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent', plugins: [koffiExternal] };
  await Promise.all([
    build({ ...options, entryPoints: [path.resolve(__dirname, '..', 'worker.ts')], outfile: workerPath }),
    build({ ...options, entryPoints: [path.resolve(__dirname, 'fixtures', 'blocking-worker.ts')], outfile: blockingPath }),
  ]);
}, 60_000);

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.dispose()));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function pool(startWorker?: () => Worker): Launcher {
  const launcher = createLauncherPool({ workerPath, sentinelPath: path.join(root, 'sentinel.js'), ...(startWorker ? { startWorker } : {}) });
  pools.push(launcher);
  return launcher;
}

function node(script: string, extra: readonly string[] = []): { file: string; args: string[] } {
  return { file: NODE, args: [...extra, '-e', script] };
}

function collect(child: LaunchedProcess, stream: 'stdout' | 'stderr' = 'stdout'): { text: () => string; chunks: Buffer[] } {
  const chunks: Buffer[] = [];
  child.onData(stream, (chunk) => chunks.push(chunk));
  return { chunks, text: () => Buffer.concat(chunks).toString('utf8') };
}

// A zombie still answers signal 0, so on Linux its state decides.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

// A parent in its own process group (POSIX) that starts a long-lived child and prints its pid.
const TREE = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(c.pid)); setInterval(() => {}, 1000);`;

async function treeOf(child: LaunchedProcess): Promise<{ parent: number; grandchild: number }> {
  const out = collect(child);
  const parent = await child.pid;
  await vi.waitFor(() => expect(out.text()).toMatch(/^\d+$/), { timeout: SPAWN_TEST_TIMEOUT_MS });
  return { parent, grandchild: Number(out.text()) };
}

describe('the process launcher pool', { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  it('streams output as it is written, and buffers to the same bytes', async () => {
    const child = pool().launch(node("process.stdout.write('first'); setTimeout(() => process.stdout.write(' second'), 300);"));
    const out = collect(child);
    await vi.waitFor(() => expect(out.text()).toBe('first'), { timeout: SPAWN_TEST_TIMEOUT_MS });
    const exit = await child.exited;
    await child.closed;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(out.text()).toBe('first second');
  });

  it('writes stdin and reports the exit code and stderr', async () => {
    const child = pool().launch(node("let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => { process.stdout.write(s.toUpperCase()); process.stderr.write('warn'); process.exit(3); });"));
    const out = collect(child);
    const err = collect(child, 'stderr');
    child.write('hello ');
    child.end(Buffer.from('world'));
    expect(await child.exited).toEqual({ code: 3, signal: null });
    await child.closed;
    expect(out.text()).toBe('HELLO WORLD');
    expect(err.text()).toBe('warn');
  });

  it('fails a start of a missing program as Node does, with ENOENT', async () => {
    const child = pool().launch({ file: 'damocles-no-such-binary-xyz', args: [] });
    await expect(child.pid).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(child.exited).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(child.closed).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kills a process, and its whole tree when asked', async () => {
    const launcher = pool();
    const single = launcher.launch(node('setInterval(() => {}, 1000)'));
    await single.pid;
    single.kill();
    const killed = await single.exited;
    expect(killed.code !== 0 || killed.signal !== null).toBe(true);

    const tree = launcher.launch({ ...node(TREE), detached: process.platform !== 'win32' });
    const { parent, grandchild } = await treeOf(tree);
    expect(alive(grandchild)).toBe(true);
    tree.kill({ tree: true });
    await tree.exited;
    await vi.waitFor(() => expect([alive(parent), alive(grandchild)]).toEqual([false, false]), { timeout: SPAWN_TEST_TIMEOUT_MS });
  });

  it('closes a process whose descendant holds its output once the exit grace passes with no output, and kills nothing', async () => {
    // Detached, since libuv's own job on Windows kills a non-detached child when its node parent exits.
    const holder = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }); c.unref(); process.stdout.write(String(c.pid));`;
    const launcher = pool();
    const start = async (extra: { exitOutputIdleMs?: number }): Promise<{ child: LaunchedProcess; grandchild: number }> => {
      const child = launcher.launch({ ...node(holder), detached: process.platform !== 'win32', ...extra });
      const out = collect(child);
      await child.exited;
      await vi.waitFor(() => expect(out.text()).toMatch(/^\d+$/), { timeout: SPAWN_TEST_TIMEOUT_MS });
      return { child, grandchild: Number(out.text()) };
    };
    const held = await start({});
    const graced = await start({ exitOutputIdleMs: 100 });
    try {
      let heldClosed = false;
      void held.child.closed.then(() => {
        heldClosed = true;
      }, () => undefined);

      await graced.child.closed;

      // held exited before graced started, so it has been silent at least as long
      expect(heldClosed).toBe(false);
      expect(alive(graced.grandchild)).toBe(true);
      process.kill(held.grandchild, 'SIGKILL');
      await held.child.closed;
    } finally {
      for (const pid of [held.grandchild, graced.grandchild]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('settles a write once it reached stdin, and rejects one the process can no longer read', async () => {
    // exits at once, leaving a child that holds its output, so the process stays open past its exit
    const leaving = `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: process.platform === 'win32' }); c.unref(); process.stdout.write(String(c.pid)); process.stdin.once('data', () => process.exit(0));`;
    const child = pool().launch({ ...node(leaving), detached: process.platform !== 'win32' });
    const out = collect(child);
    await vi.waitFor(() => expect(out.text()).toMatch(/^\d+$/), { timeout: SPAWN_TEST_TIMEOUT_MS });
    try {
      await expect(child.write('go')).resolves.toBeUndefined();
      await child.exited;
      await expect(child.write('late')).rejects.toMatchObject({ code: 'ERR_STREAM_DESTROYED' });
    } finally {
      process.kill(Number(out.text()), 'SIGKILL');
    }
  });

  it('kills what it still runs when disposed', async () => {
    const launcher = pool();
    const tree = launcher.launch({ ...node(TREE), detached: process.platform !== 'win32' });
    const { parent, grandchild } = await treeOf(tree);
    await launcher.dispose();
    await expect(tree.exited).rejects.toThrow('disposed');
    await vi.waitFor(() => expect([alive(parent), alive(grandchild)]).toEqual([false, false]), { timeout: SPAWN_TEST_TIMEOUT_MS });
  });

  it('kills a process tree when its signal aborts', async () => {
    const controller = new AbortController();
    const child = pool().launch({ ...node(TREE), detached: process.platform !== 'win32' }, { signal: controller.signal });
    const { grandchild } = await treeOf(child);
    controller.abort();
    await child.exited;
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: SPAWN_TEST_TIMEOUT_MS });
  });

  it('runs a start on another worker while one worker is held inside a start, and keeps other output flowing', async () => {
    const launcher = pool(() => new Worker(blockingPath, { env: SHARE_ENV }));
    const streaming = launcher.launch(node("let n = 0; const t = setInterval(() => { process.stdout.write('.'); if (++n === 20) { clearInterval(t); } }, 100);"));
    const ticks = collect(streaming);
    await streaming.pid;
    const started = Date.now();
    const blocked = launcher.launch(node('', [BLOCK_ARG]));
    const quick = launcher.launch(node("process.stdout.write('quick')"));
    const quickOut = collect(quick);
    await quick.exited;
    await quick.closed;
    const quickMs = Date.now() - started;
    const ticksBefore = ticks.text().length;
    await vi.waitFor(() => expect(ticks.text().length).toBeGreaterThan(ticksBefore), { timeout: BLOCK_MS / 2 });
    const tickedWhileBlocked = Date.now() - started < BLOCK_MS;
    await blocked.exited;
    expect(quickOut.text()).toBe('quick');
    expect(quickMs).toBeLessThan(BLOCK_MS);
    expect(tickedWhileBlocked).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(BLOCK_MS - 100);
  });

  it('fails every process of a worker that dies and kills what they started', async () => {
    const workers: Worker[] = [];
    const launcher = pool(() => {
      const worker = new Worker(workerPath, { env: SHARE_ENV, workerData: { marker: 'damocles-process-launcher', sentinelPath: '', spawnLock: spawnLock() } });
      workers.push(worker);
      return worker;
    });
    const child = launcher.launch({ ...node(TREE), detached: process.platform !== 'win32' });
    const { parent, grandchild } = await treeOf(child);
    await workers[0]!.terminate();
    await expect(child.exited).rejects.toBeInstanceOf(LauncherWorkerDiedError);
    await expect(child.closed).rejects.toBeInstanceOf(LauncherWorkerDiedError);
    await vi.waitFor(() => expect([alive(parent), alive(grandchild)]).toEqual([false, false]), { timeout: SPAWN_TEST_TIMEOUT_MS });
    // the pool replaced the worker
    const next = launcher.launch(node("process.stdout.write('after')"));
    const out = collect(next);
    await next.closed;
    expect(out.text()).toBe('after');
  });

  it.skipIf(process.platform !== 'win32')('kills a session job\'s processes started on two workers when the job closes', async () => {
    const launcher = pool();
    const job = launcher.createSessionJob();
    const first = launcher.launch({ ...node(TREE), job: job.id });
    const second = launcher.launch({ ...node(TREE), job: job.id });
    const trees = await Promise.all([treeOf(first), treeOf(second)]);
    job.dispose();
    await vi.waitFor(() => expect(trees.flatMap((tree) => [alive(tree.parent), alive(tree.grandchild)])).toEqual([false, false, false, false]), { timeout: SPAWN_TEST_TIMEOUT_MS });
  });

  // A long-lived process created on one thread while a short one is inside its start on another inherits the short one's
  // pipe ends (libuv makes them inheritable for the length of uv_spawn), so the short one exits but never closes.
  it.skipIf(process.platform !== 'win32')('closes every short process started beside long-lived ones on other workers once it exits', async () => {
    const launcher = pool();
    const held = await heldShorts(launcher, () => {
      const child = launcher.launch(node(LONG));
      return () => {
        child.kill({ tree: true });
        return child.closed;
      };
    });
    expect(held).toEqual([]);
  }, SPAWN_TEST_TIMEOUT_MS * 8);

  it.skipIf(process.platform !== 'win32')('closes every short process started beside long-lived ones the host thread starts without the launcher', async () => {
    const unlock = lockThreadSpawns();
    try {
      const held = await heldShorts(pool(), () => {
        const child = spawn(NODE, ['-e', LONG], { windowsHide: true });
        const closed = once(child, 'close');
        return async () => {
          child.kill();
          await closed;
        };
      });
      expect(held).toEqual([]);
    } finally {
      unlock();
    }
  }, SPAWN_TEST_TIMEOUT_MS * 8);
});

const LONG = 'setInterval(() => {}, 1000)';

// Rounds of 8 short processes on the pool beside 4 long-lived ones; the pids of short ones that exited and did not close.
async function heldShorts(launcher: Launcher, startLong: () => () => Promise<unknown>): Promise<number[]> {
  const held: number[] = [];
  for (let round = 0; round < 6 && held.length === 0; round++) {
    const shorts: LaunchedProcess[] = [];
    const stops: Array<() => Promise<unknown>> = [];
    for (let index = 0; index < 12; index++) {
      if (index % 3 === 0) stops.push(startLong());
      else shorts.push(launcher.launch(node('')));
    }
    await Promise.all(shorts.map(async (child) => {
      await child.exited;
      const closed = await Promise.race([child.closed.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000))]);
      if (!closed) held.push(await child.pid);
    }));
    await Promise.all([...stops.map((stop) => stop()), ...shorts.map((child) => child.closed)]);
  }
  return held;
}

describe('a launcher worker', { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it('pauses a process\'s output past the unacknowledged bound until the client acknowledges it', async () => {
    const total = 8 * MAX_UNACKED_BYTES;
    let posted = 0;
    let closed = false;
    const host = createLauncherHost({
      post: (event: LauncherEvent) => {
        if (event.type === 'data') posted += event.chunk.byteLength;
        if (event.type === 'close') closed = true;
      },
    });
    host({ type: 'spawn', id: 1, spec: node(`const b = Buffer.alloc(${total}, 97); process.stdout.write(b);`) });
    await vi.waitFor(() => expect(posted).toBeGreaterThan(MAX_UNACKED_BYTES), { timeout: SPAWN_TEST_TIMEOUT_MS });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // one chunk past the bound at most, since a stream pauses after the chunk it is delivering
    expect(posted).toBeLessThan(MAX_UNACKED_BYTES + 1024 * 1024);
    expect(closed).toBe(false);
    let acked = 0;
    await vi.waitFor(() => {
      host({ type: 'ack', id: 1, bytes: posted - acked });
      acked = posted;
      expect(closed).toBe(true);
    }, { timeout: SPAWN_TEST_TIMEOUT_MS, interval: 20 });
    expect(posted).toBe(total);
  });
});
