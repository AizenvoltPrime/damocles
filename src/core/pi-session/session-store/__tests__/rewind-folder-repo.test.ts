import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { getPiCodingAgent, initPiLoader } from '../../pi-loader';
import { ensurePiSessionDir } from '../session-dir';
import { getPiFileCheckpointContent, getPiRewindHistory, getPiSkippedFiles } from '../rewind';
import { deletePiSession } from '../mutations';
import {
  AutoCheckpointProducer,
  CHECKPOINT_EXCLUDE_SET,
  RepoManager,
  folderIdFor,
  getFolderRepoDir,
  getGitDir,
  getIndexPath,
  getRepoDir,
  type CheckpointEntryV2,
  type CheckpointRecord,
} from '../../checkpoints';
import { GIT_DIR_MAX_LENGTH } from '../../checkpoints/resolver';

const MB = 1024 * 1024;
const CAP = 25 * MB;

type Message = Parameters<SessionManager['appendMessage']>[0];
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }) as Message;
const assistant = (text: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }) as unknown as Message;

let root: string;
let cwd: string;

function write(rel: string, content: string): void {
  const full = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(cwd, rel), 'utf8');
}

function folderRefs(prefix = 'refs/damocles/sessions/'): string[] {
  const gitDir = getGitDir(getFolderRepoDir(folderIdFor(cwd)));
  return execFileSync('git', [`--git-dir=${gitDir}`, 'for-each-ref', '--format=%(refname)', prefix]).toString().split('\n').filter(Boolean);
}

async function newSession(): Promise<SessionManager> {
  await initPiLoader();
  const pi = getPiCodingAgent();
  if (!pi) throw new Error('pi coding-agent failed to load');
  return pi.SessionManager.create(cwd, ensurePiSessionDir(cwd));
}

function producerFor(sm: SessionManager): AutoCheckpointProducer {
  return new AutoCheckpointProducer({
    sessionId: sm.getSessionId(),
    sessionFile: sm.getSessionFile()!,
    cwd,
    maxFileSizeBytes: () => CAP,
    createTurnId: () => 'turn',
    now: () => new Date(),
  });
}

async function finalized(p: AutoCheckpointProducer, userEntryId: string, during: () => void): Promise<CheckpointRecord> {
  const started = await p.turnStart({ userEntryId, prompt: userEntryId });
  if (!started.ok) throw new Error(started.message);
  during();
  const result = await p.finalizeRun();
  if (!result.ok) throw new Error('finalize failed');
  return result.record;
}

beforeAll(async () => {
  // Short and outside the sandboxed os.tmpdir(), because the legacy repo's GIT_DIR nests the encoded
  // cwd under the test home (see AC5 below).
  root = await fs.promises.mkdtemp(path.join(inject('realTmpDir'), 'rw-'));
  cwd = root;
});

afterAll(async () => {
  await fs.promises.rm(getFolderRepoDir(folderIdFor(cwd)), { recursive: true, force: true });
  await fs.promises.rm(root, { recursive: true, force: true });
});

// Real pi session files and real git; the ceiling detects a hang, not ordinary slowness.
describe('rewind history, file content and delete across legacy and folder checkpoints', { timeout: 120_000 }, () => {
  let sm: SessionManager;
  let legacyEntry: CheckpointEntryV2;
  let u1 = '';
  let u2 = '';
  let u3 = '';

  it('AC5: a conversation holding a legacy v2 checkpoint, then v3 turns and a not-rewindable turn', async () => {
    sm = await newSession();
    u1 = sm.appendMessage(user('legacy turn'));
    sm.appendMessage(assistant('ok'));

    // The old layout: a per-session repo at getRepoDir(sessionFile), commits chained on HEAD.
    write('legacy.txt', 'legacy before\n');
    const repoDir = getRepoDir(sm.getSessionFile()!);
    // The legacy layout only ever existed where its GIT_DIR fit git's limit; a longer %TEMP% cannot host this fixture.
    expect(getGitDir(repoDir).length, `legacy fixture GIT_DIR too long for git: ${getGitDir(repoDir)}`).toBeLessThanOrEqual(GIT_DIR_MAX_LENGTH);
    const legacy = new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), cwd);
    await legacy.ensureReady(CHECKPOINT_EXCLUDE_SET);
    const before = await legacy.checkpoint(u1);
    write('legacy.txt', 'legacy after\n');
    const after = await legacy.checkpoint(u1);
    legacyEntry = {
      v: 2, kind: 'checkpoint', turnId: 't1', userEntryId: u1, beforeCommit: before, afterCommit: after, prompt: 'legacy turn',
      fileCount: 1, fileChanges: [{ path: 'legacy.txt', added: 1, removed: 1 }], createdAt: new Date(Date.now() - 3000).toISOString(),
    };
    sm.appendCustomEntry('damocles-checkpoint', legacyEntry);

    u2 = sm.appendMessage(user('folder turn'));
    sm.appendMessage(assistant('ok'));
    write('clip.mp4', 'video');
    write('folder.txt', 'folder before\n');
    const p = producerFor(sm);
    sm.appendCustomEntry('damocles-checkpoint', await finalized(p, u2, () => write('folder.txt', 'folder after\n')));

    u3 = sm.appendMessage(user('timed out turn'));
    sm.appendMessage(assistant('ok'));
    const late = p.turnStart({ userEntryId: u3, prompt: 'x' });
    p.markNotRewindable(u3, 'baseline-timeout', { tool: 'Edit', waitSeconds: 30 });
    await late;
    const record = await p.finalizeRun();
    if (!record.ok) throw new Error('no record');
    sm.appendCustomEntry('damocles-checkpoint', record.record);
    expect(folderRefs().some((r) => r.includes(`/${u3}/`))).toBe(false);
  });

  it('AC5: history lists the legacy turn with its live diff, the folder turn with its skips, and the not-rewindable turn', async () => {
    const { items, restorePoints } = await getPiRewindHistory(cwd, sm.getSessionId(), CAP);
    expect(restorePoints).toEqual([]);
    const byId = new Map(items.map((i) => [i.messageId, i]));
    expect(byId.get(u1)).toMatchObject({ kind: 'prompt', filesAffected: 3 });
    expect(byId.get(u1)?.files?.map((f) => f.displayName).sort()).toEqual(['clip.mp4', 'folder.txt', 'legacy.txt']);
    expect(byId.get(u2)?.skipped).toMatchObject({ totalCount: 1, byReason: { category: { count: 1, bytes: 5 } } });
    expect(await getPiSkippedFiles(cwd, sm.getSessionId(), { kind: 'turn', userEntryId: u2 })).toEqual({ ok: true, value: [{ path: 'clip.mp4', bytes: 5, reason: 'category' }] });
    expect(await getPiSkippedFiles(cwd, sm.getSessionId(), { kind: 'turn', userEntryId: u1 })).toMatchObject({ ok: false });
    expect(byId.get(u2)?.files?.map((f) => f.displayName)).toEqual(['folder.txt']);
    expect(byId.get(u3)).toMatchObject({ filesAffected: 0, notRewindable: { reason: 'baseline-timeout', params: { tool: 'Edit', waitSeconds: 30 } } });
  });

  it('AC5: file content before a turn comes from the repo each entry names', async () => {
    expect(await getPiFileCheckpointContent(cwd, sm.getSessionId(), u1, path.join(cwd, 'legacy.txt'))).toBe('legacy before\n');
    expect(await getPiFileCheckpointContent(cwd, sm.getSessionId(), u2, path.join(cwd, 'folder.txt'))).toBe('folder before\n');
  });

  // The legacy repo never had category excludes, so a video created after its checkpoint is removed like any later file.
  it('AC5: a legacy entry restores from its per-session repo exactly as before', async () => {
    const p = producerFor(sm);
    const result = await p.restore(legacyEntry);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(read('legacy.txt')).toBe('legacy before\n');
    expect(fs.existsSync(path.join(cwd, 'clip.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'folder.txt'))).toBe(false);

    // The state before the rewind went to the folder repo and is listed, with its own skipped list, for an undo.
    const pre = result.preRewind;
    expect(pre).toMatchObject({ v: 3, kind: 'pre-rewind', folderId: folderIdFor(cwd), target: { kind: 'turn', userEntryId: u1 } });
    sm.appendCustomEntry('damocles-checkpoint', pre);
    const { restorePoints } = await getPiRewindHistory(cwd, sm.getSessionId(), CAP);
    expect(restorePoints).toMatchObject([{ id: pre.id, target: { kind: 'turn', userEntryId: u1 } }]);
    expect(restorePoints[0]?.files?.map((f) => f.displayName).sort()).toEqual(['folder.txt', 'legacy.txt']);
    expect(await getPiSkippedFiles(cwd, sm.getSessionId(), { kind: 'restore-point', id: pre.id })).toEqual({
      ok: true,
      value: [{ path: 'clip.mp4', bytes: 5, reason: 'category' }],
    });

    const undo = await p.restorePreRewind(pre);
    if (!undo.ok) throw new Error(JSON.stringify(undo));
    expect(undo.preRewind.target).toEqual({ kind: 'undo', preRewindId: pre.id });
    expect(read('legacy.txt')).toBe('legacy after\n');
    expect(read('folder.txt')).toBe('folder after\n');
  });

  it('AC4: deleting the conversation removes its refs and its legacy repo, and leaves another conversation alone', async () => {
    const other = await newSession();
    const o1 = other.appendMessage(user('other'));
    other.appendMessage(assistant('ok'));
    other.appendCustomEntry('damocles-checkpoint', await finalized(producerFor(other), o1, () => write('o.txt', 'o\n')));
    const legacyDir = getRepoDir(sm.getSessionFile()!);
    expect(folderRefs(`refs/damocles/sessions/${sm.getSessionId()}/`).length).toBeGreaterThan(0);

    const { refsDeleted } = await deletePiSession(cwd, sm.getSessionId());
    await refsDeleted;

    expect(folderRefs(`refs/damocles/sessions/${sm.getSessionId()}/`)).toEqual([]);
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(folderRefs(`refs/damocles/sessions/${other.getSessionId()}/`)).toHaveLength(2);
  });

  // A first baseline of a large folder holds the folder lock for minutes; the delete must not wait on it.
  it('removes the session file while another holder keeps the folder lock, and its refs once the lock frees', async () => {
    const doomed = await newSession();
    const d1 = doomed.appendMessage(user('doomed'));
    doomed.appendMessage(assistant('ok'));
    doomed.appendCustomEntry('damocles-checkpoint', await finalized(producerFor(doomed), d1, () => write('d.txt', 'd\n')));
    const file = doomed.getSessionFile()!;
    const prefix = `refs/damocles/sessions/${doomed.getSessionId()}/`;
    expect(folderRefs(prefix).length).toBeGreaterThan(0);

    const repo = new RepoManager(getGitDir(getFolderRepoDir(folderIdFor(cwd))), getIndexPath(getFolderRepoDir(folderIdFor(cwd))), cwd);
    let releaseLock!: () => void;
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => { lockHeld = resolve; });
    const holding = repo.withLock(() => {
      lockHeld();
      return new Promise<void>((resolve) => { releaseLock = resolve; });
    });
    await held;

    const { refsDeleted } = await deletePiSession(cwd, doomed.getSessionId());
    expect(fs.existsSync(file)).toBe(false);
    expect(folderRefs(prefix).length).toBeGreaterThan(0);

    releaseLock();
    await holding;
    await refsDeleted;
    expect(folderRefs(prefix)).toEqual([]);
  });
});
