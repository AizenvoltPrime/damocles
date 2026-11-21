import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { piSessionDir } from '../../../core/pi-session/session-store/session-dir';
import { worktreeFolderFor } from '../../../core/worktrees/records';
import type { MirrorFile } from '../control-messages';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { createMirrorWatches, HASH_SPAN_BYTES, MAX_MIRROR_WATCHES, projectSessionFolders, syncMirror, syncProject, syncSubcalls, type MirrorStream } from '../mirror-server';

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
let worktreesRoot: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-agent-'));
  ledgerPath = path.join(agentDir, 'usage', 'subcalls.jsonl');
  worktreesRoot = path.join(agentDir, 'worktrees');
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

// Registry records as core writes them (records.ts validRecord): a chat worktree's folder is worktreeFolderFor's.
const COMMIT = 'a'.repeat(40);
function chatRecord(id: string, projectPath: string, extra: Record<string, unknown> = {}) {
  const worktreeRoot = worktreeFolderFor(worktreesRoot, projectPath, id);
  return { id, kind: 'chat', projectPath, repositoryRoot: projectPath, worktreeRoot, workingFolder: worktreeRoot, branch: `damocles/${id}`, index: 1, baseCommit: COMMIT, createdAt: 1, ...extra };
}
function adoptedRecord(id: string, projectPath: string, worktreeRoot: string) {
  return { id, kind: 'adopted', projectPath, repositoryRoot: projectPath, worktreeRoot, workingFolder: worktreeRoot, createdAt: 1 };
}
function writeRegistry(records: readonly unknown[]): void {
  fs.mkdirSync(worktreesRoot, { recursive: true });
  fs.writeFileSync(path.join(worktreesRoot, 'registry.json'), JSON.stringify({ version: 1, records }));
}
function writeIn(folder: string, relative: string, text: string, mtimeMs: number): void {
  const file = path.join(piSessionDir(folder, agentDir), ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

describe('mirror.syncProject on the daemon', () => {
  const projectDeps = () => ({ ...deps(), worktreesRoot });

  it('lists the project\'s own files and, under worktree.<id>/ and adopted.<id>/, the session folders of the registry records its Chats list reads', async () => {
    const other = path.join(path.dirname(project), 'other');
    const live = chatRecord('live0001', project);
    const deleted = chatRecord('dele0002', project, { deletedAt: 5 });
    const elsewhere = chatRecord('else0003', other);
    const adoptedHere = path.join(agentDir, 'adopted-here');
    fs.mkdirSync(adoptedHere, { recursive: true });
    const adoptedGone = path.join(agentDir, 'adopted-gone');
    writeRegistry([live, deleted, elsewhere, adoptedRecord('adop0004', project, adoptedHere), adoptedRecord('gone0005', project, adoptedGone)]);
    write('a.jsonl', 'own\n', 7000);
    write('a/subagents/agent-1.jsonl', 'agent\n', 6000);
    writeIn(live.workingFolder, 'w.jsonl', 'live\n', 5000);
    writeIn(live.workingFolder, 'w/subagents/agent-2.jsonl', 'nested\n', 4000);
    writeIn(deleted.workingFolder, 'd.jsonl', 'deleted\n', 3000);
    writeIn(adoptedGone, 'g.jsonl', 'gone\n', 2000);
    writeIn(elsewhere.workingFolder, 'e.jsonl', 'elsewhere\n', 1000);
    writeIn(adoptedHere, 'h.jsonl', 'here\n', 1000);
    const { changes } = await syncProject(projectDeps(), { projectKey: project, budgetBytes: 1 << 20, files: [] });
    await settled();
    expect(changes.map((change) => [change.file, change.kind])).toEqual([
      ['a.jsonl', 'full'],
      ['a/subagents/agent-1.jsonl', 'full'],
      ['worktree.live0001/w.jsonl', 'full'],
      ['worktree.live0001/w/subagents/agent-2.jsonl', 'full'],
      ['worktree.dele0002/d.jsonl', 'full'],
      ['adopted.gone0005/g.jsonl', 'full'],
    ]);
    expect(Buffer.concat(streams.get(changes[2]!.stream)!.bytes).toString()).toBe('live\n');
  });

  it('keeps the newest files of every folder within one budget, deletes what it no longer lists, and never lists a worktree name from the project\'s own folder', async () => {
    const live = chatRecord('live0001', project);
    writeRegistry([live]);
    write('old.jsonl', 'o'.repeat(100), 1000);
    write('worktree.fake0009/x.jsonl', 'planted\n', 9000);
    write('adopted.fake0008/y.jsonl', 'planted\n', 9000);
    writeIn(live.workingFolder, 'new.jsonl', 'n'.repeat(100), 3000);
    const { changes } = await syncProject(projectDeps(), {
      projectKey: project,
      budgetBytes: 150,
      files: [held('old.jsonl', Buffer.from('o'.repeat(100))), held('worktree.gone0007/s.jsonl', Buffer.from('x'))],
    });
    await settled();
    expect(changes).toEqual([
      { file: 'worktree.live0001/new.jsonl', kind: 'full', offset: 0, length: 100, stream: 17 },
      { file: 'old.jsonl', kind: 'deleted', offset: 0, length: 0, stream: 0 },
      { file: 'worktree.gone0007/s.jsonl', kind: 'deleted', offset: 0, length: 0, stream: 0 },
    ]);
  });


  it('lists the project\'s own folder alone with no registry, and while the registry does not parse syncs it and drops no worktree chat\'s copy', async () => {
    write('a.jsonl', 'own\n', 1000);
    expect((await syncProject(projectDeps(), { projectKey: project, budgetBytes: 1 << 20, files: [] })).changes.map((change) => change.file)).toEqual(['a.jsonl']);
    fs.mkdirSync(worktreesRoot, { recursive: true });
    fs.writeFileSync(path.join(worktreesRoot, 'registry.json'), '{ "records": [');
    write('b.jsonl', 'later\n', 2000);
    const { changes } = await syncProject(projectDeps(), {
      projectKey: project,
      budgetBytes: 1 << 20,
      files: [held('a.jsonl', Buffer.from('own\n')), held('gone.jsonl', Buffer.from('x')), held('worktree.live0001/w.jsonl', Buffer.from('live\n')), held('adopted.adop0004/s/subagents/a.jsonl', Buffer.from('agent\n'))],
    });
    await settled();
    expect(changes.map((change) => [change.file, change.kind])).toEqual([['b.jsonl', 'full'], ['gone.jsonl', 'deleted']]);
    expect(Buffer.concat(streams.get(changes[0]!.stream)!.bytes).toString()).toBe('later\n');
  });

  it('syncs a project whatever another project\'s adopted worktree folder answers, and checks only its own', async () => {
    const other = path.join(path.dirname(project), 'other');
    const aFile = path.join(agentDir, 'a-file');
    fs.writeFileSync(aFile, '');
    const refused = path.join(agentDir, 'refused', 'worktree');
    writeRegistry([adoptedRecord('file0006', other, path.join(aFile, 'worktree')), adoptedRecord('deny0007', other, refused)]);
    // as a folder below one the daemon's user may not search answers on POSIX, where a file parent also answers ENOTDIR
    const real = { lstat: fs.promises.lstat.bind(fs.promises), stat: fs.promises.stat.bind(fs.promises) };
    for (const method of ['lstat', 'stat'] as const) {
      vi.spyOn(fs.promises, method).mockImplementation(((target: fs.PathLike, options?: fs.StatOptions) =>
        String(target) === refused ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, ${method} '${refused}'`), { code: 'EACCES' })) : real[method](target, options)) as never);
    }
    try {
      write('a.jsonl', 'own\n', 1000);
      expect((await syncProject(projectDeps(), { projectKey: project, budgetBytes: 1 << 20, files: [] })).changes.map((change) => change.file)).toEqual(['a.jsonl']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // core's live list (WorktreeRegistry.recordsOfProject) follows links and counts any error as a folder that is gone
  it('lists an adopted worktree whose folder is a link to nothing, as core\'s live list does', async () => {
    const target = path.join(agentDir, 'nowhere');
    const link = path.join(agentDir, 'adopted-link');
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    writeRegistry([adoptedRecord('link0008', project, link)]);
    writeIn(link, 'l.jsonl', 'linked\n', 1000);
    expect((await syncProject(projectDeps(), { projectKey: project, budgetBytes: 1 << 20, files: [] })).changes.map((change) => change.file)).toEqual(['adopted.link0008/l.jsonl']);
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
  // a follow's outcome once every watch it makes meanwhile is ready
  const settledFollow = async <T>(following: Promise<T>): Promise<T> => {
    let done = false;
    following.then(() => { done = true; }, () => { done = true; });
    await vi.waitFor(() => {
      for (const entry of made) entry.settle();
      expect(done).toBe(true);
    });
    return following;
  };
  return { factory, made, nextWatch, settledFollow };
}

describe('mirror watches on the daemon', () => {
  it('settles a follow once the project\'s session folder is watched, announces one change per sync, and stops at release', async () => {
    const { factory, made, nextWatch } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, worktreesRoot, watchers: factory }).forConnection('connection-1');
    const changed = vi.fn();
    const watched = nextWatch();
    let followed = false;
    const first = watches.follow(project, changed).then(() => { followed = true; });
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
    await watches.follow(project, changed);
    expect(made).toHaveLength(1);
    made[0]!.fire('delete');
    expect(changed).toHaveBeenCalledTimes(2);
    watches.dispose();
    expect(made[0]!.disposed).toBe(true);
  });

  it('watches only the sub-call ledger for its follow, apart from a project whatever its key', async () => {
    const { factory, made, nextWatch } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, worktreesRoot, watchers: factory }).forConnection('connection-1');
    const ledger = vi.fn();
    const named = vi.fn();
    let watched = nextWatch();
    const following = watches.followSubcalls(ledger);
    await watched;
    expect(made).toEqual([expect.objectContaining({ base: path.dirname(ledgerPath), glob: 'subcalls.jsonl' })]);
    made[0]!.settle();
    await following;
    watched = nextWatch();
    const project = watches.follow('subcalls', named);
    await watched;
    made[1]!.settle();
    await project;
    made[0]!.fire('change');
    made[0]!.fire('change');
    expect([ledger.mock.calls.length, named.mock.calls.length]).toEqual([1, 0]);
    await watches.followSubcalls(ledger);
    expect(made).toHaveLength(2);
    made[0]!.fire('create');
    expect(ledger).toHaveBeenCalledTimes(2);
    watches.dispose();
    expect(made.map((entry) => entry.disposed)).toEqual([true, true]);
  });

  it('disposes a watch whose start failed, and follows the project afresh at the next sync', async () => {
    const { factory, made, nextWatch } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, worktreesRoot, watchers: factory }).forConnection('connection-1');
    let watched = nextWatch();
    const failing = watches.follow(project, () => undefined);
    await watched;
    made[0]!.fail(new Error('watch failed'));
    await expect(failing).rejects.toThrow('watch failed');
    expect(made[0]!.disposed).toBe(true);
    watched = nextWatch();
    const again = watches.follow(project, () => undefined);
    await watched;
    made[1]!.settle();
    await again;
    watches.dispose();
  });

  it(`refuses a connection's follow past ${MAX_MIRROR_WATCHES} watches, the ones it holds still answering`, async () => {
    const { factory, made } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, worktreesRoot, watchers: factory }).forConnection('connection-1');
    const following: Array<Promise<void>> = [];
    for (let index = 0; index < MAX_MIRROR_WATCHES; index++) following.push(watches.follow(`/srv/project-${index}`, () => undefined));
    await vi.waitFor(() => expect(made).toHaveLength(MAX_MIRROR_WATCHES));
    for (const entry of made) entry.settle();
    await Promise.all(following);
    await expect(watches.follow('/srv/one-more', () => undefined)).rejects.toThrow(`connection-1 already follows ${MAX_MIRROR_WATCHES} session folders`);
    await watches.follow('/srv/project-0', () => undefined);
    watches.dispose();
  });

  it('follows the registry before it reads it, then the project\'s own and worktree session folders, each announcing once per sync', async () => {
    const live = chatRecord('live0001', project);
    writeRegistry([live, chatRecord('else0003', path.join(path.dirname(project), 'other'))]);
    const { factory, made } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, worktreesRoot, watchers: factory }).forConnection('connection-1');
    const changed = vi.fn();
    let followed = false;
    const first = watches.followProject(project, changed).then(() => { followed = true; });
    await vi.waitFor(() => expect(made).toHaveLength(1));
    expect(made[0]).toEqual(expect.objectContaining({ base: worktreesRoot, glob: 'registry.json' }));
    // the folders come from the registry read once its watch is ready
    await new Promise((resolve) => setImmediate(resolve));
    expect(made).toHaveLength(1);
    made[0]!.settle();
    await vi.waitFor(() => expect(made).toHaveLength(3));
    expect(made.slice(1).map((entry) => [entry.base, entry.glob])).toEqual([[sessions, '**'], [piSessionDir(live.workingFolder, agentDir), '**']]);
    expect(followed).toBe(false);
    for (const entry of made.slice(1)) entry.settle();
    await first;
    made[0]!.fire('change');
    made[0]!.fire('change');
    made[2]!.fire('create');
    expect(changed).toHaveBeenCalledTimes(2);
    // a record added since: the next sync's follow keeps the watches it has and adds the new folder's
    const added = chatRecord('adde0006', project);
    writeRegistry([live, added]);
    const again = watches.followProject(project, changed);
    await vi.waitFor(() => expect(made).toHaveLength(4));
    expect(made[3]!.base).toBe(piSessionDir(added.workingFolder, agentDir));
    made[3]!.settle();
    await again;
    made[0]!.fire('change');
    expect(changed).toHaveBeenCalledTimes(3);
    watches.dispose();
    expect(made.every((entry) => entry.disposed)).toBe(true);
  });

  it('still follows the session folders when the registry\'s watch fails, and answers the failure so it is logged', async () => {
    const live = chatRecord('live0001', project);
    writeRegistry([live]);
    const { factory, made } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, worktreesRoot, watchers: factory }).forConnection('connection-1');
    const following = watches.followProject(project, () => undefined);
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0]!.fail(new Error('no registry watch'));
    await vi.waitFor(() => expect(made).toHaveLength(3));
    for (const entry of made.slice(1)) entry.settle();
    const { folders, failed } = await following;
    expect((failed as Error).message).toBe('no registry watch');
    expect(folders).toEqual({ own: sessions, worktrees: [{ id: 'live0001', kind: 'chat', folder: piSessionDir(live.workingFolder, agentDir) }], unreadable: false });
    expect(made.map((entry) => entry.disposed)).toEqual([true, false, false]);
    watches.dispose();
  });

  it('keeps each connection\'s watch of a project its own', async () => {
    const { factory, made, nextWatch } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, worktreesRoot, watchers: factory });
    const one = vi.fn();
    const two = vi.fn();
    const connections = [watches.forConnection('connection-1'), watches.forConnection('connection-2')] as const;
    for (const [connection, changed] of [[connections[0], one], [connections[1], two]] as const) {
      const watched = nextWatch();
      const following = connection.follow(project, changed);
      await watched;
      made.at(-1)!.settle();
      await following;
    }
    connections[0].dispose();
    expect(made.map((entry) => entry.disposed)).toEqual([true, false]);
    made[1]!.fire('change');
    expect([one.mock.calls.length, two.mock.calls.length]).toEqual([0, 1]);
  });

  it('watches nothing for a connection that closed while its project follow read the registry, and refuses every later follow', async () => {
    writeRegistry([chatRecord('live0001', project)]);
    const { factory, made, settledFollow } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, worktreesRoot, watchers: factory }).forConnection('connection-1');
    const following = watches.followProject(project, () => undefined);
    await vi.waitFor(() => expect(made).toHaveLength(1));
    // the registry's watch is ready, and the connection closes before the folders are read and followed
    made[0]!.settle();
    watches.dispose();
    await settledFollow(following).catch(() => undefined);
    expect(made.filter((entry) => !entry.disposed)).toEqual([]);
    expect(watches.released).toBe(true);
    await expect(watches.follow(project, () => undefined)).rejects.toThrow('connection-1 is closed');
    await expect(watches.followSubcalls(() => undefined)).rejects.toThrow('connection-1 is closed');
    expect(made).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')('reads no registry.json that links off its folder\'s share, and lists the project\'s own folder alone (win32)', async (ctx) => {
    // a registry listing a chat worktree of the project, reached only through this computer's admin share
    const remote = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mirror-share-')));
    try {
      fs.writeFileSync(path.join(remote, 'registry.json'), JSON.stringify({ version: 1, records: [chatRecord('live0001', project)] }));
      fs.mkdirSync(worktreesRoot, { recursive: true });
      try {
        fs.readdirSync(`\\\\localhost\\${remote[0]}$${remote.slice(2)}`);
        fs.symlinkSync(`\\\\localhost\\${remote[0]}$${remote.slice(2)}\\registry.json`, path.join(worktreesRoot, 'registry.json'), 'file');
      } catch {
        ctx.skip('this user cannot reach \\\\localhost\\C$ or make a file symlink');
      }
      expect(await projectSessionFolders(agentDir, worktreesRoot, project)).toEqual({ own: sessions, worktrees: [], unreadable: true });
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });

  it('follows the project\'s own folder while the registry does not parse, the registry\'s watch announcing the fix', async () => {
    fs.mkdirSync(worktreesRoot, { recursive: true });
    fs.writeFileSync(path.join(worktreesRoot, 'registry.json'), '{ "records": [');
    const { factory, made, settledFollow } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, worktreesRoot, watchers: factory }).forConnection('connection-1');
    const changed = vi.fn();
    const { folders, failed } = await settledFollow(watches.followProject(project, changed));
    expect(failed).toBeUndefined();
    expect(folders).toEqual({ own: sessions, worktrees: [], unreadable: true });
    expect(made.map((entry) => [entry.base, entry.glob])).toEqual([[worktreesRoot, 'registry.json'], [sessions, '**']]);
    made[0]!.fire('change');
    expect(changed).toHaveBeenCalledTimes(1);
    watches.dispose();
  });

  it('lets go of a worktree folder\'s watch once no project of the connection lists it, and keeps one another project lists', async () => {
    const moved = path.join(path.dirname(project), 'moved');
    const live = chatRecord('live0001', project);
    const adoptedGone = adoptedRecord('gone0005', project, path.join(agentDir, 'adopted-gone'));
    writeRegistry([live, adoptedGone]);
    const { factory, made, settledFollow } = controlledWatchers();
    const watches = createMirrorWatches({ agentDir, ledgerPath, worktreesRoot, watchers: factory }).forConnection('connection-1');
    const watchOf = (folder: string) => made.find((entry) => entry.base === piSessionDir(folder, agentDir));
    await settledFollow(watches.followProject(project, () => undefined));
    await settledFollow(watches.followProject(moved, () => undefined));
    expect(made).toHaveLength(5);
    // the project moved: its chat record now names the new folder, and the adopted record was removed
    writeRegistry([{ ...live, projectPath: moved, repositoryRoot: moved, namedFor: project }]);
    await settledFollow(watches.followProject(moved, () => undefined));
    await settledFollow(watches.followProject(project, () => undefined));
    expect(made).toHaveLength(5);
    expect(watchOf(adoptedGone.workingFolder)!.disposed).toBe(true);
    expect(watchOf(live.workingFolder)!.disposed).toBe(false);
    // the moved project lets go of it too, and the slot is free again for a folder listed later
    writeRegistry([]);
    await settledFollow(watches.followProject(moved, () => undefined));
    expect(watchOf(live.workingFolder)!.disposed).toBe(true);
    writeRegistry([live]);
    await settledFollow(watches.followProject(project, () => undefined));
    expect(made.filter((entry) => entry.base === piSessionDir(live.workingFolder, agentDir)).map((entry) => entry.disposed)).toEqual([true, false]);
    watches.dispose();
  });
});
