// The source control and worktree work desktop main asks Damocles Core for by name; core serves each name from its own
// ScmService, Repository objects and worktree registry (core-host/scm.ts, worktrees.ts), and nothing outside these lists.
import type { WorktreeFile, WorktreeOptions } from '../../core/worktrees/create';
import type { ApplyOutcome, MergeOutcome, UpdateOutcome } from '../../core/worktrees/integrate';
import type { LeftoverFinding } from '../../core/worktrees/leftovers';
import type { AdoptInput } from '../../core/worktrees/registry';

export const SCM_CALLS = [
  'setProjects', 'setAutofetchProject', 'autofetchNow', 'refresh', 'init', 'openFolder', 'close', 'reopen', 'openParents', 'trustUnsafe',
  'stage', 'stageAll', 'unstage', 'discard', 'discardAll', 'currentStatus', 'commitInput', 'undoLastCommit', 'move', 'remove',
  'abortOperation', 'addToGitignore', 'artifacts', 'checkout', 'fastForward', 'createBranch', 'renameBranch', 'deleteBranch',
  'deleteRemoteRef', 'remoteTags', 'integrate', 'stash', 'stashApply', 'stashDrop', 'stashClear', 'diffStash', 'diffRefs', 'entryPatch',
  'emptyTree', 'quickDiffBase', 'stageRanges', 'blame', 'timeline', 'historyLoad', 'historyPage', 'headRefs', 'mergeBase', 'isCommit',
  'resolveTypedCommit', 'commitMessage', 'commitDetails', 'commitAttachment', 'cherryPick', 'mergeInputs', 'noteWorktreeConflicts',
  'mergeFile', 'completeMerge', 'createTag', 'deleteTag', 'pushTags', 'addWorktree', 'worktreeDirty', 'removeWorktree', 'cancel',
  'cancelClone', 'remotes', 'remoteBranches', 'addRemote', 'removeRemote', 'fetch', 'pull', 'push', 'sync', 'clone', 'worktreeFolder',
] as const;
export type ScmCall = (typeof SCM_CALLS)[number];

/** The Repository reads main makes on an open repository. */
export const REPOSITORY_CALLS = ['confinedEntry', 'commitTemplate', 'isValidBranchName', 'diff', 'commitObject', 'show'] as const;
export type RepositoryCall = (typeof REPOSITORY_CALLS)[number];

/** WorktreeController's git and registry work (core-host/worktrees.ts). */
export const WORKTREE_CALLS = [
  'options', 'continueRows', 'apply', 'targetBranch', 'isRewritten', 'uncommittedFiles', 'mergeInto', 'rebaseOnto', 'updateFrom',
  'folderState', 'deleteFacts', 'removeWorktree', 'scanLeftovers', 'prune', 'markUsed', 'upsertAdopted', 'markAdoptedRemoved',
  'adoptOpenWorktrees',
] as const;
export type WorktreeCall = (typeof WORKTREE_CALLS)[number];

/** The finish actions, which core runs only under a hold it gave out (worktree.beginFinish) for that worktree. */
export type FinishCall = 'apply' | 'mergeInto' | 'rebaseOnto' | 'updateFrom' | 'removeWorktree';

/** A live chat worktree's row of the New menu's Continue in a worktree, as core reads it. */
export interface ContinueRow {
  readonly worktreeId: string;
  readonly branch: string;
  readonly added: number;
  readonly removed: number;
  readonly behind: number;
  readonly baseBranch?: string;
  readonly createdAt: number;
}

export interface DeleteFacts {
  readonly uncommitted: readonly WorktreeFile[];
  readonly unmerged: readonly { readonly hash: string; readonly subject: string }[];
  readonly contained: boolean;
  readonly submodules: { readonly initialized: boolean; readonly changed: readonly string[] };
}

/** Each of WORKTREE_CALLS as core serves it, records named by id; a finish action names its hold second. */
export interface WorktreeCalls {
  options(projectPath: string): Promise<WorktreeOptions>;
  // the project's live chat worktrees whose folder exists, but the held ones
  continueRows(projectPath: string, held: readonly string[]): Promise<readonly ContinueRow[]>;
  apply(worktreeId: string, hold: string): Promise<ApplyOutcome>;
  targetBranch(worktreeId: string): Promise<string | undefined>;
  isRewritten(worktreeId: string, target: string): Promise<boolean>;
  uncommittedFiles(worktreeId: string): Promise<readonly WorktreeFile[]>;
  mergeInto(worktreeId: string, hold: string, message?: string): Promise<MergeOutcome>;
  rebaseOnto(worktreeId: string, hold: string): Promise<UpdateOutcome>;
  updateFrom(worktreeId: string, hold: string): Promise<UpdateOutcome>;
  folderState(worktreeId: string): Promise<'worktree' | 'leftover' | 'gone'>;
  deleteFacts(worktreeId: string): Promise<DeleteFacts>;
  removeWorktree(worktreeId: string, hold: string, options: { readonly deleteBranch: boolean; readonly force: boolean }): Promise<void>;
  scanLeftovers(projects: readonly string[]): Promise<readonly LeftoverFinding[]>;
  prune(projectPath: string): Promise<void>;
  markUsed(worktreeId: string): Promise<void>;
  upsertAdopted(input: AdoptInput): Promise<void>;
  markAdoptedRemoved(worktreePath: string): Promise<void>;
  adoptOpenWorktrees(projects: readonly { readonly key: string; readonly fsPath: string }[]): Promise<void>;
}

// The most arguments any listed call takes.
export const MAX_CALL_ARGS = 8;
