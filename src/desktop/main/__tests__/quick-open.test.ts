import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { processLauncher, type LaunchedProcess } from '../../../core/process-launcher';
import { rgPath } from '@vscode/ripgrep';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { QuickOpenListingDeps } from '../../workspace/quick-open-listing';
import { testRemote, testWorkspaces, unretainedSpellings } from './test-workspaces';
import { FileTree } from '../files/file-tree';
import { projectKeyOf } from '../../../shared/project-location';
import { LocalizedError } from '../../../shared/localized-text';
import * as fuzzy from '../../../core/quick-open/fuzzy-match';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { OVERLAY_CHANNELS, quickOpenRowKey, type OverlayAnswer, type OverlayRequest, type PopupAnswer, type QuickOpenPick, type QuickOpenProjectResult, type QuickOpenResponse, type QuickOpenResult } from '../../preload/overlay-channels';
import { createQuickOpenFileSearch } from '../../quick-open-worker/file-search';
import { ripgrepFileArgs, type WorkerReply, type WorkerRequest } from '../../quick-open-worker/protocol';
import type { Project } from '../../local-services/confine';
import type { MenuState } from '../menu';
import { QUICK_OPEN_WORKER_SILENCE_MS, QuickOpenIndex, QuickOpenPicker, type QuickOpenAnswer, type QuickOpenWorker } from '../quick-open';
import { MAX_EDITOR_LINE } from '../../preload/shell-channels';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import { ListingUnsupportedError, OutsideFilesUnsupportedError } from '../workspace/remote-workspace';
import { fakeHandleWhileOpen } from './fake-popup-channels';
import { NO_SCM_MENU_STATE } from '../scm/scm-host';

vi.mock('../../../core/quick-open/fuzzy-match', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../core/quick-open/fuzzy-match')>();
  return { ...original, scoreItem: vi.fn(original.scoreItem) };
});

// This computer alone: no host is known, and ~ is the test's root.
const TYPED_PATHS = {
  authorityOs: (authority: string) => (authority === 'local' ? process.platform : undefined),
  spellings: unretainedSpellings(),
  homedir: (authority: string) => (authority === 'local' ? root : undefined),
  hostName: (authority: string) => authority,
};

function projectRow(result: QuickOpenResult): QuickOpenProjectResult {
  if (result.kind !== 'project') throw new Error(`a ${result.kind} row`);
  return result;
}

// The value of a popup channel's answer while Quick Open is open.
async function openValue(answer: unknown): Promise<unknown> {
  const answered = (await answer) as PopupAnswer<unknown>;
  if (!answered.ok) throw new Error('answered closed');
  return answered.value;
}

const CONTEXT: MenuState = { chat: true, liveChat: true, editor: true, browser: false, page: false, focus: 'editor', updateCheck: false, terminalCreate: true, terminal: undefined, terminalEditor: false, terminalTask: false, terminalSplit: false, terminalJoin: false, terminalInput: false, search: { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible: false }, scm: NO_SCM_MENU_STATE, editorKind: undefined, editorDocument: undefined, editorGit: null, selectedChatHasChanges: false, worktree: undefined, handOff: undefined, newChatInWorktree: undefined, remoteHostConnected: false, remoteHostSaved: false, clientCertificateSite: false };

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
  private readonly waiting = new Set<{ readonly matches: (request: WorkerRequest) => boolean; readonly resolve: () => void }>();

  postMessage(request: WorkerRequest): void {
    this.received.push(request);
    if (request.kind === 'query') this.queries.push(request);
    for (const waiter of this.waiting) if (waiter.matches(request)) waiter.resolve();
  }

  /** Settles once main posted a request that matches, as soon as it did: a real ripgrep's start has no time bound. */
  async posted(matches: (request: WorkerRequest) => boolean): Promise<void> {
    if (this.received.some(matches)) return;
    await new Promise<void>((resolve) => {
      const waiter = { matches, resolve: () => {
        this.waiting.delete(waiter);
        resolve();
      } };
      this.waiting.add(waiter);
    });
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

function index(startWorker: () => QuickOpenWorker = () => new InProcessWorker(), spawnRg?: QuickOpenListingDeps['spawnRg'], resolveRg: () => Promise<string> = async () => rgPath): QuickOpenIndex {
  return new QuickOpenIndex({
    projects: () => [alpha, beta],
    workspaces: testWorkspaces({ watchers: createFakePlatform().fileWatchers, rgPath: resolveRg, log: (line) => logged.push(line), ...(spawnRg ? { spawnListingRg: spawnRg } : {}) }),
    ignoreArgs: () => [],
    excludes: () => ['**/.git'],
    watch: () => true,
    startWorker: () => {
      started++;
      return startWorker();
    },
    log: (line) => logged.push(line),
    ...TYPED_PATHS,
  });
}

/** A ripgrep stuck on a hung file system: a real process that prints nothing and never exits. */
function hangingRg(): LaunchedProcess {
  return launch(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)']);
}

function launch(file: string, args: readonly string[]): LaunchedProcess {
  return processLauncher().launch({ file, args, stdio: ['ignore', 'pipe', 'pipe'] });
}

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
      results: [{ kind: 'project', projectKey: alpha.key, projectName: 'alpha', relativePath: 'src/editor-pane.ts', label: 'editor-pane.ts', description: 'src', labelMatches: [[0, 2], [7, 11]], descriptionMatches: [], recent: false }],
    });
    quickOpen.dispose();
  });

  it('answers a query a newer one replaced with nothing, having scored nothing for it', async () => {
    for (let i = 0; i < 5; i++) touch(alpha, `a${i}.ts`);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let open = false;
    const answers: unknown[] = [];
    const quickOpen = new QuickOpenPicker(
      { handleWhileOpen: fakeHandleWhileOpen(handlers), isOpen: () => open, request: async () => {
        open = true;
        const query = handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!;
        answers.push(...await Promise.all([openValue(query({ query: 'a1', generation: 4 })), openValue(query({ query: 'a', generation: 5 }))]));
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

  it('answers failed with the reason logged when the worker crashes, and starts a fresh worker for the next query', async () => {
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
    expect(await quickOpen.query('a:3', context, { id: search, generation: 0 })).toEqual({ currentProjectKey: alpha.key, line: 3, mention: false, results: [], failed: true });
    expect(logged).toEqual(['[quick-open] the worker failed: out of memory']);
    expect(crashing.terminated).toBe(true);
    expect((await quickOpen.query('a', context, { id: search, generation: 1 }))?.results.map((result) => projectRow(result).relativePath)).toEqual(['a.ts']);
    expect(started).toBe(2);
    quickOpen.dispose();
  });

  it('answers failed when the worker exits, fails a query or sends a reply outside the contract, and starts afresh each time', async () => {
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
      expect(await quickOpen.query('a', context, { id: search, generation })).toMatchObject({ results: [], failed: true });
    }
    expect(logged).toEqual([
      '[quick-open] the worker exited with 1',
      '[quick-open] a query failed in the worker: no',
      '[quick-open] the worker answered with a file outside the queried projects',
      '[quick-open] the worker sent a malformed reply',
      '[quick-open] the worker sent a malformed reply',
    ]);
    expect([exiting, failing, outside, escaping, oversized].every((worker) => worker.terminated)).toBe(true);
    const recovered = await quickOpen.query('a', context, { id: search, generation: 5 });
    expect(recovered?.results).toHaveLength(1);
    expect(recovered).not.toHaveProperty('failed');
    expect(started).toBe(6);
    quickOpen.dispose();
  });

  it('terminates a worker that sends nothing while a query waits, answers the query failed and starts a fresh worker next', async () => {
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

      expect(await stuck).toEqual({ currentProjectKey: alpha.key, line: 3, mention: false, results: [], failed: true });
      expect(await typedOn).toEqual({ currentProjectKey: alpha.key, mention: false, results: [], failed: true });
      expect(logged).toEqual([`[quick-open] the worker sent nothing for ${QUICK_OPEN_WORKER_SILENCE_MS} ms while a query waited`]);
      expect(silent.terminated).toBe(true);
      expect((await quickOpen.query('a', context, { id: search, generation: 2 }))?.results.map((result) => projectRow(result).relativePath)).toEqual(['a.ts']);
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
      expect(await failed).toEqual({ currentProjectKey: alpha.key, mention: false, results: [], failed: true });

      vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS / 2);
      const next = quickOpen.query('a', context, { id: search, generation: 1 });
      await turnsUntil(() => second.queries.length === 1);
      vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS / 2);
      expect(await settled(next)).toBe(false);
      vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS / 2);

      expect(await next).toEqual({ currentProjectKey: alpha.key, mention: false, results: [], failed: true });
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
      return launch(path, args);
    });
    void quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    await turnsUntil(() => worker.queries.length === 1);
    worker.emit('message', { kind: 'list', listing: 7, projectKey: alpha.key });
    await worker.posted((request) => request.kind === 'listEnd');
    expect(worker.received.at(-1)).toEqual({ kind: 'listEnd', listing: 7 });
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
    const ended = (listing: number): Promise<void> => worker.posted((request) => request.kind === 'listEnd' && request.listing === listing);

    worker.emit('message', { kind: 'list', listing: 1, projectKey: beta.key });
    await ended(1);
    expect(ends(1)).toEqual([{ kind: 'listEnd', listing: 1 }]);
    fs.rmSync(alpha.fsPath, { recursive: true });
    worker.emit('message', { kind: 'list', listing: 2, projectKey: alpha.key });
    await ended(2);
    expect(ends(2)).toEqual([{ kind: 'listEnd', listing: 2, error: expect.stringMatching(/^ripgrep exited with 2: /) }]);
    resolveRg = async () => path.join(root, 'no-such-rg.exe');
    worker.emit('message', { kind: 'list', listing: 3, projectKey: beta.key });
    await ended(3);
    await settled(Promise.resolve());
    expect(ends(3)).toEqual([{ kind: 'listEnd', listing: 3, error: expect.stringContaining('ENOENT') }]);
    resolveRg = async () => {
      throw new Error('ripgrep is missing from the install');
    };
    worker.emit('message', { kind: 'list', listing: 4, projectKey: beta.key });
    await ended(4);
    expect(ends(4)).toEqual([{ kind: 'listEnd', listing: 4, error: 'ripgrep is missing from the install' }]);
    quickOpen.dispose();
  });

  it('logs what ripgrep printed for a listing that still succeeded', async () => {
    fs.writeFileSync(path.join(alpha.fsPath, '.gitignore'), 'a{b\n');
    const worker = new ScriptedWorker();
    const quickOpen = index(() => worker);
    void quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    await turnsUntil(() => worker.queries.length === 1);
    worker.emit('message', { kind: 'list', listing: 0, projectKey: alpha.key });
    await worker.posted((request) => request.kind === 'listEnd');
    expect(worker.received.at(-1)).toEqual({ kind: 'listEnd', listing: 0 });
    expect(logged).toEqual([expect.stringMatching(/^\[quick-open\] ripgrep: .*error parsing glob 'a\{b'/)]);
    quickOpen.dispose();
  });

  it('kills no ripgrep that already finished when the worker stops', async () => {
    touch(alpha, 'a.ts');
    const worker = new ScriptedWorker();
    let kills = 0;
    const quickOpen = index(() => worker, (path, args) => {
      const rg = launch(path, args);
      return {
        ...rg,
        kill: (options) => {
          kills++;
          rg.kill(options);
        },
      };
    });
    void quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    await turnsUntil(() => worker.queries.length === 1);
    worker.emit('message', { kind: 'list', listing: 0, projectKey: alpha.key });
    await worker.posted((request) => request.kind === 'listEnd');
    expect(worker.received.at(-1)).toEqual({ kind: 'listEnd', listing: 0 });
    quickOpen.dispose();
    expect(kills).toBe(0);
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
    const rgs: LaunchedProcess[] = [];
    try {
      const quickOpen = index(() => new ListingWorker(), () => {
        const rg = hangingRg();
        rgs.push(rg);
        return rg;
      });
      const answer = quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
      await turnsUntil(() => rgs.length === 1);
      vi.advanceTimersByTime(QUICK_OPEN_WORKER_SILENCE_MS);
      expect(await answer).toEqual({ currentProjectKey: alpha.key, mention: false, results: [], failed: true });
      await rgs[0]!.exited;
      quickOpen.dispose();
    } finally {
      vi.useRealTimers();
      for (const rg of rgs) rg.kill();
    }
  });

  it('kills the ripgrep of a worker that fails, and of the running worker when Quick Open is disposed at quit', async () => {
    const rgs: LaunchedProcess[] = [];
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
      failing.emit('error', new Error('out of memory'));
      await rgs[0]!.exited;

      void quickOpen.query('a', context, { id: search, generation: 1 });
      await turnsUntil(() => rgs.length === 2);
      quickOpen.dispose();
      await rgs[1]!.exited;
    } finally {
      for (const rg of rgs) rg.kill();
    }
  });

  it('sends neither data nor an end after a kill, as a host\'s listing over the wire sends none', async () => {
    let exit!: (code: number | null) => void;
    let output!: (chunk: Buffer) => void;
    const rg = {
      onData: (stream: string, listener: (chunk: Buffer) => void) => {
        if (stream === 'stdout') output = listener;
      },
      exited: new Promise<{ code: number | null }>((resolve) => (exit = (code) => resolve({ code }))),
      closed: Promise.resolve(),
      kill: () => undefined,
    } as unknown as LaunchedProcess;
    const listed: string[] = [];
    const listing = testWorkspaces({ watchers: createFakePlatform().fileWatchers, spawnListingRg: () => rg }).local.quickOpen.list(alpha.fsPath, [], [], { data: () => listed.push('data'), end: (error) => listed.push(`end ${error}`) });
    await turnsUntil(() => output !== undefined);
    listing.kill();
    output(Buffer.from('a.ts\n'));
    exit(null);
    await settled(Promise.resolve());
    expect(listed).toEqual([]);
  });

  it('kills each listing once: a killed listing, which never ends, is not killed again when the next worker stops', async () => {
    const kills: number[] = [];
    const workers = [new ListingWorker(), new ListingWorker()];
    const quickOpen = index(() => workers.shift()!, () => {
      const id = kills.push(0) - 1;
      return { onData: () => undefined, exited: new Promise(() => undefined), closed: new Promise(() => undefined), kill: () => kills[id]!++ } as unknown as LaunchedProcess;
    });
    const search = quickOpen.open();
    const context = { currentProjectKey: alpha.key, recent: [] };
    const failing = workers[0]!;
    void quickOpen.query('a', context, { id: search, generation: 0 });
    await turnsUntil(() => kills.length === 1);
    failing.emit('error', new Error('out of memory'));
    void quickOpen.query('a', context, { id: search, generation: 1 });
    await turnsUntil(() => kills.length === 2);
    quickOpen.dispose();
    expect(kills).toEqual([1, 1]);
  });

  it('leaves a project whose host is not connected out of a query, and ends a listing the worker asks for it with the reason', async () => {
    touch(alpha, 'a.ts');
    const remote = testRemote({ watchers: createFakePlatform().fileWatchers });
    remote.disconnect('network');
    const away: Project = { key: projectKeyOf({ kind: 'loopback' }, folderKey(beta.fsPath)), fsPath: beta.fsPath, name: 'beta' };
    const workspaces = testWorkspaces({ watchers: createFakePlatform().fileWatchers, remote: () => remote.workspace() });
    const fileTree = new FileTree({ projects: () => [alpha, away], exclude: () => ({}), workspaces, ask: async () => undefined, t: (message) => message, log: (line) => logged.push(line), reveal: async () => undefined, copy: async () => undefined, changed: () => undefined, ignored: async () => new Set(), target: () => ({ os: process.platform }) });
    const worker = new InProcessWorker();
    const quickOpen = new QuickOpenIndex({ projects: () => [alpha, away], workspaces, ignoreArgs: () => [], excludes: () => [], watch: (owner) => fileTree.watch(owner), startWorker: () => worker, log: (line) => logged.push(line), ...TYPED_PATHS });
    const search = quickOpen.open();
    const answer = await quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: search, generation: 0 });
    expect(answer?.failed).toBeUndefined();
    expect(answer?.results.map((result) => [projectRow(result).projectKey, projectRow(result).relativePath])).toEqual([[alpha.key, 'a.ts']]);
    expect(await quickOpen.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: search, generation: 1 })).toMatchObject({ results: [{ relativePath: 'a.ts' }] });
    quickOpen.dispose();

    const scripted = new ScriptedWorker();
    const asking = new QuickOpenIndex({ projects: () => [alpha, away], workspaces, ignoreArgs: () => [], excludes: () => [], watch: (owner) => fileTree.watch(owner), startWorker: () => scripted, log: (line) => logged.push(line), ...TYPED_PATHS });
    void asking.query('a', { currentProjectKey: alpha.key, recent: [] }, { id: asking.open(), generation: 0 });
    await turnsUntil(() => scripted.queries.length === 1);
    expect(scripted.queries[0]!.projects.map((queried) => queried.key)).toEqual([alpha.key]);
    // a listing the worker still asks for, from a query made before the host went away
    scripted.emit('message', { kind: 'list', listing: 3, projectKey: away.key });
    await turnsUntil(() => scripted.received.some((request) => request.kind === 'listEnd'));
    expect(scripted.received.at(-1)).toEqual({ kind: 'listEnd', listing: 3, error: 'loopback is not connected.' });
    asking.dispose();
    fileTree.dispose();
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
    const names = async (raw: string, generation: number): Promise<string[] | undefined> => (await quickOpen.query(raw, context, { id: search, generation }))?.results.map((result) => `${projectRow(result).projectName}/${projectRow(result).relativePath}`);
    expect((await names('auth', 0))?.sort()).toEqual(['alpha/src/routes/auth.ts', 'beta/docs/auth.md']);
    touch(alpha, 'auth-new.ts');
    quickOpen.invalidate(alpha.key);
    expect(await names('auth', 1)).toContain('alpha/auth-new.ts');
    quickOpen.end(search);
    quickOpen.dispose();
    expect(logged).toEqual([]);
  });
});

describe('Quick Open of a typed path', () => {
  let elsewhere: string;
  let file: string;

  beforeEach(() => {
    elsewhere = path.join(root, 'elsewhere');
    file = path.join(elsewhere, 'notes.txt');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(file, 'notes\n');
  });

  // the exact row of a typed file, completed to input as its folder's listing offers it
  const pathRow = (filePath: string, input: string = filePath, caret?: number): QuickOpenResult => {
    const label = path.basename(filePath);
    const description = path.dirname(filePath);
    const complete = { input, ...(caret !== undefined ? { caret } : {}) };
    return { kind: 'path', authority: 'local', path: filePath, label, description, labelMatches: [[0, label.length]], descriptionMatches: [[0, description.length]], recent: false, complete, exact: true };
  };

  // An index over this computer's workspace whose files' methods the test replaces.
  const indexWith = (worker: QuickOpenWorker, change: (real: ProjectWorkspace['files']) => Partial<ProjectWorkspace['files']>): QuickOpenIndex => {
    const workspaces = testWorkspaces({ watchers: createFakePlatform().fileWatchers, rgPath: async () => rgPath, log: (line) => logged.push(line) });
    const local: ProjectWorkspace = { ...workspaces.local, files: { ...workspaces.local.files, ...change(workspaces.local.files) } };
    return new QuickOpenIndex({
      projects: () => [alpha, beta],
      workspaces: { ...workspaces, local, forAuthority: () => local },
      ignoreArgs: () => [],
      excludes: () => [],
      watch: () => true,
      startWorker: () => worker,
      log: (line) => logged.push(line),
      ...TYPED_PATHS,
    });
  };

  // An index over this computer's workspace whose resolveOutside is the test's.
  const indexResolving = (worker: QuickOpenWorker, resolveOutside: (real: ProjectWorkspace['files']['resolveOutside'], target: string) => ReturnType<ProjectWorkspace['files']['resolveOutside']>): QuickOpenIndex =>
    indexWith(worker, (real) => ({ resolveOutside: (target) => resolveOutside(real.resolveOutside, target) }));

  // The text search's answer to the worker query of raw, once main posted it.
  const answerText = async (worker: ScriptedWorker, raw: string, results: readonly unknown[] = []): Promise<void> => {
    await worker.posted((request) => request.kind === 'query' && request.raw === raw);
    const query = worker.queries.find((candidate) => candidate.raw === raw)!;
    worker.emit('message', { kind: 'answer', id: query.id, results });
  };

  it('answers a file outside every project as the first row, fully highlighted, with its :line:column, ahead of the text search', async () => {
    const worker = new ScriptedWorker();
    const quickOpen = index(() => worker);
    const search = quickOpen.open();
    const context = { currentProjectKey: alpha.key, recent: [] };
    expect(await quickOpen.query(`${file}:3:5`, context, { id: search, generation: 0 })).toEqual({ currentProjectKey: alpha.key, line: 3, column: 5, mention: false, results: [pathRow(file)] });
    expect(await quickOpen.query(`"${file}"`, context, { id: search, generation: 1 })).toEqual({ currentProjectKey: alpha.key, mention: false, results: [pathRow(file, `"${file}"`, file.length + 1)] });
    expect(await quickOpen.query('~/elsewhere/notes.txt(7)', context, { id: search, generation: 2 })).toEqual({ currentProjectKey: alpha.key, line: 7, mention: false, results: [pathRow(file, '~/elsewhere/notes.txt')] });
    // the worker never answered: the text search ran beside each lookup
    expect(worker.queries).toHaveLength(3);
    quickOpen.dispose();
  });

  it('answers a typed path inside a project with that project\'s row', async () => {
    touch(alpha, 'src/app.ts');
    const quickOpen = index(() => new ScriptedWorker());
    const answer = await quickOpen.query(path.join(alpha.fsPath, 'src', 'app.ts'), { currentProjectKey: alpha.key, recent: [] }, { id: quickOpen.open(), generation: 0 });
    expect(answer?.results).toEqual([
      { kind: 'project', projectKey: alpha.key, projectName: 'alpha', relativePath: 'src/app.ts', label: 'app.ts', description: 'src', labelMatches: [[0, 6]], descriptionMatches: [[0, 3]], recent: false, complete: { input: path.join(alpha.fsPath, 'src', 'app.ts') }, exact: true },
    ]);
    quickOpen.dispose();
  });

  it('sends a typed path, an @ mention and a scoped request\'s typed path to the worker\'s text search', async () => {
    const worker = new ScriptedWorker();
    const quickOpen = index(() => worker);
    const search = quickOpen.open();
    const context = { currentProjectKey: alpha.key, recent: [] };
    const queries = [path.join(root, 'gone', 'x.txt'), elsewhere, `@${file}`];
    queries.forEach((raw, generation) => void quickOpen.query(raw, context, { id: search, generation }));
    void quickOpen.query(file, { ...context, scope: { projectKey: alpha.key, projectName: 'alpha', folder: '' } }, { id: search, generation: 3 });
    expect(worker.queries.map((query) => query.raw).sort()).toEqual([...queries, file].sort());
    quickOpen.dispose();
  });

  it('answers the text search while a typed path\'s lookup never returns, marked pending until the request ends', async () => {
    const worker = new ScriptedWorker();
    const quickOpen = indexResolving(worker, () => new Promise(() => undefined));
    const search = quickOpen.open();
    const result = { projectKey: alpha.key, relativePath: 'notes.txt', labelMatches: [], descriptionMatches: [], recent: false };
    const asked = quickOpen.query(file, { currentProjectKey: alpha.key, recent: [] }, { id: search, generation: 0 });
    await answerText(worker, file, [result]);
    expect(await asked).toEqual({ currentProjectKey: alpha.key, mention: false, results: [expect.objectContaining({ kind: 'project', relativePath: 'notes.txt' })], pathPending: true });
    const row = quickOpen.typedPathAnswer(search, 0);
    expect(await settled(row)).toBe(false);
    quickOpen.end(search);
    expect(await row).toBeUndefined();
    quickOpen.dispose();
  });

  it('runs one typed-path lookup at a time, then only the newest query\'s, whose row still answers, and drops a stale row', async () => {
    const other = path.join(elsewhere, 'other.txt');
    const newest = path.join(elsewhere, 'newest.txt');
    fs.writeFileSync(other, '');
    fs.writeFileSync(newest, '');
    const worker = new ScriptedWorker();
    const looked: string[] = [];
    const gates: Array<() => void> = [];
    const quickOpen = indexResolving(worker, (real, target) => {
      looked.push(target);
      return new Promise((resolve) => gates.push(() => resolve(real(target))));
    });
    const search = quickOpen.open();
    const context = { currentProjectKey: alpha.key, recent: [] };
    const first = quickOpen.query(file, context, { id: search, generation: 0 });
    await turnsUntil(() => looked.length === 1);
    void quickOpen.query(other, context, { id: search, generation: 1 });
    const answer = quickOpen.query(newest, context, { id: search, generation: 2 });
    expect(await settled(answer)).toBe(false);
    expect(looked).toEqual([file]);
    gates[0]!();
    // the first lookup finishes on the file system, which no number of turns bounds
    await vi.waitFor(() => expect(looked).toEqual([file, newest]));
    // the first query's row came back after newer queries replaced it, and answers none of them
    expect(await settled(first)).toBe(false);
    expect(await settled(answer)).toBe(false);
    expect(await quickOpen.typedPathAnswer(search, 0)).toBeUndefined();
    gates[1]!();
    expect(await answer).toEqual({ currentProjectKey: alpha.key, mention: false, results: [pathRow(newest)] });
    expect(await quickOpen.typedPathAnswer(search, 2)).toEqual({ currentProjectKey: alpha.key, mention: false, results: [pathRow(newest)] });
    expect(worker.queries.map((query) => query.raw)).toEqual([file, other, newest]);
    quickOpen.dispose();
  });

  it('gives no row and answers the text search when a lookup fails, logging an unexpected error, a permission error once per root, and no daemon without files.outside or drive that does not answer', async () => {
    const worker = new ScriptedWorker();
    let failure: Error = new Error('the disk caught fire');
    let calls = 0;
    const quickOpen = indexResolving(worker, () => {
      calls++;
      return Promise.reject(failure);
    });
    const search = quickOpen.open();
    const context = { currentProjectKey: alpha.key, recent: [] };
    const ask = async (raw: string, generation: number): Promise<QuickOpenAnswer | undefined> => {
      const before = calls;
      const asked = quickOpen.query(raw, context, { id: search, generation });
      await turnsUntil(() => calls > before);
      await new Promise((resolve) => setImmediate(resolve));
      await answerText(worker, raw);
      const answer = await asked;
      // the listing of the missing folder settles on the file system; the lookup brings no rows once it has
      expect(await quickOpen.typedPathAnswer(search, generation)).toBeUndefined();
      return answer;
    };
    const noRow = { currentProjectKey: alpha.key, mention: false, results: [] };
    expect(await ask(path.join(root, 'gone', 'notes.txt'), 0)).toMatchObject(noRow);
    expect(logged).toEqual(['[quick-open] a typed path did not resolve: the disk caught fire']);
    logged.length = 0;
    failure = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(await ask(path.join(root, 'gone', 'a.txt'), 1)).toMatchObject(noRow);
    expect(await ask(path.join(root, 'gone', 'b.txt'), 2)).toMatchObject(noRow);
    const drive = path.parse(file).root;
    expect(logged).toEqual([`[quick-open] a typed path under ${drive} on local could not be read (EACCES); later ones there are not logged`]);
    logged.length = 0;
    failure = new OutsideFilesUnsupportedError('ssh-remote+box');
    expect(await ask(path.join(root, 'gone', 'c.txt'), 3)).toMatchObject(noRow);
    expect(logged).toEqual([]);
    // the link walk's answer for a drive that does not answer, on every keystroke under it
    failure = Object.assign(new LocalizedError({ message: 'The drive {0} did not answer within a second.', args: ['Q:\\'] }), { code: 'ETIMEDOUT' });
    expect(await ask(path.join(root, 'gone', 'd.txt'), 4)).toMatchObject(noRow);
    expect(await ask(path.join(root, 'gone', 'e.txt'), 5)).toMatchObject(noRow);
    expect(logged).toEqual([]);
    quickOpen.dispose();
  });

  it('opens a path pick only when a query of the same request returned it, and carries its line and column', async () => {
    const show = async (queried: string, pick: QuickOpenPick): Promise<unknown> => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      let open = false;
      const logs: string[] = [];
      const quickOpen = new QuickOpenPicker(
        { handleWhileOpen: fakeHandleWhileOpen(handlers), isOpen: () => open, request: async () => {
          open = true;
          await handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!({ query: queried, generation: 1 });
          open = false;
          return { kind: 'quickOpen', pick };
        } },
        index(() => new ScriptedWorker()),
        () => ({ currentProjectKey: alpha.key, recent: [] }),
        { capture: () => CONTEXT, list: () => [] },
        (line) => logs.push(line),
      );
      const outcome = await quickOpen.show(undefined, 'files');
      return outcome ?? logs;
    };
    const pick: QuickOpenPick = { kind: 'path', authority: 'local', path: file, line: 3, column: 5, mention: false };
    expect(await show(`${file}:3:5`, pick)).toEqual({ kind: 'pick', pick });
    const other = path.join(elsewhere, 'other.txt');
    fs.writeFileSync(other, '');
    expect(await show(`${file}:3:5`, { ...pick, path: other })).toEqual(['[quick-open] ignoring a path pick that no query returned']);
    expect(await show(`${file}:3:5`, { ...pick, authority: 'loopback' })).toEqual(['[quick-open] ignoring a path pick that no query returned']);
  });

  it('brings the row of a typed path whose lookup returned after the text search answered, and opens a pick of it', async () => {
    const worker = new ScriptedWorker();
    const gates: Array<() => void> = [];
    const quickOpen = indexResolving(worker, (real, target) => new Promise((resolve) => gates.push(() => resolve(real(target)))));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let open = false;
    const responses: unknown[] = [];
    const pick: QuickOpenPick = { kind: 'path', authority: 'local', path: file, line: 3, mention: false };
    const picker = new QuickOpenPicker(
      { handleWhileOpen: fakeHandleWhileOpen(handlers), isOpen: () => open, request: async () => {
        open = true;
        const asked = openValue(handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!({ query: `${file}:3`, generation: 1 }));
        await answerText(worker, `${file}:3`);
        responses.push(await asked);
        const late = openValue(handlers.get(OVERLAY_CHANNELS.quickOpenPath)!({ generation: 1 }));
        responses.push(await openValue(handlers.get(OVERLAY_CHANNELS.quickOpenPath)!({ generation: 0 })));
        await expect(handlers.get(OVERLAY_CHANNELS.quickOpenPath)!({ generation: -1 })).rejects.toThrow('Malformed Quick Open generation');
        gates[0]!();
        responses.push(await late);
        open = false;
        return { kind: 'quickOpen', pick };
      } },
      quickOpen,
      () => ({ currentProjectKey: alpha.key, recent: [] }),
      { capture: () => CONTEXT, list: () => [] },
      () => undefined,
    );
    expect(await picker.show(undefined, 'files')).toEqual({ kind: 'pick', pick });
    expect(responses).toEqual([
      { generation: 1, currentProjectKey: alpha.key, line: 3, mention: false, results: [], pathPending: true },
      null,
      { generation: 1, currentProjectKey: alpha.key, line: 3, mention: false, results: [pathRow(file)] },
    ]);
    quickOpen.dispose();
  });

  describe('a typed folder\'s listing', () => {
    const labels = (answer: QuickOpenAnswer | undefined): string[] => (answer?.results ?? []).map((row) => row.label);
    const context = () => ({ currentProjectKey: alpha.key, recent: [] });
    // an index whose listOutside the test gates, counting the requests that reached it
    const gatedListing = (worker: QuickOpenWorker): { readonly quickOpen: QuickOpenIndex; readonly asked: string[]; readonly release: () => void } => {
      const asked: string[] = [];
      let open: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const quickOpen = indexWith(worker, (real) => ({
        listOutside: async (folder, prefix) => {
          asked.push(prefix);
          await gate;
          return real.listOutside(folder, prefix);
        },
      }));
      return { quickOpen, asked, release: () => open!() };
    };

    beforeEach(() => {
      fs.mkdirSync(path.join(elsewhere, 'Sub'));
      fs.writeFileSync(path.join(elsewhere, 'a.txt'), '');
    });

    it('answers ahead of the text search: .. then folders then files, the typed file first and listed once', async () => {
      const quickOpen = index(() => new ScriptedWorker());
      const search = quickOpen.open();
      expect(labels(await quickOpen.query(`${elsewhere}${path.sep}`, context(), { id: search, generation: 0 }))).toEqual(['..', 'Sub', 'a.txt', 'notes.txt']);
      const exact = await quickOpen.query(`${path.join(elsewhere, 'a.txt')}:2`, context(), { id: search, generation: 1 });
      expect(exact).toEqual({ currentProjectKey: alpha.key, line: 2, mention: false, results: [pathRow(path.join(elsewhere, 'a.txt'))] });
      quickOpen.dispose();
    });

    it('lists a project\'s file as its project row', async () => {
      touch(alpha, 'src/app.ts');
      const quickOpen = index(() => new ScriptedWorker());
      const answer = await quickOpen.query(path.join(alpha.fsPath, 'src', 'a'), context(), { id: quickOpen.open(), generation: 0 });
      expect(answer?.results).toEqual([expect.objectContaining({ kind: 'project', projectKey: alpha.key, relativePath: 'src/app.ts', complete: { input: path.join(alpha.fsPath, 'src', 'app.ts') } })]);
      quickOpen.dispose();
    });

    it('says a folder has no match or cannot be read, and leaves a missing folder to the text search', async () => {
      const worker = new ScriptedWorker();
      const quickOpen = index(() => worker);
      const search = quickOpen.open();
      expect(await quickOpen.query(path.join(elsewhere, 'zzz'), context(), { id: search, generation: 0 })).toEqual({ currentProjectKey: alpha.key, mention: false, results: [], emptyText: 'folderNoMatch', emptyName: 'zzz' });
      const missing = path.join(root, 'gone', 'x');
      const asked = quickOpen.query(missing, context(), { id: search, generation: 1 });
      const text = { projectKey: alpha.key, relativePath: 'x.ts', labelMatches: [], descriptionMatches: [], recent: false };
      await answerText(worker, missing, [text]);
      expect(await asked).toMatchObject({ results: [expect.objectContaining({ kind: 'project', relativePath: 'x.ts' })] });
      expect(await quickOpen.typedPathAnswer(search, 1)).toBeUndefined();
      quickOpen.dispose();
      const denied = indexWith(new ScriptedWorker(), () => ({ listOutside: async () => ({ kind: 'denied' }) }));
      expect(await denied.query(`${elsewhere}${path.sep}`, context(), { id: denied.open(), generation: 0 })).toEqual({ currentProjectKey: alpha.key, mention: false, results: [], emptyText: 'folderDenied' });
      denied.dispose();
    });

    it('answers the text search while the listing runs, marked pending, then brings the listing in its place', async () => {
      const worker = new ScriptedWorker();
      const { quickOpen, release } = gatedListing(worker);
      const search = quickOpen.open();
      const raw = `${elsewhere}${path.sep}`;
      const asked = quickOpen.query(raw, context(), { id: search, generation: 0 });
      await answerText(worker, raw);
      expect(await asked).toEqual({ currentProjectKey: alpha.key, mention: false, results: [], pathPending: true });
      const listed = quickOpen.typedPathAnswer(search, 0);
      release();
      expect(labels(await listed)).toEqual(['..', 'Sub', 'a.txt', 'notes.txt']);
      quickOpen.dispose();
    });

    it('holds one lookup per request while a listing hangs, and serves a longer name in the same folder from its last whole listing', async () => {
      const worker = new ScriptedWorker();
      const { quickOpen, asked, release } = gatedListing(worker);
      const search = quickOpen.open();
      const first = quickOpen.query(`${elsewhere}${path.sep}`, context(), { id: search, generation: 0 });
      await turnsUntil(() => asked.length === 1);
      void quickOpen.query(`${elsewhere}${path.sep}n`, context(), { id: search, generation: 1 });
      const newest = quickOpen.query(`${elsewhere}${path.sep}no`, context(), { id: search, generation: 2 });
      expect(await settled(newest)).toBe(false);
      expect(asked).toEqual(['']);
      release();
      expect(await settled(first)).toBe(false);
      expect(labels(await newest)).toEqual(['notes.txt']);
      expect(labels(await quickOpen.query(`${elsewhere}${path.sep}N`, context(), { id: search, generation: 3 }))).toEqual(['notes.txt']);
      // the whole listing of '' served 'no' and 'N'; another folder asks again, and so does the next request
      expect(asked).toEqual(['']);
      await quickOpen.query(`${path.join(elsewhere, 'Sub')}${path.sep}`, context(), { id: search, generation: 4 });
      await quickOpen.query(`${elsewhere}${path.sep}no`, context(), { id: quickOpen.open(), generation: 0 });
      expect(asked).toEqual(['', '', 'no']);
      quickOpen.dispose();
    });

    it('says an unreadable folder cannot be read when a name follows it too, logging the file lookup\'s refusal once', async () => {
      const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      const quickOpen = indexWith(new ScriptedWorker(), () => ({ resolveOutside: () => Promise.reject(denied), listOutside: async () => ({ kind: 'denied' }) }));
      const search = quickOpen.open();
      for (const [generation, name] of ['x', 'xy'].entries()) {
        expect(await quickOpen.query(path.join(elsewhere, name), context(), { id: search, generation })).toEqual({ currentProjectKey: alpha.key, mention: false, results: [], emptyText: 'folderDenied' });
      }
      expect(logged).toEqual([`[quick-open] a typed path under ${path.parse(file).root} on local could not be read (EACCES); later ones there are not logged`]);
      quickOpen.dispose();
    });

    it('gives the file row alone, logging nothing, from a daemon that cannot list', async () => {
      const quickOpen = indexWith(new ScriptedWorker(), () => ({ listOutside: () => Promise.reject(new ListingUnsupportedError('local')) }));
      const answer = await quickOpen.query(file, context(), { id: quickOpen.open(), generation: 0 });
      expect(answer?.results).toEqual([expect.objectContaining({ kind: 'path', path: file })]);
      expect(logged).toEqual([]);
      quickOpen.dispose();
    });

    it('keys each row once and accepts a pick of a listed file by that key, never one of a folder row', async () => {
      const show = async (pick: QuickOpenPick): Promise<{ readonly outcome: unknown; readonly keys: string[]; readonly logs: string[] }> => {
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        let open = false;
        const logs: string[] = [];
        let keys: string[] = [];
        const picker = new QuickOpenPicker(
          { handleWhileOpen: fakeHandleWhileOpen(handlers), isOpen: () => open, request: async () => {
            open = true;
            const response = (await openValue(handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!({ query: `${elsewhere}${path.sep}`, generation: 1 }))) as QuickOpenResponse;
            keys = response.results.map(quickOpenRowKey);
            open = false;
            return { kind: 'quickOpen', pick };
          } },
          index(() => new ScriptedWorker()),
          context,
          { capture: () => CONTEXT, list: () => [] },
          (line) => logs.push(line),
        );
        return { outcome: await picker.show(undefined, 'files'), keys, logs };
      };
      const listed: QuickOpenPick = { kind: 'path', authority: 'local', path: path.join(elsewhere, 'a.txt'), mention: false };
      const first = await show(listed);
      expect(first.outcome).toEqual({ kind: 'pick', pick: listed });
      expect(new Set(first.keys).size).toBe(first.keys.length);
      expect(first.keys).toContain(quickOpenRowKey(listed));
      // a folder row's key is in the answer, yet nothing a pick names can be one
      const folder = { kind: 'folder', authority: 'local', input: `${elsewhere}${path.sep}Sub${path.sep}` } as unknown as QuickOpenPick;
      expect(first.keys).toContain(quickOpenRowKey(folder));
      const refused = await show(folder);
      expect(refused.outcome).toBeUndefined();
      expect(refused.logs).toEqual(['[quick-open] ignoring a folder pick that no query returned']);
    });
  });
});

describe('Quick Open positions', () => {
  it('reads no line or column past what main accepts in a pick, which it would otherwise refuse', () => {
    expect(fuzzy.MAX_POSITION).toBeLessThanOrEqual(MAX_EDITOR_LINE);
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
      { handleWhileOpen: fakeHandleWhileOpen(state.handlers), isOpen: () => state.open, request: (request) => state.request(request) },
      index(),
      () => ({ currentProjectKey: alpha.key, recent: [] }),
      { capture: () => CONTEXT, list: () => [] },
      () => undefined,
    );
  }

  it('accepts only a pick a query returned', async () => {
    touch(alpha, 'a.ts');
    expect(await picker(overlay({ kind: 'quickOpen', pick: { kind: 'project', projectKey: alpha.key, relativePath: 'a.ts', mention: false } })).show(undefined, 'files')).toEqual({ kind: 'pick', pick: { kind: 'project', projectKey: alpha.key, relativePath: 'a.ts', mention: false } });
    expect(await picker(overlay({ kind: 'quickOpen', pick: { kind: 'project', projectKey: alpha.key, relativePath: 'never-listed.ts', mention: false } })).show(undefined, 'files')).toBeUndefined();
    expect(await picker(overlay({ kind: 'quickOpen', pick: null })).show(undefined, 'files')).toBeUndefined();
  });

  it('answers a command with the focus context captured before the overlay showed, and lists commands only while it is open', async () => {
    const state = overlay({ kind: 'quickOpen', command: 'damocles.editor.save' });
    const listed: MenuState[] = [];
    let context: MenuState = CONTEXT;
    const quickOpen = new QuickOpenPicker(
      { handleWhileOpen: fakeHandleWhileOpen(state.handlers), isOpen: () => state.open, request: async (request) => {
        context = { ...CONTEXT, focus: undefined };
        state.open = true;
        listed.push(...(await openValue(state.handlers.get(OVERLAY_CHANNELS.commandsList)!({})) as MenuState[]));
        await expect(Promise.resolve(state.handlers.get(OVERLAY_CHANNELS.commandsList)!({ extra: 1 }))).rejects.toThrow('Malformed');
        state.open = false;
        expect(request).toEqual({ kind: 'quickOpen', mode: 'commands' });
        return { kind: 'quickOpen', command: 'damocles.editor.save' };
      } },
      index(),
      () => ({ currentProjectKey: alpha.key, recent: [] }),
      { capture: () => context, list: (captured) => [captured as never] },
      () => undefined,
    );
    await expect(Promise.resolve(state.handlers.get(OVERLAY_CHANNELS.commandsList)!({}))).resolves.toEqual({ ok: false, reason: 'closed' });
    expect(await quickOpen.show(undefined, 'commands')).toEqual({ kind: 'command', id: 'damocles.editor.save', context: CONTEXT });
    expect(listed).toEqual([CONTEXT]);
    // The overlay still reports quickOpen open, but the request's captured context is gone once it answered.
    state.open = true;
    await expect(Promise.resolve(state.handlers.get(OVERLAY_CHANNELS.commandsList)!({}))).resolves.toEqual({ ok: false, reason: 'closed' });
  });

  it('lists no commands for a request that answered between its host\'s open check and the handler', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let open = false;
    let late: Promise<unknown> | undefined;
    const lists: unknown[] = [];
    // Runs the handler a turn after the open check, which OverlayHost happens not to do.
    const checkThenRun = <T>(channel: string, isOpen: () => boolean, handler: (...args: unknown[]) => T | Promise<T>): void => {
      handlers.set(channel, async (...args: unknown[]) => {
        if (!isOpen()) return { ok: false, reason: 'closed' };
        await new Promise((resolve) => setImmediate(resolve));
        return { ok: true, value: await handler(...args) };
      });
    };
    const quickOpen = new QuickOpenPicker(
      { handleWhileOpen: checkThenRun, isOpen: () => open, request: async () => {
        open = true;
        late = Promise.resolve(handlers.get(OVERLAY_CHANNELS.commandsList)!({}));
        return { kind: 'quickOpen', pick: null };
      } },
      index(),
      () => ({ currentProjectKey: alpha.key, recent: [] }),
      { capture: () => CONTEXT, list: (captured) => {
        lists.push(captured);
        return [];
      } },
      () => undefined,
    );
    expect(await quickOpen.show(undefined, 'commands')).toBeUndefined();
    await expect(late).rejects.toThrow('no captured focus context');
    expect(lists).toEqual([]);
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
      { handleWhileOpen: fakeHandleWhileOpen(handlers), isOpen: () => open, request: async (request) => {
        expect(request).toEqual({ kind: 'quickOpen', mode: 'files', scope });
        open = true;
        queried.push(await openValue(handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!({ query: '', generation: 1 })));
        queried.push(await openValue(handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!({ query: 'users', generation: 2 })));
        open = false;
        return { kind: 'quickOpen', pick: { kind: 'project', projectKey: beta.key, relativePath: 'src/routes/users.ts', mention: false } };
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
    expect(all?.results.map((result) => projectRow(result).projectName).sort()).toEqual(['alpha', 'beta']);
  });

  it('answers queries only while Quick Open is open, within bounds, and closed as a value otherwise', async () => {
    const state = overlay({ kind: 'dismissed' });
    picker(state);
    const query = state.handlers.get(OVERLAY_CHANNELS.quickOpenQuery)!;
    await expect(Promise.resolve(query({ query: 'a', generation: 1 }))).resolves.toEqual({ ok: false, reason: 'closed' });
    state.open = true;
    await expect(Promise.resolve(query({ query: 'x'.repeat(513), generation: 1 }))).rejects.toThrow('Malformed Quick Open query');
    await expect(Promise.resolve(query({ query: 'a', generation: -1 }))).rejects.toThrow('Malformed Quick Open generation');
    await expect(Promise.resolve(query({ query: 'a', generation: 7 }))).resolves.toMatchObject({ ok: true, value: { generation: 7 } });
  });
});
