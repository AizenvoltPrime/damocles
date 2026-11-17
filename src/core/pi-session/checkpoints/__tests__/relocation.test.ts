import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installRelocations, relocationsSnapshot } from '../../../project-relocation/current';
import { runCheckpointsStep } from '../../../project-relocation/steps/checkpoints';
import { RELOCATION_STEPS, type RelocationFolder, type RelocationRecord } from '../../../project-relocation/types';
import { AutoCheckpointProducer } from '../auto-checkpoint';
import { withRepoLock } from '../lock';
import { readSkippedManifest } from '../folder-repo';
import { folderIdFor, folderRepoIdOf, folderRepoIdsOf, getFolderRepoDir } from '../resolver';
import type { CheckpointEntryV3 } from '../types';

vi.mock('../lock', async (importOriginal) => {
  const lock = await importOriginal<typeof import('../lock')>();
  return { ...lock, withRepoLock: vi.fn(lock.withRepoLock) };
});

let root: string;
let oldFolder: string;
let newFolder: string;
let turn = 0;

function producer(sessionId: string, cwd: string): AutoCheckpointProducer {
  const sessionFile = path.join(root, 'sessions', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, '');
  return new AutoCheckpointProducer({ sessionId, sessionFile, cwd, maxFileSizeBytes: () => 25 * 1024 * 1024, createTurnId: () => `turn-${++turn}`, now: () => new Date() });
}

async function turnWriting(p: AutoCheckpointProducer, cwd: string, userEntryId: string, content: string): Promise<CheckpointEntryV3> {
  const started = await p.turnStart({ userEntryId, prompt: userEntryId });
  if (!started.ok) throw new Error(started.message);
  fs.writeFileSync(path.join(cwd, 'notes.txt'), content);
  const finalized = await p.finalizeRun();
  const record = finalized.ok ? finalized.record : undefined;
  if (record?.kind !== 'checkpoint' || record.v !== 3) throw new Error(`expected a v3 checkpoint, got ${JSON.stringify(record)}`);
  return record;
}

function coreDone(seq: number, folder: RelocationFolder): RelocationRecord {
  const steps = Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: 'done' }])) as RelocationRecord['steps'];
  return { id: `r${seq}`, seq, requestedBy: 'desktop', mode: folder.checkpointRepo ? 'locate' : 'merge', folders: [folder], chats: 0, state: 'coreDone', steps, startedAt: 1 };
}

function install(records: readonly RelocationRecord[]): void {
  installRelocations(relocationsSnapshot(records, records));
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-relocate-'));
  oldFolder = path.join(root, 'old');
  newFolder = path.join(root, 'new');
  fs.mkdirSync(oldFolder, { recursive: true });
  fs.writeFileSync(path.join(oldFolder, 'notes.txt'), 'first\n');
});

afterEach(async () => {
  for (const folder of [oldFolder, newFolder]) await fs.promises.rm(getFolderRepoDir(folderRepoIdOf(folder)), { recursive: true, force: true });
  installRelocations(undefined);
  for (const folder of [oldFolder, newFolder]) await fs.promises.rm(getFolderRepoDir(folderIdFor(folder)), { recursive: true, force: true });
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('checkpoints across a relocation (real git)', { timeout: 120_000 }, () => {
  it('a located folder continues in the old repo, and a rewind to a turn before the move restores into the new folder', async () => {
    const before = await turnWriting(producer('s-old', oldFolder), oldFolder, 'u1', 'second\n');
    fs.renameSync(oldFolder, newFolder);

    const folder: RelocationFolder = { kind: 'project', from: oldFolder, to: newFolder, checkpointRepo: folderRepoIdOf(oldFolder) };
    const empty = relocationsSnapshot([], []);
    expect(await runCheckpointsStep([folder], empty)).toEqual({ kind: 'done' });
    // the step is idempotent
    expect(await runCheckpointsStep([folder], empty)).toEqual({ kind: 'done' });
    install([coreDone(1, folder)]);

    expect(folderRepoIdOf(newFolder)).toBe(folderIdFor(oldFolder));
    expect(folderRepoIdsOf(newFolder)).toEqual(new Set([folderIdFor(newFolder), folderIdFor(oldFolder)]));
    expect(JSON.parse(fs.readFileSync(path.join(getFolderRepoDir(folderIdFor(oldFolder)), 'folder.json'), 'utf8'))).toMatchObject({ path: path.resolve(newFolder) });

    const moved = producer('s-old', newFolder);
    expect(await readSkippedManifest(before, newFolder)).toMatchObject({ ok: true });
    expect(await moved.restore(before)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(newFolder, 'notes.txt'), 'utf8')).toBe('first\n');
    // new turns go to the same repo, with no second repo for the new folder
    const after = await turnWriting(moved, newFolder, 'u2', 'third\n');
    expect(after.folderId).toBe(folderIdFor(oldFolder));
    expect(fs.existsSync(getFolderRepoDir(folderIdFor(newFolder)))).toBe(false);
  });

  it('a merge keeps the target repo for new turns, and still restores a turn the old folder recorded', async () => {
    fs.mkdirSync(newFolder, { recursive: true });
    fs.writeFileSync(path.join(newFolder, 'notes.txt'), 'target\n');
    await turnWriting(producer('s-target', newFolder), newFolder, 't1', 'target two\n');
    const before = await turnWriting(producer('s-old', oldFolder), oldFolder, 'u1', 'second\n');
    await fs.promises.rm(oldFolder, { recursive: true, force: true });

    const folder: RelocationFolder = { kind: 'project', from: oldFolder, to: newFolder };
    await runCheckpointsStep([folder], relocationsSnapshot([], []));
    install([coreDone(1, folder)]);

    expect(folderRepoIdOf(newFolder)).toBe(folderIdFor(newFolder));
    expect(folderRepoIdsOf(newFolder).has(folderIdFor(oldFolder))).toBe(true);
    const merged = producer('s-old', newFolder);
    expect(await merged.restore(before)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(newFolder, 'notes.txt'), 'utf8')).toBe('first\n');
  });

  it('a folder re-added where a located project was writes its own repo and restores from it, and the moved project still restores', async () => {
    const before = await turnWriting(producer('s-old', oldFolder), oldFolder, 'u1', 'second\n');
    fs.renameSync(oldFolder, newFolder);
    const folder: RelocationFolder = { kind: 'project', from: oldFolder, to: newFolder, checkpointRepo: folderRepoIdOf(oldFolder) };
    await runCheckpointsStep([folder], relocationsSnapshot([], []));
    install([coreDone(1, folder)]);

    fs.mkdirSync(oldFolder, { recursive: true });
    fs.writeFileSync(path.join(oldFolder, 'notes.txt'), 'reborn\n');
    const reborn = producer('s-reborn', oldFolder);
    const first = await turnWriting(reborn, oldFolder, 'r1', 'reborn two\n');
    expect(first.folderId).not.toBe(folderIdFor(oldFolder));
    expect(folderRepoIdsOf(oldFolder).has(folderIdFor(oldFolder))).toBe(false);
    expect(await readSkippedManifest(first, oldFolder)).toMatchObject({ ok: true });
    expect(await reborn.restore(first)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(oldFolder, 'notes.txt'), 'utf8')).toBe('reborn\n');
    // the re-added folder cannot restore the moved project's checkpoint, which still restores where that project is
    expect(await reborn.restore(before)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await producer('s-old', newFolder).restore(before)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(newFolder, 'notes.txt'), 'utf8')).toBe('first\n');
  });

  it('refuses a checkpoint of a folder that never moved to this one', async () => {
    const before = await turnWriting(producer('s-old', oldFolder), oldFolder, 'u1', 'second\n');
    fs.mkdirSync(newFolder, { recursive: true });
    expect(await producer('s-other', newFolder).restore(before)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await readSkippedManifest(before, newFolder)).toMatchObject({ ok: false });
  });

  it('leaves a repo whose folder.json does not hold a folder record, and still finishes the step', async () => {
    await turnWriting(producer('s-old', oldFolder), oldFolder, 'u1', 'second\n');
    const folderJson = path.join(getFolderRepoDir(folderIdFor(oldFolder)), 'folder.json');
    const folder: RelocationFolder = { kind: 'project', from: oldFolder, to: newFolder, checkpointRepo: folderIdFor(oldFolder) };
    for (const unreadable of ['{"path": "C:/half', 'null']) {
      fs.writeFileSync(folderJson, unreadable);
      expect(await runCheckpointsStep([folder], relocationsSnapshot([], []))).toEqual({ kind: 'done' });
      expect(fs.readFileSync(folderJson, 'utf8')).toBe(unreadable);
    }
  });

  it('never takes the lock of, or rewrites, the repo of a chat worktree\'s folder, which stays where it is', async () => {
    await turnWriting(producer('s-wt', oldFolder), oldFolder, 'u1', 'second\n');
    const folderJson = path.join(getFolderRepoDir(folderIdFor(oldFolder)), 'folder.json');
    const written = fs.statSync(folderJson).mtimeMs;
    vi.mocked(withRepoLock).mockClear();
    expect(await runCheckpointsStep([{ kind: 'worktree', from: oldFolder, to: oldFolder, worktreeId: 'w1' }], relocationsSnapshot([], []))).toEqual({ kind: 'done' });
    expect(withRepoLock).not.toHaveBeenCalled();
    expect(fs.statSync(folderJson).mtimeMs).toBe(written);
  });
});
