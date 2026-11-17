import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { folderIdFor } from '../../pi-session/checkpoints/folder-id';
import { folderRepoIdsIn } from '../../pi-session/checkpoints/resolver';
import { folderKey } from '../../workspace-folders/folder-key';
import { relocationsSnapshot, type RelocationsSnapshot } from '../current';
import { RELOCATION_STEPS, type RelocationFolder, type RelocationRecord, type RelocationState } from '../types';

// The folder repo ids the journal gives each path (docs/invariants.md "Checkpoints", the relocated folder rule).

const root = path.resolve('/checkpoint-ids');
const p = (name: string): string => path.join(root, name);
const id = (name: string, generation?: number): string => folderIdFor(p(name), generation);

function record(seq: number, folders: readonly RelocationFolder[], state: RelocationState = 'coreDone'): RelocationRecord {
  const steps = Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: state === 'coreDone' ? 'done' : 'pending' }])) as RelocationRecord['steps'];
  return { id: `r${seq}`, seq, requestedBy: 'desktop', mode: folders[0]!.checkpointRepo ? 'locate' : 'merge', folders, chats: 0, state, steps, startedAt: seq * 1_000 };
}
const merge = (seq: number, from: string, to: string, state?: RelocationState): RelocationRecord => record(seq, [{ kind: 'project', from: p(from), to: p(to) }], state);
const locate = (seq: number, from: string, to: string, checkpointRepo: string, state?: RelocationState): RelocationRecord => record(seq, [{ kind: 'project', from: p(from), to: p(to), checkpointRepo }], state);

function snapshotOf(records: readonly RelocationRecord[]): RelocationsSnapshot {
  return relocationsSnapshot(records, records);
}
const writes = (snapshot: RelocationsSnapshot, name: string): string => snapshot.checkpointBindings.get(folderKey(p(name))) ?? id(name);
const repos = (snapshot: RelocationsSnapshot, name: string): Set<string> => folderRepoIdsIn(snapshot, p(name));

describe('checkpoint repo ids from the relocation journal', () => {
  it('merge X→Y then locate Y→Z: Z continues in Y\'s repo and holds X\'s', () => {
    const snapshot = snapshotOf([merge(1, 'x', 'y'), locate(2, 'y', 'z', id('y'))]);
    expect(writes(snapshot, 'z')).toBe(id('y'));
    expect(repos(snapshot, 'z')).toEqual(new Set([id('z'), id('y'), id('x')]));
  });

  it('merges W→X→Y→Z carry every repo along the chain', () => {
    const snapshot = snapshotOf([merge(1, 'w', 'x'), merge(2, 'x', 'y'), merge(3, 'y', 'z')]);
    expect(writes(snapshot, 'z')).toBe(id('z'));
    expect(repos(snapshot, 'z')).toEqual(new Set([id('z'), id('y'), id('x'), id('w')]));
  });

  it('move back A→B→A: A writes its own repo again, and a folder re-added at B gets a fresh one', () => {
    const snapshot = snapshotOf([locate(1, 'a', 'b', id('a')), locate(2, 'b', 'a', id('a'))]);
    expect(writes(snapshot, 'a')).toBe(id('a'));
    expect(repos(snapshot, 'a').has(id('a'))).toBe(true);
    expect(writes(snapshot, 'b')).toBe(id('b', 2));
    expect(repos(snapshot, 'b')).toEqual(new Set([id('b', 2)]));
  });

  it('a folder re-added where a merged project was gets a fresh repo, and the merge target keeps the old one', () => {
    const snapshot = snapshotOf([merge(1, 'x', 'y')]);
    expect(writes(snapshot, 'x')).toBe(id('x', 1));
    expect(repos(snapshot, 'x')).toEqual(new Set([id('x', 1)]));
    expect(repos(snapshot, 'y')).toEqual(new Set([id('y'), id('x')]));
  });

  it('reuse A→B then C→A: A writes C\'s repo and never reaches A\'s first repo, which B holds', () => {
    const snapshot = snapshotOf([locate(1, 'a', 'b', id('a')), locate(2, 'c', 'a', id('c'))]);
    expect(writes(snapshot, 'a')).toBe(id('c'));
    expect(repos(snapshot, 'a').has(id('a'))).toBe(false);
    expect(repos(snapshot, 'b')).toEqual(new Set([id('b'), id('a')]));
  });

  it('a chat worktree\'s folder, which stays where it is, keeps its own repo', () => {
    const snapshot = snapshotOf([record(1, [{ kind: 'project', from: p('a'), to: p('b'), checkpointRepo: id('a') }, { kind: 'worktree', from: p('wt'), to: p('wt'), worktreeId: 'aaaa1111' }])]);
    expect(writes(snapshot, 'wt')).toBe(id('wt'));
    expect(repos(snapshot, 'wt')).toEqual(new Set([id('wt')]));
  });

  it('a relocation that is not coreDone leaves its old path\'s own id as it was', () => {
    const snapshot = snapshotOf([locate(1, 'a', 'b', id('a'), 'running')]);
    expect(writes(snapshot, 'a')).toBe(id('a'));
    expect(writes(snapshot, 'b')).toBe(id('a'));
  });

  it('an abandoned relocation whose checkpoints step is done places the repos as a finished one, its other moves as if it never ran', () => {
    const abandoned = (seq: number, from: string, to: string, done: readonly string[]): RelocationRecord => {
      const base = locate(seq, from, to, id(from), 'abandoned');
      return { ...base, steps: Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: done.includes(name) ? 'done' : 'pending' }])) as RelocationRecord['steps'] };
    };
    const after = snapshotOf([abandoned(1, 'a', 'b', ['checkpoints'])]);
    expect(writes(after, 'b')).toBe(id('a'));
    expect(repos(after, 'b')).toEqual(new Set([id('b'), id('a')]));
    expect(writes(after, 'a')).toBe(id('a', 1));
    expect(repos(after, 'a')).toEqual(new Set([id('a', 1)]));
    expect(after.pendingKeys.size).toBe(0);
    expect(after.stoppedPairs).toEqual([{ from: p('a'), to: p('b') }]);

    const before = snapshotOf([abandoned(1, 'a', 'b', [])]);
    expect(writes(before, 'a')).toBe(id('a'));
    expect(repos(before, 'b')).toEqual(new Set([id('b')]));
    expect(before.stoppedPairs).toEqual([]);
  });
});
