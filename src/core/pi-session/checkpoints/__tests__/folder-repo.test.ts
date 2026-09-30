import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutoCheckpointProducer } from '../auto-checkpoint';
import { copyCheckpointRefs, deleteSessionCheckpointRefs, folderIdsInSessionFile, markForkCopyPending, readSessionRegistration, readSkippedManifest } from '../folder-repo';
import { runCheckpointMaintenance } from '../maintenance';
import { GIT_DIR_MAX_LENGTH, folderIdFor, getFolderRepoDir, getGitDir } from '../resolver';
import type { CheckpointEntryV3, CheckpointRecord } from '../types';

const MB = 1024 * 1024;
const CAP = 25 * MB;

let root: string;
let cwd: string;
let turn = 0;

function sessionFile(name: string): string {
  const file = path.join(root, 'sessions', `${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  return file;
}

function producer(sessionId: string, workTree = cwd): AutoCheckpointProducer {
  return new AutoCheckpointProducer({
    sessionId,
    sessionFile: sessionFile(sessionId),
    cwd: workTree,
    maxFileSizeBytes: () => CAP,
    createTurnId: () => `turn-${++turn}`,
    now: () => new Date(),
  });
}

function gitDirFor(workTree = cwd): string {
  return getGitDir(getFolderRepoDir(folderIdFor(workTree)));
}

function git(args: string[], workTree = cwd): string {
  return execFileSync('git', [`--git-dir=${gitDirFor(workTree)}`, ...args], { maxBuffer: 64 * MB }).toString();
}

function treePaths(commit: string, workTree = cwd): string[] {
  return git(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', commit], workTree).split('\n').filter(Boolean);
}

function refsOf(sessionId: string): string[] {
  return git(['for-each-ref', '--format=%(refname)', `refs/damocles/sessions/${sessionId}/`]).split('\n').filter(Boolean);
}

function write(rel: string, content: string | Buffer, workTree = cwd): void {
  const full = path.join(workTree, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function read(rel: string, workTree = cwd): string {
  return fs.readFileSync(path.join(workTree, rel), 'utf8');
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * MB })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** A 1 GB file created by extending it, so no gigabyte is ever written; only its first bytes are data. */
function hugeFile(rel: string): string {
  const full = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const fd = fs.openSync(full, 'w');
  fs.writeSync(fd, 'raw render frame header');
  fs.ftruncateSync(fd, 1024 * MB);
  fs.closeSync(fd);
  return full;
}

function smallFiles(count: number): void {
  for (let i = 0; i < count; i++) write(`src/d${i % 40}/f${i}.txt`, `file ${i}\n`);
}

function blobCount(): number {
  return git(['cat-file', '--batch-all-objects', '--batch-check=%(objecttype)']).split('\n').filter((t) => t === 'blob').length;
}

function packCount(): number {
  const dir = path.join(gitDirFor(), 'objects', 'pack');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.pack')).length : 0;
}

function asEntry(record: CheckpointRecord | undefined): CheckpointEntryV3 {
  if (!record || record.kind !== 'checkpoint' || record.v !== 3) throw new Error(`expected a v3 checkpoint, got ${JSON.stringify(record)}`);
  return record;
}

async function turnOf(p: AutoCheckpointProducer, userEntryId: string, during?: () => void): Promise<CheckpointEntryV3> {
  const started = await p.turnStart({ userEntryId, prompt: userEntryId });
  if (!started.ok) throw new Error(started.message);
  during?.();
  const finalized = await p.finalizeRun();
  return asEntry(finalized.ok ? finalized.record : undefined);
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-folder-'));
  cwd = path.join(root, 'music video');
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(getFolderRepoDir(folderIdFor(cwd)), { recursive: true, force: true });
  await fs.promises.rm(root, { recursive: true, force: true });
});

// Real git, 2000-file trees and a 1 GB file: the ceiling detects a hang, not ordinary slowness.
describe('folder repo checkpoints (real git)', { timeout: 180_000 }, () => {
  it('AC2: keeps an over-cap file and a category file out of the snapshot, lists both, and a rewind leaves both byte-identical', async () => {
    smallFiles(2000);
    const big = hugeFile('renders/frame.rgba');
    write('videos/clip.mp4', 'not really a video, but named like one');
    write('notes.txt', 'v1\n');
    write('grow.dat', 'small at first\n');
    write('render', 'a file where a directory will stand\n');
    const bigHash = await sha256(big);

    const p = producer('session-a');
    const t0 = Date.now();
    const entry = await turnOf(p, 'u1', () => {
      write('notes.txt', 'v2 by the agent\n');
      write('created.txt', 'made this turn\n');
    });
    const baselineMs = Date.now() - t0;
    console.log(`[AC2] 1 GB + mp4 + 2000 files: first turn (baseline + finalize) ${baselineMs} ms`);

    const snapshot = treePaths(entry.beforeCommit);
    expect(snapshot).toContain('notes.txt');
    expect(snapshot).toContain('grow.dat');
    expect(snapshot).toContain('src/d0/f0.txt');
    expect(snapshot).not.toContain('renders/frame.rgba');
    expect(snapshot).not.toContain('videos/clip.mp4');
    expect(await readSkippedManifest(entry, cwd)).toEqual({
      ok: true,
      value: [
        { path: 'renders/frame.rgba', bytes: 1024 * MB, reason: 'size' },
        { path: 'videos/clip.mp4', bytes: 38, reason: 'category' },
      ],
    });
    expect(entry.skipped).toEqual({
      totalCount: 2,
      totalBytes: 1024 * MB + 38,
      byReason: { size: { count: 1, bytes: 1024 * MB }, category: { count: 1, bytes: 38 } },
      patterns: [{ pattern: '*.mp4', reason: 'category', count: 1, bytes: 38 }],
      manifest: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(git(['rev-parse', 'refs/damocles/sessions/session-a/u1/skipped']).trim()).toBe(entry.skipped.manifest);

    // After the turn: the video changes, a tracked small file grows over the cap.
    write('videos/clip.mp4', 'edited video bytes');
    const grown = Buffer.alloc(30 * MB, 7);
    write('grow.dat', grown);

    const restored = await p.restore(entry);
    expect(restored).toMatchObject({ ok: true });
    expect(read('notes.txt')).toBe('v1\n');
    expect(fs.existsSync(path.join(cwd, 'created.txt'))).toBe(false);
    expect(await sha256(big)).toBe(bigHash);
    expect(read('videos/clip.mp4')).toBe('edited video bytes');
    // The target holds the old small grow.dat; the rewind must not bring it back.
    expect(fs.statSync(path.join(cwd, 'grow.dat')).size).toBe(30 * MB);
    expect(fs.readFileSync(path.join(cwd, 'grow.dat')).equals(grown)).toBe(true);
  });

  it('AC2: refuses a restore when a protected file stands where the target needs a path, touching nothing', async () => {
    smallFiles(50);
    const big = hugeFile('renders/frame.rgba');
    write('notes.txt', 'v1\n');
    write('render', 'a file where a directory will stand\n');
    const bigHash = await sha256(big);

    const p = producer('session-a');
    const entry = await turnOf(p, 'u1');

    // The target wants a file at `render`, where a directory now holds a protected video.
    fs.rmSync(path.join(cwd, 'render'));
    write('render/out.mp4', 'protected video');
    write('notes.txt', 'v2\n');
    write('created.txt', 'made later\n');

    const result = await p.restore(entry);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('cannot restore render') });
    expect(read('render/out.mp4')).toBe('protected video');
    expect(await sha256(big)).toBe(bigHash);
    expect(read('notes.txt')).toBe('v2\n');
    expect(read('created.txt')).toBe('made later\n');
  });

  it('AC3: a second conversation shares the folder repo; its first baseline adds no blob and no pack for unchanged files', async () => {
    smallFiles(2000);
    const a = producer('session-a');
    let t = Date.now();
    expect((await a.turnStart({ userEntryId: 'a1', prompt: 'a' })).ok).toBe(true);
    const firstMs = Date.now() - t;
    const blobs = blobCount();
    const packs = packCount();
    expect(blobs).toBe(2000);

    const b = producer('session-b');
    t = Date.now();
    expect((await b.turnStart({ userEntryId: 'b1', prompt: 'b' })).ok).toBe(true);
    const secondMs = Date.now() - t;
    console.log(`[AC3] 2000 files: first conversation baseline ${firstMs} ms, second conversation baseline ${secondMs} ms`);
    expect(blobCount()).toBe(blobs);
    expect(packCount()).toBe(packs);
    expect(fs.readdirSync(path.join(root, 'sessions'))).toHaveLength(2);
    expect(refsOf('session-a')).toEqual(['refs/damocles/sessions/session-a/a1/before']);
    expect(refsOf('session-b')).toEqual(['refs/damocles/sessions/session-b/b1/before']);

    write('src/d0/f0.txt', 'changed\n');
    const c = producer('session-c');
    await c.turnStart({ userEntryId: 'c1', prompt: 'c' });
    expect(blobCount()).toBe(blobs + 1);
  });

  it('AC4: refs survive gc, delete removes only its own refs, and a fork rewinds after its parent is gone', async () => {
    write('a.txt', 'parent v1\n');
    const parent = producer('session-a');
    const inherited = await turnOf(parent, 'u1', () => write('a.txt', 'parent v2\n'));
    const sibling = producer('session-b');
    const siblingEntry = await turnOf(sibling, 'b1', () => write('b.txt', 'sibling\n'));

    const maintenance = await runCheckpointMaintenance({ baseDir: path.join(root, 'no-session-repos'), throttleMs: 0 });
    expect(maintenance.folderReposCollected).toBe(1);
    expect(maintenance.failures).toBe(0);
    for (const commit of [inherited.beforeCommit, inherited.afterCommit, siblingEntry.beforeCommit]) {
      git(['cat-file', '-e', `${commit}^{commit}`]);
    }

    expect(await copyCheckpointRefs(cwd, 'session-fork', sessionFile('session-fork'), [inherited])).toBe(1);
    await deleteSessionCheckpointRefs(cwd, 'session-a', await folderIdsInSessionFile(sessionFile('session-a')));
    expect(refsOf('session-a')).toEqual([]);
    expect(refsOf('session-b')).toEqual(['refs/damocles/sessions/session-b/b1/after', 'refs/damocles/sessions/session-b/b1/before']);
    expect(refsOf('session-fork')).toHaveLength(2);

    await runCheckpointMaintenance({ baseDir: path.join(root, 'no-session-repos'), throttleMs: 0 });
    write('a.txt', 'edited after the parent was deleted\n');
    const fork = producer('session-fork');
    expect(await fork.restore(inherited)).toMatchObject({ ok: true });
    expect(read('a.txt')).toBe('parent v1\n');
  });

  it('AC4: maintenance prunes an orphan past the grace and evicts by age, never a live conversation', async () => {
    write('a.txt', 'x\n');
    await turnOf(producer('session-live'), 'l1');
    await turnOf(producer('session-gone'), 'g1');
    fs.rmSync(sessionFile('session-gone'));

    const soon = await runCheckpointMaintenance({ baseDir: path.join(root, 'none'), throttleMs: 0 });
    expect(soon.orphanSessionsPruned).toBe(0);
    expect(refsOf('session-gone')).toHaveLength(1);

    const later = Date.now() + 2 * 86_400_000;
    const swept = await runCheckpointMaintenance({ baseDir: path.join(root, 'none'), throttleMs: 0, now: () => later });
    expect(swept.orphanSessionsPruned).toBe(1);
    expect(refsOf('session-gone')).toEqual([]);
    expect(refsOf('session-live')).toHaveLength(1);

    const aged = await runCheckpointMaintenance({ baseDir: path.join(root, 'none'), throttleMs: 0, retentionDays: 1, now: () => later });
    expect(aged.sessionRefsEvicted).toBe(1);
    expect(refsOf('session-live')).toEqual([]);
    expect(fs.existsSync(gitDirFor())).toBe(true);
  });

  describe('a fork whose ref copy never ran (the process exited first)', () => {
    const repoDir = (): string => getFolderRepoDir(folderIdFor(cwd));

    function checkpointLine(data: unknown, id: string): string {
      return JSON.stringify({ type: 'custom', customType: 'damocles-checkpoint', data, id, parentId: null, timestamp: new Date().toISOString() });
    }

    async function crashedFork(sessionId: string, lines: readonly string[]): Promise<string> {
      const file = sessionFile(sessionId);
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
      await markForkCopyPending(sessionId, file, new Set([folderIdFor(cwd)]));
      expect((await readSessionRegistration(repoDir(), sessionId))?.pendingCopy).toBe(true);
      return file;
    }

    /** `<entryId>/<phase>` → object id of every ref of `sessionId`. */
    function refTargets(sessionId: string): Record<string, string> {
      const lines = git(['for-each-ref', '--format=%(refname) %(objectname)', `refs/damocles/sessions/${sessionId}/`]).split('\n').filter(Boolean);
      return Object.fromEntries(lines.map((line) => {
        const [ref, id] = line.split(' ');
        return [ref!.split('/').slice(-2).join('/'), id!];
      }));
    }

    async function parentTurn(): Promise<CheckpointEntryV3> {
      write('a.txt', 'parent v1\n');
      write('videos/clip.mp4', 'a skipped file, so the checkpoint has a manifest');
      const entry = await turnOf(producer('session-a'), 'u1', () => write('a.txt', 'parent v2\n'));
      expect(entry.skipped.manifest).not.toBeNull();
      return entry;
    }

    async function expectForkRewindsAfterPrune(inherited: CheckpointEntryV3): Promise<void> {
      expect(refTargets('session-fork')).toEqual({ 'u1/before': inherited.beforeCommit, 'u1/after': inherited.afterCommit, 'u1/skipped': inherited.skipped.manifest });
      expect((await readSessionRegistration(repoDir(), 'session-fork'))?.pendingCopy).toBe(false);
      git(['prune', '--expire=now']);
      expect(await readSkippedManifest(inherited, cwd)).toMatchObject({ ok: true, value: [{ path: 'videos/clip.mp4' }] });
      write('a.txt', 'edited after the parent was gone\n');
      expect(await producer('session-fork').restore(inherited)).toMatchObject({ ok: true });
      expect(read('a.txt')).toBe('parent v1\n');
    }

    it('gets its own refs before its parent is deleted, and rewinds after a prune', async () => {
      const inherited = await parentTurn();
      await crashedFork('session-fork', [checkpointLine(inherited, 'e1')]);
      await deleteSessionCheckpointRefs(cwd, 'session-a', new Set());
      expect(refsOf('session-a')).toEqual([]);
      await expectForkRewindsAfterPrune(inherited);
    });

    it('gets its own refs before maintenance evicts its parent by age, and rewinds after a prune', async () => {
      const inherited = await parentTurn();
      await crashedFork('session-fork', [checkpointLine(inherited, 'e1')]);
      const later = Date.now() + 2 * 86_400_000;
      // The fork was made just before the sweep, long after its parent's last checkpoint.
      const forkMadeAt = new Date(later - 3_600_000);
      fs.utimesSync(path.join(repoDir(), 'sessions', 'session-fork.json'), forkMadeAt, forkMadeAt);
      const swept = await runCheckpointMaintenance({ baseDir: path.join(root, 'none'), throttleMs: 0, retentionDays: 1, now: () => later });
      expect(swept.sessionRefsEvicted).toBe(1);
      expect(refsOf('session-a')).toEqual([]);
      await expectForkRewindsAfterPrune(inherited);
    });

    it('is dropped with nothing copied when its session file is gone', async () => {
      await parentTurn();
      const forkFile = path.join(root, 'sessions', 'session-fork.jsonl');
      await markForkCopyPending('session-fork', forkFile, new Set([folderIdFor(cwd)]));
      await deleteSessionCheckpointRefs(cwd, 'session-a', new Set());
      expect(refsOf('session-a')).toEqual([]);
      expect(await readSessionRegistration(repoDir(), 'session-fork')).toBeNull();
      expect(refsOf('session-fork')).toEqual([]);
    });

    it('copies nothing for a malformed or unsafe entry, and the parent delete still completes', async () => {
      const inherited = await parentTurn();
      await crashedFork('session-fork', [
        '{"type":"custom","customType":"damocles-checkpoint",',
        checkpointLine({ ...inherited, beforeCommit: 'HEAD~1' }, 'e1'),
        checkpointLine({ ...inherited, userEntryId: '../../heads/main' }, 'e2'),
      ]);
      await deleteSessionCheckpointRefs(cwd, 'session-a', new Set());
      expect(refsOf('session-a')).toEqual([]);
      expect(refsOf('session-fork')).toEqual([]);
      expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/']).trim()).toBe('');
      expect((await readSessionRegistration(repoDir(), 'session-fork'))?.pendingCopy).toBe(false);
    });

    it('the background copy clears the flag and keeps the registration time', async () => {
      const inherited = await parentTurn();
      const forkFile = await crashedFork('session-fork', [checkpointLine(inherited, 'e1')]);
      const registration = path.join(repoDir(), 'sessions', 'session-fork.json');
      const madeAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
      fs.utimesSync(registration, madeAt, madeAt);
      expect(await copyCheckpointRefs(cwd, 'session-fork', forkFile, [inherited])).toBe(1);
      expect(await readSessionRegistration(repoDir(), 'session-fork')).toEqual({ sessionFile: forkFile, registeredAtMs: madeAt.getTime(), pendingCopy: false });
      expect(Object.keys(refTargets('session-fork')).sort()).toEqual(['u1/after', 'u1/before', 'u1/skipped']);
    });
  });

  it('AC7: a cwd over 150 characters checkpoints and rewinds, with GIT_DIR under the limit', async () => {
    const longCwd = path.join(root, 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(40));
    expect(longCwd.length).toBeGreaterThan(150);
    const deepRel = `${'d'.repeat(50)}/${'e'.repeat(50)}/file.txt`;
    write(deepRel, 'v1\n', longCwd);
    expect(gitDirFor(longCwd).length).toBeLessThan(GIT_DIR_MAX_LENGTH);

    const p = producer('session-long', longCwd);
    const entry = await turnOf(p, 'u1', () => write(deepRel, 'v2\n', longCwd));
    expect(entry.fileChanges).toEqual([{ path: deepRel, added: 1, removed: 1 }]);
    expect(await p.restore(entry)).toMatchObject({ ok: true });
    expect(read(deepRel, longCwd)).toBe('v1\n');
    await fs.promises.rm(getFolderRepoDir(folderIdFor(longCwd)), { recursive: true, force: true });
  });
});
