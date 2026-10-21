import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../logger', () => ({ log: vi.fn(), installLogSink: vi.fn() }));

import { SessionMetaIndex, type MetaIndexWorkerLike } from '../client';
import type { MetaIndexEvent, MetaIndexRequest } from '../protocol';
import { inProcessIndex } from './in-process';

class FakeWorker implements MetaIndexWorkerLike {
  readonly posted: MetaIndexRequest[] = [];
  terminated = false;
  /** Whether the worker keeps its host alive, as a node Worker's ref and unref set it. */
  held = true;
  private readonly listeners: { message: Array<(m: MetaIndexEvent) => void>; error: Array<(e: Error) => void>; exit: Array<(c: number) => void> } = {
    message: [], error: [], exit: [],
  };

  on(event: 'message', listener: (msg: MetaIndexEvent) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'message' | 'error' | 'exit', listener: (arg: never) => void): void {
    (this.listeners[event] as Array<(arg: never) => void>).push(listener);
  }

  postMessage(message: MetaIndexRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  ref(): void {
    this.held = true;
  }

  unref(): void {
    this.held = false;
  }

  emit(msg: MetaIndexEvent): void {
    for (const l of this.listeners.message) l(msg);
  }

  crash(err: Error): void {
    for (const l of this.listeners.error) l(err);
    this.exit(1);
  }

  exit(code: number): void {
    for (const l of this.listeners.exit) l(code);
  }

  lastId(): number {
    const last = [...this.posted].reverse().find((m) => 'id' in m);
    if (!last || !('id' in last)) throw new Error('no request posted');
    return last.id;
  }
}

const REQUEST_TIMEOUT = 1_000;
const STALL_TIMEOUT = 5_000;
const IDLE_TIMEOUT = 10_000;
const CLOSE_TIMEOUT = 2_000;

function setup() {
  const workers: FakeWorker[] = [];
  const index = new SessionMetaIndex({
    workerPath: '/ext/dist/session-meta-index-worker.js',
    cacheDir: '/cache',
    piPackageDir: '/pi',
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    requestTimeoutMs: REQUEST_TIMEOUT,
    stallTimeoutMs: STALL_TIMEOUT,
    idleTimeoutMs: IDLE_TIMEOUT,
    closeTimeoutMs: CLOSE_TIMEOUT,
  });
  return { index, workers };
}

const row = (id: string) => ({ id, timestamp: 1, createdAt: 1, preview: id, messageCount: 1 });

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionMetaIndex client', () => {
  it('starts no worker until the first request', () => {
    const { workers } = setup();
    expect(workers).toHaveLength(0);
  });

  it('retries a request once on a replacement worker when its worker crashes', async () => {
    const { index, workers } = setup();
    const answer = index.cachedRow('/s/a.jsonl');
    workers[0]!.crash(new Error('boom'));

    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toEqual([{ type: 'cachedRow', id: workers[0]!.lastId(), file: '/s/a.jsonl' }]);
    workers[1]!.emit({ type: 'cachedRow', id: workers[1]!.lastId(), found: true, stored: row('a') });
    await expect(answer).resolves.toEqual(row('a'));
  });

  it('fails a request whose replacement worker dies too', async () => {
    const { index, workers } = setup();
    const answer = index.meta('/s/a.jsonl');
    workers[0]!.exit(1);
    workers[1]!.exit(1);

    await expect(answer).rejects.toThrow(/exited with code 1/);
    expect(workers).toHaveLength(2);
  });

  it('a list replayed on a replacement worker delivers its valid rows as a batch', async () => {
    const { index, workers } = setup();
    const batch = vi.fn();
    const end = vi.fn();
    const listed = index.list('/s', { batch, end });
    workers[0]!.emit({ type: 'listed', id: workers[0]!.lastId(), sessions: [row('a')], files: ['/s/a.jsonl', '/s/b.jsonl'], parsing: 1 });
    await expect(listed).resolves.toEqual({ sessions: [row('a')], files: ['/s/a.jsonl', '/s/b.jsonl'], parsing: 1 });

    workers[0]!.crash(new Error('boom'));
    const id = workers[1]!.lastId();
    workers[1]!.emit({ type: 'listed', id, sessions: [row('a')], files: ['/s/a.jsonl'], parsing: 1 });
    workers[1]!.emit({ type: 'listBatch', id, sessions: [row('b')] });
    workers[1]!.emit({ type: 'listDone', id, complete: true });

    expect(batch.mock.calls).toEqual([[[row('a')]], [[row('b')]]]);
    expect(end.mock.calls).toEqual([[true]]);
  });

  it('ends a list incomplete when the worker found a file that yielded no row', async () => {
    const { index, workers } = setup();
    const end = vi.fn();
    const listed = index.list('/s', { batch: vi.fn(), end });
    const id = workers[0]!.lastId();
    workers[0]!.emit({ type: 'listed', id, sessions: [], files: ['/s/a.jsonl'], parsing: 1 });
    await listed;
    workers[0]!.emit({ type: 'listDone', id, complete: false });

    expect(end.mock.calls).toEqual([[false]]);
  });

  it('holds its host open only while a request is in flight or a worker is closing', async () => {
    const { index, workers } = setup();
    const answer = index.cachedRow('/s/a.jsonl');
    expect(workers[0]!.held).toBe(true);
    workers[0]!.emit({ type: 'cachedRow', id: workers[0]!.lastId(), found: false, stored: null });
    await answer;
    expect(workers[0]!.held).toBe(false);

    index.put('/s/a.jsonl', { size: 1, mtimeMs: 1, stored: null, prompts: [] });
    expect(workers[0]!.held).toBe(false);
    const closed = index.close();
    expect(workers[0]!.held).toBe(true);
    workers[0]!.exit(0);
    await closed;
  });

  it('gives a worker it closed for idleness the same bounded stop, and close waits for it', async () => {
    vi.useFakeTimers();
    const { index, workers } = setup();
    const answer = index.cachedRow('/s/a.jsonl');
    workers[0]!.emit({ type: 'cachedRow', id: workers[0]!.lastId(), found: false, stored: null });
    await answer;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT);
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'close' });

    const closed = index.close();
    await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT - 1);
    expect(workers[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closed;
    expect(workers[0]!.terminated).toBe(true);
  });

  it('replaces a worker that sends nothing for the stall timeout, and retries on the new one', async () => {
    vi.useFakeTimers();
    const { index, workers } = setup();
    const answer = expect(index.promptHistory(['/s'], ['a'])).rejects.toThrow(/timed out/);
    // The request timeout fails the caller first; the entry stays in flight until the stall replaces the worker.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT);
    await answer;
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT);
    expect(workers[0]!.terminated).toBe(true);

    const next = index.promptHistory(['/s'], ['a']);
    expect(workers).toHaveLength(2);
    workers[1]!.emit({ type: 'promptHistory', id: workers[1]!.lastId(), prompts: ['p'], opened: 0 });
    await expect(next).resolves.toEqual({ prompts: ['p'], opened: 0 });
  });

  it('closes an idle worker after the idle timeout, and a later request starts a new one', async () => {
    vi.useFakeTimers();
    const { index, workers } = setup();
    const answer = index.cachedRow('/s/a.jsonl');
    workers[0]!.emit({ type: 'cachedRow', id: workers[0]!.lastId(), found: false, stored: null });
    await answer;

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT);
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'close' });

    void index.cachedRow('/s/a.jsonl');
    expect(workers).toHaveLength(2);
  });

  it('close waits for the worker to exit, at most the close timeout, and rejects requests in flight', async () => {
    vi.useFakeTimers();
    const { index, workers } = setup();
    const answer = index.meta('/s/a.jsonl');
    const closed = index.close();
    await expect(answer).rejects.toThrow(/closed/);
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'close' });

    await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT);
    await closed;
    expect(workers[0]!.terminated).toBe(true);
    await expect(index.cachedRow('/s/a.jsonl')).rejects.toThrow(/closed/);
  });

  it('close resolves as soon as the worker exits', async () => {
    const { index, workers } = setup();
    index.put('/s/a.jsonl', { size: 1, mtimeMs: 1, stored: null, prompts: [] });
    const closed = index.close();
    workers[0]!.exit(0);
    await closed;
    expect(workers[0]!.terminated).toBe(false);
    expect(workers[0]!.posted.map((m) => m.type)).toEqual(['put', 'close']);
  });

  it('an in-process worker that crashes mid-list is replaced and the list still completes', async () => {
    const root = path.join(os.homedir(), 'meta-index-client-crash');
    fs.rmSync(root, { recursive: true, force: true });
    const sessions = path.join(root, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const id = '01a0e000-0000-7000-8000-000000000001';
    fs.writeFileSync(path.join(sessions, `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: root })}\n`);
    const { index, workers } = inProcessIndex({ cacheDir: path.join(root, 'cache') });
    try {
      const rows: string[] = [];
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const listed = index.list(sessions, { batch: (batch) => rows.push(...batch.map((s) => s.id)), end: finish });
      workers[0]!.crash(new Error('boom'));
      const first = await listed;
      await finished;

      expect(workers).toHaveLength(2);
      expect([...first.sessions.map((s) => s.id), ...rows]).toEqual([id]);
    } finally {
      await index.close();
    }
  });
});
