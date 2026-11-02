import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawEventType, TrackWork } from '../../watch-worker/fs-watch-tree';
import { startPolling, startShallowPolling, type PollingDeps, type SnapshotApi } from '../polling-watcher';

const INTERVAL_MS = 40;
const track: TrackWork = (work) => work;
// a start that fails here is a test failure
const unexpected = (err: unknown): void => {
  throw new Error(`the watch failed to start: ${String(err)}`);
};

let base: string;
let root: string;
let temp: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'polling-watcher-'));
  root = path.join(base, 'root');
  temp = path.join(base, 'temp');
  fs.mkdirSync(root);
  fs.mkdirSync(temp);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const deps = (overrides: Partial<PollingDeps> = {}): PollingDeps => ({ snapshots: () => import('@parcel/watcher'), tmpdir: () => temp, intervalMs: INTERVAL_MS, ...overrides });

function recorder(): { readonly events: Array<[RawEventType, string]>; readonly emit: (type: RawEventType, fsPath: string) => void; seen(type: RawEventType, fsPath: string): boolean } {
  const events: Array<[RawEventType, string]> = [];
  return {
    events,
    emit: (type, fsPath) => void events.push([type, fsPath]),
    seen: (type, fsPath) => events.some(([t, p]) => t === type && p === fsPath),
  };
}

describe('startPolling', () => {
  it('reports a create, a change, a delete and a rename made after the first snapshot', async () => {
    fs.writeFileSync(path.join(root, 'kept.txt'), 'one');
    fs.writeFileSync(path.join(root, 'gone.txt'), 'x');
    fs.mkdirSync(path.join(root, 'old'));
    fs.writeFileSync(path.join(root, 'old', 'inside.txt'), 'x');
    const { events, emit, seen } = recorder();
    const watch = startPolling(root, emit, () => undefined, unexpected, () => undefined, track, deps());
    await watch.ready;
    fs.writeFileSync(path.join(root, 'new.txt'), 'new');
    fs.writeFileSync(path.join(root, 'kept.txt'), 'one two three');
    fs.rmSync(path.join(root, 'gone.txt'));
    fs.renameSync(path.join(root, 'old'), path.join(root, 'renamed'));
    await vi.waitFor(() => {
      expect(seen('create', path.join(root, 'new.txt'))).toBe(true);
      expect(seen('change', path.join(root, 'kept.txt'))).toBe(true);
      expect(seen('delete', path.join(root, 'gone.txt'))).toBe(true);
      expect(seen('delete', path.join(root, 'old'))).toBe(true);
      expect(seen('create', path.join(root, 'renamed'))).toBe(true);
      expect(seen('create', path.join(root, 'renamed', 'inside.txt'))).toBe(true);
    }, { timeout: 5000 });
    expect(events.filter(([, p]) => p === path.join(root, 'kept.txt')).every(([type]) => type === 'change')).toBe(true);
    watch.dispose();
  });

  it('reports nothing under the ignore list', async () => {
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    const { emit, events, seen } = recorder();
    const watch = startPolling(root, emit, () => undefined, unexpected, () => undefined, track, deps());
    await watch.ready;
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    fs.writeFileSync(path.join(root, 'marker.txt'), 'x');
    await vi.waitFor(() => expect(seen('create', path.join(root, 'marker.txt'))).toBe(true), { timeout: 5000 });
    expect(events.some(([, p]) => p.includes('node_modules'))).toBe(false);
    watch.dispose();
  });

  it('keeps its snapshots in a private temp folder that goes when the watch ends', async () => {
    const { emit } = recorder();
    const watch = startPolling(root, emit, () => undefined, unexpected, () => undefined, track, deps());
    await watch.ready;
    const folders = fs.readdirSync(temp);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatch(/^damocles-poll-/);
    expect(fs.readdirSync(path.join(temp, folders[0]!))).toEqual(['a']);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(temp, folders[0]!)).mode & 0o777).toBe(0o700);
    watch.dispose();
    await vi.waitFor(() => expect(fs.readdirSync(temp)).toEqual([]));
  });

  it('settles ready only once the first snapshot is written', async () => {
    let release = (): void => undefined;
    const written = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots: SnapshotApi = {
      writeSnapshot: async (_dir, snapshot) => {
        await written;
        return snapshot;
      },
      getEventsSince: async () => [],
    };
    let ready = false;
    const watch = startPolling(root, () => undefined, () => undefined, unexpected, () => undefined, track, deps({ snapshots: async () => snapshots }));
    void watch.ready.then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 3 * INTERVAL_MS));
    expect(ready).toBe(false);
    release();
    await watch.ready;
    expect(ready).toBe(true);
    watch.dispose();
  });

  it('reports a first snapshot that fails while the root is there as a failed start, taking no more snapshots', async () => {
    const writes: string[] = [];
    const snapshots: SnapshotApi = {
      writeSnapshot: async (_dir, snapshot) => {
        writes.push(snapshot);
        throw new Error('EACCES: the snapshot folder is not writable');
      },
      getEventsSince: async () => [],
    };
    const failed = vi.fn();
    const lost = vi.fn();
    const watch = startPolling(root, () => undefined, lost, failed, () => undefined, track, deps({ snapshots: async () => snapshots }));
    await watch.ready;
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(String(failed.mock.calls[0]![0])).toContain('EACCES');
    await new Promise((resolve) => setTimeout(resolve, 4 * INTERVAL_MS));
    expect(writes).toHaveLength(1);
    expect(lost).not.toHaveBeenCalled();
    watch.dispose();
  });

  it('reads no events once disposed while the next snapshot is written', async () => {
    const tracked: Array<Promise<unknown>> = [];
    const tracking: TrackWork = (work) => {
      tracked.push(work);
      return work;
    };
    const writes: string[] = [];
    const reads = vi.fn(async () => []);
    const snapshots: SnapshotApi = {
      writeSnapshot: async (_dir, snapshot) => {
        writes.push(snapshot);
        // a quit or a daemon close while the poll's snapshot is written
        if (writes.length === 2) watch.dispose();
        return snapshot;
      },
      getEventsSince: reads,
    };
    const watch = startPolling(root, () => undefined, () => undefined, unexpected, () => undefined, tracking, deps({ snapshots: async () => snapshots }));
    await watch.ready;
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    await Promise.allSettled(tracked);
    expect(reads).not.toHaveBeenCalled();
  });

  it('logs a failure that persists once, until a poll succeeds again', async () => {
    let write = 0;
    // the first snapshot, then two failed polls, one that succeeds, and failures again
    const fails = new Set([2, 3, 5, 6]);
    const snapshots: SnapshotApi = {
      writeSnapshot: async (_dir, snapshot) => {
        write++;
        if (fails.has(write)) throw new Error('ENOENT: the snapshot folder is gone');
        return snapshot;
      },
      getEventsSince: async () => [],
    };
    const logs: string[] = [];
    const watch = startPolling(root, () => undefined, () => undefined, unexpected, (line) => logs.push(line), track, deps({ snapshots: async () => snapshots }));
    await watch.ready;
    await vi.waitFor(() => expect(write).toBeGreaterThanOrEqual(7));
    watch.dispose();
    expect(logs.filter((line) => line.startsWith(`[watcher] polling ${root} failed`))).toEqual([
      `[watcher] polling ${root} failed: ENOENT: the snapshot folder is gone`,
      `[watcher] polling ${root} failed: ENOENT: the snapshot folder is gone`,
    ]);
  });

  it('says only that it could not watch when the snapshot folder cannot be made, deleting nothing', async () => {
    const tracked: Array<Promise<unknown>> = [];
    const tracking: TrackWork = (work) => {
      tracked.push(work);
      return work;
    };
    const failed = vi.fn();
    const logs: string[] = [];
    const watch = startPolling(root, () => undefined, () => undefined, failed, (line) => logs.push(line), tracking, deps({ tmpdir: () => path.join(base, 'missing-temp') }));
    await watch.ready;
    expect(String(failed.mock.calls[0]?.[0])).toContain('ENOENT');
    watch.dispose();
    await Promise.allSettled(tracked);
    expect(logs).toEqual([]);
  });

  it('hands a root that is gone back to waiting', async () => {
    const lost = vi.fn();
    const watch = startPolling(root, () => undefined, lost, unexpected, () => undefined, track, deps());
    await watch.ready;
    fs.rmSync(root, { recursive: true });
    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce(), { timeout: 5000 });
    watch.dispose();
  });
});

describe('startShallowPolling', () => {
  it('reports a first listing that fails while the folder is there as a failed start', async () => {
    const file = path.join(root, 'not-a-folder');
    fs.writeFileSync(file, 'x');
    const failed = vi.fn();
    const lost = vi.fn();
    const watch = startShallowPolling(file, () => undefined, lost, failed, () => undefined, track, INTERVAL_MS);
    await watch.ready;
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(lost).not.toHaveBeenCalled();
    watch.dispose();
  });

  it('reports the direct children created, changed and deleted, and nothing deeper', async () => {
    fs.writeFileSync(path.join(root, 'a.json'), '1');
    fs.writeFileSync(path.join(root, 'b.json'), '1');
    fs.mkdirSync(path.join(root, 'sub'));
    const { emit, events, seen } = recorder();
    const watch = startShallowPolling(root, emit, () => undefined, unexpected, () => undefined, track, INTERVAL_MS);
    await watch.ready;
    fs.writeFileSync(path.join(root, 'c.json'), '1');
    fs.writeFileSync(path.join(root, 'a.json'), '1234');
    fs.rmSync(path.join(root, 'b.json'));
    fs.writeFileSync(path.join(root, 'sub', 'deep.json'), '1');
    await vi.waitFor(() => {
      expect(seen('create', path.join(root, 'c.json'))).toBe(true);
      expect(seen('change', path.join(root, 'a.json'))).toBe(true);
      expect(seen('delete', path.join(root, 'b.json'))).toBe(true);
    }, { timeout: 5000 });
    expect(events.some(([, p]) => p.endsWith('deep.json'))).toBe(false);
    watch.dispose();
  });

  it('reports no change for a child folder whose own mtime moved with an entry made inside it, as a native watch does not', async () => {
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'old.json'), '1');
    const { emit, events, seen } = recorder();
    const watch = startShallowPolling(root, emit, () => undefined, unexpected, () => undefined, track, INTERVAL_MS);
    await watch.ready;
    const before = fs.statSync(path.join(root, 'sub')).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(path.join(root, 'sub', 'new.json'), '1');
    fs.rmSync(path.join(root, 'sub', 'old.json'));
    // the folder's mtime moved, so a listing that compared it would see a change
    expect(fs.statSync(path.join(root, 'sub')).mtimeMs).not.toBe(before);
    fs.writeFileSync(path.join(root, 'marker.json'), '1');
    await vi.waitFor(() => expect(seen('create', path.join(root, 'marker.json'))).toBe(true), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 3 * INTERVAL_MS));
    expect(events.filter(([, p]) => p === path.join(root, 'sub'))).toEqual([]);
    watch.dispose();
  });
});
