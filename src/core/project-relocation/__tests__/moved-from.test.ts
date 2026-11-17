import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FolderIdentity } from '../identity';
import type { RecordedIdentity } from '../identity-store';
import { movedFromCandidates, type MovedFromDeps } from '../moved-from';
import type { PathPresence } from '../../workspace-folders/folder-presence-probe';

const root = path.resolve('/moved-from');
const to = path.join(root, 'clone', 'widgets');
const old = path.join(root, 'old', 'widgets');
const ROOT_A = 'a'.repeat(40);

const here: Omit<FolderIdentity, 'roots'> = { subpath: '', remotes: ['github.com/acme/widgets'] };
const recorded = (folder: string, extra: Partial<RecordedIdentity> = {}): RecordedIdentity => ({ path: folder, subpath: '', remotes: ['github.com/acme/widgets'], roots: [], seenAt: 1, ...extra });

function deps(entries: RecordedIdentity[], overrides: Partial<MovedFromDeps> & { present?: Record<string, PathPresence>; chats?: Record<string, number> } = {}): MovedFromDeps {
  const present: Record<string, PathPresence> = { ...overrides.present };
  return {
    recorded: async () => entries,
    relocationSources: () => [],
    inChatWorktree: () => false,
    presence: async (target) => present[target] ?? 'missing',
    chatsOf: async (from) => overrides.chats?.[from] ?? 2,
    rootsOfTarget: async () => [],
    ...overrides,
  };
}

describe('movedFromCandidates', () => {
  it('offers a missing folder with chats that shares a remote, with its chat count', async () => {
    expect(await movedFromCandidates(to, here, deps([recorded(old)], { chats: { [old]: 3 } }))).toEqual([{ from: old, chats: 3 }]);
  });

  it('matches on a shared root commit when the remotes differ (a fork)', async () => {
    const entries = [recorded(old, { remotes: ['github.com/upstream/widgets'], roots: [ROOT_A] })];
    expect(await movedFromCandidates(to, here, deps(entries, { rootsOfTarget: async () => [ROOT_A] }))).toEqual([{ from: old, chats: 2 }]);
  });

  it('reads the root commits of `to` only for a missing folder with chats that has roots and shares no remote, and once', async () => {
    const rootsOfTarget = vi.fn(async () => [ROOT_A]);
    const withRoots = (folder: string): RecordedIdentity => recorded(folder, { remotes: ['github.com/upstream/widgets'], roots: [ROOT_A] });
    expect(await movedFromCandidates(to, here, deps([], { rootsOfTarget }))).toEqual([]);
    expect(await movedFromCandidates(to, here, deps([recorded(old, { roots: [ROOT_A] })], { rootsOfTarget }))).toEqual([{ from: old, chats: 2 }]);
    expect(await movedFromCandidates(to, here, deps([recorded(old, { remotes: ['github.com/other/repo'] })], { rootsOfTarget }))).toEqual([]);
    expect(await movedFromCandidates(to, here, deps([withRoots(old)], { rootsOfTarget, present: { [old]: 'directory' } }))).toEqual([]);
    expect(await movedFromCandidates(to, here, deps([withRoots(old)], { rootsOfTarget, chats: { [old]: 0 } }))).toEqual([]);
    expect(rootsOfTarget).not.toHaveBeenCalled();
    const second = path.join(root, 'older', 'widgets');
    expect(await movedFromCandidates(to, here, deps([withRoots(old), withRoots(second)], { rootsOfTarget }))).toEqual([{ from: old, chats: 2 }, { from: second, chats: 2 }]);
    expect(rootsOfTarget).toHaveBeenCalledOnce();
  });

  it('offers nothing for another repository, a folder of no recorded identity, or another subpath', async () => {
    expect(await movedFromCandidates(to, { ...here, remotes: ['github.com/other/repo'] }, deps([recorded(old)]))).toEqual([]);
    expect(await movedFromCandidates(to, { subpath: '', remotes: [] }, deps([recorded(old)]))).toEqual([]);
    expect(await movedFromCandidates(to, here, deps([recorded(old, { subpath: 'packages/app' })]))).toEqual([]);
  });

  it('skips a folder that is there, unreachable or on a volume that does not answer, with no chats, a relocation source, or the folder itself', async () => {
    const entries = [recorded(old)];
    expect(await movedFromCandidates(to, here, deps(entries, { present: { [old]: 'directory' } }))).toEqual([]);
    expect(await movedFromCandidates(to, here, deps(entries, { present: { [old]: 'unreachable' } }))).toEqual([]);
    expect(await movedFromCandidates(to, here, deps(entries, { chats: { [old]: 0 } }))).toEqual([]);
    expect(await movedFromCandidates(to, here, deps(entries, { relocationSources: () => [old] }))).toEqual([]);
    expect(await movedFromCandidates(to, here, deps([recorded(to)]))).toEqual([]);
  });

  it('never offers a folder that lies in a chat worktree, and offers nothing to one', async () => {
    const worktree = path.join(root, 'worktrees', 'widgets-123456', 'aaaa1111');
    const inside = (folder: string): boolean => folder.startsWith(path.join(root, 'worktrees'));
    expect(await movedFromCandidates(to, here, deps([recorded(worktree), recorded(old)], { inChatWorktree: inside }))).toEqual([{ from: old, chats: 2 }]);
    expect(await movedFromCandidates(worktree, here, deps([recorded(old)], { inChatWorktree: inside }))).toEqual([]);
  });

  it('offers every matching folder', async () => {
    const second = path.join(root, 'older', 'widgets');
    expect(await movedFromCandidates(to, here, deps([recorded(old), recorded(second)]))).toEqual([{ from: old, chats: 2 }, { from: second, chats: 2 }]);
  });
});
