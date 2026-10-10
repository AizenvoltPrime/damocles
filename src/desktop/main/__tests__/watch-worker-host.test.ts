import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FsWatchTreeHost, RawListener } from '../../watch-worker/fs-watch-tree';
import type { WatchRequest } from '../../watch-worker/protocol';
import { createWorkerTreeHost, MAX_WORKER_RESTARTS, type WatchWorker } from '../platform/watch-worker-host';

// Runs the built worker; with a gate, every fs.promises.readdir posts 'entered' on it and waits for its first message.
const GATED_ENTRY = `
const fs = require('node:fs');
const { workerData } = require('node:worker_threads');
const { gate } = workerData;
if (gate) {
  const opened = new Promise((resolve) => gate.once('message', resolve));
  const readdir = fs.promises.readdir;
  fs.promises.readdir = async (...args) => {
    gate.postMessage('entered');
    await opened;
    return readdir(...args);
  };
}
require(workerData.bundle);
`;

const WAIT = { timeout: 15_000 };

let bundle: string;
let dir: string;
let lines: string[];
// Set before a worker starts to gate its listings; gate is then the test's end.
let holdListings: boolean;
let gate: MessagePort | undefined;
let workers: Worker[];
let host: FsWatchTreeHost;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Long enough for a flush, the scans it queues and the message that carries their events.
const quiet = (): Promise<void> => sleep(500);

interface Recorded {
  readonly events: string[];
  readonly emit: RawListener;
}

// Every event as "<type> <path under dir>", with / separators.
function recorder(): Recorded {
  const events: string[] = [];
  return { events, emit: (type, fsPath) => events.push(`${type} ${path.relative(dir, fsPath).split(path.sep).join('/')}`) };
}

// The startup scan absorbs what it lists, so a fresh probe name is written until one is reported; its stragglers then settle.
async function live(recorded: Recorded, base = dir): Promise<string[]> {
  const probe = path.join(base, 'probe');
  const prefix = `create ${path.relative(dir, probe).split(path.sep).join('/')}/`;
  fs.mkdirSync(probe, { recursive: true });
  let attempt = 0;
  await vi.waitFor(() => {
    fs.writeFileSync(path.join(probe, String(attempt++)), 'probe');
    expect(recorded.events.some((event) => event.startsWith(prefix))).toBe(true);
  }, WAIT);
  await quiet();
  const seen = [...recorded.events];
  recorded.events.length = 0;
  return seen;
}

// Every message a worker posts to main, in arrival order.
function rawReplies(worker: Worker): unknown[] {
  const replies: unknown[] = [];
  worker.on('message', (message: unknown) => replies.push(message));
  return replies;
}

const isEventsFor = (id: number) => (reply: unknown): boolean => (reply as { kind?: unknown; id?: unknown }).kind === 'events' && (reply as { id?: unknown }).id === id;

beforeAll(async () => {
  bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-watch-worker-')), 'watch-worker.js');
  await build({ entryPoints: [path.resolve(__dirname, '..', '..', 'watch-worker', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: bundle, logLevel: 'silent' });
});

afterAll(() => {
  fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-watch-worker-'));
  lines = [];
  holdListings = false;
  gate = undefined;
  workers = [];
  host = createWorkerTreeHost(() => {
    const channel = holdListings ? new MessageChannel() : undefined;
    gate = channel?.port1;
    const worker = new Worker(GATED_ENTRY, { eval: true, workerData: { bundle, gate: channel?.port2 }, transferList: channel ? [channel.port2] : [] });
    workers.push(worker);
    return worker;
  }, (line) => lines.push(line));
});

afterEach(async () => {
  gate?.postMessage('open');
  gate?.close();
  await host.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('the Windows tree on the watch worker', { timeout: 30_000 }, () => {
  it('reports a file created, changed, renamed and deleted under the path main gave', async () => {
    const recorded = recorder();
    host.start(dir, false, recorded.emit, () => undefined);
    await live(recorded);

    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'one');
    await vi.waitFor(() => expect(recorded.events).toContain('create sub/a.txt'), WAIT);
    await quiet();
    fs.appendFileSync(path.join(dir, 'sub', 'a.txt'), ', two');
    await vi.waitFor(() => expect(recorded.events).toContain('change sub/a.txt'), WAIT);
    await quiet();
    fs.renameSync(path.join(dir, 'sub', 'a.txt'), path.join(dir, 'sub', 'b.txt'));
    await vi.waitFor(() => expect(recorded.events).toContain('create sub/b.txt'), WAIT);
    await quiet();
    fs.rmSync(path.join(dir, 'sub', 'b.txt'));
    await vi.waitFor(() => expect(recorded.events).toContain('delete sub/b.txt'), WAIT);
    await quiet();
    expect(recorded.events).toEqual(['create sub', 'create sub/a.txt', 'change sub/a.txt', 'delete sub/a.txt', 'create sub/b.txt', 'delete sub/b.txt']);
    expect(workers).toHaveLength(1);
  });

  it('sends a disposed watch nothing more, while another watch on the same worker goes on', async () => {
    const disposed = recorder();
    const kept = recorder();
    const watch = host.start(dir, false, disposed.emit, () => undefined);
    host.start(dir, false, kept.emit, () => undefined);
    await live(disposed);
    await live(kept);

    watch.dispose();
    disposed.events.length = 0;
    fs.writeFileSync(path.join(dir, 'after.txt'), 'x');
    await vi.waitFor(() => expect(kept.events).toContain('create after.txt'), WAIT);
    await quiet();
    expect(disposed.events).toEqual([]);
    expect(workers).toHaveLength(1);
  });

  it('does nothing for a watch disposed before the worker started it', async () => {
    const kept = recorder();
    const dropped = recorder();
    const lost = vi.fn();
    host.start(dir, false, kept.emit, () => undefined);
    const replies = rawReplies(workers[0]!);
    host.start(dir, true, dropped.emit, lost).dispose();
    fs.writeFileSync(path.join(dir, 'present.txt'), 'x');
    await live(kept);

    fs.writeFileSync(path.join(dir, 'after.txt'), 'x');
    await vi.waitFor(() => expect(kept.events).toContain('create after.txt'), WAIT);
    await quiet();
    expect(replies.filter((reply) => (reply as { id?: unknown }).id === 1)).toEqual([]);
    expect(dropped.events).toEqual([]);
    expect(lost).not.toHaveBeenCalled();
  });

  it('reports the files of a deleted root before its lost reply', async () => {
    const root = path.join(dir, 'root');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'x');
    const recorded = recorder();
    host.start(root, false, recorded.emit, () => recorded.events.push('lost'));
    await live(recorded, root);

    fs.rmSync(root, { recursive: true });
    await vi.waitFor(() => expect(recorded.events).toContain('lost'), WAIT);
    await quiet();
    expect(recorded.events.at(-1)).toBe('lost');
    expect(recorded.events).toEqual(expect.arrayContaining(['delete root/a.txt', 'delete root/sub/b.txt', 'delete root/sub', 'delete root/probe']));
    expect(lines.filter((line) => line.includes('the watch worker'))).toEqual([]);
  });

  it('closes only once a running scan settled, sends no events after the close, then ends the worker', async () => {
    fs.writeFileSync(path.join(dir, 'present.txt'), 'x');
    holdListings = true;
    const recorded = recorder();
    host.start(dir, true, recorded.emit, () => undefined);
    const replies = rawReplies(workers[0]!);
    await once(gate!, 'message');
    let exited = false;
    workers[0]!.on('exit', () => (exited = true));

    let closed = false;
    const closing = host.close().then(() => {
      closed = true;
    });
    await sleep(100);
    expect(closed).toBe(false);
    expect(exited).toBe(false);

    gate!.postMessage('open');
    await closing;
    expect(exited).toBe(true);
    expect(recorded.events).toEqual([]);
    expect(replies.filter(isEventsFor(0))).toEqual([]);
    expect(replies).toContainEqual({ kind: 'closed' });
    expect(host.start(dir, true, recorded.emit, () => undefined)).toBeDefined();
    expect(workers).toHaveLength(1);
  });

  it('watches every root again on a fresh worker when the worker exits, reporting nothing the roots already held', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'present.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'nested.txt'), 'x');
    const recorded = recorder();
    const lost = vi.fn();
    host.start(dir, false, recorded.emit, lost);
    await live(recorded);

    await workers[0]!.terminate();
    await vi.waitFor(() => expect(lines).toContain('[watcher] the watch worker restarted; 1 watches re-established'), WAIT);
    expect(lines).toContain('[watcher] the watch worker exited with 1');
    expect(workers).toHaveLength(2);

    const seen = await live(recorded);
    expect(seen.filter((event) => !/^(create|change) probe\/\d+$/.test(event))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'after.txt'), 'x');
    await vi.waitFor(() => expect(recorded.events).toContain('create after.txt'), WAIT);
    await quiet();
    expect(recorded.events).toEqual(['create after.txt']);
    expect(lost).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.includes('is gone'))).toEqual([]);
  });
});

// A worker thread main drives by hand: what main posted, and the replies, errors and exits a test makes it send.
class FakeWorker implements WatchWorker {
  readonly posted: WatchRequest[] = [];
  terminated = false;
  private readonly listeners = new Map<string, ((value: never) => void)[]>();

  postMessage(request: WatchRequest): void {
    this.posted.push(request);
    if (request.kind === 'close') setImmediate(() => this.reply({ kind: 'closed' }));
  }

  on(event: string, listener: (value: never) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  async terminate(): Promise<number> {
    if (!this.terminated) {
      this.terminated = true;
      setImmediate(() => this.fire('exit', 1));
    }
    return 1;
  }

  reply(message: unknown): void {
    this.fire('message', message);
  }

  fire(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
}

describe('the watch worker host', () => {
  let fakes: FakeWorker[];
  let logged: string[];
  let tree: FsWatchTreeHost;
  let existing: string;

  beforeEach(() => {
    fakes = [];
    logged = [];
    existing = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-watch-host-'));
    tree = createWorkerTreeHost(() => {
      const fake = new FakeWorker();
      fakes.push(fake);
      return fake;
    }, (line) => logged.push(line));
  });

  afterEach(async () => {
    await tree.close();
    fs.rmSync(existing, { recursive: true, force: true });
  });

  it('logs a failed watch whose directory exists and does not report it lost', () => {
    const lost = vi.fn();
    const emit = vi.fn();
    tree.start(existing, false, emit, lost);
    fakes[0]!.reply({ kind: 'failed', id: 0, message: 'EPERM: operation not permitted' });
    fakes[0]!.reply({ kind: 'events', id: 0, events: [['create', path.join(existing, 'a')]] });

    expect(logged).toEqual([`[watcher] could not watch ${existing}: EPERM: operation not permitted`]);
    expect(lost).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('reports a failed watch lost when its directory vanished', () => {
    const lost = vi.fn();
    const gone = path.join(existing, 'gone');
    tree.start(gone, false, () => undefined, lost);
    fakes[0]!.reply({ kind: 'failed', id: 0, message: 'ENOENT: no such file or directory' });

    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('ends a worker that sends a malformed reply and watches every live root again on a fresh one, without replay', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const lost = vi.fn();
    tree.start(existing, true, first, lost);
    tree.start(os.tmpdir(), false, () => undefined, lost).dispose();
    tree.start(existing, false, second, lost);
    fakes[0]!.reply({ kind: 'events', id: 0, events: [['renamed', 'x']] });

    expect(fakes[0]!.terminated).toBe(true);
    expect(fakes).toHaveLength(2);
    expect(fakes[1]!.posted).toEqual([
      { kind: 'watch', id: 0, dir: existing, report: false },
      { kind: 'watch', id: 2, dir: existing, report: false },
    ]);
    expect(logged).toEqual(['[watcher] the watch worker sent a malformed reply', '[watcher] the watch worker restarted; 2 watches re-established']);
    expect(lost).not.toHaveBeenCalled();

    const created = path.join(existing, 'a.txt');
    fakes[0]!.reply({ kind: 'events', id: 0, events: [['create', created]] });
    fakes[1]!.reply({ kind: 'events', id: 2, events: [['create', created]] });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('create', created);
    await sleep(10);
    expect(fakes).toHaveLength(2);
  });

  it('treats a closed reply nobody asked for as a failure and keeps every watch', () => {
    const lost = vi.fn();
    tree.start(existing, false, () => undefined, lost);
    fakes[0]!.reply({ kind: 'closed' });

    expect(logged[0]).toBe('[watcher] the watch worker closed unasked');
    expect(fakes[0]!.terminated).toBe(true);
    expect(fakes[1]!.posted).toEqual([{ kind: 'watch', id: 0, dir: existing, report: false }]);
    expect(lost).not.toHaveBeenCalled();
  });

  it('sends the unwatch of a watch restarted on a fresh worker to that worker', () => {
    const watch = tree.start(existing, false, () => undefined, () => undefined);
    fakes[0]!.fire('error', new Error('boom'));
    watch.dispose();

    expect(logged[0]).toBe('[watcher] the watch worker failed: boom');
    expect(fakes[0]!.posted).toEqual([{ kind: 'watch', id: 0, dir: existing, report: false }]);
    expect(fakes[1]!.posted).toEqual([
      { kind: 'watch', id: 0, dir: existing, report: false },
      { kind: 'unwatch', id: 0 },
    ]);
  });

  it('restarts no worker for a host with no watch left; the next watch starts one', async () => {
    tree.start(existing, false, () => undefined, () => undefined).dispose();
    fakes[0]!.fire('exit', 1);
    await sleep(10);
    expect(fakes).toHaveLength(1);

    tree.start(existing, false, () => undefined, () => undefined);
    expect(fakes).toHaveLength(2);
  });

  it('restarts a worker that keeps dying MAX_WORKER_RESTARTS times, then logs once and watches nothing', async () => {
    let spawned = 0;
    const lost = vi.fn();
    // A worker that exits as soon as it starts, as one whose file is missing does.
    const dying = (): WatchWorker => {
      spawned++;
      const fake = new FakeWorker();
      setImmediate(() => fake.fire('exit', 1));
      return fake;
    };
    const dies = createWorkerTreeHost(dying, (line) => logged.push(line));
    dies.start(existing, false, () => undefined, lost);

    await vi.waitFor(() => expect(logged.some((line) => line.includes('not watched until Damocles restarts'))).toBe(true), WAIT);
    await sleep(100);
    expect(spawned).toBe(MAX_WORKER_RESTARTS + 1);
    expect(logged.filter((line) => line.includes('not watched until Damocles restarts'))).toHaveLength(1);
    expect(logged.filter((line) => line.includes('re-established'))).toHaveLength(MAX_WORKER_RESTARTS);
    expect(lost).not.toHaveBeenCalled();
    dies.start(existing, false, () => undefined, lost);
    expect(spawned).toBe(MAX_WORKER_RESTARTS + 1);
    await dies.close();
  });
});
