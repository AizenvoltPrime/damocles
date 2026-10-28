import { describe, expect, it } from 'vitest';
import type { ChatWorktreeRecord } from '../../../../core/worktrees/registry';
import { openWorktreeConflicts, type WorktreeConflictDeps } from '../worktree-conflicts';

const REMOTE = 'ssh+h1';
const FOLDER = '/srv/app';
const RECORD = { id: 'abcd1234', kind: 'chat', branch: 'damocles/fix', projectPath: FOLDER } as unknown as ChatWorktreeRecord;

// Each authority holds its own registry; every call lands in the trail.
function deps(registries: Record<string, ChatWorktreeRecord | undefined>): WorktreeConflictDeps & { trail: string[] } {
  const trail: string[] = [];
  return {
    trail,
    liveChatRecordAt: (authority, folder) => (folder === FOLDER ? registries[authority] : undefined),
    worktreeRootKey: (record, authority) => `root:${authority}:${record.id}`,
    worktreeProjectKey: (authority, folder) => `project:${authority}:${folder}`,
    withScmRoot: async (key, work) => {
      trail.push(`pin ${key}`);
      await work(`repo-of-${key}`);
      trail.push(`unpin ${key}`);
      return undefined;
    },
    noteWorktreeConflicts: (repoId, files, branch) => { trail.push(`note ${repoId} ${files.join(',')} ${branch}`); },
    currentStatus: async (repoId) => { trail.push(`status ${repoId}`); },
    openMergeEditor: async (repoId, path) => { trail.push(`merge ${repoId} ${path}`); },
  };
}

describe('openWorktreeConflicts', () => {
  it('opens Apply\'s conflicts on a remote worktree chat in the merge editor of that host\'s repository, the branch noted first', async () => {
    // the local registry has a chat at the same path, which a remote Apply never reads
    const remote = deps({ [REMOTE]: RECORD, local: { ...RECORD, id: 'local0001' } as ChatWorktreeRecord });
    await openWorktreeConflicts(remote, REMOTE, FOLDER, ['a.ts', 'b.ts'], 'damocles/fix');
    const repo = `repo-of-root:${REMOTE}:abcd1234`;
    expect(remote.trail).toEqual([
      `pin root:${REMOTE}:abcd1234`,
      `note ${repo} a.ts,b.ts damocles/fix`,
      `status ${repo}`,
      `merge ${repo} a.ts`,
      `unpin root:${REMOTE}:abcd1234`,
    ]);
  });

  it('uses the host\'s project key for a folder no live chat works in, and notes nothing without an Apply branch', async () => {
    const merge = deps({});
    await openWorktreeConflicts(merge, REMOTE, FOLDER, ['a.ts']);
    const repo = `repo-of-project:${REMOTE}:${FOLDER}`;
    expect(merge.trail).toEqual([`pin project:${REMOTE}:${FOLDER}`, `status ${repo}`, `merge ${repo} a.ts`, `unpin project:${REMOTE}:${FOLDER}`]);
  });

  it('refreshes the status and opens no editor when no file is conflicted', async () => {
    const none = deps({ [REMOTE]: RECORD });
    await openWorktreeConflicts(none, REMOTE, FOLDER, [], 'damocles/fix');
    expect(none.trail.some((line) => line.startsWith('merge '))).toBe(false);
    expect(none.trail).toContain(`status repo-of-root:${REMOTE}:abcd1234`);
  });
});
