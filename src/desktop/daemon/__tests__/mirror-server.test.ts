import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { piSessionDir } from '../../../core/pi-session/session-store/session-dir';
import type { MirrorFile } from '../control-messages';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { createMirrorWatches, HASH_SPAN_BYTES, MAX_MIRROR_WATCHES, syncMirror, syncSubcalls, type MirrorStream } from '../mirror-server';

let agentDir: string;
let project: string;
let sessions: string;
let streams: Map<number, { bytes: Buffer[]; ended: boolean }>;
let nextId: number;

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function held(file: string, bytes: Buffer): MirrorFile {
  return { file, size: bytes.length, headHash: sha(bytes.subarray(0, HASH_SPAN_BYTES)), tailHash: sha(bytes.subarray(Math.max(0, bytes.length - HASH_SPAN_BYTES))) };
}
const heldLedger = (bytes: Buffer) => {
  const { file: _file, ...rest } = held('subcalls.jsonl', bytes);
  return rest;
};

function write(relative: string, text: string, mtimeMs: number): void {
  const file = path.join(sessions, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

const deps = () => ({
  agentDir,
  log: () => undefined,
  reserveStream: () => (nextId += 2),
  drained: () => Promise.resolve(),
  openStream: (id: number): MirrorStream => {
    const record = { bytes: [] as Buffer[], ended: false };
    streams.set(id, record);
    return { id, closed: false, write: (bytes) => { record.bytes.push(Buffer.from(bytes)); return true; }, end: () => { record.ended = true; }, onDrain: () => undefined };
  },
});

// the streams open after the answer, from an immediate
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  for (let tries = 0; tries < 100 && [...streams.values()].some((stream) => !stream.ended); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
}

let ledgerPath: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-agent-'));
  ledgerPath = path.join(agentDir, 'usage', 'subcalls.jsonl');
  project = path.join(os.tmpdir(), 'srv', 'app');
  sessions = piSessionDir(project, agentDir);
  streams = new Map();
  nextId = 15;
});

describe('mirror.sync on the daemon', () => {
  it('sends a file the client lacks whole, and only the appended bytes of one whose head and tail match', async () => {
    write('a.jsonl', 'line one\nline two\n', 2000);
    write('a/subagents/agent-1.jsonl', 'agent\n', 1000);
    const before = Buffer.from('line one\n');
    const { changes } = await syncMirror(deps(), { projectKey: project, budgetBytes: 1 << 20, files: [held('a.jsonl', before)] });
    await settled();
    expect(changes).toEqual([
      { file: 'a.jsonl', kind: 'append', offset: before.length, length: 9, stream: 17 },
      { file: 'a/subagents/agent-1.jsonl', kind: 'full', offset: 0, length: 6, stream: 19 },
    ]);
    expect(Buffer.concat(streams.get(17)!.bytes).toString()).toBe('line two\n');
    expect(Buffer.concat(streams.get(19)!.bytes).toString()).toBe('agent\n');
  });

  it('resyncs the whole file when its head changed, as after pi rewrites it', async () => {
    write('a.jsonl', 'REWRITTEN\nline two\n', 2000);
    const { changes } = await syncMirror(deps(), { projectKey: project, budgetBytes: 1 << 20, files: [held('a.jsonl', Buffer.from('line one\n'))] });
    await settled();
    expect(changes).toEqual([{ file: 'a.jsonl', kind: 'full', offset: 0, length: 19, stream: 17 }]);
  });

  it('sends nothing for a file the client holds whole', async () => {
    write('a.jsonl', 'same\n', 2000);
    expect(await syncMirror(deps(), { projectKey: project, budgetBytes: 1 << 20, files: [held('a.jsonl', Buffer.from('same\n'))] })).toEqual({ changes: [] });
  });

  it('stops sending once the connection closes under a writer waiting for its drain', async () => {
    write('big.jsonl', 'x'.repeat(3 * 256 * 1024), 2000);
    let drain: (() => void) | undefined;
    let ended = false;
    const stream = { id: 17, closed: false, write: () => false, end: () => { ended = true; }, onDrain: (listener: () => void) => { drain = listener; } };
    await syncMirror({ ...deps(), openStream: () => stream }, { projectKey: project, budgetBytes: 1 << 20, files: [] });
    await vi.waitFor(() => expect(drain).toBeDefined());
    // what the mux does as it is disposed
    stream.closed = true;
    drain!();
    await vi.waitFor(() => expect(ended).toBe(true));
  });

  it('deletes what the client holds outside the newest files that fit the budget, and names no path of its own', async () => {
    write('new.jsonl', 'n'.repeat(100), 3000);
    write('old.jsonl', 'o'.repeat(100), 1000);
    const { changes } = await syncMirror(deps(), {
      projectKey: project,
      budgetBytes: 150,
      files: [held('old.jsonl', Buffer.from('o'.repeat(100))), held('gone.jsonl', Buffer.from('x')), held('../../etc/passwd', Buffer.from('x'))],
    });
    await settled();
    expect(changes).toEqual([
      { file: 'new.jsonl', kind: 'full', offset: 0, length: 100, stream: 17 },
      { file: 'old.jsonl', kind: 'deleted', offset: 0, length: 0, stream: 0 },
      { file: 'gone.jsonl', kind: 'deleted', offset: 0, length: 0, stream: 0 },
      { file: '../../etc/passwd', kind: 'deleted', offset: 0, length: 0, stream: 0 },
    ]);
  });
});

describe('mirror.syncSubcalls on the daemon', () => {
  const writeLedger = (text: string): void => {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, text);
  };
  const ledgerDeps = () => ({ ...deps(), ledgerPath });

  it('sends the ledger whole to a client that holds none, then only the bytes appended after what it holds', async () => {
    writeLedger('one\n');
    expect(await syncSubcalls(ledgerDeps(), { budgetBytes: 1 << 20 })).toEqual({ change: { kind: 'full', offset: 0, length: 4, stream: 17 } });
    await settled();
    expect(Buffer.concat(streams.get(17)!.bytes).toString()).toBe('one\n');
    fs.appendFileSync(ledgerPath, 'two\n');
    expect(await syncSubcalls(ledgerDeps(), { budgetBytes: 1 << 20, held: heldLedger(Buffer.from('one\n')) })).toEqual({ change: { kind: 'append', offset: 4, length: 4, stream: 19 } });
    await settled();
    expect(Buffer.concat(streams.get(19)!.bytes).toString()).toBe('two\n');
    expect(await syncSubcalls(ledgerDeps(), { budgetBytes: 1 << 20, held: heldLedger(Buffer.from('one\ntwo\n')) })).toEqual({});
  });

  it('sends the whole ledger again once it was truncated or rewritten', async () => {
    writeLedger('new\n');
    expect(await syncSubcalls(ledgerDeps(), { budgetBytes: 1 << 20, held: heldLedger(Buffer.from('old line\n')) })).toEqual({ change: { kind: 'full', offset: 0, length: 4, stream: 17 } });
    writeLedger('NEW line\nmore\n');
    expect(await syncSubcalls(ledgerDeps(), { budgetBytes: 1 << 20, held: heldLedger(Buffer.from('old line\n')) })).toEqual({ change: { kind: 'full', offset: 0, length: 14, stream: 19 } });
    await settled();
    expect(Buffer.concat(streams.get(19)!.bytes).toString()).toBe('NEW line\nmore\n');
  });

  it('answers deleted for a held ledger that is gone, is no regular file or no longer fits the budget, and nothing when none is held', async () => {
    const someHeld = heldLedger(Buffer.from('x\n'));
    expect(await syncSubcalls(ledgerDeps(), { budgetBytes: 1 << 20, held: someHeld })).toEqual({ change: { kind: 'deleted', offset: 0, length: 0, stream: 0 } });
    expect(await syncSubcalls(ledgerDeps(), { budgetBytes: 1 << 20 })).toEqual({});
    fs.mkdirSync(ledgerPath, { recursive: true });
    expect(await syncSubcalls(ledgerDeps(), { budgetBytes: 1 << 20, held: someHeld })).toEqual({ change: { kind: 'deleted', offset: 0, length: 0, stream: 0 } });
    fs.rmSync(ledgerPath, { recursive: true });
    writeLedger('y'.repeat(100));
    expect(await syncSubcalls(ledgerDeps(), { budgetBytes: 99, held: someHeld })).toEqual({ change: { kind: 'deleted', offset: 0, length: 0, stream: 0 } });
    expect(await syncSubcalls(ledgerDeps(), { budgetBytes: 99 })).toEqual({});
    expect(streams.size).toBe(0);
  });
});

// A watcher factory whose watches settle only when the test says so, and fire only when it says so.
function controlledWatchers() {
  type Kind = 'create' | 'change' | 'delete';
  const made: Array<{ base: string; glob: string; disposed: boolean; settle: () => void; fail: (err: Error) => void; fire: (kind: Kind) => void }> = [];
  let onWatch: () => void = () => undefined;
  const factory: FileWatcherFactory = {
    watch: (base, glob) => {
      const listeners: Record<Kind, Array<(fsPath: string) => void>> = { create: [], change: [], delete: [] };
      let settle!: () => void;
      let fail!: (err: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      const entry = { base, glob, disposed: false, settle, fail, fire: (kind: Kind) => { for (const listener of listeners[kind]) listener(path.join(base, 'a.jsonl')); } };
      made.push(entry);
      onWatch();
      const on = (kind: Kind) => (cb: (fsPath: string) => void) => {
        listeners[kind].push(cb);
        return { dispose: () => undefined };
      };
      return { ready, onDidCreate: on('create'), onDidChange: on('change'), onDidDelete: on('delete'), dispose: () => { entry.disposed = true; } };
    },
    watchWorkspace: () => { throw new Error('no workspace watch in this test'); },
    onDidRenameFiles: () => ({ dispose: () => undefined }),
  };
  const nextWatch = (): Promise<void> => new Promise((resolve) => { onWatch = resolve; });
  return { factory, made, nextWatch };
}

describe('mirror watches on the daemon', () => {
  it('settles a follow once the project\'s session folder is watched, announces one change per sync, and stops at release', async () => {
    const { factory, made, nextWatch } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, watchers: factory });
    const changed = vi.fn();
    const watched = nextWatch();
    let followed = false;
    const first = watches.follow('connection-1', project, changed).then(() => { followed = true; });
    await watched;
    expect(made).toEqual([expect.objectContaining({ base: sessions, glob: '**' })]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(followed).toBe(false);
    made[0]!.settle();
    await first;
    made[0]!.fire('change');
    made[0]!.fire('create');
    expect(changed).toHaveBeenCalledTimes(1);
    // the next sync of the project keeps its watch and hears the next change
    await watches.follow('connection-1', project, changed);
    expect(made).toHaveLength(1);
    made[0]!.fire('delete');
    expect(changed).toHaveBeenCalledTimes(2);
    watches.release('connection-1');
    expect(made[0]!.disposed).toBe(true);
  });

  it('watches only the sub-call ledger for its follow, apart from a project whatever its key', async () => {
    const { factory, made, nextWatch } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, watchers: factory });
    const ledger = vi.fn();
    const named = vi.fn();
    let watched = nextWatch();
    const following = watches.followSubcalls('connection-1', ledger);
    await watched;
    expect(made).toEqual([expect.objectContaining({ base: path.dirname(ledgerPath), glob: 'subcalls.jsonl' })]);
    made[0]!.settle();
    await following;
    watched = nextWatch();
    const project = watches.follow('connection-1', 'subcalls', named);
    await watched;
    made[1]!.settle();
    await project;
    made[0]!.fire('change');
    made[0]!.fire('change');
    expect([ledger.mock.calls.length, named.mock.calls.length]).toEqual([1, 0]);
    await watches.followSubcalls('connection-1', ledger);
    expect(made).toHaveLength(2);
    made[0]!.fire('create');
    expect(ledger).toHaveBeenCalledTimes(2);
    watches.release('connection-1');
    expect(made.map((entry) => entry.disposed)).toEqual([true, true]);
  });

  it('disposes a watch whose start failed, and follows the project afresh at the next sync', async () => {
    const { factory, made, nextWatch } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, watchers: factory });
    let watched = nextWatch();
    const failing = watches.follow('connection-1', project, () => undefined);
    await watched;
    made[0]!.fail(new Error('watch failed'));
    await expect(failing).rejects.toThrow('watch failed');
    expect(made[0]!.disposed).toBe(true);
    watched = nextWatch();
    const again = watches.follow('connection-1', project, () => undefined);
    await watched;
    made[1]!.settle();
    await again;
    watches.release('connection-1');
  });

  it(`refuses a connection's follow past ${MAX_MIRROR_WATCHES} watches, the ones it holds still answering`, async () => {
    const { factory, made } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, watchers: factory });
    const following: Array<Promise<void>> = [];
    for (let index = 0; index < MAX_MIRROR_WATCHES; index++) following.push(watches.follow('connection-1', `/srv/project-${index}`, () => undefined));
    await vi.waitFor(() => expect(made).toHaveLength(MAX_MIRROR_WATCHES));
    for (const entry of made) entry.settle();
    await Promise.all(following);
    await expect(watches.follow('connection-1', '/srv/one-more', () => undefined)).rejects.toThrow(`connection-1 already follows ${MAX_MIRROR_WATCHES} session folders`);
    await watches.follow('connection-1', '/srv/project-0', () => undefined);
    watches.release('connection-1');
  });

  it('keeps each connection\'s watch of a project its own', async () => {
    const { factory, made, nextWatch } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, watchers: factory });
    const one = vi.fn();
    const two = vi.fn();
    for (const [id, changed] of [['connection-1', one], ['connection-2', two]] as const) {
      const watched = nextWatch();
      const following = watches.follow(id, project, changed);
      await watched;
      made.at(-1)!.settle();
      await following;
    }
    watches.release('connection-1');
    expect(made.map((entry) => entry.disposed)).toEqual([true, false]);
    made[1]!.fire('change');
    expect([one.mock.calls.length, two.mock.calls.length]).toEqual([0, 1]);
  });
});
