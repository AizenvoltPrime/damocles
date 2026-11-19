import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InThreadWalkChild } from '../../../__mocks__/in-thread-walk-child';
import { buildWalkChild } from '../../../__mocks__/built-walk-child';
import { processLauncher, type LaunchedProcess, type ProcessExit } from '../../process-launcher';
import { commandLineCost } from '../command-line';
import { ALL_IGNORE_FILES } from '../walk';
import { createWalkHost, lineWalkChild, MAX_WALK_FAILURES, MAX_WALK_PROCESSES, startWalkChild, WALK_CLOSE_WAIT_MS, WALK_FAILURE_WINDOW_MS, WALK_IDLE_MS, type LineWalkProcess, type WalkChild, type WalkStream } from '../walk-host';
import { lineReader, MAX_WALK_LINE_BYTES, WALK_CREDIT, walkLine, type WalkReply, type WalkRequest, type WalkSpec } from '../walk-protocol';

let root: string;
let logged: string[];

function touch(relativePath: string, content = ''): void {
  const file = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const spec = (overrides: Partial<WalkSpec> = {}): WalkSpec => ({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: [], ...overrides });

async function all(stream: WalkStream): Promise<string[]> {
  const files: string[] = [];
  for await (const batch of stream) files.push(...batch);
  return files.sort();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean): Promise<void> {
  for (let wait = 0; wait < 500 && !check(); wait++) await sleep(10);
  expect(check()).toBe(true);
}

// The replies a child sent.
function repliesOf(child: InThreadWalkChild): WalkReply[] {
  const replies: WalkReply[] = [];
  child.onReply((reply) => replies.push(reply as WalkReply), () => undefined);
  return replies;
}

// The 'files' replies a child sent.
function filesSent(child: InThreadWalkChild): () => number {
  const replies = repliesOf(child);
  return () => replies.filter((reply) => reply.kind === 'files').length;
}

// Whether the child sent its released for walk 0.
const releases = new WeakMap<InThreadWalkChild, WalkReply[]>();
function released(child: InThreadWalkChild): boolean {
  if (!releases.has(child)) releases.set(child, repliesOf(child));
  return releases.get(child)!.some((reply) => reply.kind === 'released' && reply.id === 0);
}

/** A child that runs nothing; the test sends its replies and ends it. */
class ScriptedChild extends InThreadWalkChild {
  override async send(request: WalkRequest): Promise<void> {
    if (this.killed) throw new Error('The process has closed');
    this.requests.push(request);
  }

  reply(reply: WalkReply | Record<string, unknown>): void {
    this.emit(reply);
  }
}

/** A process on the line protocol whose stdout the test writes. */
class LineProcess implements LineWalkProcess {
  readonly written: string[] = [];
  killed = false;
  readonly exited: Promise<ProcessExit> = new Promise(() => undefined);
  private readonly listeners = { stdout: [] as Array<(chunk: Buffer) => void>, stderr: [] as Array<(chunk: Buffer) => void> };

  onData(stream: 'stdout' | 'stderr', listener: (chunk: Buffer) => void): void {
    this.listeners[stream].push(listener);
  }

  emit(stream: 'stdout' | 'stderr', text: string): void {
    for (const listener of this.listeners[stream]) listener(Buffer.from(text));
  }

  async write(text: string): Promise<void> {
    this.written.push(text);
  }

  kill(): void {
    this.killed = true;
  }
}

/** A child whose start failed, as a launch of a missing executable fails. */
function unstartable(message: string): WalkChild {
  const exited = Promise.reject(Object.assign(new Error(message), { code: 'ENOENT' }));
  exited.catch(() => undefined);
  return { onReply: () => undefined, onStderr: () => undefined, send: () => Promise.reject(new Error('The process has closed')), exited, kill: () => undefined };
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-walk-host-')));
  logged = [];
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the walk host', () => {
  it('lists the walk\'s files as / paths below the root, with its ignore rules and overrides, .git as gitFolders says', async () => {
    touch('src/a.ts');
    touch('src/deep/b.ts');
    touch('ignored.log');
    touch('build/out.js');
    touch('.gitignore', '*.log\n');
    touch('.git/HEAD');
    const host = createWalkHost(() => new InThreadWalkChild(), (line) => logged.push(line));
    expect(await all(host.walk(spec({ overrides: ['!build'] })))).toEqual(['.gitignore', 'src/a.ts', 'src/deep/b.ts']);
    expect(await all(host.walk(spec({ gitFolders: 'list', ignore: { files: false, global: true, parents: true } })))).toEqual(['.git/HEAD', '.gitignore', 'build/out.js', 'ignored.log', 'src/a.ts', 'src/deep/b.ts']);
    await host.close();
    expect(logged).toEqual([]);
  });

  it('never lists through a junction or under it', async () => {
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-walk-outside-')));
    try {
      fs.writeFileSync(path.join(outside, 'secret.ts'), '');
      touch('mine.ts');
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
      const host = createWalkHost(() => new InThreadWalkChild(), (line) => logged.push(line));
      expect(await all(host.walk(spec({ gitFolders: 'list' })))).toEqual(['mine.ts']);
      await host.close();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('sends WALK_CREDIT batches ahead and one more per batch taken, each batch within the line budget', async () => {
    const names = Array.from({ length: 3 * WALK_CREDIT }, (_, index) => `f${String(index).padStart(2, '0')}.txt`);
    for (const name of names) touch(name);
    const child = new InThreadWalkChild();
    const sent = filesSent(child);
    const host = createWalkHost(() => child, (line) => logged.push(line));
    // a budget that holds two names and not three
    const stream = host.walk(spec({ lineBudget: 2 * commandLineCost('f00.txt') }));
    await until(() => sent() === WALK_CREDIT);
    await sleep(200);
    expect(sent()).toBe(WALK_CREDIT);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toHaveLength(2);
    await until(() => sent() === WALK_CREDIT + 1);
    await sleep(100);
    expect(sent()).toBe(WALK_CREDIT + 1);
    const files = [...(first.value as string[])];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      expect(next.value.length).toBeLessThanOrEqual(2);
      files.push(...next.value);
    }
    expect(files.sort()).toEqual(names);
    await host.close();
  });

  it('cancels a walk whose signal aborts or whose iteration is left early, and the process sends nothing more for it', async () => {
    for (let index = 0; index < 40; index++) touch(`d${index % 4}/f${index}.txt`);
    const child = new InThreadWalkChild();
    const sent = filesSent(child);
    const host = createWalkHost(() => child, (line) => logged.push(line));
    const controller = new AbortController();
    const aborted = host.walk(spec({ lineBudget: 10 }), controller.signal);
    await until(() => sent() === WALK_CREDIT);
    controller.abort();
    await expect(all(aborted)).rejects.toThrow('Operation aborted');
    const left = host.walk(spec({ lineBudget: 10 }));
    for await (const batch of left) {
      expect(batch).toHaveLength(1);
      break;
    }
    expect(child.requests.filter((request) => request.kind === 'cancel').map((request) => request.id)).toEqual([0, 1]);
    // a third walk runs to its end on the same process, after anything the cancelled ones could still send
    expect(await all(host.walk(spec()))).toHaveLength(40);
    const late = repliesOf(child);
    await sleep(200);
    expect(late.filter((reply) => reply.id === 0 || reply.id === 1)).toEqual([]);
    // a walk whose signal aborted before it began sends nothing
    const before = child.requests.length;
    await expect(all(host.walk(spec(), AbortSignal.abort()))).rejects.toThrow('Operation aborted');
    expect(child.requests).toHaveLength(before);
    await host.close();
    expect(logged).toEqual([]);
  });

  it('ends a walk with its failure: a missing root, a glob rg refuses', async () => {
    const host = createWalkHost(() => new InThreadWalkChild(), (line) => logged.push(line));
    await expect(all(host.walk(spec({ root: path.join(root, 'gone') })))).rejects.toThrow(/ENOENT/);
    await expect(all(host.walk(spec({ overrides: ['a{b'] })))).rejects.toThrow('error parsing glob \'a{b\'');
    touch('a.ts');
    expect(await all(host.walk(spec()))).toEqual(['a.ts']);
    await host.close();
  });

  it('ends every walk of a process that exits or breaks the contract, kills it, and starts a fresh one for the next walk', async () => {
    touch('a.ts');
    const broken = Array.from({ length: 4 }, () => new ScriptedChild());
    const children: Array<() => WalkChild> = [...broken.map((child) => () => child), () => new InThreadWalkChild()];
    let started = 0;
    const host = createWalkHost(() => {
      started++;
      return children.shift()!();
    }, (line) => logged.push(line));
    const failures: Array<(child: ScriptedChild) => void> = [
      (child) => {
        child.emitStderr('Error: Cannot find module walk-child.js\n');
        child.end({ code: 1, signal: null });
      },
      (child) => child.reply({ kind: 'files', id: child.requests[0]!.id, files: ['../secret.ts'] }),
      (child) => child.reply({ kind: 'files', id: child.requests[0]!.id, files: Array.from({ length: 1001 }, (_, index) => `f${index}`) }),
      (child) => child.fault(`sent a reply longer than ${MAX_WALK_LINE_BYTES} bytes`),
    ];
    for (const [index, failure] of failures.entries()) {
      const walk = host.walk(spec());
      failure(broken[index]!);
      await expect(all(walk)).rejects.toThrow('The walk process');
      expect(broken[index]!.killed).toBe(true);
    }
    expect(logged).toEqual([
      '[walk] the walk process exited with code 1; its stderr ends: Error: Cannot find module walk-child.js',
      '[walk] the walk process sent a malformed reply',
      `[walk] the walk process sent a reply longer than ${MAX_WALK_LINE_BYTES} bytes`,
    ]);
    expect(await all(host.walk(spec()))).toEqual(['a.ts']);
    expect(started).toBe(5);
    await host.close();
  });

  it('starts a second process only while the first has a walk, and gives a later walk to the one with the fewest', async () => {
    const children = [new ScriptedChild(), new ScriptedChild()];
    const host = createWalkHost(() => children.shift()!, (line) => logged.push(line));
    const [first, second] = children as [ScriptedChild, ScriptedChild];
    const walks = [host.walk(spec()), host.walk(spec()), host.walk(spec())];
    expect(children).toHaveLength(0);
    expect(first.requests.map((request) => request.id)).toEqual([0, 2]);
    expect(second.requests.map((request) => request.id)).toEqual([1]);
    second.reply({ kind: 'end', id: 1, errors: [] });
    expect(await all(walks[1]!)).toEqual([]);
    // the second process has no walk left, so it takes the next
    const fourth = host.walk(spec());
    expect(second.requests.map((request) => request.id)).toEqual([1, 3]);
    // a process that fails ends its own walks and no other
    first.end({ code: 1, signal: null });
    await expect(all(walks[0]!)).rejects.toThrow('The walk process exited with code 1');
    await expect(all(walks[2]!)).rejects.toThrow('The walk process exited with code 1');
    second.reply({ kind: 'files', id: 3, files: ['a.ts'] });
    second.reply({ kind: 'end', id: 3, errors: [] });
    expect(await all(fourth)).toEqual(['a.ts']);
    expect(MAX_WALK_PROCESSES).toBe(2);
    await host.close();
    expect(second.killed).toBe(true);
  });

  it('counts a cancelled walk as load until its process released it, so the next walk goes to the other process', async () => {
    const children = [new ScriptedChild(), new ScriptedChild()];
    const host = createWalkHost(() => children.shift()!, (line) => logged.push(line));
    const [first, second] = children as [ScriptedChild, ScriptedChild];
    // a walk of a share that stopped answering, left by its user
    const controller = new AbortController();
    const hung = host.walk(spec(), controller.signal);
    controller.abort();
    await expect(all(hung)).rejects.toThrow('Operation aborted');
    expect(first.requests.map((request) => request.kind)).toEqual(['walk', 'cancel']);
    const next = host.walk(spec());
    expect(second.requests.map((request) => request.id)).toEqual([1]);
    second.reply({ kind: 'end', id: 1, errors: [] });
    expect(await all(next)).toEqual([]);
    // once its reads returned, the first process takes walks again
    first.reply({ kind: 'released', id: 0 });
    void host.walk(spec());
    expect(first.requests.map((request) => request.id)).toEqual([0, 0, 2]);
    // an end that ran its reads past its walk holds the process until its released; one that crossed a cancel frees it
    first.reply({ kind: 'end', id: 2, errors: [], reading: true });
    void host.walk(spec());
    expect(second.requests.map((request) => request.id)).toEqual([1, 3]);
    const crossed = new AbortController();
    void host.walk(spec(), crossed.signal);
    crossed.abort();
    expect(first.requests.map((request) => request.id)).toEqual([0, 0, 2, 4, 4]);
    first.reply({ kind: 'released', id: 2 });
    first.reply({ kind: 'end', id: 4, errors: [] });
    void host.walk(spec());
    expect(first.requests.map((request) => request.id)).toEqual([0, 0, 2, 4, 4, 5]);
    await host.close();
    expect(logged).toEqual([]);
  });

  it('sends the next walk to another process while the read of a hung folder by a cancelled walk is still out', async () => {
    for (let index = 0; index < 10; index++) touch(`d${index}/f.txt`);
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const readdir = fs.promises.readdir.bind(fs.promises);
    // the read of d5, which the walk reads ahead, waits as one of a share that stopped answering
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (folder: fs.PathLike, options: never) => {
      if (String(folder).endsWith(`${path.sep}d5`)) await gate;
      return readdir(folder, options);
    }) as never);
    const children = [new InThreadWalkChild(), new InThreadWalkChild()];
    const host = createWalkHost(() => children.shift()!, (line) => logged.push(line));
    const [first, second] = children as [InThreadWalkChild, InThreadWalkChild];
    const controller = new AbortController();
    const hung = host.walk(spec({ lineBudget: 10 }), controller.signal);
    const iterator = hung[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toThrow('Operation aborted');
    expect(await all(host.walk(spec({ root: path.join(root, 'd0') })))).toEqual(['f.txt']);
    expect(second.requests.filter((request) => request.kind === 'walk')).toHaveLength(1);
    open();
    await until(() => first.requests.length > 0 && released(first));
    expect(await all(host.walk(spec({ root: path.join(root, 'd1') })))).toEqual(['f.txt']);
    expect(first.requests.filter((request) => request.kind === 'walk')).toHaveLength(2);
    await host.close();
    vi.restoreAllMocks();
  });

  it('fails a process that sends a walk more batches than its credit', async () => {
    const child = new ScriptedChild();
    const host = createWalkHost(() => child, (line) => logged.push(line));
    const walk = host.walk(spec());
    for (let batch = 0; batch <= WALK_CREDIT; batch++) child.reply({ kind: 'files', id: 0, files: [`f${batch}`] });
    await expect(all(walk)).rejects.toThrow('The walk process sent more batches than its credit');
    expect(child.killed).toBe(true);
  });

  it('starts no process once MAX_WALK_FAILURES failed within the window, and starts one again once the oldest is that old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    touch('a.ts');
    let started = 0;
    const host = createWalkHost(() => {
      started++;
      return started <= MAX_WALK_FAILURES ? unstartable('spawn EACCES') : new InThreadWalkChild();
    }, (line) => logged.push(line));
    for (let failure = 0; failure < MAX_WALK_FAILURES; failure++) {
      await expect(all(host.walk(spec()))).rejects.toThrow('The walk process could not start: spawn EACCES');
      vi.setSystemTime(Date.now() + 1000);
    }
    await expect(all(host.walk(spec()))).rejects.toThrow(`The walk process failed ${MAX_WALK_FAILURES} times within ${WALK_FAILURE_WINDOW_MS / 60_000} minutes`);
    expect(started).toBe(MAX_WALK_FAILURES);
    expect(logged).toEqual([
      '[walk] the walk process could not start: spawn EACCES',
      `[walk] the walk process failed ${MAX_WALK_FAILURES} times within ${WALK_FAILURE_WINDOW_MS / 60_000} minutes; no walk starts it until a failure is that old`,
    ]);
    vi.setSystemTime(Date.now() + WALK_FAILURE_WINDOW_MS);
    expect(await all(host.walk(spec()))).toEqual(['a.ts']);
    expect(started).toBe(MAX_WALK_FAILURES + 1);
    await host.close();
  });

  it('closes by ending every walk and killing the process, and a later walk starts a fresh one', async () => {
    touch('a.ts');
    const children = [new ScriptedChild(), new InThreadWalkChild()];
    const host = createWalkHost(() => children.shift()!, (line) => logged.push(line));
    const first = children[0] as ScriptedChild;
    const running = host.walk(spec());
    await host.close();
    expect(first.killed).toBe(true);
    await expect(all(running)).rejects.toThrow('The walk process was closed');
    expect(await all(host.walk(spec()))).toEqual(['a.ts']);
    await host.close();
    expect(logged).toEqual([]);
  });

  it('settles close WALK_CLOSE_WAIT_MS after the kill when the process does not exit', async () => {
    vi.useFakeTimers();
    const kills: number[] = [];
    const stuck: WalkChild = { onReply: () => undefined, onStderr: () => undefined, send: async () => undefined, exited: new Promise<ProcessExit>(() => undefined), kill: () => void kills.push(Date.now()) };
    const host = createWalkHost(() => stuck, (line) => logged.push(line));
    const running = host.walk(spec());
    let closed = false;
    const closing = host.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(WALK_CLOSE_WAIT_MS - 1);
    expect(closed).toBe(false);
    expect(kills).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(logged).toEqual([`[walk] a walk process did not exit within ${WALK_CLOSE_WAIT_MS} ms of its kill`]);
    await expect(all(running)).rejects.toThrow('The walk process was closed');
  });
});

describe('an idle walk process', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  // A host over scripted children, each walk of which the test ends.
  function scripted(): { host: ReturnType<typeof createWalkHost>; children: ScriptedChild[] } {
    const children: ScriptedChild[] = [];
    const host = createWalkHost(() => {
      const child = new ScriptedChild();
      children.push(child);
      return child;
    }, (line) => logged.push(line));
    return { host, children };
  }

  async function walked(host: ReturnType<typeof createWalkHost>, child: () => ScriptedChild): Promise<void> {
    const walk = host.walk(spec());
    const { id } = child().requests.at(-1)!;
    child().reply({ kind: 'end', id, errors: [] });
    expect(await all(walk)).toEqual([]);
  }

  it('is killed WALK_IDLE_MS after its last walk ended, as no failure and outside the restart cap, and the next walk starts a fresh one', async () => {
    const { host, children } = scripted();
    for (let round = 0; round <= MAX_WALK_FAILURES; round++) {
      await walked(host, () => children.at(-1)!);
      expect(children).toHaveLength(round + 1);
      await vi.advanceTimersByTimeAsync(WALK_IDLE_MS - 1);
      expect(children[round]!.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(children[round]!.killed).toBe(true);
    }
    expect(logged).toEqual([]);
    await host.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is kept by a walk that comes during the countdown, which starts the countdown again once it ends', async () => {
    const { host, children } = scripted();
    await walked(host, () => children[0]!);
    await vi.advanceTimersByTimeAsync(WALK_IDLE_MS - 1);
    const second = host.walk(spec());
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * WALK_IDLE_MS);
    expect(children[0]!.killed).toBe(false);
    children[0]!.reply({ kind: 'end', id: 1, errors: [] });
    expect(await all(second)).toEqual([]);
    await vi.advanceTimersByTimeAsync(WALK_IDLE_MS - 1);
    expect(children[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]!.killed).toBe(true);
    expect(logged).toEqual([]);
  });

  it('is kept while a cancelled walk or one that ended reading ahead holds a read, and killed WALK_IDLE_MS after its released', async () => {
    const { host, children } = scripted();
    const controller = new AbortController();
    const cancelled = host.walk(spec(), controller.signal);
    controller.abort();
    await expect(all(cancelled)).rejects.toThrow('Operation aborted');
    await vi.advanceTimersByTimeAsync(2 * WALK_IDLE_MS);
    expect(children[0]!.killed).toBe(false);
    children[0]!.reply({ kind: 'released', id: 0 });
    const reading = host.walk(spec());
    children[0]!.reply({ kind: 'end', id: 1, errors: [], reading: true });
    expect(await all(reading)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * WALK_IDLE_MS);
    expect(children[0]!.killed).toBe(false);
    children[0]!.reply({ kind: 'released', id: 1 });
    await vi.advanceTimersByTimeAsync(WALK_IDLE_MS);
    expect(children[0]!.killed).toBe(true);
    expect(children).toHaveLength(1);
    expect(logged).toEqual([]);
  });

  it('leaves no timer once its host closed', async () => {
    const { host, children } = scripted();
    await walked(host, () => children[0]!);
    expect(vi.getTimerCount()).toBe(1);
    await host.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(children[0]!.killed).toBe(true);
  });

  it('is waited for by a close that comes after its idle kill and before its exit', async () => {
    const { host, children } = scripted();
    await walked(host, () => children[0]!);
    // a process that takes its time to exit once killed
    const slow = children[0]!;
    let exit: () => void = () => undefined;
    slow.kill = () => {
      exit = () => slow.end({ code: null, signal: 'SIGKILL' });
    };
    await vi.advanceTimersByTimeAsync(WALK_IDLE_MS);
    let closed = false;
    const closing = host.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(WALK_CLOSE_WAIT_MS - 1);
    expect(closed).toBe(false);
    exit();
    await closing;
    expect(logged).toEqual([]);
  });

  it('holds no event loop open while it counts down', async () => {
    vi.useRealTimers();
    const armed: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
      const timer = realSetTimeout(callback, ms);
      if (ms === WALK_IDLE_MS) armed.push(timer);
      return timer;
    }) as typeof setTimeout);
    const { host, children } = scripted();
    await walked(host, () => children[0]!);
    expect(armed.map((timer) => timer.hasRef())).toEqual([false]);
    await host.close();
    vi.restoreAllMocks();
  });
});

describe('lineWalkChild', () => {
  it('sends each request as a line and passes each reply line on parsed, with stderr as text', async () => {
    const lines = new LineProcess();
    const child = lineWalkChild(lines);
    const replies: unknown[] = [];
    const faults: string[] = [];
    const stderr: string[] = [];
    child.onReply((reply) => replies.push(reply), (reason) => faults.push(reason));
    child.onStderr((text) => stderr.push(text));
    await child.send({ kind: 'ack', id: 3 });
    expect(lines.written).toEqual([walkLine({ kind: 'ack', id: 3 })]);
    const end = walkLine({ kind: 'end', id: 3, errors: [] });
    lines.emit('stdout', end.slice(0, 5));
    lines.emit('stdout', end.slice(5));
    lines.emit('stderr', 'warning\n');
    expect(replies).toEqual([{ kind: 'end', id: 3, errors: [] }]);
    expect(stderr).toEqual(['warning\n']);
    expect(faults).toEqual([]);
    child.kill();
    expect(lines.killed).toBe(true);
  });

  it('faults a line that is no JSON, and a line longer than MAX_WALK_LINE_BYTES, after which it reads nothing more', () => {
    const broken = new LineProcess();
    const faults: string[] = [];
    lineWalkChild(broken).onReply(() => undefined, (reason) => faults.push(reason));
    broken.emit('stdout', 'not json\n');
    expect(faults).toEqual(['sent a malformed reply']);
    const long = new LineProcess();
    const replies: unknown[] = [];
    lineWalkChild(long).onReply((reply) => replies.push(reply), (reason) => faults.push(reason));
    long.emit('stdout', 'x'.repeat(MAX_WALK_LINE_BYTES + 1));
    long.emit('stdout', walkLine({ kind: 'released', id: 0 }));
    expect(faults).toEqual(['sent a malformed reply', `sent a reply longer than ${MAX_WALK_LINE_BYTES} bytes`]);
    expect(replies).toEqual([]);
  });
});

describe('lineReader', () => {
  it('splits lines across chunks and stops at a line longer than its bound', () => {
    const lines: string[] = [];
    let overflowed = 0;
    const read = lineReader(8, (line) => lines.push(line), () => overflowed++);
    read(Buffer.from('ab\ncd'));
    read(Buffer.from('ef\n\u00e9'));
    read(Buffer.from('\n'));
    expect(lines).toEqual(['ab', 'cdef', '\u00e9']);
    read(Buffer.from('12345678'));
    expect(overflowed).toBe(0);
    read(Buffer.from('9\nnext\n'));
    expect(overflowed).toBe(1);
    expect(lines).toEqual(['ab', 'cdef', '\u00e9']);
  });
});

describe('the built walk process', () => {
  let built: Awaited<ReturnType<typeof buildWalkChild>>;

  beforeAll(async () => {
    built = await buildWalkChild();
  });

  afterAll(() => {
    built.dispose();
  });

  /** The processes the launcher starts meanwhile. */
  function launches(): { readonly started: LaunchedProcess[]; restore(): void } {
    const launcher = processLauncher();
    const original = launcher.launch.bind(launcher);
    const started: LaunchedProcess[] = [];
    const spy = vi.spyOn(launcher, 'launch').mockImplementation((...args) => {
      const child = original(...args);
      started.push(child);
      return child;
    });
    return { started, restore: () => spy.mockRestore() };
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('starts one process at the first walk, as this executable running the entry as Node, and serves every later walk on it', async () => {
    touch('a.ts');
    touch('sub/b.ts');
    const launched = launches();
    try {
      const host = createWalkHost(() => startWalkChild(built.entry), (line) => logged.push(line));
      expect(launched.started).toHaveLength(0);
      expect(await all(host.walk(spec()))).toEqual(['a.ts', 'sub/b.ts']);
      expect(await all(host.walk(spec({ root: path.join(root, 'sub') })))).toEqual(['b.ts']);
      expect(launched.started).toHaveLength(1);
      const [call] = vi.mocked(processLauncher().launch).mock.calls;
      expect(call![0]).toMatchObject({ file: process.execPath, args: [built.entry], env: { ELECTRON_RUN_AS_NODE: '1' } });
      const pid = await launched.started[0]!.pid;
      await host.close();
      expect(alive(pid)).toBe(false);
      expect(logged).toEqual([]);
    } finally {
      launched.restore();
    }
  });

  it('exits when its stdin ends, as when its host dies', async () => {
    const child = processLauncher().launch({ file: process.execPath, args: [built.entry], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    const pid = await child.pid;
    expect(alive(pid)).toBe(true);
    child.end();
    await child.exited;
    expect(alive(pid)).toBe(false);
  });

  it('ends the walks of a process killed from outside, and the next walk starts a fresh one', async () => {
    for (let index = 0; index < 50; index++) touch(`d${index}/f.txt`);
    const launched = launches();
    try {
      const host = createWalkHost(() => startWalkChild(built.entry), (line) => logged.push(line));
      const walk = host.walk(spec({ lineBudget: 10 }));
      const iterator = walk[Symbol.asyncIterator]();
      await iterator.next();
      process.kill(await launched.started[0]!.pid);
      await expect((async () => {
        for (let next = await iterator.next(); !next.done; next = await iterator.next());
      })()).rejects.toThrow(/The walk process (exited with code|was ended by)/);
      expect(await all(host.walk(spec()))).toHaveLength(50);
      expect(launched.started).toHaveLength(2);
      await host.close();
      expect(logged).toHaveLength(1);
    } finally {
      launched.restore();
    }
  });

  it('places a .git file\'s pointer before reading its exclude, on Windows through koffi inside the process', async () => {
    const gitDir = path.join(root, 'elsewhere.git');
    touch('elsewhere.git/commondir', '.\n');
    touch('elsewhere.git/info/exclude', 'secret.txt\n');
    touch('repo/.git', `gitdir: ${gitDir}\n`);
    touch('repo/secret.txt');
    touch('repo/kept.txt');
    const host = createWalkHost(() => startWalkChild(built.entry), (line) => logged.push(line));
    expect(await all(host.walk(spec({ root: path.join(root, 'repo') })))).toEqual(['.git', 'kept.txt']);
    await host.close();
    expect(logged).toEqual([]);
  });
});
