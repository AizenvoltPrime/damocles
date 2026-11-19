import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { folderIdFor } from '../../pi-session/checkpoints/folder-id';
import { registeredFileGone } from '../../pi-session/checkpoints/folder-repo';
import { folderRepoIdOf, folderRepoIdsOf } from '../../pi-session/checkpoints/resolver';
import { piSessionDir } from '../../pi-session/session-store/session-dir';
import { currentPathOf } from '../aliases';
import { currentRelocations, isRelocationPending } from '../current';
import { ProjectRelocations } from '../index';
import { parseJournal, RelocationStore } from '../store';
import { RELOCATION_STEPS, type RelocationStepName, type RelocationStepState } from '../types';

// Which relocations count as pending, and what an abandoned one leaves (docs/invariants.md "Project relocation").

let dir: string;
let journalFile: string;
let from: string;
let to: string;
const opened: Array<{ dispose(): void }> = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relocation-pending-')));
  journalFile = path.join(dir, 'project-relocations.json');
  from = path.join(dir, 'old');
  to = path.join(dir, 'new');
  fs.mkdirSync(to, { recursive: true });
});
afterEach(() => {
  for (const item of opened.splice(0)) item.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(): ProjectRelocations {
  const relocations = new ProjectRelocations({
    requestedBy: 'desktop',
    watcherFactory: createFakePlatform().fileWatchers,
    metaIndex: { move: async () => undefined, meta: async () => null },
    memory: { relocateWorkspace: async () => ({}) },
    hostState: { mcp: { relocateFolders: async () => undefined } },
    trust: { isTrusted: () => true, onDidChangeTrust: () => ({ dispose: () => undefined }) },
    projectFolders: () => [],
    log: () => undefined,
    file: journalFile,
    identitiesFile: path.join(dir, 'folder-identities.json'),
    lockDir: path.join(dir, 'locks'),
  });
  opened.push(relocations);
  return relocations;
}

const stepsWith = (states: Partial<Record<RelocationStepName, RelocationStepState>>): Record<RelocationStepName, RelocationStepState> =>
  Object.fromEntries(RELOCATION_STEPS.map((name) => [name, states[name] ?? { state: 'pending' }])) as Record<RelocationStepName, RelocationStepState>;

// A relocation paused in its sessions step after moving some chats, as a core left it.
async function pausedInSessions(id: string): Promise<void> {
  const store = new RelocationStore({ file: journalFile, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
  const steps = stepsWith({ checkpoints: { state: 'done' }, sessions: { state: 'pending', failure: { code: 'conflict', params: { path: to } } } });
  await store.add((seq) => ({ id, seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from, to, checkpointRepo: folderIdFor(from) }], chats: 3, state: 'paused', steps, startedAt: 1_000 }));
  store.dispose();
}

const onDisk = (id: string) => parseJournal(fs.readFileSync(journalFile, 'utf8'), () => undefined).records.find((record) => record.id === id)!;

describe('pending relocations', () => {
  it('a relocation another app version left running refuses a move of its folder and keeps the sweeps off it', async () => {
    fs.writeFileSync(journalFile, JSON.stringify({ version: 1, hostAliases: [], relocations: [
      { id: 'newer', seq: 1, state: 'running', aNewerField: 1, folders: [{ kind: 'project', from, to: path.join(dir, 'elsewhere') }] },
    ] }));
    const relocations = open();
    expect(await relocations.preflight({ from, to, listed: [] })).toEqual({ ok: false, refusal: { code: 'pendingRelocation', params: { path: from } } });
    expect(await relocations.relocate({ from, to, listed: [] })).toEqual({ refusal: { code: 'pendingRelocation', params: { path: from } } });
    expect(isRelocationPending(from)).toBe(true);
  });

  it('Stop moving abandons a paused relocation: it is no longer pending or shown, and what it moved stays where it landed', async () => {
    await pausedInSessions('r1');
    const relocations = open();
    expect(isRelocationPending(from)).toBe(true);
    expect(relocations.views().map((view) => view.id)).toEqual(['r1']);

    expect(await relocations.abandon('r1')).toBeUndefined();
    expect(onDisk('r1').state).toBe('abandoned');
    expect(relocations.views()).toEqual([]);
    expect(isRelocationPending(from)).toBe(false);
    expect(await relocations.preflight({ from, to, listed: [] })).toMatchObject({ ok: true, mode: 'locate' });
    // the chats it left keep their recorded folder; the checkpoints step already gave the old folder's repos to the new one
    expect(currentPathOf(currentRelocations().aliases, from, 500)).toBe(from);
    expect(folderRepoIdsOf(to).has(folderIdFor(from))).toBe(true);
    expect(folderRepoIdOf(to)).toBe(folderIdFor(from));
    expect(folderRepoIdOf(from)).not.toBe(folderIdFor(from));
    // a chat whose registration the sessions step re-pointed before its file's commit failed is not taken for gone
    const left = path.join(piSessionDir(from), '2026-01-01T10-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000001.jsonl');
    fs.mkdirSync(path.dirname(left), { recursive: true });
    fs.writeFileSync(left, '');
    expect(await registeredFileGone(path.join(piSessionDir(to), path.basename(left)), 500)).toBe(false);
  });

  it('the alias map readers get names the journal it was folded from', async () => {
    await pausedInSessions('r1');
    open();
    expect(currentRelocations().aliases.journal).toBe((JSON.parse(fs.readFileSync(journalFile, 'utf8')) as { id: string }).id);
  });

  it('refuses to abandon a relocation that is running or finished', async () => {
    const store = new RelocationStore({ file: journalFile, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
    await store.add((seq) => ({ id: 'running', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from, to }], chats: 0, state: 'running', steps: stepsWith({}), startedAt: 1 }));
    const done = stepsWith(Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: 'done' }])));
    await store.add((seq) => ({ id: 'done', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: path.join(dir, 'x'), to: path.join(dir, 'y') }], chats: 0, state: 'coreDone', steps: done, startedAt: 1, finishedAt: 2 }));
    store.dispose();
    const relocations = open();
    expect(await relocations.abandon('running')).toEqual({ code: 'notPaused' });
    expect(await relocations.abandon('done')).toEqual({ code: 'notPaused' });
    expect(onDisk('running').state).toBe('running');
    expect(onDisk('done').state).toBe('coreDone');
  });

  it('a finished relocation\'s view names every waiting step, a repair waiting on trust beside memories waiting on the store', async () => {
    const store = new RelocationStore({ file: journalFile, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
    const untrusted = { code: 'untrusted', params: { count: 1 } };
    const readOnly = { code: 'memoryReadOnly', params: { reason: 'readOnly' } };
    const steps = stepsWith({ ...Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: 'done' }])), repair: { state: 'waiting', failure: untrusted }, memory: { state: 'waiting', failure: readOnly } });
    await store.add((seq) => ({ id: 'r1', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from, to }], chats: 0, state: 'coreDone', steps, startedAt: 1, finishedAt: 2 }));
    store.dispose();
    expect(open().views()).toEqual([expect.objectContaining({ id: 'r1', step: 'repair', failure: untrusted, waiting: [untrusted, readOnly] })]);
  });
});
