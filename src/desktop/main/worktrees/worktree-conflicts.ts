// The merge editor on the first conflicted file of the repository holding a worktree finish action's folder.
import type { ChatWorktreeRecord } from '../../../core/worktrees/registry';

export interface WorktreeConflictDeps {
  // the authority's own registry, never the local one for a remote authority
  readonly liveChatRecordAt: (authority: string, folder: string) => ChatWorktreeRecord | undefined;
  readonly worktreeRootKey: (record: ChatWorktreeRecord, authority: string) => string;
  readonly worktreeProjectKey: (authority: string, folder: string) => string;
  readonly withScmRoot: (key: string, work: (repoId: string) => Promise<undefined>) => Promise<undefined>;
  readonly noteWorktreeConflicts: (repoId: string, files: readonly string[], branch: string) => void;
  readonly currentStatus: (repoId: string) => Promise<unknown>;
  readonly openMergeEditor: (repoId: string, path: string) => Promise<unknown>;
}

/** folder is native to the authority; Apply's conflicts (applyBranch set) take the worktree branch's Incoming label. */
export async function openWorktreeConflicts(deps: WorktreeConflictDeps, authority: string, folder: string, files: readonly string[], applyBranch?: string): Promise<void> {
  const live = deps.liveChatRecordAt(authority, folder);
  const key = live ? deps.worktreeRootKey(live, authority) : deps.worktreeProjectKey(authority, folder);
  await deps.withScmRoot(key, async (repoId) => {
    if (applyBranch !== undefined) deps.noteWorktreeConflicts(repoId, files, applyBranch);
    await deps.currentStatus(repoId);
    const first = files[0];
    if (first !== undefined) await deps.openMergeEditor(repoId, first);
    return undefined;
  });
}
