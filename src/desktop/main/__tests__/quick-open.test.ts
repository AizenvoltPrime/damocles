import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { rgPath } from '@vscode/ripgrep';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fuzzy from '../../../core/quick-open/fuzzy-match';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { OVERLAY_CHANNELS, type OverlayAnswer, type OverlayRequest } from '../../preload/overlay-channels';
import { createQuickOpenFileSearch } from '../../quick-open-worker/file-search';
import { ripgrepFileArgs, type WorkerReply, type WorkerRequest } from '../../quick-open-worker/protocol';
import type { Project } from '../documents/confine';
import type { MenuState } from '../menu';
import { QUICK_OPEN_WORKER_SILENCE_MS, QuickOpenIndex, QuickOpenPicker, type QuickOpenDeps, type QuickOpenWorker } from '../quick-open';

vi.mock('../../../core/quick-open/fuzzy-match', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../core/quick-open/fuzzy-match')>();
  return { ...original, scoreItem: vi.fn(original.scoreItem) };
});

const CONTEXT: MenuState = { chat: true, editor: true, browser: false, page: false, focus: 'editor', updateCheck: false, project: true, terminal: undefined, terminalSplit: false, terminalInput: false, search: { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible: false } };

let root: string;
let alpha: Project;
let beta: Project;
let logged: string[];
let started: number;

function project(name: string): Project {
  const fsPath = path.join(root, name);
  fs.mkdirSync(fsPath, { recursive: true });
  return { key: folderKey(fsPath), fsPath, name };
}

function touch(owner: Project, relativePath: string): void {
  const file = path.join(owner.fsPath, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

/** The worker's code on this thread, with messages copied and delivered a turn later as a worker thread's are. */
class InProcessWorker extends EventEmitter implements QuickOpenWorker {
  terminated = false;
  private readonly reply: (reply: WorkerReply) => unknown;
  private readonly receive = createQuickOpenFileSearch((reply) => setImmediate(() => {
    if (!this.terminated) this.emit('message', this.reply(structuredClone(reply)));
  }));

  constructor(reply: (reply: WorkerReply) => unknown = (sent) => sent) {
    super();
    this.reply = reply;
  }

  postMessage(request: WorkerRequest): void {
    const copy = structuredClone(request);
    setImmediate(() => {
      if (!this.terminated) this.receive(copy);
    });
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 1;
  }
}

/** A worker double that records each query and replies only with what the test emits, so it can go silent. */
class ScriptedWorker extends EventEmitter implements QuickOpenWorker {
  terminated = false;
  readonly queries: Array<Extract<WorkerRequest, { kind: 'query' }>> = [];
  readonly received: WorkerRequest[] = [];

  postMessage(request: WorkerRequest): void {
    this.received.push(request);
    if (request.kind === 'query') this.queries.push(request);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 1;
  }
}

// Turns of the event loop until check holds; fake intervals leave setImmediate real.
async function turnsUntil(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !check(); turn++) await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}

async function settled<T>(promise: Promise<T>): Promise<boolean> {
  let done = false;
  void promise.finally(() => (done = true));
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  return done;
}

function index(startWorker: () => QuickOpenWorker = () => new InProcessWorker(), spawnRg?: QuickOpenDeps['spawnRg'], resolveRg: () => Promise<string> = async () => rgPath): QuickOpenIndex {
  return new QuickOpenIndex({
    projects: () => [alpha, beta],
    rgPath: resolveRg,
    ignoreArgs: () => [],
    excludes: () => ['**/.git'],
    watch: () => undefined,
    startWorker: () => {
      started++;
      return startWorker();
    },
    log: (line) => logged.push(line),
    ...(spawnRg ? { spawnRg } : {}),
  });
}

/** A ripgrep stuck on a hung file system: a real process that prints nothing and never exits. */
function hangingRg(): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

const ended = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

/** A worker double that asks main to list alpha as each query arrives, then goes silent. */
class ListingWorker extends ScriptedWorker {
  override postMessage(request: WorkerRequest): void {
    super.postMessage(request);
    if (request.kind === 'query') setImmediate(() => this.emit('message', { kind: 'list', listing: request.id, projectKey: alpha.key }));
  }
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-quick-')));
  alpha = project('alpha');
  beta = project('beta');
  logged = [];
  started = 0;
  vi.mocked(fuzzy.scoreItem).mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Quick Open in its worker', () => {
  it('answers with main\'s project names, the :line and @ main parsed, and the worker\'s highlights', async () => {
    touch(alpha, 'src/editor-pane.ts');
    touch(beta, 'other.ts');
    const quickOpen = index();
    const answer = await quickOpen.query('@edpane:42', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    expect(answer).toEqual({
      currentProjectKey: alpha.key,
      line: 42,
      mention: true,
      results: [{ projectKey: alpha.key, projectName: 'alpha', relativePath: 'src/editor-pane.ts', label: 'editor-pane.ts', description: 'src', labelMatches: [[0, 2], [7, 11]], descriptionMatches: [], recent: false }],
    });
    quickOpen.dispose();
  });

  it('answers a query a newer one replaced with nothing, having scored nothing for it', async () => {
    for (let i = 0; i < 5; i++) touch(alpha, `a${i}.ts`);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let open = false;
    const answers: unknown[] = [];
    const quickOpen = new QuickOpenPicker(
      { handle: (channel, handler) => handlers.set(channel, handler), isOpen: () => open, request: async () => {
        open = true;
        const query = handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!;
        answers.push(...await Promise.all([query({ query: 'a1', generation: 4 }), query({ query: 'a', generation: 5 })]));
        open = false;
        return { kind: 'dismissed' };
      } },
      index(),
      () => ({ currentProjectKey: alpha.key, recent: [] }),
      { capture: () => CONTEXT, list: () => [] },
      () => undefined,
    );
    await quickOpen.show(undefined, 'files');
    expect(answers).toEqual([{ generation: 4, mention: false, results: [] }, expect.objectContaining({ generation: 5 })]);
    expect((answers[1] as { results: unknown[] }).results).toHaveLength(5);
    expect(vi.mocked(fuzzy.scoreItem)).toHaveBeenCalledTimes(5);
  });

  it('answers empty with the reason logged when the worker crashes, and starts a fresh worker for the next query', async () => {
    touch(alpha, 'a.ts');
    const crashing = new (class extends EventEmitter implements QuickOpenWorker {
      terminated = false;
      postMessage(request: WorkerRequest): void {
        if (request.kind === 'query') setImmediate(() => this.emit('error', new Error('out of memory')));
      }
      async terminate(): Promise<number> {
        this.terminated = true;
        return 1;
      }
    })();
    const workers: QuickOpenWorker[] = [crashing, new InProcessWorker()];
    const quickOpen = index(() => workers.shift()!);
    const search = quickOpen.open();
    const context = { currentProjectKey: alpha.key, recent: [] };
    expect(await quickOpen.query('a:3', context, { id: search, generation: 0 })).toEqual({ currentProjectKey: alpha.key, line: 3, mention: false, results: [] });
    expect(logged).toEqual(['[quick-open] the worker failed: out of memory']);
    expect(crashing.terminated).toBe(true);
    expect((await quickOpen.query('a', context, { id: search, generation: 1 }))?.results.map((result) => result.relativePath)).toEqual(['a.ts']);
    expect(started).toBe(2);
    quickOpen.dispose();
  });

  it('answers empty when the worker exits, fails a query or sends a reply outside the contract, and starts afresh each time', async () => {
    touch(alpha, 'a.ts');
    const exiting = new InProcessWorker();
    exiting.postMessage = () => setImmediate(() => exiting.emit('exit', 1));
    const failing = new InProcessWorker((reply) => (reply.kind === 'answer' ? { kind: 'failed', id: reply.id, message: 'no' } : reply));
    const outside = new InProcessWorker((reply) => (reply.kind === 'answer' ? { ...reply, results: [{ ...reply.results[0], projectKey: 'elsewhere' }] } : reply));
    const escaping = new InProcessWorker((reply) => (reply.kind === 'answer' ? { ...reply, results: [{ ...reply.results[0], relativePath: '../secret.ts' }] } : reply));
    const oversized = new InProcessWorker((reply) => (reply.kind === 'answer' ? { ...reply, results: Array.from({ length: 31 }, () => reply.results[0]) } : reply));
    const workers: InProcessWorker[] = [exiting, failing, outside, escaping, oversized, new InProcessWorker()];
    const quickOpen = index(() => workers.shift()!);
    const search = quickOpen.open();
    const context = { currentProjectKey: alpha.key, recent: [] };
    for (let generation = 0; generation < 5; generation++) {
      expect((await quickOpen.query('a', context, { id: search, generation }))?.results).toEqual([]);
    }
    expect(logged).toEqual([
      '[quick-open] the worker exited with 1',
      '[quick-open] a query failed in the worker: no',
      '[quick-open] the worker answered with a file outside the queried projects',
      '[quick-open] the worker sent a malformed reply',
      '[quick-open] the worker sent a malformed reply',
    ]);
    expect([exiting, failing, outside, escaping, oversized].every((worker) => worker.terminated)).toBe(true);
    expect((await quickOpen.query('a', context, { id: search, generation: 5 }))?.results).toHaveLength(1);
    expect(started).toBe(6);
    quickOpen.dispose();
  });

  it('terminates a worker that sends nothing while a query waits, answers the query empty and starts a fresh worker next', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      touch(alpha, 'a.ts');
      const silent = new ScriptedWorker();
      const workers: QuickOpenWorker[] = [silent, new InProcessWorker()];
      const quickOpen = index(() => workers.shift()!);
      const search = quickOpen.open();
      const context = { currentProjectKey: alpha.key, recent: [] };
      const stuck = quickOpen.query('a:3', context, { id: search, generation: 0 });
      await turnsUntil(() => silent.queries.length === 1);
      vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS / 2);
      // A keystroke while the worker is silent does not put off the deadline.
      const typedOn = quickOpen.query('a.', context, { id: search, generation: 1 });
      await turnsUntil(() => silent.queries.length === 2);

      vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS / 2 - 250);
      expect(await settled(stuck)).toBe(false);
      vi.advanceTimersByTime(250);

      expect(await stuck).toEqual({ currentProjectKey: alpha.key, line: 3, mention: false, results: [] });
      expect(await typedOn).toEqual({ currentProjectKey: alpha.key, mention: false, results: [] });
      expect(logged).toEqual([`[quick-open] the worker sent nothing for ${QUICK_OPEN_WORKER_SILENCE_MS} ms while a query waited`]);
      expect(silent.terminated).toBe(true);
      expect((await quickOpen.query('a', context, { id: search, generation: 2 }))?.results.map((result) => result.relativePath)).toEqual(['a.ts']);
      expect(started).toBe(2);
      quickOpen.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never stops a worker that is slow but reports progress, and stops watching it once no query waits', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const slow = new ScriptedWorker();
      const quickOpen = index(() => slow);
      const search = quickOpen.open();
      const context = { currentProjectKey: alpha.key, recent: [] };
      const answer = quickOpen.query('a', context, { id: search, generation: 0 });
      await turnsUntil(() => slow.queries.length === 1);

      for (let report = 0; report < 3; report++) {
        vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS - 250);
        slow.emit('message', { kind: 'progress' });
      }
      expect(await settled(answer)).toBe(false);
      slow.emit('message', { kind: 'answer', id: slow.queries[0]!.id, results: [] });
      expect(await answer).toEqual({ currentProjectKey: alpha.key, mention: false, results: [] });

      vi.advanceTimersByTime(2 * QUICK_OPEN_WORKER_SILENCE_MS);
      expect(slow.terminated).toBe(false);
      expect(logged).toEqual([]);
      void quickOpen.query('b', context, { id: search, generation: 1 });
      await turnsUntil(() => slow.queries.length === 2);
      expect(started).toBe(1);
      quickOpen.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no deadline of a worker that failed running against the worker that replaced it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const first = new ScriptedWorker();
      const second = new ScriptedWorker();
      const workers: QuickOpenWorker[] = [first, second];
      const quickOpen = index(() => workers.shift()!);
      const search = quickOpen.open();
      const context = { currentProjectKey: alpha.key, recent: [] };
      const failed = quickOpen.query('a', context, { id: search, generation: 0 });
      await turnsUntil(() => first.queries.length === 1);
      first.emit('error', new Error('out of memory'));
      expect(await failed).toEqual({ currentProjectKey: alpha.key, mention: false, results: [] });

      vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS / 2);
      const next = quickOpen.query('a', context, { id: search, generation: 1 });
      await turnsUntil(() => second.queries.length === 1);
      vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS / 2);
      expect(await settled(next)).toBe(false);
      vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS / 2);

      expect(await next).toEqual({ currentProjectKey: alpha.key, mention: false, results: [] });
      expect(logged).toEqual(['[quick-open] the worker failed: out of memory', `[quick-open] the worker sent nothing for ${QUICK_OPEN_WORKER_SILENCE_MS} ms while a query waited`]);
      quickOpen.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never starts a worker for a query of a request that already closed', async () => {
    const quickOpen = index();
    const search = quickOpen.open();
    quickOpen.end(search);
    expect(await quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: search, generation: 0 })).toBeUndefined();
    expect(started).toBe(0);
  });
});

describe('ripgrep listings main runs for the worker', () => {
  it('runs with no config, no link following, each exclude negated and the root after --', () => {
    const args = ripgrepFileArgs('/p', ['--no-ignore'], ['**/.git', '-x']);
    expect(args).toEqual(['--files', '--hidden', '--no-config', '--no-ignore', '-g', '!**/.git', '-g', '!-x', '--', '/p']);
    expect(args).not.toContain('--follow');
  });

  it('streams ripgrep\'s output for a project to the worker that asked, then ends the listing', async () => {
    touch(alpha, 'a.ts');
    const worker = new ScriptedWorker();
    const spawned: Array<{ rgPath: string; args: readonly string[] }> = [];
    const quickOpen = index(() => worker, (path, args) => {
      spawned.push({ rgPath: path, args });
      return spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    });
    void quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    await turnsUntil(() => worker.queries.length === 1);
    worker.emit('message', { kind: 'list', listing: 7, projectKey: alpha.key });
    await vi.waitFor(() => expect(worker.received.at(-1)).toEqual({ kind: 'listEnd', listing: 7 }));
    expect(spawned).toEqual([{ rgPath, args: ripgrepFileArgs(alpha.fsPath, [], ['**/.git']) }]);
    const output = worker.received.flatMap((request) => (request.kind === 'listOutput' && request.listing === 7 ? [Buffer.from(request.data).toString('utf8')] : [])).join('');
    expect(output.trim()).toBe(path.join(alpha.fsPath, 'a.ts'));
    quickOpen.dispose();
  });

  it('ends an empty project\'s listing as found, a failed ripgrep\'s with its exit code, and one that cannot start once', async () => {
    const worker = new ScriptedWorker();
    let resolveRg = async (): Promise<string> => rgPath;
    const quickOpen = index(() => worker, undefined, () => resolveRg());
    void quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    await turnsUntil(() => worker.queries.length === 1);
    const ends = (listing: number): WorkerRequest[] => worker.received.filter((request) => request.kind === 'listEnd' && request.listing === listing);

    worker.emit('message', { kind: 'list', listing: 1, projectKey: beta.key });
    await vi.waitFor(() => expect(ends(1)).toEqual([{ kind: 'listEnd', listing: 1 }]));
    fs.rmSync(alpha.fsPath, { recursive: true });
    worker.emit('message', { kind: 'list', listing: 2, projectKey: alpha.key });
    await vi.waitFor(() => expect(ends(2)).toEqual([{ kind: 'listEnd', listing: 2, error: expect.stringMatching(/^ripgrep exited with 2: /) }]));
    resolveRg = async () => path.join(root, 'no-such-rg.exe');
    worker.emit('message', { kind: 'list', listing: 3, projectKey: beta.key });
    await vi.waitFor(() => expect(ends(3)).toHaveLength(1));
    await settled(Promise.resolve());
    expect(ends(3)).toEqual([{ kind: 'listEnd', listing: 3, error: expect.stringContaining('ENOENT') }]);
    resolveRg = async () => {
      throw new Error('ripgrep is missing from the install');
    };
    worker.emit('message', { kind: 'list', listing: 4, projectKey: beta.key });
    await vi.waitFor(() => expect(ends(4)).toEqual([{ kind: 'listEnd', listing: 4, error: 'ripgrep is missing from the install' }]));
    quickOpen.dispose();
  });

  it('logs what ripgrep printed for a listing that still succeeded', async () => {
    fs.writeFileSync(path.join(alpha.fsPath, '.gitignore'), 'a{b\n');
    const worker = new ScriptedWorker();
    const quickOpen = index(() => worker);
    void quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    await turnsUntil(() => worker.queries.length === 1);
    worker.emit('message', { kind: 'list', listing: 0, projectKey: alpha.key });
    await vi.waitFor(() => expect(worker.received.at(-1)).toEqual({ kind: 'listEnd', listing: 0 }));
    expect(logged).toEqual([expect.stringMatching(/^\[quick-open\] ripgrep: .*error parsing glob 'a\{b'/)]);
    quickOpen.dispose();
  });

  it('kills no ripgrep that already finished when the worker stops', async () => {
    touch(alpha, 'a.ts');
    const worker = new ScriptedWorker();
    const kills: number[] = [];
    const quickOpen = index(() => worker, (path, args) => {
      const rg = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const kill = rg.kill.bind(rg);
      rg.kill = (signal) => {
        kills.push(rg.pid!);
        return kill(signal);
      };
      return rg;
    });
    void quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    await turnsUntil(() => worker.queries.length === 1);
    worker.emit('message', { kind: 'list', listing: 0, projectKey: alpha.key });
    await vi.waitFor(() => expect(worker.received.at(-1)).toEqual({ kind: 'listEnd', listing: 0 }));
    quickOpen.dispose();
    expect(kills).toEqual([]);
  });

  it('refuses a listing of a folder that is not a project, running nothing', async () => {
    const worker = new ScriptedWorker();
    const spawnRg = vi.fn(hangingRg);
    const quickOpen = index(() => worker, spawnRg);
    void quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    await turnsUntil(() => worker.queries.length === 1);
    worker.emit('message', { kind: 'list', listing: 0, projectKey: folderKey(root) });
    await turnsUntil(() => worker.received.some((request) => request.kind === 'listEnd'));
    expect(worker.received.at(-1)).toEqual({ kind: 'listEnd', listing: 0, error: 'not a project' });
    expect(spawnRg).not.toHaveBeenCalled();
    quickOpen.dispose();
  });

  it('kills the ripgrep a silent worker asked for when it replaces the worker', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const rgs: ChildProcess[] = [];
    try {
      const quickOpen = index(() => new ListingWorker(), () => {
        const rg = hangingRg();
        rgs.push(rg);
        return rg;
      });
      const answer = quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
      await turnsUntil(() => rgs.length === 1);
      const exited = once(rgs[0]!, 'exit');
      vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS);
      expect(await answer).toEqual({ currentProjectKey: alpha.key, mention: false, results: [] });
      await exited;
      expect(ended(rgs[0]!)).toBe(true);
      quickOpen.dispose();
    } finally {
      vi.useRealTimers();
      for (const rg of rgs) rg.kill();
    }
  });

  it('kills the ripgrep of a worker that fails, and of the running worker when Quick Open is disposed at quit', async () => {
    const rgs: ChildProcess[] = [];
    const workers = [new ListingWorker(), new ListingWorker()];
    try {
      const quickOpen = index(() => workers.shift()!, () => {
        const rg = hangingRg();
        rgs.push(rg);
        return rg;
      });
      const search = quickOpen.open();
      const context = { currentProjectKey: alpha.key, recent: [] };
      const failing = workers[0]!;
      void quickOpen.query('a', context, { id: search, generation: 0 });
      await turnsUntil(() => rgs.length === 1);
      const first = once(rgs[0]!, 'exit');
      failing.emit('error', new Error('out of memory'));
      await first;

      void quickOpen.query('a', context, { id: search, generation: 1 });
      await turnsUntil(() => rgs.length === 2);
      const second = once(rgs[1]!, 'exit');
      quickOpen.dispose();
      await second;
      expect(rgs.every(ended)).toBe(true);
    } finally {
      for (const rg of rgs) rg.kill();
    }
  });

  it('starts no ripgrep for a worker that stopped while main looked for ripgrep', async () => {
    let found!: (path: string) => void;
    const spawnRg = vi.fn(hangingRg);
    const worker = new ListingWorker();
    const quickOpen = index(() => worker, spawnRg, () => new Promise<string>((resolve) => (found = resolve)));
    const answer = quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    await turnsUntil(() => worker.queries.length === 1);
    await turnsUntil(() => found !== undefined);
    worker.emit('error', new Error('out of memory'));
    await answer;
    found(rgPath);
    await settled(Promise.resolve());
    expect(spawnRg).not.toHaveBeenCalled();
  });
});

describe('Quick Open in a worker thread', () => {
  let bundle: string;

  beforeAll(async () => {
    bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-quick-worker-')), 'quick-open-worker.js');
    await build({ entryPoints: [path.resolve(__dirname, '..', '..', 'quick-open-worker', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: bundle, logLevel: 'silent' });
  });

  afterAll(() => {
    fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
  });

  it('lists and scores the projects\' files in the built worker, and invalidates a project\'s list', async () => {
    touch(alpha, 'src/routes/auth.ts');
    touch(beta, 'docs/auth.md');
    const quickOpen = index(() => new Worker(bundle));
    const search = quickOpen.open();
    const context = { currentProjectKey: alpha.key, recent: [] };
    const names = async (raw: string, generation: number): Promise<string[] | undefined> => (await quickOpen.query(raw, context, { id: search, generation }))?.results.map((result) => `${result.projectName}/${result.relativePath}`);
    expect((await names('auth', 0))?.sort()).toEqual(['alpha/src/routes/auth.ts', 'beta/docs/auth.md']);
    touch(alpha, 'auth-new.ts');
    quickOpen.invalidate(alpha.key);
    expect(await names('auth', 1)).toContain('alpha/auth-new.ts');
    quickOpen.end(search);
    quickOpen.dispose();
    expect(logged).toEqual([]);
  });
});

describe('Quick Open picker', () => {
  function overlay(answer: OverlayAnswer): { handlers: Map<string, (...args: unknown[]) => unknown>; open: boolean; request: (request: OverlayRequest) => Promise<OverlayAnswer> } {
    const state = {
      handlers: new Map<string, (...args: unknown[]) => unknown>(),
      open: false,
      request: async (request: OverlayRequest) => {
        expect(request).toEqual({ kind: 'quickOpen', mode: 'files' });
        state.open = true;
        await state.handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!({ query: 'a', generation: 3 });
        state.open = false;
        return answer;
      },
    };
    return state;
  }

  function picker(state: ReturnType<typeof overlay>): QuickOpenPicker {
    return new QuickOpenPicker(
      { handle: (channel, handler) => state.handlers.set(channel, handler), isOpen: () => state.open, request: (request) => state.request(request) },
      index(),
      () => ({ currentProjectKey: alpha.key, recent: [] }),
      { capture: () => CONTEXT, list: () => [] },
      () => undefined,
    );
  }

  it('accepts only a pick a query returned', async () => {
    touch(alpha, 'a.ts');
    expect(await picker(overlay({ kind: 'quickOpen', pick: { projectKey: alpha.key, relativePath: 'a.ts', mention: false } })).show(undefined, 'files')).toEqual({ kind: 'pick', pick: { projectKey: alpha.key, relativePath: 'a.ts', mention: false } });
    expect(await picker(overlay({ kind: 'quickOpen', pick: { projectKey: alpha.key, relativePath: 'never-listed.ts', mention: false } })).show(undefined, 'files')).toBeUndefined();
    expect(await picker(overlay({ kind: 'quickOpen', pick: null })).show(undefined, 'files')).toBeUndefined();
  });

  it('answers a command with the focus context captured before the overlay showed, and lists commands only while it is open', async () => {
    const state = overlay({ kind: 'quickOpen', command: 'damocles.editor.save' });
    const listed: MenuState[] = [];
    let context: MenuState = CONTEXT;
    const quickOpen = new QuickOpenPicker(
      { handle: (channel, handler) => state.handlers.set(channel, handler), isOpen: () => state.open, request: async (request) => {
        context = { ...CONTEXT, focus: undefined };
        state.open = true;
        listed.push(...(await state.handlers.get(OVERLAY_CHANNELS.commandsList)!({}) as MenuState[]));
        expect(() => state.handlers.get(OVERLAY_CHANNELS.commandsList)!({ extra: 1 })).toThrow('Malformed');
        state.open = false;
        expect(request).toEqual({ kind: 'quickOpen', mode: 'commands' });
        return { kind: 'quickOpen', command: 'damocles.editor.save' };
      } },
      index(),
      () => ({ currentProjectKey: alpha.key, recent: [] }),
      { capture: () => context, list: (captured) => [captured as never] },
      () => undefined,
    );
    expect(() => state.handlers.get(OVERLAY_CHANNELS.commandsList)!({})).toThrow('Quick Open is not open');
    expect(await quickOpen.show(undefined, 'commands')).toEqual({ kind: 'command', id: 'damocles.editor.save', context: CONTEXT });
    expect(listed).toEqual([CONTEXT]);
  });

  it('limits a request scoped to a folder to that project folder\'s files, and a pick to one of them', async () => {
    touch(alpha, 'src/routes/users.ts');
    touch(alpha, 'src/routes/admin/audit.ts');
    touch(alpha, 'src/routes.ts');
    touch(alpha, 'src/app.ts');
    touch(beta, 'src/routes/users.ts');
    const scope = { projectKey: alpha.key, projectName: 'alpha', folder: 'src/routes/' };
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let open = false;
    const queried: unknown[] = [];
    const quickOpenIndex = index();
    const quickOpen = new QuickOpenPicker(
      { handle: (channel, handler) => handlers.set(channel, handler), isOpen: () => open, request: async (request) => {
        expect(request).toEqual({ kind: 'quickOpen', mode: 'files', scope });
        open = true;
        queried.push(await handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!({ query: '', generation: 1 }));
        queried.push(await handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!({ query: 'users', generation: 2 }));
        open = false;
        return { kind: 'quickOpen', pick: { projectKey: beta.key, relativePath: 'src/routes/users.ts', mention: false } };
      } },
      quickOpenIndex,
      () => ({ currentProjectKey: beta.key, recent: [{ projectKey: alpha.key, relativePath: 'src/app.ts' }] }),
      { capture: () => CONTEXT, list: () => [] },
      () => undefined,
    );
    expect(await quickOpen.show(undefined, 'files', scope)).toBeUndefined();
    const names = (response: unknown): string[] => (response as { results: Array<{ projectName: string; relativePath: string; recent: boolean }> }).results.map((result) => `${result.projectName}/${result.relativePath}${result.recent ? '*' : ''}`);
    expect(names(queried[0])).toEqual(['alpha/src/routes/admin/audit.ts', 'alpha/src/routes/users.ts']);
    expect(names(queried[1])).toEqual(['alpha/src/routes/users.ts']);

    // The next request is not scoped: every project's files come back.
    const all = await quickOpenIndex.query('users', { currentProjectKey: beta.key, recent: [] }, { id: quickOpenIndex.open(), generation: 0 });
    expect(all?.results.map((result) => result.projectName).sort()).toEqual(['alpha', 'beta']);
  });

  it('answers queries only while Quick Open is open, within bounds', async () => {
    const state = overlay({ kind: 'dismissed' });
    picker(state);
    const query = state.handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!;
    await expect(Promise.resolve(query({ query: 'a', generation: 1 }))).rejects.toThrow('Quick Open is not open');
    state.open = true;
    await expect(Promise.resolve(query({ query: 'x'.repeat(513), generation: 1 }))).rejects.toThrow('Malformed Quick Open query');
    await expect(Promise.resolve(query({ query: 'a', generation: -1 }))).rejects.toThrow('Malformed Quick Open generation');
    await expect(Promise.resolve(query({ query: 'a', generation: 7 }))).resolves.toMatchObject({ generation: 7 });
  });
});
