import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { AutoCheckpointProducer } from '../auto-checkpoint';
import { deleteSessionCheckpointRefs, folderIdsInSessionFile, readSkippedManifest } from '../folder-repo';
import { runCheckpointMaintenance } from '../maintenance';
import { RepoManager } from '../repo-manager';
import { folderIdFor, getFolderRepoDir, getGitDir, getIndexPath, getRepoDir } from '../resolver';
import { CHECKPOINT_EXCLUDE_SET } from '../types';
import type { CheckpointEntryV2, CheckpointEntryV3, CheckpointRecord } from '../types';
import { getPiCodingAgent, initPiLoader } from '../../pi-loader';
import { ensurePiSessionDir } from '../../session-store/session-dir';
import { getPiRewindHistory } from '../../session-store/rewind';

// Reviewer integrity tests: a rewind never modifies, deletes or restores a protected file on any path
// (forward, both rollback shapes, raised cap, legacy v2, LFS), the preview never hashes an over-cap
// file, and only per-conversation refs keep folder repo commits alive.

const MB = 1024 * 1024;

let root: string;
let cwd: string;
let cap = MB;
let turn = 0;

function sessionFile(name: string): string {
  const file = path.join(root, 'sessions', `${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  return file;
}

function producer(sessionId: string, file = sessionFile(sessionId)): AutoCheckpointProducer {
  return new AutoCheckpointProducer({
    sessionId,
    sessionFile: file,
    cwd,
    maxFileSizeBytes: () => cap,
    createTurnId: () => `turn-${++turn}`,
    now: () => new Date(),
  });
}

function folderGitDir(): string {
  return getGitDir(getFolderRepoDir(folderIdFor(cwd)));
}

function git(gitDir: string, args: string[]): string {
  return execFileSync('git', [`--git-dir=${gitDir}`, ...args], { maxBuffer: 64 * MB }).toString();
}

function commitExists(gitDir: string, commit: string): boolean {
  try {
    execFileSync('git', [`--git-dir=${gitDir}`, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function largestBlob(gitDir: string): number {
  const sizes = git(gitDir, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectsize)'])
    .split('\n')
    .filter((l) => l.startsWith('blob '))
    .map((l) => Number(l.split(' ')[1]));
  return Math.max(0, ...sizes);
}

function write(rel: string, content: string | Buffer): void {
  const full = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function hashOf(rel: string): string | null {
  const full = path.join(cwd, rel);
  return fs.existsSync(full) ? createHash('sha256').update(fs.readFileSync(full)).digest('hex') : null;
}

function hashes(rels: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(rels.map((r) => [r, hashOf(r)]));
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

type GitFn = (this: RepoManager, args: string[], options?: unknown) => Promise<{ stdout: string; stderr: string }>;
const gitProto = RepoManager.prototype as unknown as { git: GitFn };

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-integrity-'));
  cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  cap = MB;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(getFolderRepoDir(folderIdFor(cwd)), { recursive: true, force: true });
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('rewind protection (integrity)', { timeout: 120_000 }, () => {
  async function setUpTurnThenDrift(): Promise<{ p: AutoCheckpointProducer; entry: CheckpointEntryV3; tracked: string[] }> {
    write('notes.txt', 'v1\n');
    write('grow.dat', 'small at first\n');
    write('clip.mp4', 'video v1');
    write('big.bin', Buffer.alloc(2 * MB, 1));
    const p = producer('session-a');
    const entry = await turnOf(p, 'u1', () => {
      write('notes.txt', 'v2\n');
      write('created.txt', 'made this turn\n');
    });
    const listed = await readSkippedManifest(entry, cwd);
    expect(listed.ok && listed.value.map((f) => f.path).sort()).toEqual(['big.bin', 'clip.mp4']);
    // Drift after the turn: a captured small file grows over the cap, protected files change, a new one appears.
    write('grow.dat', Buffer.alloc(2 * MB, 2));
    write('clip.mp4', 'video v2');
    write('big.bin', Buffer.alloc(2 * MB, 3));
    write('huge2.bin', Buffer.alloc(3 * MB, 4));
    return { p, entry, tracked: ['notes.txt', 'created.txt', 'grow.dat', 'clip.mp4', 'big.bin', 'huge2.bin'] };
  }

  it('rollback after a forward read-tree that never ran leaves every file as it was, protected or not', async () => {
    const { p, entry, tracked } = await setUpTurnThenDrift();
    const before = hashes(tracked);
    const original = gitProto.git;
    vi.spyOn(gitProto, 'git').mockImplementation(function (this: RepoManager, args, options) {
      if (args[0] === 'read-tree' && args.includes('-m')) return Promise.reject(new Error('injected forward failure'));
      return original.call(this, args, options);
    });
    const result = await p.restore(entry);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('injected forward failure') });
    expect(result).not.toHaveProperty('rollbackError');
    expect(hashes(tracked)).toEqual(before);
    expect(largestBlob(folderGitDir())).toBeLessThan(MB);
  });

  it('rollback after a forward read-tree that rewrote the tree restores the pre-rewind state and never touches a protected file', async () => {
    const { p, entry, tracked } = await setUpTurnThenDrift();
    const before = hashes(tracked);
    const original = gitProto.git;
    let forwardRan = false;
    let cleanFailed = false;
    vi.spyOn(gitProto, 'git').mockImplementation(function (this: RepoManager, args, options) {
      if (args[0] === 'read-tree' && args.includes('-m')) forwardRan = true;
      if (forwardRan && !cleanFailed && args[0] === 'clean') {
        cleanFailed = true;
        return Promise.reject(new Error('injected clean failure'));
      }
      return original.call(this, args, options);
    });
    const result = await p.restore(entry);
    expect(forwardRan).toBe(true);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('injected clean failure') });
    expect(result).not.toHaveProperty('rollbackError');
    expect(hashes(tracked)).toEqual(before);
  });

  it('forward restore rewinds tracked files and leaves over-cap, grown, category and newer over-cap files alone', async () => {
    const { p, entry } = await setUpTurnThenDrift();
    const protectedBefore = hashes(['grow.dat', 'clip.mp4', 'big.bin', 'huge2.bin']);
    expect(await p.restore(entry)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8')).toBe('v1\n');
    expect(fs.existsSync(path.join(cwd, 'created.txt'))).toBe(false);
    expect(hashes(['grow.dat', 'clip.mp4', 'big.bin', 'huge2.bin'])).toEqual(protectedBefore);
    expect(largestBlob(folderGitDir())).toBeLessThan(MB);
    // No shared HEAD chain: the folder repo's HEAD stays unborn through snapshots and a restore.
    expect(() => git(folderGitDir(), ['rev-parse', '--verify', '-q', 'HEAD'])).toThrow();
  });

  it('a file the target snapshot skipped stays untouched after the cap is raised, with or without a later snapshot', async () => {
    write('a.txt', 'a1\n');
    write('model.dat', Buffer.alloc(2 * MB, 5));
    const p = producer('session-a');
    const entry = await turnOf(p, 'u1', () => write('a.txt', 'a2\n'));
    expect(await readSkippedManifest(entry, cwd)).toEqual({ ok: true, value: [{ path: 'model.dat', bytes: 2 * MB, reason: 'size' }] });

    cap = 10 * MB;
    write('model.dat', Buffer.alloc(2 * MB, 6));
    let expected = hashOf('model.dat');
    expect(await p.restore(entry)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('a1\n');
    expect(hashOf('model.dat')).toBe(expected);

    // Under the raised cap the next snapshot captures model.dat; a rewind to u1 must still skip it.
    const second = await turnOf(p, 'u2', () => write('a.txt', 'a3\n'));
    expect(second.skipped.totalCount).toBe(0);
    write('model.dat', Buffer.alloc(2 * MB, 7));
    expected = hashOf('model.dat');
    expect(await p.restore(entry)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('a1\n');
    expect(hashOf('model.dat')).toBe(expected);
  });

  it('a legacy v2 restore never deletes, restores or hashes a file over the current cap', async () => {
    const file = sessionFile('legacy');
    const repoDir = getRepoDir(file);
    const legacy = new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), cwd);
    try {
      write('a.txt', 'legacy v1\n');
      write('grow.dat', 'small\n');
      write('clip.mp4', 'legacy video v1');
      await legacy.ensureReady(CHECKPOINT_EXCLUDE_SET);
      const before = await legacy.checkpoint('u1');
      const entry: CheckpointEntryV2 = {
        v: 2, kind: 'checkpoint', turnId: 't1', userEntryId: 'u1', beforeCommit: before, afterCommit: before,
        prompt: 'legacy', fileCount: 0, fileChanges: [], createdAt: new Date().toISOString(),
      };
      write('a.txt', 'legacy v2\n');
      write('grow.dat', Buffer.alloc(2 * MB, 8));
      write('big.bin', Buffer.alloc(2 * MB, 9));
      write('clip.mp4', 'legacy video v2');
      const protectedBefore = hashes(['grow.dat', 'big.bin']);

      expect(await producer('legacy', file).restore(entry)).toMatchObject({ ok: true });
      expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('legacy v1\n');
      expect(hashes(['grow.dat', 'big.bin'])).toEqual(protectedBefore);
      // Legacy repos keep their own exclude set: a small video they captured is restored as before.
      expect(fs.readFileSync(path.join(cwd, 'clip.mp4'), 'utf8')).toBe('legacy video v1');
      expect(largestBlob(getGitDir(repoDir))).toBeLessThan(MB);
    } finally {
      await fs.promises.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('a path the project later marks filter=lfs is never restored to its captured version', async () => {
    cap = 25 * MB;
    write('model.bin', 'weights v1');
    write('a.txt', 'a1\n');
    const p = producer('session-a');
    const first = await turnOf(p, 'u1', () => write('a.txt', 'a2\n'));
    expect(git(folderGitDir(), ['ls-tree', '-r', '--name-only', first.beforeCommit]).split('\n')).toContain('model.bin');

    write('.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n*.psd filter=lfs diff=lfs merge=lfs -text\n');
    write('design.psd', 'psd v1');
    write('model.bin', 'weights v2');
    const second = await turnOf(p, 'u2');
    const secondTree = git(folderGitDir(), ['ls-tree', '-r', '--name-only', second.beforeCommit]).split('\n');
    expect(secondTree).not.toContain('model.bin');
    expect(secondTree).not.toContain('design.psd');
    expect(second.skipped.patterns?.map((s) => s.reason)).toEqual(['lfs', 'lfs']);

    write('model.bin', 'weights v3');
    write('design.psd', 'psd v2');
    expect(await p.restore(second)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(cwd, 'model.bin'), 'utf8')).toBe('weights v3');
    expect(fs.readFileSync(path.join(cwd, 'design.psd'), 'utf8')).toBe('psd v2');

    expect(await p.restore(first)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('a1\n');
    expect(fs.readFileSync(path.join(cwd, 'model.bin'), 'utf8')).toBe('weights v3');
    expect(fs.readFileSync(path.join(cwd, 'design.psd'), 'utf8')).toBe('psd v2');
  });
});

describe('refs are the only thing keeping folder repo commits alive (integrity)', { timeout: 120_000 }, () => {
  it('gc --prune=now keeps every commit a live entry names and drops a deleted conversation\'s own commits', async () => {
    cap = 25 * MB;
    write('a.txt', 'a1\n');
    const a = producer('session-a');
    const a1 = await turnOf(a, 'a1', () => write('a.txt', 'a2\n'));
    const snap = await a.snapshot('compaction-1');
    if (!snap.ok) throw new Error(snap.message);
    const late = a.turnStart({ userEntryId: 'a2', prompt: 'late' });
    a.markNotRewindable('a2', 'baseline-timeout', { tool: 'Edit', waitSeconds: 30 });
    expect((await late).ok).toBe(true);
    const lateRecord = await a.finalizeRun();
    expect(lateRecord).toMatchObject({ ok: true, record: { kind: 'not-rewindable' } });

    const b = producer('session-b');
    const b1 = await turnOf(b, 'b1', () => write('b.txt', 'b\n'));

    const gitDir = folderGitDir();
    const refsOf = (id: string): string[] =>
      git(gitDir, ['for-each-ref', '--format=%(refname)', `refs/damocles/sessions/${id}/`]).split('\n').filter(Boolean);
    expect(refsOf('session-a').some((r) => r.includes('/a2/'))).toBe(false);

    const maintenance = await runCheckpointMaintenance({ baseDir: path.join(root, 'no-session-repos'), throttleMs: 0, retentionDays: 30 });
    expect(maintenance.failures).toBe(0);
    git(gitDir, ['gc', '--quiet', '--prune=now']);
    for (const commit of [a1.beforeCommit, a1.afterCommit, snap.entry.beforeCommit, b1.beforeCommit, b1.afterCommit]) {
      expect(commitExists(gitDir, commit)).toBe(true);
    }

    await deleteSessionCheckpointRefs(cwd, 'session-a', await folderIdsInSessionFile(sessionFile('session-a')));
    git(gitDir, ['gc', '--quiet', '--prune=now']);
    for (const commit of [a1.beforeCommit, a1.afterCommit, snap.entry.beforeCommit]) {
      expect(commitExists(gitDir, commit)).toBe(false);
    }
    expect(commitExists(gitDir, b1.beforeCommit)).toBe(true);
    expect(commitExists(gitDir, b1.afterCommit)).toBe(true);
    git(gitDir, ['fsck', '--connectivity-only', '--no-dangling']);
  });
});

describe('rewind preview (integrity)', { timeout: 120_000 }, () => {
  it('never hashes an over-cap file into the folder repo and never lists a protected file', async () => {
    await initPiLoader();
    const pi = getPiCodingAgent();
    if (!pi) throw new Error('pi coding-agent failed to load');
    const sm: SessionManager = pi.SessionManager.create(cwd, ensurePiSessionDir(cwd));
    type Message = Parameters<SessionManager['appendMessage']>[0];
    const userId = sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'turn' }], timestamp: Date.now() } as Message);
    sm.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    } as unknown as Message);

    write('notes.txt', 'v1\n');
    write('grow.dat', 'small\n');
    const p = producer(sm.getSessionId(), sm.getSessionFile()!);
    const entry = await turnOf(p, userId, () => write('notes.txt', 'v2\n'));
    sm.appendCustomEntry('damocles-checkpoint', entry);

    write('huge.bin', Buffer.alloc(3 * MB, 1));
    write('grow.dat', Buffer.alloc(2 * MB, 2));
    const history = await getPiRewindHistory(cwd, sm.getSessionId(), cap);
    const item = history.items.find((h) => h.messageId === userId);
    expect(item?.files?.map((f) => f.displayName)).toEqual(['notes.txt']);
    expect(largestBlob(folderGitDir())).toBeLessThan(MB);
  });

  it('never hashes an over-cap file that the user-global gitignore matches', async () => {
    // git reads ~/.config/git/ignore of the hermetic home; the preview must ignore it as a restore does.
    const globalIgnore = path.join(os.homedir(), '.config', 'git', 'ignore');
    const xdg = process.env['XDG_CONFIG_HOME'];
    delete process.env['XDG_CONFIG_HOME'];
    fs.mkdirSync(path.dirname(globalIgnore), { recursive: true });
    fs.writeFileSync(globalIgnore, '*.sqlite\n');
    try {
      await initPiLoader();
      const pi = getPiCodingAgent();
      if (!pi) throw new Error('pi coding-agent failed to load');
      const sm: SessionManager = pi.SessionManager.create(cwd, ensurePiSessionDir(cwd));
      type Message = Parameters<SessionManager['appendMessage']>[0];
      const userId = sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'turn' }], timestamp: Date.now() } as Message);
      write('notes.txt', 'v1\n');
      const p = producer(sm.getSessionId(), sm.getSessionFile()!);
      sm.appendCustomEntry('damocles-checkpoint', await turnOf(p, userId, () => write('notes.txt', 'v2\n')));

      write('db.sqlite', Buffer.alloc(3 * MB, 1));
      await getPiRewindHistory(cwd, sm.getSessionId(), cap);
      expect(largestBlob(folderGitDir())).toBeLessThan(MB);
    } finally {
      fs.rmSync(globalIgnore, { force: true });
      if (xdg !== undefined) process.env['XDG_CONFIG_HOME'] = xdg;
    }
  });
});
