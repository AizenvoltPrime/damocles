import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { currentPathOf, foldAliases } from '../aliases';
import { parseJournal, RelocationStore } from '../store';
import { RELOCATION_STEPS, type RelocationStepName, type RelocationStepState } from '../types';

const FROM = path.resolve('/old/p');
const TO = path.resolve('/new/p');

let dir: string;
let journalFile: string;
const opened: Array<{ dispose(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relocation-store-'));
  journalFile = path.join(dir, 'project-relocations.json');
});
afterEach(() => {
  for (const item of opened.splice(0)) item.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function openStore(): RelocationStore {
  const store = new RelocationStore({ file: journalFile, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
  opened.push(store);
  return store;
}

const stepsWith = (done: readonly RelocationStepName[]): Record<RelocationStepName, RelocationStepState> =>
  Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: done.includes(name) ? 'done' : 'pending' }])) as Record<RelocationStepName, RelocationStepState>;

const entry = (folders: unknown[], state = 'running'): Record<string, unknown> => ({ id: 'r1', seq: 1, requestedBy: 'desktop', mode: 'locate', folders, chats: 0, state, steps: stepsWith([]), startedAt: 1 });

describe('RelocationStore', () => {
  it('keeps as another version\'s a record whose first folder is not its one project folder', () => {
    const worktree = { kind: 'worktree', from: path.resolve('/w'), to: path.resolve('/w'), worktreeId: 'aaaa1111' };
    const project = { kind: 'project', from: FROM, to: TO };
    const read = (folders: unknown[]) => parseJournal(JSON.stringify({ version: 1, relocations: [entry(folders)] }), () => undefined);
    expect(read([project, worktree]).records).toHaveLength(1);
    expect(read([worktree, project]).foreign).toHaveLength(1);
    expect(read([project, { kind: 'project', from: path.resolve('/old/q'), to: path.resolve('/new/q') }]).foreign).toHaveLength(1);
    expect(read([worktree]).foreign).toHaveLength(1);
  });

  it('reads an abandoned record, and an entry another version left that is not finished as pending', () => {
    const foreign = (seq: number, state: unknown): Record<string, unknown> => ({ seq, state, folders: [{ kind: 'project', from: path.resolve(`/f${seq}/old`), to: path.resolve(`/f${seq}/new`) }] });
    fs.writeFileSync(journalFile, JSON.stringify({ version: 1, relocations: [
      { ...entry([{ kind: 'project', from: FROM, to: TO }], 'abandoned'), finishedAt: 2 },
      foreign(2, 'running'), foreign(3, 'paused'), foreign(4, 'coreDone'), foreign(5, 'abandoned'), foreign(6, 'someNewState'), foreign(7, undefined),
    ] }));
    const store = openStore();
    expect(store.records().map((record) => record.state)).toEqual(['abandoned']);
    expect(store.foreignPending().map((source) => source.seq)).toEqual([2, 3, 6, 7]);
    expect(store.foreignPending()[0]!.folders).toEqual([{ from: path.resolve('/f2/old'), to: path.resolve('/f2/new') }]);
  });

  it('an abandoned record moves its folders for the alias rule only once its worktrees step is done, and still counts its seq', async () => {
    const store = openStore();
    await store.add((seq) => ({ id: 'early', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: FROM, to: TO }], chats: 3, state: 'abandoned', steps: stepsWith(['checkpoints']), startedAt: 10, finishedAt: 11 }));
    const early = foldAliases(store.aliasSources());
    expect(currentPathOf(early, FROM, 5)).toBe(FROM);
    expect(early.localSeq).toBe(1);

    const late = path.resolve('/late/old');
    await store.add((seq) => ({ id: 'late', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: late, to: path.resolve('/late/new') }], chats: 3, state: 'abandoned', steps: stepsWith(['checkpoints', 'sessions', 'worktrees']), startedAt: 20, finishedAt: 21 }));
    const both = foldAliases(store.aliasSources());
    expect(currentPathOf(both, late, 5)).toBe(path.resolve('/late/new'));
    expect(currentPathOf(both, FROM, 5)).toBe(FROM);
    expect(both.localSeq).toBe(2);
  });

  it('writes the journal\'s id with the file and keeps it, and a journal written after the file was deleted has its own', async () => {
    const store = openStore();
    expect(store.journalId()).toBeUndefined();
    const record = (id: string) => (seq: number) => ({ id, seq, requestedBy: 'desktop' as const, mode: 'locate' as const, folders: [{ kind: 'project' as const, from: FROM, to: TO }], chats: 0, state: 'coreDone' as const, steps: stepsWith([...RELOCATION_STEPS]), startedAt: 10, finishedAt: 11 });
    await store.add(record('first'));
    const first = store.journalId();
    expect(first).toEqual(expect.any(String));
    await store.addHostAlias({ hostId: 'h1', from: '/srv/a', to: '/srv/b', startedAt: 5 });
    expect(store.journalId()).toBe(first);
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({ id: first });

    fs.rmSync(journalFile);
    store.reload();
    expect(store.journalId()).toBeUndefined();
    await store.add(record('second'));
    expect(store.records().map((r) => [r.id, r.seq])).toEqual([['second', 1]]);
    expect(store.journalId()).toEqual(expect.any(String));
    expect(store.journalId()).not.toBe(first);
  });
});
