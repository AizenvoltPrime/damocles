import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as crypto from 'crypto';
// vscode is aliased to src/__mocks__/vscode.ts in vitest.config — these are its test-only handles.
import { __watchers, __renameEmitter, type FakeFileSystemWatcher } from 'vscode';
import { createTestMemoryDb } from './test-helpers';
import { MemoryWriteQueue } from '../write-queue';
import { FileChangeTracker } from '../managers/file-change-tracker';
import { ObservationManager } from '../managers/observation-manager';
import { RetrievalManager } from '../managers/retrieval-manager';
import { normalizedContentHash } from '../types';
import type { DatabaseInstance } from '../types';

// path.resolve so these paths match the tracker's own normalizePath on any platform, including
// Windows (drive letter + backslashes).
const ROOT = path.resolve('/repo');

interface SeedOpts {
  id?: string;
  content?: string;
  filesRead?: string[];
  filesModified?: string[];
  isLatest?: 0 | 1;
  forgotten?: 0 | 1;
  workspace?: string;
}

function seedObservation(db: DatabaseInstance, opts: SeedOpts = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  const content = opts.content ?? `observation ${id}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories
       (id, kind, scope, content, content_hash, version, is_latest, root_id, workspace,
        created_at, updated_at, observation_type, files_read, files_modified, forgotten)
     VALUES (?, 'observation', 'project', ?, ?, 1, ?, ?, ?, ?, ?, 'implementation', ?, ?, ?)`,
  ).run(
    id,
    content,
    normalizedContentHash(content),
    opts.isLatest ?? 1,
    id,
    opts.workspace ?? ROOT,
    now,
    now,
    JSON.stringify(opts.filesRead ?? []),
    JSON.stringify(opts.filesModified ?? []),
    opts.forgotten ?? 0,
  );
  return id;
}

function staleness(db: DatabaseInstance, id: string): number {
  const row = db.prepare('SELECT file_change_count FROM memories WHERE id = ?').get(id) as
    | { file_change_count: number }
    | undefined;
  return row?.file_change_count ?? -1;
}

/** The watcher the most-recently-initialized tracker created. */
function latestWatcher(): FakeFileSystemWatcher {
  const w = __watchers[__watchers.length - 1];
  if (!w) throw new Error('no FakeFileSystemWatcher was created — did initialize() run?');
  return w;
}

describe('FileChangeTracker — Slice 11 file-staleness correctness', () => {
  let db: DatabaseInstance;
  let writeQueue: MemoryWriteQueue;
  let tracker: FileChangeTracker;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Reset the mock handles so each test drives a fresh watcher/rename emitter.
    __watchers.length = 0;
    __renameEmitter.clear();
    db = await createTestMemoryDb();
    writeQueue = new MemoryWriteQueue(db);
  });

  afterEach(() => {
    tracker?.dispose();
    vi.useRealTimers();
  });

  function buildTracker(workspaceRoot: string = ROOT): FileChangeTracker {
    tracker = new FileChangeTracker(db, writeQueue, workspaceRoot);
    tracker.initialize();
    return tracker;
  }

  it('marks a dependent observation stale on an agent write (onDidChange, no save) after the 5s debounce', async () => {
    const file = path.join(ROOT, 'src', 'foo.ts');
    const id = seedObservation(db, { filesModified: [file] });
    buildTracker();

    latestWatcher().emitChange(file);
    // Nothing bumped before the debounce elapses.
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(0);

    vi.advanceTimersByTime(5000);
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(1);
  });

  it('marks stale on onDidCreate after the 5s debounce', async () => {
    const file = path.join(ROOT, 'src', 'created.ts');
    const id = seedObservation(db, { filesRead: [file] });
    buildTracker();

    latestWatcher().emitCreate(file);
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(0);

    vi.advanceTimersByTime(5000);
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(1);
  });

  it('marks stale IMMEDIATELY on delete (before any timer advance)', async () => {
    const file = path.join(ROOT, 'src', 'gone.ts');
    const id = seedObservation(db, { filesModified: [file] });
    buildTracker();

    latestWatcher().emitDelete(file);
    await writeQueue.drain();
    // Asserted before advancing timers — deletes do not debounce.
    expect(staleness(db, id)).toBe(1);

    vi.advanceTimersByTime(5000);
    await writeQueue.drain();
    // No second bump from a lingering debounce timer.
    expect(staleness(db, id)).toBe(1);
  });

  it('marks stale IMMEDIATELY on rename of the old path (before any timer advance)', async () => {
    const oldFile = path.join(ROOT, 'src', 'old-name.ts');
    const newFile = path.join(ROOT, 'src', 'new-name.ts');
    const id = seedObservation(db, { filesModified: [oldFile] });
    buildTracker();

    __renameEmitter.fire({ files: [{ oldUri: { fsPath: oldFile }, newUri: { fsPath: newFile } }] });
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(1);
  });

  it('coalesces a burst of rapid changes into a single stale increment', async () => {
    const file = path.join(ROOT, 'src', 'busy.ts');
    const id = seedObservation(db, { filesModified: [file] });
    buildTracker();

    const w = latestWatcher();
    w.emitChange(file);
    vi.advanceTimersByTime(1000);
    w.emitChange(file);
    vi.advanceTimersByTime(1000);
    w.emitChange(file);
    // Only ~2s of the repeatedly-reset debounce has elapsed — nothing yet.
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(0);

    vi.advanceTimersByTime(5000);
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(1);
  });

  it('resolves a RELATIVE stored path against workspaceRoot to match an absolute event path', async () => {
    const id = seedObservation(db, { filesModified: ['src/foo.ts'] });
    buildTracker(ROOT);

    // The absolute path vscode would emit under the workspace root.
    const eventPath = path.resolve(ROOT, 'src/foo.ts');
    latestWatcher().emitChange(eventPath);
    vi.advanceTimersByTime(5000);
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(1);
  });

  it('falls back to a >=2-trailing-segment suffix match when the full path key misses', async () => {
    // Stored under a different absolute root, so its full-path key can never equal the event key.
    const storedUnderOtherRoot = path.resolve('/other-root', 'lib', 'util.ts');
    const id = seedObservation(db, { filesModified: [storedUnderOtherRoot] });
    buildTracker(ROOT);

    const eventPath = path.resolve(ROOT, 'lib', 'util.ts'); // same last 2 segments: lib/util.ts
    expect(eventPath).not.toBe(storedUnderOtherRoot); // full paths genuinely differ
    latestWatcher().emitChange(eventPath);
    vi.advanceTimersByTime(5000);
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(1);
  });

  it('does not stale a same-named file\'s observation in a DIFFERENT workspace', async () => {
    // Both workspaces have a file with identical trailing segments. Editing it in this workspace must
    // not bump the other workspace's observation via the suffix-match index.
    const OTHER_WS = path.resolve('/other-workspace');
    const relPath = path.join('src', 'shared-name.ts');
    const mine = seedObservation(db, { filesModified: [path.join(ROOT, relPath)], workspace: ROOT });
    const theirs = seedObservation(db, { filesModified: [path.join(OTHER_WS, relPath)], workspace: OTHER_WS });
    buildTracker(ROOT);

    latestWatcher().emitChange(path.resolve(ROOT, relPath));
    vi.advanceTimersByTime(5000);
    await writeQueue.drain();

    expect(staleness(db, mine)).toBe(1);
    expect(staleness(db, theirs)).toBe(0); // other workspace's row was never indexed by this tracker
  });

  it('excludes forgotten and superseded rows from the reverse index (R15)', async () => {
    const file = path.join(ROOT, 'src', 'tracked.ts');
    const liveId = seedObservation(db, { filesModified: [file] });
    const forgottenId = seedObservation(db, { filesModified: [file], forgotten: 1 });
    const supersededId = seedObservation(db, { filesModified: [file], isLatest: 0 });
    buildTracker();

    latestWatcher().emitChange(file);
    vi.advanceTimersByTime(5000);
    await writeQueue.drain();

    expect(staleness(db, liveId)).toBe(1);
    expect(staleness(db, forgottenId)).toBe(0);
    expect(staleness(db, supersededId)).toBe(0);
  });

  it('removeObservation untracks from both indexes so a later change does not re-stale it (R15)', async () => {
    // Stored under another root so removal exercises both a full-path miss and a suffix hit.
    const storedUnderOtherRoot = path.resolve('/other-root', 'src', 'removed.ts');
    const id = seedObservation(db, { filesModified: [storedUnderOtherRoot] });
    buildTracker(ROOT);

    const eventPath = path.resolve(ROOT, 'src', 'removed.ts'); // suffix src/removed.ts

    // First change bumps it via suffix fallback.
    latestWatcher().emitChange(eventPath);
    vi.advanceTimersByTime(5000);
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(1);

    // After removeObservation, a later change must not bump it again.
    tracker.removeObservation(id);
    latestWatcher().emitChange(eventPath);
    vi.advanceTimersByTime(5000);
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(1);
  });

  it('dispose() clears pending debounce timers and disposes the watcher', async () => {
    const file = path.join(ROOT, 'src', 'disposed.ts');
    const id = seedObservation(db, { filesModified: [file] });
    buildTracker();
    const w = latestWatcher();

    w.emitChange(file); // schedule a debounce timer
    tracker.dispose(); // must clear it
    expect(w.disposed).toBe(true);

    vi.advanceTimersByTime(5000);
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(0);

    // Watcher callbacks are cleared on dispose, so post-dispose emits are inert.
    w.emitChange(file);
    vi.advanceTimersByTime(5000);
    await writeQueue.drain();
    expect(staleness(db, id)).toBe(0);
  });
});

describe('R5 — forward-slash normalization of files_read / files_modified', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('normalizes backslash paths to forward slashes at write time', () => {
    const om = new ObservationManager(db);
    const entry = om.addRichObservation('session-1', ROOT, {
      type: 'implementation',
      title: 'win paths',
      content: 'did a thing',
      facts: ['a', 'b', 'c'],
      filesModified: ['src\\win\\foo.ts'],
      filesRead: ['lib\\bar.ts'],
    });

    const row = db.prepare('SELECT files_read, files_modified FROM memories WHERE id = ?').get(entry.id) as {
      files_read: string;
      files_modified: string;
    };
    expect(JSON.parse(row.files_modified)).toEqual(['src/win/foo.ts']);
    expect(JSON.parse(row.files_read)).toEqual(['lib/bar.ts']);
    // Returned entry is normalized too.
    expect(entry.filesModified).toEqual(['src/win/foo.ts']);
    expect(entry.filesRead).toEqual(['lib/bar.ts']);
  });

  it('matches a backslash files query against forward-slash-stored paths', async () => {
    seedObservationRow(db, ['src/query/foo.ts']);
    const retrieval = new RetrievalManager(db);

    const results = await retrieval.search({ files: ['src\\query\\foo.ts'], workspace: ROOT });
    expect(results.length).toBe(1);
  });

  it('defensively forward-slashes legacy backslash paths returned by getDetails', () => {
    const id = seedObservationRow(db, [], ['src\\legacy\\baz.ts']);
    const retrieval = new RetrievalManager(db);

    const [entry] = retrieval.getDetails([id]);
    expect(entry?.filesModified).toEqual(['src/legacy/baz.ts']);
  });

  it('one-time sweep rewrites existing backslash JSON to forward slashes and is idempotent', () => {
    const backslashId = seedObservationRow(db, ['a\\b\\c.ts'], ['d\\e.ts']);
    const cleanId = seedObservationRow(db, ['already/clean.ts']);

    // Constructing the manager runs the guarded GLOB '*\*' sweep once.
    new ObservationManager(db);
    const swept = readFiles(db, backslashId);
    expect(JSON.parse(swept.files_read)).toEqual(['a/b/c.ts']);
    expect(JSON.parse(swept.files_modified)).toEqual(['d/e.ts']);
    // Already-clean row is untouched (byte-identical JSON).
    expect(readFiles(db, cleanId).files_read).toBe(JSON.stringify(['already/clean.ts']));

    // Idempotent: a second construction is a no-op (guard selects zero rows).
    new ObservationManager(db);
    const again = readFiles(db, backslashId);
    expect(JSON.parse(again.files_read)).toEqual(['a/b/c.ts']);
    expect(JSON.parse(again.files_modified)).toEqual(['d/e.ts']);
  });
});

// Raw seeding that bypasses write-time normalization.
function seedObservationRow(db: DatabaseInstance, filesRead: string[], filesModified: string[] = []): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories
       (id, kind, scope, content, content_hash, version, is_latest, root_id, workspace,
        created_at, updated_at, observation_type, files_read, files_modified, forgotten)
     VALUES (?, 'observation', 'project', ?, ?, 1, 1, ?, ?, ?, ?, 'implementation', ?, ?, 0)`,
  ).run(
    id,
    `obs ${id}`,
    normalizedContentHash(`obs ${id}`),
    id,
    ROOT,
    now,
    now,
    JSON.stringify(filesRead),
    JSON.stringify(filesModified),
  );
  return id;
}

function readFiles(db: DatabaseInstance, id: string): { files_read: string; files_modified: string } {
  return db.prepare('SELECT files_read, files_modified FROM memories WHERE id = ?').get(id) as {
    files_read: string;
    files_modified: string;
  };
}
