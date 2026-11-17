import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installRelocations, relocationsSnapshot } from '../../../project-relocation/current';
import { RELOCATION_STEPS, type RelocationRecord, type RelocationStepState } from '../../../project-relocation/types';
import { piSessionDir } from '../../session-store/session-dir';
import { AutoCheckpointProducer } from '../auto-checkpoint';
import { markForkCopyPending, readSessionRegistration, registeredFileGone, repointRegistrationLocked } from '../folder-repo';
import { moveLegacyCheckpointRepo, withRepoLock } from '../lock';
import { ORPHAN_SESSION_GRACE_MS, runCheckpointMaintenance } from '../maintenance';
import { folderIdFor, getFolderRepoDir, getGitDir } from '../resolver';

// Maintenance's orphan rule across a project relocation (docs/invariants.md "Project relocation", the sweeps bullet): a moved
// conversation's refs are its rewind points, and a wrong orphan verdict deletes them for good.

let root: string;
let oldFolder: string;
let newFolder: string;
let turn = 0;

const fileIn = (folder: string, sessionId: string): string => path.join(piSessionDir(folder), `${sessionId}.jsonl`);

async function checkpointedSession(sessionId: string): Promise<void> {
  const sessionFile = fileIn(oldFolder, sessionId);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, '');
  const producer = new AutoCheckpointProducer({ sessionId, sessionFile, cwd: oldFolder, maxFileSizeBytes: () => 25 * 1024 * 1024, createTurnId: () => `turn-${++turn}`, now: () => new Date() });
  const started = await producer.turnStart({ userEntryId: `${sessionId}-u1`, prompt: 'p' });
  if (!started.ok) throw new Error(started.message);
  fs.writeFileSync(path.join(oldFolder, `${sessionId}.txt`), 'written this turn\n');
  const finalized = await producer.finalizeRun();
  if (!finalized.ok || finalized.record?.kind !== 'checkpoint') throw new Error(`expected a checkpoint, got ${JSON.stringify(finalized)}`);
}

const repoDir = (): string => getFolderRepoDir(folderIdFor(oldFolder));
const registrationFile = (sessionId: string): string => path.join(repoDir(), 'sessions', `${sessionId}.json`);

function refsOf(sessionId: string): string[] {
  return execFileSync('git', [`--git-dir=${getGitDir(repoDir())}`, 'for-each-ref', '--format=%(refname)', `refs/damocles/sessions/${sessionId}/`]).toString().split('\n').filter(Boolean);
}

function backDate(file: string, atMs: number): void {
  fs.utimesSync(file, new Date(atMs), new Date(atMs));
}

function relocation(state: RelocationRecord['state'], startedAt: number): RelocationRecord {
  const step: RelocationStepState = { state: state === 'coreDone' ? 'done' : 'pending' };
  const steps = Object.fromEntries(RELOCATION_STEPS.map((name) => [name, step])) as RelocationRecord['steps'];
  return { id: 'r1', seq: 1, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: oldFolder, to: newFolder, checkpointRepo: folderIdFor(oldFolder) }], chats: 2, state, steps, startedAt };
}

function install(records: readonly RelocationRecord[]): void {
  installRelocations(relocationsSnapshot(records, records));
}

function moveSessionFile(sessionId: string): void {
  fs.mkdirSync(piSessionDir(newFolder), { recursive: true });
  fs.renameSync(fileIn(oldFolder, sessionId), fileIn(newFolder, sessionId));
}

const sweep = (now: number) => runCheckpointMaintenance({ baseDir: path.join(root, 'no-session-repos'), throttleMs: 0, now: () => now });

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-relocate-maint-'));
  oldFolder = path.join(root, 'old');
  newFolder = path.join(root, 'new');
  fs.mkdirSync(oldFolder, { recursive: true });
  fs.writeFileSync(path.join(oldFolder, 'notes.txt'), 'first\n');
});

afterEach(async () => {
  installRelocations(undefined);
  vi.restoreAllMocks();
  await fs.promises.rm(repoDir(), { recursive: true, force: true });
  for (const folder of [oldFolder, newFolder]) await fs.promises.rm(piSessionDir(folder), { recursive: true, force: true });
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('checkpoint maintenance across a relocation (real git)', { timeout: 120_000 }, () => {
  it('skips a pending relocation\'s repo, keeps a re-pointed registration\'s date and fork flag, and follows a moved file through the move', async () => {
    for (const id of ['kept', 'repointed', 'gone']) await checkpointedSession(id);
    const registeredAtMs = Date.now() - 3_600_000;
    for (const id of ['kept', 'repointed', 'gone']) backDate(registrationFile(id), registeredAtMs);
    const fork = fileIn(oldFolder, 'fork');
    fs.writeFileSync(fork, '');
    await markForkCopyPending('fork', fork, new Set([folderIdFor(oldFolder)]));
    backDate(registrationFile('fork'), registeredAtMs);
    const pastGrace = Date.now() + ORPHAN_SESSION_GRACE_MS + 86_400_000;

    // A relocation in flight: its sessions step may have re-pointed a registration before the file's commit.
    install([relocation('running', Date.now())]);
    fs.rmSync(fileIn(oldFolder, 'gone'));
    const pending = await sweep(pastGrace);
    expect(pending).toMatchObject({ folderReposCollected: 0, orphanSessionsPruned: 0, failures: 0 });
    expect(refsOf('gone')).not.toEqual([]);

    await withRepoLock(repoDir(), () => repointRegistrationLocked(repoDir(), 'repointed', fileIn(oldFolder, 'repointed'), fileIn(newFolder, 'repointed')));
    await withRepoLock(repoDir(), () => repointRegistrationLocked(repoDir(), 'fork', fork, fileIn(newFolder, 'fork')));
    expect(await readSessionRegistration(repoDir(), 'repointed')).toEqual({ sessionFile: fileIn(newFolder, 'repointed'), registeredAtMs, pendingCopy: false });
    expect(await readSessionRegistration(repoDir(), 'fork')).toEqual({ sessionFile: fileIn(newFolder, 'fork'), registeredAtMs, pendingCopy: true });

    // The relocation finished; 'kept' was registered in a repo the sessions step did not re-point, so it names the old dir.
    for (const id of ['kept', 'repointed', 'fork']) moveSessionFile(id);
    install([relocation('coreDone', Date.now())]);
    const done = await sweep(pastGrace);
    expect(done).toMatchObject({ folderReposCollected: 1, orphanSessionsPruned: 1, failures: 0 });
    expect(refsOf('gone')).toEqual([]);
    expect(refsOf('kept')).not.toEqual([]);
    expect(refsOf('repointed')).not.toEqual([]);
    expect(await readSessionRegistration(repoDir(), 'kept')).toMatchObject({ sessionFile: fileIn(oldFolder, 'kept') });
  });

  it('while a relocation is pending, a registration naming the new dir finds its file still in the old one', async () => {
    const left = fileIn(oldFolder, 'left');
    fs.mkdirSync(path.dirname(left), { recursive: true });
    fs.writeFileSync(left, '');
    expect(await registeredFileGone(fileIn(newFolder, 'left'), Date.now())).toBe(true);
    install([relocation('paused', Date.now())]);
    expect(await registeredFileGone(fileIn(newFolder, 'left'), Date.now())).toBe(false);
  });
});

describe('moveLegacyCheckpointRepo', () => {
  it('moves nothing when age eviction removed the repo while the move waited for its lock', async () => {
    const fromDir = path.join(root, 'legacy', 'session-repo');
    const toDir = path.join(root, 'moved', 'session-repo');
    fs.mkdirSync(getGitDir(fromDir), { recursive: true });
    fs.writeFileSync(path.join(getGitDir(fromDir), 'HEAD'), 'ref: refs/heads/main\n');
    // Resolves once the move has seen the repo, so the eviction below lands during its lock wait.
    let sawRepo!: () => void;
    const seen = new Promise<void>((resolve) => (sawRepo = resolve));
    const access = fs.promises.access.bind(fs.promises);
    vi.spyOn(fs.promises, 'access').mockImplementation(async (target, mode) => {
      await access(target, mode);
      if (target === fromDir) sawRepo();
    });
    const rename = vi.fn(async () => undefined);

    let move: Promise<void> | undefined;
    await withRepoLock(fromDir, async () => {
      move = moveLegacyCheckpointRepo(fromDir, toDir, rename);
      await seen;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await fs.promises.rm(fromDir, { recursive: true, force: true });
    });
    await move;

    expect(rename).not.toHaveBeenCalled();
    expect(fs.existsSync(fromDir)).toBe(false);
    expect(fs.existsSync(toDir)).toBe(false);
  });
});
