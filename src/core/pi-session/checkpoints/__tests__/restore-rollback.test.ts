import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fault = vi.hoisted(() => ({ failApply: false, failRollback: false, applied: 0 }));

// Lets the forward `read-tree -u -m` apply the target fully, then fails it, so the restore takes its
// rollback path from a work tree the target already rewrote.
vi.mock('../exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec')>();
  return {
    ...actual,
    exec: async (...args: Parameters<typeof actual.exec>) => {
      const result = await actual.exec(...args);
      const argv = args[1];
      if (fault.failApply && argv.includes('read-tree') && argv.includes('-m') && argv.includes('-u')) {
        fault.applied++;
        throw new Error('injected failure after applying the target');
      }
      if (fault.failRollback && argv.includes('read-tree') && argv.includes('--reset')) throw new Error('injected rollback failure');
      return result;
    },
  };
});

import { AutoCheckpointProducer } from '../auto-checkpoint';
import { RepoManager } from '../repo-manager';
import { CHECKPOINT_EXCLUDE_SET, type CheckpointEntryV2 } from '../types';
import { folderIdFor, getFolderRepoDir, getGitDir, getIndexPath, getRepoDir } from '../resolver';

const MB = 1024 * 1024;
let root: string;
let cwd: string;

function write(rel: string, content: string | Buffer): void {
  const full = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(cwd, rel), 'utf8');
}

function producer(sessionFile: string): AutoCheckpointProducer {
  return new AutoCheckpointProducer({
    sessionId: 'session-a',
    sessionFile,
    cwd,
    maxFileSizeBytes: () => MB,
    createTurnId: () => 'turn',
    now: () => new Date(),
  });
}

beforeEach(async () => {
  fault.failApply = false;
  fault.failRollback = false;
  fault.applied = 0;
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-rollback-'));
  cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(getFolderRepoDir(folderIdFor(cwd)), { recursive: true, force: true });
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('restore rollback (real git, injected apply failure)', { timeout: 60_000 }, () => {
  it('folder repo: rolls every unprotected file back and never touches a protected one', async () => {
    write('notes.txt', 'v1\n');
    write('grow.dat', 'small\n');
    const sessionFile = path.join(root, 's.jsonl');
    fs.writeFileSync(sessionFile, '');
    const p = producer(sessionFile);
    await p.turnStart({ userEntryId: 'u1', prompt: 'p' });
    const finalized = await p.finalizeRun();
    if (!finalized.ok || finalized.record.kind !== 'checkpoint') throw new Error('no entry');

    write('notes.txt', 'v2\n');
    write('created.txt', 'later\n');
    write('clip.mp4', 'video made later');
    const grown = Buffer.alloc(2 * MB, 3);
    write('grow.dat', grown);

    fault.failApply = true;
    const result = await p.restore(finalized.record);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('injected failure') });
    expect(fault.applied).toBe(1);
    expect(result).not.toHaveProperty('rollbackError');
    expect(read('notes.txt')).toBe('v2\n');
    expect(read('created.txt')).toBe('later\n');
    expect(read('clip.mp4')).toBe('video made later');
    expect(fs.readFileSync(path.join(cwd, 'grow.dat')).equals(grown)).toBe(true);
  });

  it('folder repo: when the apply and its rollback both fail, the result keeps the pre-rewind snapshot, and an undo restores it', async () => {
    write('notes.txt', 'v1\n');
    const sessionFile = path.join(root, 's.jsonl');
    fs.writeFileSync(sessionFile, '');
    const p = producer(sessionFile);
    await p.turnStart({ userEntryId: 'u1', prompt: 'p' });
    const finalized = await p.finalizeRun();
    if (!finalized.ok || finalized.record.kind !== 'checkpoint') throw new Error('no entry');
    write('notes.txt', 'v2, the work the rewind must not lose\n');
    write('created.txt', 'later\n');

    fault.failApply = true;
    fault.failRollback = true;
    const result = await p.restore(finalized.record);
    expect(result).toMatchObject({ ok: false, reason: 'checkout-failed', error: expect.stringContaining('injected failure'), rollbackError: expect.stringContaining('injected rollback failure') });
    if (result.ok || result.reason !== 'checkout-failed') throw new Error('expected checkout-failed');
    const gitDir = getGitDir(getFolderRepoDir(folderIdFor(cwd)));
    const refName = `refs/damocles/sessions/session-a/_rewinds/${result.preRewind.id}/snapshot`;
    expect(execFileSync('git', [`--git-dir=${gitDir}`, 'rev-parse', refName]).toString().trim()).toBe(result.preRewind.commit);

    fault.failApply = false;
    fault.failRollback = false;
    expect(await p.restorePreRewind(result.preRewind)).toMatchObject({ ok: true });
    expect(read('notes.txt')).toBe('v2, the work the rewind must not lose\n');
    expect(read('created.txt')).toBe('later\n');
  });

  it('legacy per-session repo: a tracked file grown over the cap survives the rollback, and the repo excludes are unchanged', async () => {
    const sessionFile = path.join(root, 'sessions', '2026-01-01_legacy.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const repoDir = getRepoDir(sessionFile);
    const legacy = new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), cwd);
    await legacy.ensureReady(CHECKPOINT_EXCLUDE_SET);
    write('notes.txt', 'v1\n');
    write('grow.dat', 'small\n');
    const before = await legacy.checkpoint('u1');
    const exclude = fs.readFileSync(path.join(getGitDir(repoDir), 'info', 'exclude'), 'utf8');
    const entry: CheckpointEntryV2 = {
      v: 2, kind: 'checkpoint', turnId: 't', userEntryId: 'u1', beforeCommit: before, afterCommit: before,
      prompt: 'p', fileCount: 0, fileChanges: [], createdAt: new Date().toISOString(),
    };

    write('notes.txt', 'v2\n');
    const grown = Buffer.alloc(2 * MB, 5);
    write('grow.dat', grown);
    const p = producer(sessionFile);

    fault.failApply = true;
    expect((await p.restore(entry)).ok).toBe(false);
    expect(read('notes.txt')).toBe('v2\n');
    expect(fs.readFileSync(path.join(cwd, 'grow.dat')).equals(grown)).toBe(true);

    fault.failApply = false;
  fault.failRollback = false;
    expect(await p.restore(entry)).toMatchObject({ ok: true });
    expect(read('notes.txt')).toBe('v1\n');
    expect(fs.readFileSync(path.join(cwd, 'grow.dat')).equals(grown)).toBe(true);
    expect(fs.readFileSync(path.join(getGitDir(repoDir), 'info', 'exclude'), 'utf8')).toBe(exclude);
    execFileSync('git', [`--git-dir=${getGitDir(repoDir)}`, 'cat-file', '-e', `${before}^{commit}`]);
  });
});
