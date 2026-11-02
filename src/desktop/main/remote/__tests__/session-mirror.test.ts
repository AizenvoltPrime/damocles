import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { piSessionDir } from '../../../../core/pi-session/session-store/session-dir';
import { createMirrorWatches, syncMirror, syncSubcalls, type MirrorStream } from '../../../daemon/mirror-server';
import type { FileWatcherFactory } from '../../../../platform/file-watcher';
import type { RemoteConnection } from '../connection';
import type { MirrorChange, MirrorFile, MirrorHeld, MirrorLedgerChange } from '../../../daemon/control-messages';
import { MIRROR_CLOCK_FILE, MIRROR_SUBCALLS_FILE } from '../../../../shared/remote-mirror';
import { connectionMirrorChannel, followMirrorChanges, frozenMirrorChannel, isMirrorName, MIRROR_CHANGED_FEATURE, MIRROR_QUOTA_BYTES, MIRROR_SUBCALLS_FEATURE, mirrorPath, projectMirrorFolder, SessionMirror, type MirrorChannel } from '../session-mirror';

// The daemon's own syncMirror and syncSubcalls over an in-memory stream hub that delivers like the connection's inbox:
// buffered from the open until claimed, in order, then ended.
function daemon(agentDir: string, ledgerPath = path.join(agentDir, '..', 'usage', 'subcalls.jsonl')) {
  const streams = new Map<number, { chunks: Uint8Array[]; ended: boolean; sink?: (chunk: Uint8Array | null) => void }>();
  let next = 2;
  const slot = (id: number) => {
    let found = streams.get(id);
    if (!found) {
      found = { chunks: [], ended: false };
      streams.set(id, found);
    }
    return found;
  };
  const push = (id: number, chunk: Uint8Array | null): void => {
    const target = slot(id);
    if (target.sink) target.sink(chunk);
    else if (chunk === null) target.ended = true;
    else target.chunks.push(chunk);
  };
  const requests: Array<{ projectKey: string; budgetBytes: number; files: readonly MirrorFile[] }> = [];
  const answers: Array<readonly MirrorChange[]> = [];
  const ledgerRequests: Array<{ budgetBytes: number; held?: MirrorHeld }> = [];
  const ledgerAnswers: Array<MirrorLedgerChange | undefined> = [];
  const streamDeps = {
    reserveStream: () => (next += 2),
    openStream: (id: number): MirrorStream => ({ id, closed: false, write: (bytes) => { push(id, Uint8Array.from(bytes)); return true; }, end: () => push(id, null), onDrain: () => undefined }),
    drained: () => Promise.resolve(),
    log: () => undefined,
  };
  return {
    requests,
    answers,
    ledgerRequests,
    ledgerAnswers,
    syncSubcalls: async (request: { readonly budgetBytes: number; readonly held?: MirrorHeld }) => {
      ledgerRequests.push({ ...request });
      const answer = await syncSubcalls({ ...streamDeps, ledgerPath }, request);
      ledgerAnswers.push(answer.change);
      return answer;
    },
    sync: async (request: { readonly projectKey: string; readonly budgetBytes: number; readonly files: readonly MirrorFile[] }) => {
      requests.push({ ...request });
      const answer = await syncMirror({ agentDir, ...streamDeps }, request);
      answers.push(answer.changes);
      return answer;
    },
    receive: (id: number, maxBytes: number, onChunk: (bytes: Uint8Array) => Promise<void>) => new Promise<number>((resolve, reject) => {
      const target = slot(id);
      let total = 0;
      let writing = Promise.resolve();
      target.sink = (chunk) => {
        if (chunk === null) {
          writing.then(() => resolve(total), reject);
          return;
        }
        total += chunk.length;
        if (total > maxBytes) reject(new Error('too many bytes'));
        writing = writing.then(() => onChunk(chunk));
      };
      for (const chunk of target.chunks.splice(0)) target.sink(chunk);
      if (target.ended) target.sink(null);
    }),
  };
}

let base: string;
let agentDir: string;
let root: string;
const projectKey = '/srv/app';

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-mirror-'));
  agentDir = path.join(base, 'target', 'agent');
  root = path.join(base, 'client', 'remote', 'host1', 'mirror');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const targetFile = (name: string): string => path.join(piSessionDir(projectKey, agentDir), ...name.split('/'));
function writeTarget(name: string, text: string, mtimeSeconds?: number): void {
  const file = targetFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeSeconds !== undefined) fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
}
const mirrored = (name: string): string => path.join(projectMirrorFolder(root, projectKey), ...name.split('/'));

describe('mirror names', () => {
  it('accepts session, agent and team names and refuses unsafe ids and paths out of the root', () => {
    expect(isMirrorName('s1.jsonl')).toBe(true);
    expect(isMirrorName('s1/subagents/a-1.jsonl')).toBe(true);
    for (const name of ['../x.jsonl', 'a/../../x', '.hidden', 'a//b', '', 'a\\b', 'C:x', 'a/b c', 'x.jsonl.mirror-partial', 'a/b/c/d/e/f/g', 'CON', 'nul.jsonl', 's1/com1']) {
      expect(isMirrorName(name)).toBe(false);
    }
    const folder = projectMirrorFolder(root, projectKey);
    expect(mirrorPath(folder, 's1/subagents/a.jsonl')).toBe(path.join(folder, 's1', 'subagents', 'a.jsonl'));
    expect(mirrorPath(folder, '../../escape')).toBeUndefined();
    expect(mirrorPath(folder, '/etc/passwd')).toBeUndefined();
  });
});

describe('SessionMirror', () => {
  it('copies new files whole, then only appended bytes, and propagates deletes', async () => {
    const target = daemon(agentDir);
    const mirror = new SessionMirror({ root, channel: () => ({ sync: target.sync, receive: target.receive }), log: () => undefined });
    writeTarget('s1.jsonl', 'line one\n');
    writeTarget('s1/subagents/a1.jsonl', 'agent\n');
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    expect(fs.readFileSync(mirrored('s1.jsonl'), 'utf8')).toBe('line one\n');
    expect(fs.readFileSync(mirrored('s1/subagents/a1.jsonl'), 'utf8')).toBe('agent\n');
    fs.appendFileSync(targetFile('s1.jsonl'), 'line two\n');
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    expect(target.answers[1]).toEqual([expect.objectContaining({ file: 's1.jsonl', kind: 'append', offset: 9, length: 9 })]);
    expect(fs.readFileSync(mirrored('s1.jsonl'), 'utf8')).toBe('line one\nline two\n');
    fs.rmSync(targetFile('s1/subagents/a1.jsonl'));
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    expect(fs.existsSync(mirrored('s1/subagents/a1.jsonl'))).toBe(false);
    expect(await mirror.sessionFile(projectKey, 's1')).toBe(mirrored('s1.jsonl'));
    expect(await mirror.sessionFile(projectKey, '../s1')).toBeUndefined();
    // pi names a session file <timestamp>_<session id>.jsonl
    writeTarget('2026-01-01T00-00-00-000Z_s2.jsonl', 'second\n');
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    expect(await mirror.sessionFile(projectKey, 's2')).toBe(mirrored('2026-01-01T00-00-00-000Z_s2.jsonl'));
    expect(await mirror.sessionFile('/srv/never-synced', 's2')).toBeUndefined();
  });

  it('resyncs a rewritten file whole', async () => {
    const target = daemon(agentDir);
    const mirror = new SessionMirror({ root, channel: () => ({ sync: target.sync, receive: target.receive }), log: () => undefined });
    writeTarget('s1.jsonl', 'aaaa\nbbbb\n');
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    // pi's _rewriteFile: the head changes and the file grows
    writeTarget('s1.jsonl', 'AAAA\nbbbb\ncccc\n');
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    expect(target.answers[1]).toEqual([expect.objectContaining({ file: 's1.jsonl', kind: 'full', offset: 0 })]);
    expect(fs.readFileSync(mirrored('s1.jsonl'), 'utf8')).toBe('AAAA\nbbbb\ncccc\n');
  });

  it('passes each project the quota the earlier ones left, and never receives a file dropped for it again', async () => {
    const target = daemon(agentDir);
    const mirror = new SessionMirror({ root, channel: () => ({ sync: target.sync, receive: target.receive }), log: () => undefined });
    writeTarget('old.jsonl', 'o'.repeat(600), 1_000_000);
    writeTarget('new.jsonl', 'n'.repeat(600), 2_000_000);
    await mirror.syncProject(projectKey, 1000);
    expect(fs.existsSync(mirrored('new.jsonl'))).toBe(true);
    expect(fs.existsSync(mirrored('old.jsonl'))).toBe(false);
    // the budget shrinks below what the mirror holds: the daemon drops it and the client deletes it
    await mirror.syncProject(projectKey, 100);
    expect(fs.existsSync(mirrored('new.jsonl'))).toBe(false);
    await mirror.syncProject(projectKey, 100);
    expect(target.answers[2]).toEqual([]);
    expect(target.requests.map((request) => request.budgetBytes)).toEqual([1000, 100, 100]);
  });

  it('gives later projects only what the earlier ones left', async () => {
    const target = daemon(agentDir);
    const sync = vi.fn(target.sync);
    const mirror = new SessionMirror({ root, channel: () => ({ sync, receive: target.receive }), log: () => undefined });
    writeTarget('s1.jsonl', 'x'.repeat(1000));
    await mirror.syncAll([projectKey, '/srv/other']);
    expect(sync.mock.calls.map(([request]) => [request.projectKey, request.budgetBytes])).toEqual([[projectKey, MIRROR_QUOTA_BYTES], ['/srv/other', MIRROR_QUOTA_BYTES - 1000]]);
  });

  it('syncs the later projects when one project\'s mirror folder cannot be read, counting nothing for it', async () => {
    const target = daemon(agentDir);
    const sync = vi.fn(target.sync);
    const log = vi.fn();
    const mirror = new SessionMirror({ root, channel: () => ({ sync, receive: target.receive }), log });
    // a file where the project's mirror folder belongs: listing it fails, before the sync and when counting it after
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(projectMirrorFolder(root, '/srv/broken'), 'not a folder');
    writeTarget('s1.jsonl', 'kept\n');
    await mirror.syncAll(['/srv/broken', projectKey]);
    expect(sync.mock.calls.map(([request]) => [request.projectKey, request.budgetBytes])).toEqual([[projectKey, MIRROR_QUOTA_BYTES]]);
    expect(fs.readFileSync(mirrored('s1.jsonl'), 'utf8')).toBe('kept\n');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reading what a project\'s mirror holds failed'));
  });

  it('writes nothing for an unsafe or escaping name a daemon sends, and keeps every write under the root', async () => {
    const log = vi.fn();
    const received: number[] = [];
    const mirror = new SessionMirror({
      root,
      channel: () => ({
        sync: async () => ({ changes: [
          { file: '../../../evil.jsonl', kind: 'full', offset: 0, length: 4, stream: 2 },
          { file: '.ssh/authorized_keys', kind: 'full', offset: 0, length: 4, stream: 4 },
          { file: 'ok.jsonl', kind: 'full', offset: 0, length: 4, stream: 6 },
        ] }),
        receive: async (stream, _max, onChunk) => {
          received.push(stream);
          await onChunk(new TextEncoder().encode('data'));
          return 4;
        },
      }),
      log,
    });
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    expect(received).toEqual([2, 4, 6]);
    expect(fs.readFileSync(mirrored('ok.jsonl'), 'utf8')).toBe('data');
    expect(fs.existsSync(path.join(base, 'client', 'evil.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'evil.jsonl'))).toBe(false);
    expect(fs.readdirSync(projectMirrorFolder(root, projectKey))).toEqual(['ok.jsonl']);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('drops a file when an append does not follow the bytes it holds', async () => {
    const folder = projectMirrorFolder(root, projectKey);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 's1.jsonl'), 'abc');
    const mirror = new SessionMirror({
      root,
      channel: () => ({
        sync: async () => ({ changes: [{ file: 's1.jsonl', kind: 'append', offset: 10, length: 2, stream: 2 }] }),
        receive: async () => 2,
      }),
      log: () => undefined,
    });
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    expect(fs.existsSync(path.join(folder, 's1.jsonl'))).toBe(false);
  });

  // Every stream the daemon opens must be claimed, or its bytes pile up in the connection's inbox until it closes.
  it('drains the stream of a change whose write fails before it reads, and the later changes still land', async () => {
    const folder = projectMirrorFolder(root, projectKey);
    fs.mkdirSync(folder, { recursive: true });
    // a file where the change needs a folder: the mkdir fails before the stream is read
    fs.writeFileSync(path.join(folder, 's1'), 'not a folder');
    const log = vi.fn();
    const received: number[] = [];
    const mirror = new SessionMirror({
      root,
      channel: () => ({
        sync: async () => ({ changes: [
          { file: 's1/subagents/a.jsonl', kind: 'full', offset: 0, length: 4, stream: 2 },
          { file: 'ok.jsonl', kind: 'full', offset: 0, length: 4, stream: 4 },
        ] }),
        receive: async (stream, _max, onChunk) => {
          received.push(stream);
          await onChunk(new TextEncoder().encode('data'));
          return 4;
        },
      }),
      log,
    });
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    expect(received).toEqual([2, 4]);
    expect(fs.readFileSync(mirrored('ok.jsonl'), 'utf8')).toBe('data');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the change to "s1/subagents/a.jsonl" failed'));
  });

  it('claims a stream once when its receive rejects, leaves no partial file and lands the later changes', async () => {
    const received: number[] = [];
    const mirror = new SessionMirror({
      root,
      channel: () => ({
        sync: async () => ({ changes: [
          { file: 'bad.jsonl', kind: 'full', offset: 0, length: 4, stream: 2 },
          { file: 'ok.jsonl', kind: 'full', offset: 0, length: 4, stream: 4 },
        ] }),
        receive: async (stream, _max, onChunk) => {
          received.push(stream);
          if (stream === 2) throw new Error('stream 2 carried more than the 4 bytes it was named for');
          await onChunk(new TextEncoder().encode('data'));
          return 4;
        },
      }),
      log: () => undefined,
    });
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    expect(received).toEqual([2, 4]);
    expect(fs.readdirSync(projectMirrorFolder(root, projectKey))).toEqual(['ok.jsonl']);
  });

  it('receives every stream of a sync over the channel that answered it, though the host moved to another meanwhile', async () => {
    const onFirst: number[] = [];
    const onSecond: number[] = [];
    const channelOf = (received: number[]) => ({
      sync: async () => ({ changes: [
        { file: 'a.jsonl', kind: 'full' as const, offset: 0, length: 1, stream: 2 },
        { file: 'b.jsonl', kind: 'full' as const, offset: 0, length: 1, stream: 4 },
      ] }),
      receive: async (stream: number, _max: number, onChunk: (bytes: Uint8Array) => Promise<void>) => {
        received.push(stream);
        await onChunk(new TextEncoder().encode('x'));
        return 1;
      },
    });
    const channels = [channelOf(onFirst), channelOf(onSecond)];
    const mirror = new SessionMirror({ root, channel: () => channels.shift()!, log: () => undefined });
    await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES);
    expect(onFirst).toEqual([2, 4]);
    expect(onSecond).toEqual([]);
  });

  it('removes a partial file a crash left and counts it nowhere', async () => {
    const folder = projectMirrorFolder(root, projectKey);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 's1.jsonl.mirror-partial'), 'x'.repeat(100));
    const mirror = new SessionMirror({ root, channel: () => ({ sync: async () => ({ changes: [] }), receive: async () => 0 }), log: () => undefined });
    expect(await mirror.syncProject(projectKey, MIRROR_QUOTA_BYTES)).toBe(0);
    expect(fs.readdirSync(folder)).toEqual([]);
  });
});

describe('the sub-call ledger in the session mirror', () => {
  const ledgerPath = (): string => path.join(base, 'target', 'usage', 'subcalls.jsonl');
  const writeLedger = (text: string): void => {
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(ledgerPath(), text);
  };
  const mirroredLedger = (): string => path.join(root, MIRROR_SUBCALLS_FILE);
  const ledgerChannel = (target: ReturnType<typeof daemon>, extra: Partial<MirrorChannel> = {}): MirrorChannel => ({ sync: target.sync, receive: target.receive, syncSubcalls: target.syncSubcalls, ...extra });

  it('copies the target\'s ledger to its fixed place under the root, then only appended bytes, the whole of a truncated one, and deletes it with the target\'s', async () => {
    const target = daemon(agentDir, ledgerPath());
    const mirror = new SessionMirror({ root, channel: () => ledgerChannel(target), log: () => undefined });
    writeLedger('{"a":1}\n');
    expect(await mirror.syncSubcalls(MIRROR_QUOTA_BYTES)).toBe(8);
    expect(fs.readFileSync(mirroredLedger(), 'utf8')).toBe('{"a":1}\n');
    fs.appendFileSync(ledgerPath(), '{"b":2}\n');
    await mirror.syncSubcalls(MIRROR_QUOTA_BYTES);
    expect(target.ledgerAnswers[1]).toEqual(expect.objectContaining({ kind: 'append', offset: 8, length: 8 }));
    expect(fs.readFileSync(mirroredLedger(), 'utf8')).toBe('{"a":1}\n{"b":2}\n');
    writeLedger('{"c":3}\n');
    await mirror.syncSubcalls(MIRROR_QUOTA_BYTES);
    expect(target.ledgerAnswers[2]).toEqual(expect.objectContaining({ kind: 'full', offset: 0, length: 8 }));
    expect(fs.readFileSync(mirroredLedger(), 'utf8')).toBe('{"c":3}\n');
    fs.rmSync(ledgerPath());
    expect(await mirror.syncSubcalls(MIRROR_QUOTA_BYTES)).toBe(0);
    expect(fs.existsSync(mirroredLedger())).toBe(false);
  });

  it('syncs the ledger first with the whole quota and leaves the projects what it holds, and syncs it with no project', async () => {
    const target = daemon(agentDir, ledgerPath());
    const sync = vi.fn(target.sync);
    const mirror = new SessionMirror({ root, channel: () => ledgerChannel(target, { sync }), log: () => undefined });
    writeLedger('x'.repeat(300));
    await mirror.syncAll([projectKey]);
    expect(target.ledgerRequests.map((request) => request.budgetBytes)).toEqual([MIRROR_QUOTA_BYTES]);
    expect(sync.mock.calls.map(([request]) => request.budgetBytes)).toEqual([MIRROR_QUOTA_BYTES - 300]);
    fs.appendFileSync(ledgerPath(), 'y');
    await mirror.syncAll([]);
    expect(fs.statSync(mirroredLedger()).size).toBe(301);
  });

  it('counts the ledger it holds against the quota while the daemon cannot sync it', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, MIRROR_SUBCALLS_FILE), 'z'.repeat(500));
    const target = daemon(agentDir);
    const sync = vi.fn(target.sync);
    const mirror = new SessionMirror({ root, channel: () => ({ sync, receive: target.receive }), log: () => undefined });
    await mirror.syncAll([projectKey]);
    expect(sync.mock.calls.map(([request]) => request.budgetBytes)).toEqual([MIRROR_QUOTA_BYTES - 500]);
    expect(fs.readFileSync(path.join(root, MIRROR_SUBCALLS_FILE), 'utf8')).toBe('z'.repeat(500));
  });

  it('drops the ledger the daemon no longer keeps within the budget, and is not sent it again', async () => {
    const target = daemon(agentDir, ledgerPath());
    const mirror = new SessionMirror({ root, channel: () => ledgerChannel(target), log: () => undefined });
    writeLedger('l'.repeat(200));
    await mirror.syncSubcalls(1000);
    await mirror.syncSubcalls(100);
    expect(fs.existsSync(mirroredLedger())).toBe(false);
    await mirror.syncSubcalls(100);
    expect(target.ledgerAnswers).toEqual([expect.objectContaining({ kind: 'full' }), expect.objectContaining({ kind: 'deleted' }), undefined]);
  });

  it('writes nothing for a change past the budget or not starting at 0, drains its stream, and drops an append that does not follow what it holds', async () => {
    const log = vi.fn();
    const received: number[] = [];
    const changes: MirrorLedgerChange[] = [
      { kind: 'full', offset: 0, length: 101, stream: 2 },
      { kind: 'full', offset: 5, length: 4, stream: 4 },
      { kind: 'append', offset: 0, length: 4, stream: 6 },
    ];
    const mirror = new SessionMirror({
      root,
      channel: () => ({
        sync: async () => ({ changes: [] }),
        syncSubcalls: async () => ({ change: changes.shift()! }),
        receive: async (stream, _max, onChunk) => {
          received.push(stream);
          await onChunk(new TextEncoder().encode('data'));
          return 4;
        },
      }),
      log,
    });
    await mirror.syncSubcalls(100);
    await mirror.syncSubcalls(100);
    expect(fs.existsSync(root)).toBe(false);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(mirroredLedger(), 'held');
    await mirror.syncSubcalls(100);
    expect(received).toEqual([2, 4, 6]);
    expect(fs.existsSync(mirroredLedger())).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(log.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining('refused a full of 101 bytes at 0'),
      expect.stringContaining('refused a full of 4 bytes at 5'),
      expect.stringContaining('does not follow the 4 bytes held'),
    ]);
  });

  it('records the clock skew of the channel it syncs over, rounded, before the ledger, and none for a daemon of another protocol', async () => {
    const target = daemon(agentDir, ledgerPath());
    let skewMs: number | undefined = 600_000.4;
    const mirror = new SessionMirror({ root, channel: () => ({ ...ledgerChannel(target), ...(skewMs !== undefined ? { skewMs } : {}) }), log: () => undefined });
    await mirror.syncAll([]);
    expect(JSON.parse(fs.readFileSync(path.join(root, MIRROR_CLOCK_FILE), 'utf8'))).toEqual({ skewMs: 600_000 });
    skewMs = -600_000;
    await mirror.syncAll([]);
    expect(JSON.parse(fs.readFileSync(path.join(root, MIRROR_CLOCK_FILE), 'utf8'))).toEqual({ skewMs: -600_000 });
    skewMs = undefined;
    await mirror.syncAll([]);
    expect(JSON.parse(fs.readFileSync(path.join(root, MIRROR_CLOCK_FILE), 'utf8'))).toEqual({ skewMs: -600_000 });
    expect(fs.readdirSync(root).sort()).toEqual([MIRROR_CLOCK_FILE]);
  });

  it('syncs the ledger and carries the skew only over a connection whose daemon lists mirror.subcalls', async () => {
    const request = vi.fn(async () => ({}));
    const connection = (features: readonly string[]) => ({ features, skewMs: 1234, control: { request }, receiveStream: async () => 0 }) as unknown as Parameters<typeof connectionMirrorChannel>[0];
    const listed = connectionMirrorChannel(connection([MIRROR_SUBCALLS_FEATURE]));
    expect(listed.skewMs).toBe(1234);
    await listed.syncSubcalls!({ budgetBytes: 10 });
    expect(request).toHaveBeenCalledWith('mirror.syncSubcalls', { budgetBytes: 10 });
    const unlisted = connectionMirrorChannel(connection([]));
    expect(unlisted.syncSubcalls).toBeUndefined();
    expect(unlisted.skewMs).toBe(1234);
    const frozen = frozenMirrorChannel({ control: { request }, receiveStream: async () => 0 } as unknown as Parameters<typeof frozenMirrorChannel>[0]);
    expect([frozen.syncSubcalls, frozen.skewMs]).toEqual([undefined, undefined]);
  });
});

describe('SessionMirror.schedule', () => {
  it('coalesces requests made during a sync into one more sync that reads the projects anew, and idle settles after it', async () => {
    const target = daemon(agentDir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sync = vi.fn(async (request: Parameters<typeof target.sync>[0]) => {
      if (sync.mock.calls.length === 1) await gate;
      return target.sync(request);
    });
    const mirror = new SessionMirror({ root, channel: () => ({ sync, receive: target.receive }), log: () => undefined });
    let projects = [projectKey];
    writeTarget('s1.jsonl', 'first\n');
    const first = mirror.schedule(() => projects);
    projects = [projectKey, '/srv/other'];
    void mirror.schedule(() => projects);
    void mirror.schedule(() => projects);
    release();
    await first;
    await mirror.idle();
    // the first sync, then one more for both requests, which lists the project added meanwhile
    expect(sync.mock.calls.map(([request]) => request.projectKey)).toEqual([projectKey, projectKey, '/srv/other']);
    expect(fs.readFileSync(mirrored('s1.jsonl'), 'utf8')).toBe('first\n');
  });

  // the request lands at each microtask turn around the end of the running sync, the turn its loop exits included
  it('syncs a request made in any turn after the running sync read its last request', async () => {
    for (let hops = 0; hops < 8; hops++) {
      const mirror = new SessionMirror({ root, channel: () => { throw new Error('no channel in this test'); }, log: () => undefined });
      const synced: string[][] = [];
      let finish!: () => void;
      mirror.syncAll = async (folderKeys) => {
        synced.push([...folderKeys]);
        if (synced.length === 1) await new Promise<void>((resolve) => { finish = resolve; });
      };
      const first = mirror.schedule(() => ['/srv/first']);
      finish();
      for (let hop = 0; hop < hops; hop++) await Promise.resolve();
      const late = mirror.schedule(() => ['/srv/late']);
      await Promise.all([first, late]);
      await mirror.idle();
      expect({ hops, synced }).toEqual({ hops, synced: [['/srv/first'], ['/srv/late']] });
    }
  });

  it('runs the coalesced sync with the latest request\'s projects, not the first one\'s', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sync = vi.fn(async (_request: { readonly projectKey: string }) => {
      if (sync.mock.calls.length === 1) await gate;
      return { changes: [] };
    });
    const mirror = new SessionMirror({ root, channel: () => ({ sync, receive: async () => 0 }), log: () => undefined });
    const first = mirror.schedule(() => [projectKey]);
    void mirror.schedule(() => ['/srv/a']);
    void mirror.schedule(() => ['/srv/b', projectKey]);
    release();
    await first;
    expect(sync.mock.calls.map(([request]) => request.projectKey)).toEqual([projectKey, '/srv/b', projectKey]);
  });
});

describe('following the daemon\'s mirror.changed', () => {
  // the daemon's own mirror watches over a watcher factory the test fires, and the connection's control events
  function followedHost(features: readonly string[]) {
    const target = daemon(agentDir);
    const watchers: Array<{ base: string; change: Array<(fsPath: string) => void> }> = [];
    const factory: FileWatcherFactory = {
      watch: (base) => {
        const entry = { base, change: [] as Array<(fsPath: string) => void> };
        watchers.push(entry);
        const none = () => ({ dispose: () => undefined });
        return { ready: Promise.resolve(), onDidCreate: none, onDidDelete: none, onDidChange: (cb) => { entry.change.push(cb); return { dispose: () => undefined }; }, dispose: () => undefined };
      },
      watchWorkspace: () => { throw new Error('no workspace watch in this test'); },
      onDidRenameFiles: () => ({ dispose: () => undefined }),
    };
    const watches = createMirrorWatches({ agentDir, ledgerPath: path.join(base, 'target', 'usage', 'subcalls.jsonl'), watchers: factory });
    const listeners = new Set<(event: { projectKey: string }) => void>();
    const connection = {
      features,
      control: { onEvent: (_name: 'mirror.changed', cb: (event: { projectKey: string }) => void) => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; } },
    } as unknown as Pick<RemoteConnection, 'features' | 'control'>;
    // as connections.ts serves mirror.sync: the project is followed before it is listed
    const sync = async (request: Parameters<typeof target.sync>[0]) => {
      await watches.follow('connection-1', request.projectKey, () => { for (const cb of [...listeners]) cb({ projectKey: request.projectKey }); });
      return target.sync(request);
    };
    const mirror = new SessionMirror({ root, channel: () => ({ sync, receive: target.receive }), log: () => undefined });
    const changed = (fsPath: string): void => {
      for (const watcher of watchers) for (const cb of watcher.change) cb(fsPath);
    };
    return { mirror, connection, changed };
  }

  it('receives the bytes core appends to a session file after its turn settled', async () => {
    const { mirror, connection, changed } = followedHost([MIRROR_CHANGED_FEATURE]);
    followMirrorChanges(connection, () => void mirror.schedule(() => [projectKey]));
    writeTarget('s1.jsonl', 'header\nprompt\nreply\n');
    // the sync the turn's chat.turnSettled starts
    void mirror.schedule(() => [projectKey]);
    await mirror.idle();
    expect(fs.readFileSync(mirrored('s1.jsonl'), 'utf8')).toBe('header\nprompt\nreply\n');
    // the turn's checkpoint record lands after the turn settled
    fs.appendFileSync(targetFile('s1.jsonl'), 'checkpoint\n');
    changed(targetFile('s1.jsonl'));
    await mirror.idle();
    expect(fs.readFileSync(mirrored('s1.jsonl'), 'utf8')).toBe('header\nprompt\nreply\ncheckpoint\n');
  });

  it('syncs again on mirror.subcallsChanged from a daemon that lists mirror.subcalls, and stops at dispose', () => {
    const listeners = new Map<string, () => void>();
    const onEvent = vi.fn((name: string, cb: () => void) => {
      listeners.set(name, cb);
      return { dispose: () => { listeners.delete(name); } };
    });
    const sync = vi.fn();
    const following = followMirrorChanges({ features: [MIRROR_SUBCALLS_FEATURE], control: { onEvent } } as unknown as Pick<RemoteConnection, 'features' | 'control'>, sync);
    expect([...listeners.keys()]).toEqual(['mirror.subcallsChanged']);
    listeners.get('mirror.subcallsChanged')!();
    expect(sync).toHaveBeenCalledTimes(1);
    following.dispose();
    expect(listeners.size).toBe(0);
  });

  it('follows nothing on a daemon that does not list mirror.changed', () => {
    const onEvent = vi.fn();
    const following = followMirrorChanges({ features: [], control: { onEvent } } as unknown as Pick<RemoteConnection, 'features' | 'control'>, () => undefined);
    expect(onEvent).not.toHaveBeenCalled();
    following.dispose();
  });
});
