import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { CheckpointService, type CheckpointTreeReader } from '../checkpoint-service';
import { execSafe, folderRepoFor, getGitDir, withRepoLock, type StoredCheckpointRecord } from '../checkpoints';

/**
 * The gate's bounded wait against the real producer and a real folder repo, with the baseline held
 * back by another holder of the folder lock (as a second conversation or window would).
 */

const made: string[] = [];
const services: CheckpointService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.drain(60_000);
    service.dispose();
  }
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function reader(sessionFile: string): CheckpointTreeReader {
  const entries = [{ type: 'message', id: 'u1', parentId: null, timestamp: '', message: { role: 'user', content: [] } } as unknown as SessionEntry];
  return { getBranch: () => entries, getLeafId: () => 'u1', getSessionFile: () => sessionFile, getEntries: () => entries };
}

function setup(sessionId: string, waitMs: number) {
  const cwd = tempDir('dam-wait-cwd-');
  // The folder repo lives under the hermetic home, outside the temp dir.
  made.push(folderRepoFor(cwd).repoDir);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'v1');
  const limit = { waitMs };
  const sessionFile = path.join(tempDir('dam-wait-sessions-'), `${sessionId}.jsonl`);
  const records: StoredCheckpointRecord[] = [];
  const notices: number[] = [];
  const service = new CheckpointService({
    cwd,
    sessionId,
    onCheckpointReady: () => undefined,
    persist: (record) => { records.push(record); return true; },
    onBaselineTimeout: (ms) => notices.push(ms),
    baselineWaitMs: () => limit.waitMs,
    maxFileSizeBytes: () => 25 * 1024 * 1024,
  });
  services.push(service);
  return { cwd, sm: reader(sessionFile), service, records, notices, limit };
}

/** Hold the folder repo's lock until the returned release is called. */
async function holdFolderLock(cwd: string): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let acquired!: () => void;
  const isAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  void withRepoLock(folderRepoFor(cwd).repoDir, async () => { acquired(); await held; });
  await isAcquired;
  return release;
}

/** 'settled' when `promise` settles within `ms`, else 'pending'. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<'settled' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); }),
  ]);
  clearTimeout(timer);
  return outcome;
}

async function sessionRefs(cwd: string, sessionId: string): Promise<string[]> {
  const listed = await execSafe('git', [`--git-dir=${getGitDir(folderRepoFor(cwd).repoDir)}`, 'for-each-ref', '--format=%(refname)', `refs/damocles/sessions/${sessionId}/`]);
  if (!listed.ok) throw new Error(listed.error);
  return listed.value.stdout.split('\n').filter(Boolean);
}

describe('bounded baseline wait with the real producer', () => {
  it('lets a file-changing tool run past the limit, marks the turn not rewindable once, and never uses the late snapshot', async () => {
    const { cwd, sm, service, records, notices, limit } = setup('sess-timeout', 300);
    const release = await holdFolderLock(cwd);
    service.startTurn(sm, 'u1', 'edit a.txt');

    const waitStarted = performance.now();
    await service.awaitBaseline(new AbortController().signal, 'Edit');
    const waitedMs = performance.now() - waitStarted;
    expect(waitedMs).toBeGreaterThanOrEqual(280);
    expect(waitedMs).toBeLessThan(5_000);
    expect(notices).toEqual([300]);

    // The tool proceeds while the baseline is still blocked, so the late snapshot holds its change.
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'v2 written by the tool');
    // With the lock still held and a long limit, only the turn's timed-out state can release this wait.
    limit.waitMs = 60_000;
    expect(await settlesWithin(service.awaitBaseline(new AbortController().signal, 'Write'), 5_000)).toBe('settled');
    expect(notices).toEqual([300]);

    release();
    service.onSettled();
    await expect.poll(() => records.length, { timeout: 60_000 }).toBe(1);
    expect(records[0]).toMatchObject({ kind: 'not-rewindable', userEntryId: 'u1', reason: 'baseline-timeout' });
    expect(records[0]).toMatchObject({ params: { tool: 'Edit', waitSeconds: 0 } });
    // No ref keeps the late snapshot, so nothing can rewind to it as this turn's before-state.
    expect(await sessionRefs(cwd, 'sess-timeout')).toEqual([]);
  }, 90_000);

  it('releases the waiter the moment the turn aborts, and the turn keeps its checkpoint', async () => {
    const { cwd, sm, service, records, notices } = setup('sess-abort', 60_000);
    const release = await holdFolderLock(cwd);
    service.startTurn(sm, 'u1', 'edit a.txt');

    const abort = new AbortController();
    const wait = service.awaitBaseline(abort.signal, 'Edit');
    expect(await settlesWithin(wait, 50)).toBe('pending');
    // The lock is held and the limit is a minute away, so only the abort can release the waiter.
    abort.abort();
    expect(await settlesWithin(wait, 5_000)).toBe('settled');
    expect(notices).toEqual([]);

    release();
    service.onSettled();
    await expect.poll(() => records.length, { timeout: 60_000 }).toBe(1);
    expect(records[0]).toMatchObject({ kind: 'checkpoint', v: 3, userEntryId: 'u1' });
    expect(await sessionRefs(cwd, 'sess-abort')).toContain('refs/damocles/sessions/sess-abort/u1/before');
  }, 90_000);
});

describe('an unchanged turn with the real producer', () => {
  it('records the baseline as its after-state and writes no after ref', async () => {
    const { cwd, sm, service, records } = setup('sess-same', 60_000);
    service.startTurn(sm, 'u1', 'read only');
    await service.awaitBaseline(new AbortController().signal, 'Edit');
    service.onSettled();
    await expect.poll(() => records.length, { timeout: 60_000 }).toBe(1);
    const record = records[0]!;
    if (record.kind !== 'checkpoint') throw new Error(`expected a checkpoint, got ${record.kind}`);
    expect(record.afterCommit).toBe(record.beforeCommit);
    expect(record.fileChanges).toEqual([]);
    expect(await sessionRefs(cwd, 'sess-same')).toEqual(['refs/damocles/sessions/sess-same/u1/before']);
  }, 90_000);
});
