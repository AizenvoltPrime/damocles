import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutoCheckpointProducer } from '../auto-checkpoint';
import { folderIdFor, getFolderRepoDir, getGitDir } from '../resolver';
import type { CheckpointEntryV3, CheckpointRecord } from '../types';

const MB = 1024 * 1024;

interface Harness {
  root: string;
  cwd: string;
  sessionFile: string;
}

let h: Harness;
let turn = 0;

function makeProducer(sessionId = 'session-a', sessionFile = h.sessionFile): AutoCheckpointProducer {
  return new AutoCheckpointProducer({
    sessionId,
    sessionFile,
    cwd: h.cwd,
    maxFileSizeBytes: () => 25 * MB,
    createTurnId: () => `turn-${++turn}`,
    now: () => new Date('2026-06-18T12:00:00.000Z'),
  });
}

function gitDir(): string {
  return getGitDir(getFolderRepoDir(folderIdFor(h.cwd)));
}

function refs(): Record<string, string> {
  const out = execFileSync('git', [`--git-dir=${gitDir()}`, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/damocles/sessions/']).toString();
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]));
}

function write(rel: string, content: string): void {
  const full = path.join(h.cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function asEntry(record: CheckpointRecord | undefined): CheckpointEntryV3 {
  if (!record || record.kind !== 'checkpoint' || record.v !== 3) throw new Error(`expected a v3 checkpoint, got ${JSON.stringify(record)}`);
  return record;
}

beforeEach(async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-producer-'));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const sessionFile = path.join(root, 'sessions', 's.jsonl');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, '');
  h = { root, cwd, sessionFile };
});

afterEach(async () => {
  await fs.promises.rm(getFolderRepoDir(folderIdFor(h.cwd)), { recursive: true, force: true });
  await fs.promises.rm(h.root, { recursive: true, force: true });
});

// Real git on every case: the per-describe ceiling detects a hang, not worker contention.
describe('AutoCheckpointProducer (real git, folder repo)', { timeout: 60_000 }, () => {
  it('takes the baseline, refs it, and finalizes a v3 entry with the after-state', async () => {
    write('a.txt', 'one\n');
    const producer = makeProducer();
    expect(await producer.turnStart({ userEntryId: 'u1', prompt: 'p' })).toEqual({ ok: true, entries: [] });
    const before = refs()['refs/damocles/sessions/session-a/u1/before'];
    expect(before).toMatch(/^[0-9a-f]{40}$/);

    write('a.txt', 'one\ntwo\n');
    const finalized = await producer.finalizeRun();
    expect(finalized.ok).toBe(true);
    const entry = asEntry(finalized.ok ? finalized.record : undefined);
    expect(entry).toMatchObject({ v: 3, repo: 'folder', folderId: folderIdFor(h.cwd), userEntryId: 'u1', beforeCommit: before, fileCount: 1 });
    expect(entry.afterCommit).not.toBe(before);
    expect(refs()['refs/damocles/sessions/session-a/u1/after']).toBe(entry.afterCommit);
    // No shared HEAD chain: the commits are reachable only through the conversation's refs.
    expect(() => execFileSync('git', [`--git-dir=${gitDir()}`, 'rev-parse', '--verify', '-q', 'HEAD'], { stdio: 'ignore' })).toThrow();
    const folderJson = JSON.parse(fs.readFileSync(path.join(getFolderRepoDir(folderIdFor(h.cwd)), 'folder.json'), 'utf8'));
    expect(folderJson).toEqual({ path: path.resolve(h.cwd), layout: 1 });
  });

  it('dedups a repeated start for the pending turn and finalizes a different pending turn first', async () => {
    write('a.txt', 'one\n');
    const producer = makeProducer();
    await producer.turnStart({ userEntryId: 'u1', prompt: 'p1' });
    const refsAfterFirst = refs();
    expect(await producer.turnStart({ userEntryId: 'u1', prompt: 'again' })).toEqual({ ok: true, entries: [] });
    expect(refs()).toEqual(refsAfterFirst);

    write('b.txt', 'new\n');
    const second = await producer.turnStart({ userEntryId: 'u2', prompt: 'p2' });
    expect(second.ok).toBe(true);
    expect(second.entries).toHaveLength(1);
    expect(asEntry(second.entries[0]).userEntryId).toBe('u1');
    expect(asEntry(second.entries[0]).fileChanges).toEqual([{ path: 'b.txt', added: 1, removed: 0 }]);
    expect(refs()['refs/damocles/sessions/session-a/u2/before']).toMatch(/^[0-9a-f]{40}$/);
  });

  it('records the prompt given at turn start, and a second finalize has nothing to close', async () => {
    const producer = makeProducer();
    await producer.turnStart({ userEntryId: 'u1', prompt: 'the prompt' });
    const finalized = await producer.finalizeRun();
    expect(asEntry(finalized.ok ? finalized.record : undefined).prompt).toBe('the prompt');
    expect(await producer.finalizeRun()).toEqual({ ok: false });
  });

  it('a turn marked not rewindable while its baseline runs never gets a ref, and finalizes to its record', async () => {
    write('a.txt', 'one\n');
    const producer = makeProducer();
    const started = producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    producer.markNotRewindable('u1', 'baseline-timeout', { tool: 'Edit', waitSeconds: 30 });
    expect((await started).ok).toBe(true);
    expect(refs()).toEqual({});

    const finalized = await producer.finalizeRun();
    expect(finalized).toEqual({
      ok: true,
      record: { v: 3, kind: 'not-rewindable', userEntryId: 'u1', reason: 'baseline-timeout', params: { tool: 'Edit', waitSeconds: 30 }, createdAt: '2026-06-18T12:00:00.000Z' },
    });
    expect(refs()).toEqual({});
  });

  it('a turn marked after its baseline landed loses the baseline ref at finalize', async () => {
    const producer = makeProducer();
    await producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    expect(Object.keys(refs())).toEqual(['refs/damocles/sessions/session-a/u1/before']);
    producer.markNotRewindable('u1', 'baseline-timeout', { tool: 'Write', waitSeconds: 5 });
    producer.markNotRewindable('u1', 'baseline-failed', { error: 'second call does not win' });
    const finalized = await producer.finalizeRun();
    expect(finalized.ok && finalized.record.kind === 'not-rewindable' && finalized.record.reason).toBe('baseline-timeout');
    expect(refs()).toEqual({});
  });

  it('a failed baseline reports failure and finalizes to a baseline-failed record', async () => {
    const producer = makeProducer('bad/../id');
    const result = await producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('unsafe session id');
    const finalized = await producer.finalizeRun();
    expect(finalized.ok && finalized.record.kind === 'not-rewindable' && finalized.record.reason).toBe('baseline-failed');
    // The raw git or engine error travels only as a parameter; the webview words the reason.
    if (finalized.ok && finalized.record.kind === 'not-rewindable') {
      expect(Object.keys(finalized.record).sort()).toEqual(['createdAt', 'kind', 'params', 'reason', 'userEntryId', 'v']);
      expect(finalized.record.params.error).toContain('unsafe session id');
    }
  });

  it('refuses a second start for a finalized turn, so its refs are never rewritten or dropped', async () => {
    write('a.txt', 'one\n');
    const producer = makeProducer();
    await producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    write('a.txt', 'two\n');
    const first = await producer.finalizeRun();
    expect(asEntry(first.ok ? first.record : undefined).afterCommit).not.toBe(asEntry(first.ok ? first.record : undefined).beforeCommit);
    const refsAfterFinalize = refs();

    write('a.txt', 'three\n');
    expect(await producer.turnStart({ userEntryId: 'u1', prompt: 'again' })).toEqual({ ok: false, message: 'already-finalized', entries: [] });
    expect(producer.markNotRewindable('u1', 'baseline-timeout', { tool: 'Edit', waitSeconds: 30 })).toBe(false);
    expect(await producer.finalizeRun()).toEqual({ ok: false });
    expect(refs()).toEqual(refsAfterFinalize);
  });

  it('writes no ref after dispose, even for a baseline already queued', async () => {
    const producer = makeProducer();
    const started = producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    expect(producer.dispose()).toBe('u1');
    await started;
    expect(fs.existsSync(gitDir()) ? refs() : {}).toEqual({});
    expect(await producer.finalizeRun()).toEqual({ ok: false });
  });

  it('a compaction snapshot refs its commit and leaves the pending turn alone', async () => {
    write('a.txt', 'one\n');
    const producer = makeProducer();
    await producer.turnStart({ userEntryId: 'u1', prompt: 'p' });
    const snap = await producer.snapshot('c1');
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.entry).toMatchObject({ v: 3, userEntryId: 'c1', fileCount: 0 });
      expect(snap.entry.beforeCommit).toBe(snap.entry.afterCommit);
      expect(refs()['refs/damocles/sessions/session-a/c1/snapshot']).toBe(snap.entry.beforeCommit);
    }
    const finalized = await producer.finalizeRun();
    expect(asEntry(finalized.ok ? finalized.record : undefined).userEntryId).toBe('u1');
  });

  it('refuses an unsafe entry id before git sees it', async () => {
    const producer = makeProducer();
    const result = await producer.turnStart({ userEntryId: '--upload-pack=x', prompt: 'p' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('unsafe entry id');
  });
});
