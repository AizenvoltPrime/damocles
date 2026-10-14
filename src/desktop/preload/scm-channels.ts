// Source control's channels (plan AD4, IPC), shared by the shell preload, main and (as types only) the shell app.
// Main issues every repoId for the run and keys everything it persists by the repository's root path; the renderer names a
// file only as a repo-relative path, which main validates here and core confines again.

import { isObjectName } from '../../shared/git-object-name';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';

export const SCM_CHANNELS = {
  // renderer → main, invoke
  // → ScmShellState
  getState: 'damocles:scm:get-state',
  // ScmSelectRequest; persisted per project by the repository's root path. The reply precedes the view naming the selection,
  // so the shell never infers the selected repository from it.
  select: 'damocles:scm:select',
  // ScmRunRequest → ScmRunResult
  run: 'damocles:scm:run',
  // ScmCommitRequest → ScmCommitResult
  commit: 'damocles:scm:commit',
  // ScmRepoRef → ScmGenerateResult; a failure leaves the box as it is and main posts the notice
  generateMessage: 'damocles:scm:generate-message',
  // ScmFileDiffRequest → ScmFileDiffResult
  fileDiff: 'damocles:scm:file-diff',
  // ScmCopyRequest; main composes the text from its own data and writes the clipboard
  copy: 'damocles:scm:copy',
  // ScmRepoRef → ScmCommitInput
  commitInput: 'damocles:scm:commit-input',
  // ScmAmendReport: the selected repository's commit box amend mode, which titles the palette's and menu's commit commands
  amend: 'damocles:scm:amend',
  // ScmArtifactsRequest → ScmArtifactsResult
  artifacts: 'damocles:scm:artifacts',
  // main → renderer
  // ScmView, for one project, on every change
  view: 'damocles:scm:view',
  // ScmRepoSnapshot, coalesced per repository
  state: 'damocles:scm:state',
  // ScmDecorations, for one project, on every change
  decorations: 'damocles:scm:decorations',
  // ScmSettings on every change of a damocles.desktop.git.* key the shell reads
  settings: 'damocles:scm:settings',
  // ScmShellCommand: a palette command the shell carries out (it holds the commit drafts)
  command: 'damocles:scm:command',
  // ScmSetInput: text main put in a repository's commit box, whatever started it
  setInput: 'damocles:scm:set-input',
  // ScmCloneState: the window's clone, on every change
  clone: 'damocles:scm:clone',
  // ScmArtifactsChanged, coalesced per repository, after the .git watcher fires on refs, stashes or worktrees
  // and after every engine write to them
  artifactsChanged: 'damocles:scm:artifacts-changed',
} as const;

// Bounds main checks; anything outside is refused, never clamped.
export const MAX_SCM_ID_LENGTH = 200;
export const MAX_SCM_PATHS = 10_000;
// A commit message's characters; must equal MAX_MESSAGE_CHARS in src/core/scm/repository.ts.
export const MAX_COMMIT_MESSAGE_CHARS: number = 64 * 1024;
// VS Code's git.statusLimit default: past it a status lists only the first entries and the snapshot says so. Must equal
// STATUS_LIMIT in src/core/scm/repository.ts.
export const SCM_STATUS_LIMIT = 10_000;

// A change's status: VS Code's Status enum names (extensions/git/src/api/git.d.ts).
export const SCM_STATUSES = [
  'INDEX_MODIFIED',
  'INDEX_ADDED',
  'INDEX_DELETED',
  'INDEX_RENAMED',
  'INDEX_COPIED',
  'MODIFIED',
  'DELETED',
  'UNTRACKED',
  'IGNORED',
  'INTENT_TO_ADD',
  'INTENT_TO_RENAME',
  'TYPE_CHANGED',
  'ADDED_BY_US',
  'ADDED_BY_THEM',
  'DELETED_BY_US',
  'DELETED_BY_THEM',
  'BOTH_ADDED',
  'BOTH_DELETED',
  'BOTH_MODIFIED',
] as const;
export type ScmStatus = (typeof SCM_STATUSES)[number];

// The letter VS Code's resource decoration shows; S marks a submodule, ! a conflict.
export type ScmLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '!' | 'S' | 'I';
export type ScmTone = 'modified' | 'added' | 'deleted' | 'untracked' | 'conflict' | 'renamed' | 'submodule' | 'ignored';

export const SCM_GROUPS = ['merge', 'index', 'workingTree', 'untracked'] as const;
export type ScmGroup = (typeof SCM_GROUPS)[number];

export interface ScmChange {
  // repo-relative, '/' separated
  readonly path: string;
  // a rename's or copy's source, repo-relative
  readonly originalPath?: string;
  readonly status: ScmStatus;
  readonly letter: ScmLetter;
  readonly tone: ScmTone;
  // deleted in this group: the row and the decoration strike the name through
  readonly strike: boolean;
  // the path is a submodule of the repository
  readonly submodule?: true;
}

export type ScmRepoKind = 'root' | 'nested' | 'submodule' | 'parent';

export type ScmHead =
  | { readonly type: 'branch'; readonly name: string }
  | { readonly type: 'detached'; readonly commit: string }
  | { readonly type: 'unborn'; readonly name: string };

export type ScmOperation = 'merge' | 'rebase' | 'cherryPick';

// The interactive cancellable remote operation on a repository; publish and Push Tags run as push, a pullBeforeCheckout
// fast-forward as pull. Autofetch never shows as one.
export const SCM_REMOTE_OPS = ['fetch', 'pull', 'push', 'sync', 'deleteRemoteBranch', 'deleteRemoteTag'] as const;
export type ScmRemoteOp = (typeof SCM_REMOTE_OPS)[number];

export interface ScmUpstream {
  // the upstream's remote name ('.' for a local branch), never ''
  readonly remote: string;
  // the branch name on the remote
  readonly branch: string;
  // commits HEAD has that the upstream lacks
  readonly ahead: number;
  // commits the upstream has that HEAD lacks
  readonly behind: number;
}

// How the repository's last interactive remote operation ended; seq grows with each one, so a repeat is a new value.
export interface ScmRemoteOutcome {
  readonly op: ScmRemoteOp;
  readonly outcome: 'ok' | 'failed' | 'cancelled';
  // a pull or sync whose stashed changes could not be applied back, so they stay in the stash list; never set for another op
  readonly stashKept: boolean;
  readonly seq: number;
}

// The folder name a clone writes into.
export interface ScmCloneProgress {
  readonly name: string;
}

// running: the clone under way; last: how the window's last clone ended, seq growing with each one
export interface ScmCloneState {
  readonly running: ScmCloneProgress | null;
  readonly last: { readonly outcome: ScmRemoteOutcome['outcome']; readonly seq: number } | null;
}

// Ref, stash and worktree lists, pulled on demand (AD4, IPC); the branch picker, the Stashes group and the Repositories
// section all read them through damocles:scm:artifacts.
export const SCM_ARTIFACT_GROUPS = ['branches', 'remoteBranches', 'tags', 'stashes', 'worktrees'] as const;
export type ScmArtifactGroup = (typeof SCM_ARTIFACT_GROUPS)[number];

export interface ScmArtifactCommit {
  // the full object name
  readonly hash: string;
  // the message's first line
  readonly subject: string;
  // the author's name
  readonly author: string;
  // the committer date, ms since epoch (VS Code's commitDetails.commitDate)
  readonly date: number;
}

// Rows of every ref group come in for-each-ref --sort=-creatordate order (newest first).
export interface ScmBranchArtifact {
  // 'refs/heads/feat/a'
  readonly ref: string;
  // 'feat/a'
  readonly name: string;
  readonly commit: ScmArtifactCommit | null;
  // HEAD is this branch
  readonly current: boolean;
  // from %(upstream) and %(upstream:track); null when none or gone
  readonly upstream: ScmUpstream | null;
}

export interface ScmRemoteBranchArtifact {
  // 'refs/remotes/origin/main'; refs/remotes/*/HEAD is left out, as VS Code does
  readonly ref: string;
  // 'origin/main'
  readonly name: string;
  readonly remote: string;
  readonly commit: ScmArtifactCommit | null;
}

export interface ScmTagArtifact {
  // 'refs/tags/v1.0'
  readonly ref: string;
  // 'v1.0'
  readonly name: string;
  // the peeled commit (%(*objectname) for an annotated tag)
  readonly commit: ScmArtifactCommit | null;
  readonly annotated: boolean;
  // HEAD is detached at this tag's commit, VS Code artifactProvider's rule
  readonly current: boolean;
}

export interface ScmStashArtifact {
  // n of stash@{n}
  readonly index: number;
  // the stash commit
  readonly hash: string;
  // the stash's message (parseGitStashes)
  readonly description: string;
  // the branch it was made on (parseGitStashes branchName)
  readonly branch: string | null;
  // ms since epoch
  readonly date: number;
}

export interface ScmWorktreeArtifact {
  // absolute, OS separators
  readonly path: string;
  // the folder name
  readonly name: string;
  // short name; null when detached
  readonly branch: string | null;
  // its HEAD commit
  readonly commit: ScmArtifactCommit | null;
  // the main worktree, listed first
  readonly main: boolean;
  // this repository's own worktree
  readonly current: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
  // what Open does (D58), decided by main: select the project whose folder the worktree holds, or Add as Project
  readonly opens: ScmWorktreeOpen;
}

export type ScmWorktreeOpen = 'project' | 'addProject';

export type ScmArtifacts =
  | { readonly group: 'branches'; readonly rows: readonly ScmBranchArtifact[] }
  | { readonly group: 'remoteBranches'; readonly rows: readonly ScmRemoteBranchArtifact[] }
  | { readonly group: 'tags'; readonly rows: readonly ScmTagArtifact[] }
  | { readonly group: 'stashes'; readonly rows: readonly ScmStashArtifact[] }
  | { readonly group: 'worktrees'; readonly rows: readonly ScmWorktreeArtifact[] };

export interface ScmArtifactsRequest {
  readonly repoId: string;
  readonly group: ScmArtifactGroup;
}

// unknown: the repoId is not main's; failed: git failed and main logged it to the Git output (the list shows a failure line)
export type ScmArtifactsResult = { readonly ok: true; readonly artifacts: ScmArtifacts } | { readonly ok: false; readonly reason: 'unknown' | 'failed' };

export interface ScmArtifactsChanged {
  readonly repoId: string;
  readonly groups: readonly ScmArtifactGroup[];
}

// What the repository's git can do (AD4's version checks)
export interface ScmCapabilities {
  // git 2.35 or later: Stash Staged
  readonly stashStaged: boolean;
}

export interface ScmRepoSummary {
  readonly repoId: string;
  // the root folder's name
  readonly label: string;
  // project-relative ('' for the project folder itself), or absolute for a parent repository
  readonly displayPath: string;
  readonly kind: ScmRepoKind;
}

export interface ScmRepoSnapshot {
  readonly repoId: string;
  readonly projectKey: string;
  readonly head: ScmHead | null;
  // HEAD's commit and its message's first line (the amend banner); null on an unborn branch
  readonly commit: { readonly hash: string; readonly subject: string } | null;
  readonly operation: ScmOperation | null;
  // MERGE_MSG without its comment lines, while a merge or cherry-pick is in progress: the box's prefill
  readonly mergeMessage?: string;
  // untracked is non-empty only at untrackedChanges 'separate'; at 'mixed' untracked files sit in workingTree, at 'hidden' nowhere
  readonly groups: { readonly [G in ScmGroup]: readonly ScmChange[] };
  // the status held more than SCM_STATUS_LIMIT entries and the groups hold the first ones
  readonly tooManyChanges: boolean;
  // an index-writing operation runs (stage, unstage, discard, commit, continue, abort): its buttons show busy
  readonly busy: boolean;
  // null: detached, unborn, or a branch without an upstream
  readonly upstream: ScmUpstream | null;
  // the repository's remote names, sorted
  readonly remotes: readonly string[];
  readonly running: ScmRemoteOp | null;
  readonly lastRemote: ScmRemoteOutcome | null;
}

// loading: the project's discovery runs. noRepository covers closed ones too: closedCount tells the shell which text to show.
export type ScmViewState = 'loading' | 'untrusted' | 'gitMissing' | 'noRepository' | 'ready';

export interface ScmView {
  readonly projectKey: string;
  readonly state: ScmViewState;
  // picker order: the repository holding the project folder first, then by path
  readonly repos: readonly ScmRepoSummary[];
  readonly selectedRepoId: string | null;
  // repositories of this project the user closed (Reopen Closed Repositories...)
  readonly closedCount: number;
  // repositories git refused for dubious ownership, as display paths (Manage Unsafe Repositories)
  readonly unsafePaths: readonly string[];
  // parent repositories waiting on the D9 prompt's answer (Open Repositories In Parent Folders)
  readonly parentCount: number;
}

export interface ScmDecoration {
  // absent for ignored entries, which only fade
  readonly letter?: ScmLetter;
  readonly tone: ScmTone;
  // the change is staged (index group); unstaged changes win where a file has both
  readonly staged: boolean;
  readonly strike: boolean;
  // absent for a submodule folder and an ignored entry
  readonly status?: ScmStatus;
  readonly submodule?: true;
}

export interface ScmDecorations {
  readonly projectKey: string;
  // by project-relative path; files outside the project (a parent repository's) are not listed
  readonly files: { readonly [projectRelativePath: string]: ScmDecoration };
}

export interface ScmSettings {
  readonly untrackedChanges: 'mixed' | 'separate' | 'hidden';
  readonly inputValidation: boolean;
  readonly inputValidationSubjectLength: number;
  readonly inputValidationLength: number;
  // the No Verify commit variants show only while this is on
  readonly allowNoVerifyCommit: boolean;
  // the force push variants show only while this is on
  readonly allowForcePush: boolean;
}

export interface ScmShellState {
  // one per open project
  readonly views: readonly ScmView[];
  // every open repository of every view
  readonly snapshots: readonly ScmRepoSnapshot[];
  readonly decorations: readonly ScmDecorations[];
  readonly settings: ScmSettings;
  // the window's clone, which belongs to no repository
  readonly clone: ScmCloneState;
  readonly capabilities: ScmCapabilities;
}

export interface ScmSelectRequest {
  readonly projectKey: string;
  readonly repoId: string;
}

export interface ScmRepoRef {
  readonly repoId: string;
}

// amending: every commit action of repoId's box amends (the store's amendingIn)
export interface ScmAmendReport {
  readonly repoId: string;
  readonly amending: boolean;
}

// The source of a diff: one group's side pair; a stash against its base commit, untracked files (stash^3) included, pinned
// by its hash so a shifted index never shows another stash; or left → right, both full commit hashes, so a moved ref never
// changes an open tab.
export type ScmDiffSource =
  | { readonly kind: ScmGroup }
  | { readonly kind: 'stash'; readonly index: number; readonly hash: string }
  | { readonly kind: 'refs'; readonly left: string; readonly right: string };

export const SCM_STAGE_ALL_SCOPES = ['all', 'tracked', 'untracked', 'merge'] as const;
export const SCM_DISCARD_ALL_SCOPES = ['all', 'tracked', 'untracked'] as const;
export const SCM_FETCH_SCOPES = ['default', 'prune', 'all'] as const;
export const SCM_STASH_SCOPES = ['default', 'includeUntracked', 'staged'] as const;
export type ScmStashScope = (typeof SCM_STASH_SCOPES)[number];

// Stashes past this index are refused; git keeps them all, but no list shows that many.
export const MAX_STASH_INDEX = 1_000_000;
// A full refname or a worktree path a renderer names.
export const MAX_SCM_REF_LENGTH = 1024;
export const MAX_SCM_WORKTREE_PATH_LENGTH = 4096;

export interface ScmStashTarget {
  readonly index: number;
  readonly hash: string;
}

// latest: stash@{0}; pick: main shows the stash picker; a target names one stash (a row, View Stash's title)
export type ScmStashChoice = 'latest' | 'pick' | ScmStashTarget;

// User flows main runs, keyed by op. Questions (discard confirmations, the parent prompt, safe.directory) go through the
// overlay dialog; failures are notices with Show Git Output.
export type ScmRunRequest =
  | { readonly op: 'init'; readonly projectKey: string }
  | { readonly op: 'openRepository'; readonly projectKey: string }
  | { readonly op: 'reopenClosed'; readonly projectKey: string }
  | { readonly op: 'openParentRepositories'; readonly projectKey: string }
  | { readonly op: 'manageUnsafeRepositories'; readonly projectKey: string }
  | { readonly op: 'showOutput' }
  // the git-not-installed state's link: main opens https://git-scm.com/download/<os> itself
  | { readonly op: 'openGitDownload' }
  | { readonly op: 'closeRepository'; readonly repoId: string }
  | { readonly op: 'closeOtherRepositories'; readonly repoId: string }
  | { readonly op: 'refresh'; readonly repoId: string }
  | { readonly op: 'stage'; readonly repoId: string; readonly paths: readonly string[] }
  | { readonly op: 'unstage'; readonly repoId: string; readonly paths: readonly string[] }
  | { readonly op: 'discard'; readonly repoId: string; readonly paths: readonly string[] }
  | { readonly op: 'stageAll'; readonly repoId: string; readonly scope: (typeof SCM_STAGE_ALL_SCOPES)[number] }
  | { readonly op: 'unstageAll'; readonly repoId: string }
  | { readonly op: 'discardAll'; readonly repoId: string; readonly scope: (typeof SCM_DISCARD_ALL_SCOPES)[number] }
  | { readonly op: 'abortOperation'; readonly repoId: string }
  | { readonly op: 'addToGitignore'; readonly repoId: string; readonly paths: readonly string[] }
  | { readonly op: 'reveal'; readonly repoId: string; readonly path: string }
  | { readonly op: 'mention'; readonly repoId: string; readonly path: string }
  | { readonly op: 'openChanges'; readonly repoId: string; readonly path: string; readonly group: ScmGroup }
  | { readonly op: 'openFile'; readonly repoId: string; readonly path: string }
  | { readonly op: 'openFileHead'; readonly repoId: string; readonly path: string }
  | { readonly op: 'openGroupChanges'; readonly repoId: string; readonly group: ScmGroup }
  // the undone commit's message and the template come back through setInput
  | { readonly op: 'undoLastCommit'; readonly repoId: string }
  | { readonly op: 'restoreCommitTemplate'; readonly repoId: string }
  // Fetch, Fetch (Prune), Fetch From All Remotes; default honours pruneOnFetch
  | { readonly op: 'fetch'; readonly repoId: string; readonly scope: (typeof SCM_FETCH_SCOPES)[number] }
  // Pull, Pull (Rebase); autoStash honoured
  | { readonly op: 'pull'; readonly repoId: string; readonly rebase: boolean }
  // a remote picker, then a branch picker
  | { readonly op: 'pullFrom'; readonly repoId: string }
  // Push, Push to..., Push (Follow Tags) and the force variants, which main refuses unless allowForcePush and always confirms
  | { readonly op: 'push'; readonly repoId: string; readonly to: boolean; readonly force: boolean; readonly followTags: boolean }
  // rebase: Sync (Rebase); false lets rebaseWhenSync decide
  | { readonly op: 'sync'; readonly repoId: string; readonly rebase: boolean }
  // Publish Branch... with a remote picker, skipped when there is one remote
  | { readonly op: 'publish'; readonly repoId: string }
  | { readonly op: 'addRemote'; readonly repoId: string }
  | { readonly op: 'removeRemote'; readonly repoId: string }
  // works whatever the selected project's trust, and with no project
  | { readonly op: 'clone'; readonly recursive: boolean }
  // cancels the repository's running remote operation, whose run then answers cancelled
  | { readonly op: 'cancel'; readonly repoId: string }
  | { readonly op: 'cancelClone' }
  // Checkout to..., Checkout to (Detached)...: the branch picker; ref (a full refname from artifacts) skips it
  | { readonly op: 'checkout'; readonly repoId: string; readonly detached: boolean; readonly ref?: string }
  // Create Branch... (at HEAD), Create Branch From... (a ref picker unless ref is given)
  | { readonly op: 'createBranch'; readonly repoId: string; readonly from: boolean; readonly ref?: string }
  | { readonly op: 'renameBranch'; readonly repoId: string }
  // a refs/heads/* ref skips the picker; an unmerged branch asks a danger question, then deletes with -D
  | { readonly op: 'deleteBranch'; readonly repoId: string; readonly ref?: string }
  | { readonly op: 'deleteRemoteBranch'; readonly repoId: string }
  | { readonly op: 'merge'; readonly repoId: string; readonly ref?: string }
  | { readonly op: 'rebase'; readonly repoId: string; readonly ref?: string }
  // Stash, Stash (Include Untracked), Stash Staged (refused below git 2.35): save-before-stash, then the message
  | { readonly op: 'stash'; readonly repoId: string; readonly scope: ScmStashScope }
  // Stash Changes on files
  | { readonly op: 'stashChanges'; readonly repoId: string; readonly paths: readonly string[] }
  // Apply Latest Stash, Apply Stash..., Pop Latest Stash, Pop Stash..., and a row's or the tab's Apply and Pop
  | { readonly op: 'stashApply'; readonly repoId: string; readonly pop: boolean; readonly target: ScmStashChoice }
  // Drop Stash... (pick), a row or the tab (target); always confirmed, as VS Code does; the tab of the dropped stash closes
  | { readonly op: 'stashDrop'; readonly repoId: string; readonly target: 'pick' | ScmStashTarget }
  // a danger question, Cancel focused
  | { readonly op: 'stashDropAll'; readonly repoId: string }
  | { readonly op: 'viewStash'; readonly repoId: string; readonly target: 'pick' | ScmStashTarget }
  | { readonly op: 'createTag'; readonly repoId: string }
  // a refs/tags/* ref skips the picker
  | { readonly op: 'deleteTag'; readonly repoId: string; readonly ref?: string }
  | { readonly op: 'deleteRemoteTag'; readonly repoId: string }
  | { readonly op: 'pushTags'; readonly repoId: string }
  | { readonly op: 'createWorktree'; readonly repoId: string }
  // path (absolute, from a worktrees row) skips the picker; a dirty worktree asks a danger question, then removes with --force
  | { readonly op: 'deleteWorktree'; readonly repoId: string; readonly path?: string }
  // a Repositories branch or tag row's Compare with...: a picker of the other refs, then one multi-file diff tab
  | { readonly op: 'compareRef'; readonly repoId: string; readonly ref: string }
  // a Repositories worktree row's Open (D58): selects the project whose folder it holds, else Add as Project
  | { readonly op: 'openWorktree'; readonly repoId: string; readonly path: string };
export type ScmOp = ScmRunRequest['op'];

// cancelled: the user said no to a question; failed: main told the user; unknown: the repoId or projectKey is not main's
export type ScmRunResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'cancelled' | 'failed' | 'unknown' };

export const SCM_COMMIT_SCOPES = ['auto', 'staged', 'all'] as const;

// VS Code's commit commands: auto is Commit, staged Commit Staged (the same behaviour), all Commit All; the flags combine.
export interface ScmCommitVariant {
  readonly scope: (typeof SCM_COMMIT_SCOPES)[number];
  readonly amend: boolean;
  readonly signoff: boolean;
  readonly noVerify: boolean;
  readonly empty: boolean;
}

// While a merge or cherry-pick is in progress Commit concludes it with the message; while a rebase is, Commit is Continue
// Rebase, which reuses git's prepared message and ignores this one. With amend, an empty message keeps HEAD's.
export interface ScmCommitRequest {
  readonly repoId: string;
  readonly message: string;
  readonly variant: ScmCommitVariant;
  // Commit & Push, Commit & Sync: runs after a successful commit in place of the postCommitCommand setting
  readonly postCommit?: ScmPostCommit;
}

export const SCM_POST_COMMITS = ['push', 'sync'] as const;
export type ScmPostCommit = (typeof SCM_POST_COMMITS)[number];

export type ScmCommitFailure = 'emptyMessage' | 'nothingToCommit' | 'unresolvedConflicts' | 'missingUserConfig' | 'cancelled' | 'failed' | 'unknown';
// The shell shows emptyMessage, nothingToCommit, unresolvedConflicts and missingUserConfig inline and nothing for cancelled (the
// user answered a question so); main posts a notice with Show Git Output for failed only. The shell keeps the draft; a success
// replaces it through setInput.
// ok carries the box's new text (the template or nothing) and the commit input read after core recorded the commit, so the
// shell applies both as the commit settles; commitInput is absent when main could not read it, and the shell reads it again
export type ScmCommitResult =
  | { readonly ok: true; readonly message: string; readonly commitInput?: ScmCommitInput }
  | { readonly ok: false; readonly reason: ScmCommitFailure };

export interface ScmCommitInput {
  // the commit.template file's text, comment lines dropped; null when the repository has none
  readonly template: string | null;
  // committed messages of this repository's root, newest first
  readonly history: readonly string[];
  // HEAD's full message, which amend mode fills an empty box with; null on an unborn branch
  readonly headMessage: string | null;
}

// undo: Undo Last Commit's message; template: Restore Commit Template. A commit's text comes back in its ScmCommitResult.
export interface ScmSetInput {
  readonly repoId: string;
  readonly message: string;
  readonly cause: 'undo' | 'template';
  // undo: the commit input read after core undid the commit, so the box and its history change together; absent when main
  // could not read it, and the shell reads it again
  readonly commitInput?: ScmCommitInput;
}

export type ScmGenerateResult = { readonly ok: true; readonly message: string } | { readonly ok: false };

export interface ScmFileDiffRequest {
  readonly repoId: string;
  readonly source: ScmDiffSource;
  // repo-relative
  readonly path: string;
}

// patch: one file's unified diff (parseUnifiedDiff); missing: the path is no longer in that group
export type ScmFileDiffResult =
  | { readonly kind: 'patch'; readonly patch: string }
  | { readonly kind: 'binary' }
  | { readonly kind: 'tooLarge' }
  | { readonly kind: 'missing' };

export const SCM_COPY_KINDS = ['path', 'relativePath', 'branchName', 'stashName', 'tagName', 'commitHash', 'worktreePath'] as const;
export type ScmCopyKind = (typeof SCM_COPY_KINDS)[number];

// value names the row, never the text, and main finds the row in its own fresh lists: for path and relativePath the
// repo-relative path (path copies the absolute path, relativePath the project-relative one, repo-relative for a parent
// repository's file outside the project); a stash's commit hash for stashName (its description, as VS Code's copyStashName
// copies the row's name) and branchName (its branch); a refs/heads/ refname for branchName and commitHash, a refs/tags/ one
// for tagName and commitHash (the commit a tag peels to); a worktree path for branchName, commitHash and worktreePath.
// branchName is refused for a stash or worktree on no branch.
export interface ScmCopyRequest {
  readonly repoId: string;
  readonly kind: ScmCopyKind;
  readonly value: string;
}

// A palette commit command: the shell commits its draft for repoId with the variant.
export type ScmShellCommand = { readonly command: 'commit'; readonly repoId: string; readonly variant: ScmCommitVariant };

// The editor's multi-file diff tab (EditorTabKind 'changes'); main keeps entries current while the tab is open.
export interface ScmChangesTab {
  readonly repoId: string;
  readonly source: ScmDiffSource;
  readonly entries: readonly ScmChange[];
}

export interface DamoclesScmApi {
  getState(): Promise<ScmShellState>;
  // each returns the unsubscribe
  onView(listener: (view: ScmView) => void): () => void;
  onState(listener: (snapshot: ScmRepoSnapshot) => void): () => void;
  onDecorations(listener: (decorations: ScmDecorations) => void): () => void;
  onSettings(listener: (settings: ScmSettings) => void): () => void;
  onCommand(listener: (command: ScmShellCommand) => void): () => void;
  onSetInput(listener: (input: ScmSetInput) => void): () => void;
  onClone(listener: (clone: ScmCloneState) => void): () => void;
  onArtifactsChanged(listener: (changed: ScmArtifactsChanged) => void): () => void;
  artifacts(request: ScmArtifactsRequest): Promise<ScmArtifactsResult>;
  select(request: ScmSelectRequest): Promise<void>;
  run(request: ScmRunRequest): Promise<ScmRunResult>;
  commit(request: ScmCommitRequest): Promise<ScmCommitResult>;
  generateMessage(repoId: string): Promise<ScmGenerateResult>;
  fileDiff(request: ScmFileDiffRequest): Promise<ScmFileDiffResult>;
  copy(request: ScmCopyRequest): Promise<void>;
  commitInput(repoId: string): Promise<ScmCommitInput>;
  reportAmend(report: ScmAmendReport): Promise<void>;
}

// Validators main runs on every invoke before anything reaches core. Each payload carries exactly its fields.

function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) ? value : undefined;
}

const isScmId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_SCM_ID_LENGTH;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

/**
 * A repo-relative path a renderer may name: isRelativeFilePath's rules (no '..', no root, no backslash, no NUL) and, on
 * Windows, no segment Win32 would resolve to another entry.
 */
export const isRepoPath = (value: unknown): value is string => isRelativeFilePath(value) && !(process.platform === 'win32' && hasUnsafeWindowsSegment(value));

const isHash = (value: unknown): value is string => typeof value === 'string' && isObjectName(value);

/**
 * A full refname under one of prefixes that git check-ref-format accepts: no control character, space, '~^:?*[\\', '..', '@{'
 * or '//', no component starting with '.' or ending in '.lock', no trailing '/' or '.', and a name after the prefix.
 */
export function isFullRefName(value: unknown, prefixes: readonly string[]): value is string {
  if (typeof value !== 'string' || value.length > MAX_SCM_REF_LENGTH) return false;
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  if (prefix === undefined || value.length === prefix.length) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(value) || value.includes('..') || value.includes('@{') || value.includes('//')) return false;
  if (value.endsWith('/') || value.endsWith('.')) return false;
  return value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

const ANY_REF = ['refs/heads/', 'refs/remotes/', 'refs/tags/'] as const;

/**
 * An absolute local path (a drive path on Windows, '/'-rooted elsewhere; never UNC or root-relative), bounded, with no control
 * character.
 */
export function isWorktreePath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SCM_WORKTREE_PATH_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) : value.startsWith('/');
}

const isStashIndex = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_STASH_INDEX;

function parseStashTarget(raw: unknown): ScmStashTarget | undefined {
  const value = exact(raw, ['index', 'hash']);
  return value && isStashIndex(value['index']) && isHash(value['hash']) ? { index: value['index'], hash: value['hash'] } : undefined;
}

// The present keys of raw among optional, after required; undefined unless raw holds exactly required plus some of optional.
function withOptional(raw: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  return exact(raw, [...required, ...optional.filter((key) => Object.hasOwn(raw, key))]);
}

function repoPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCM_PATHS) return undefined;
  return (value as unknown[]).every(isRepoPath) ? [...(value as string[])] : undefined;
}

export function parseScmSelect(raw: unknown): ScmSelectRequest | undefined {
  const value = exact(raw, ['projectKey', 'repoId']);
  return value && isScmId(value['projectKey']) && isScmId(value['repoId']) ? { projectKey: value['projectKey'], repoId: value['repoId'] } : undefined;
}

export function parseScmRepoRef(raw: unknown): ScmRepoRef | undefined {
  const value = exact(raw, ['repoId']);
  return value && isScmId(value['repoId']) ? { repoId: value['repoId'] } : undefined;
}

export function parseScmAmend(raw: unknown): ScmAmendReport | undefined {
  const value = exact(raw, ['repoId', 'amending']);
  return value && isScmId(value['repoId']) && typeof value['amending'] === 'boolean' ? { repoId: value['repoId'], amending: value['amending'] } : undefined;
}

export function parseScmRun(raw: unknown): ScmRunRequest | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Object.hasOwn(raw, 'op')) return undefined;
  const op = (raw as Record<string, unknown>)['op'];
  switch (op) {
    case 'init':
    case 'openRepository':
    case 'reopenClosed':
    case 'openParentRepositories':
    case 'manageUnsafeRepositories': {
      const value = exact(raw, ['op', 'projectKey']);
      return value && isScmId(value['projectKey']) ? { op, projectKey: value['projectKey'] } : undefined;
    }
    case 'showOutput':
    case 'openGitDownload':
    case 'cancelClone':
      return exact(raw, ['op']) ? { op } : undefined;
    case 'closeRepository':
    case 'closeOtherRepositories':
    case 'refresh':
    case 'unstageAll':
    case 'abortOperation':
    case 'undoLastCommit':
    case 'restoreCommitTemplate':
    case 'pullFrom':
    case 'publish':
    case 'addRemote':
    case 'removeRemote':
    case 'cancel':
    case 'renameBranch':
    case 'deleteRemoteBranch':
    case 'stashDropAll':
    case 'createTag':
    case 'deleteRemoteTag':
    case 'pushTags':
    case 'createWorktree': {
      const value = exact(raw, ['op', 'repoId']);
      return value && isScmId(value['repoId']) ? { op, repoId: value['repoId'] } : undefined;
    }
    case 'checkout': {
      const value = withOptional(raw, ['op', 'repoId', 'detached'], ['ref']);
      if (!value || !isScmId(value['repoId']) || typeof value['detached'] !== 'boolean') return undefined;
      const ref = value['ref'];
      if (Object.hasOwn(value, 'ref') && !isFullRefName(ref, ANY_REF)) return undefined;
      return { op, repoId: value['repoId'], detached: value['detached'], ...(ref !== undefined ? { ref: ref as string } : {}) };
    }
    case 'createBranch': {
      const value = withOptional(raw, ['op', 'repoId', 'from'], ['ref']);
      if (!value || !isScmId(value['repoId']) || typeof value['from'] !== 'boolean') return undefined;
      const ref = value['ref'];
      if (Object.hasOwn(value, 'ref') && !isFullRefName(ref, ANY_REF)) return undefined;
      return { op, repoId: value['repoId'], from: value['from'], ...(ref !== undefined ? { ref: ref as string } : {}) };
    }
    case 'deleteBranch':
    case 'merge':
    case 'rebase':
    case 'deleteTag': {
      const value = withOptional(raw, ['op', 'repoId'], ['ref']);
      if (!value || !isScmId(value['repoId'])) return undefined;
      const ref = value['ref'];
      const prefixes = op === 'deleteBranch' ? ['refs/heads/'] : op === 'deleteTag' ? ['refs/tags/'] : ANY_REF;
      if (Object.hasOwn(value, 'ref') && !isFullRefName(ref, prefixes)) return undefined;
      return { op, repoId: value['repoId'], ...(ref !== undefined ? { ref: ref as string } : {}) };
    }
    case 'stash': {
      const value = exact(raw, ['op', 'repoId', 'scope']);
      return value && isScmId(value['repoId']) && oneOf(SCM_STASH_SCOPES, value['scope']) ? { op, repoId: value['repoId'], scope: value['scope'] } : undefined;
    }
    case 'stashChanges': {
      const value = exact(raw, ['op', 'repoId', 'paths']);
      const paths = value ? repoPaths(value['paths']) : undefined;
      return value && isScmId(value['repoId']) && paths ? { op, repoId: value['repoId'], paths } : undefined;
    }
    case 'stashApply': {
      const value = exact(raw, ['op', 'repoId', 'pop', 'target']);
      if (!value || !isScmId(value['repoId']) || typeof value['pop'] !== 'boolean') return undefined;
      const choice = value['target'];
      const target = choice === 'latest' || choice === 'pick' ? choice : parseStashTarget(choice);
      return target ? { op, repoId: value['repoId'], pop: value['pop'], target } : undefined;
    }
    case 'stashDrop':
    case 'viewStash': {
      const value = exact(raw, ['op', 'repoId', 'target']);
      if (!value || !isScmId(value['repoId'])) return undefined;
      const target = value['target'] === 'pick' ? 'pick' : parseStashTarget(value['target']);
      return target ? { op, repoId: value['repoId'], target } : undefined;
    }
    case 'deleteWorktree': {
      const value = withOptional(raw, ['op', 'repoId'], ['path']);
      if (!value || !isScmId(value['repoId'])) return undefined;
      const worktree = value['path'];
      if (Object.hasOwn(value, 'path') && !isWorktreePath(worktree)) return undefined;
      return { op, repoId: value['repoId'], ...(worktree !== undefined ? { path: worktree as string } : {}) };
    }
    case 'compareRef': {
      const value = exact(raw, ['op', 'repoId', 'ref']);
      return value && isScmId(value['repoId']) && isFullRefName(value['ref'], ['refs/heads/', 'refs/tags/']) ? { op, repoId: value['repoId'], ref: value['ref'] } : undefined;
    }
    case 'openWorktree': {
      const value = exact(raw, ['op', 'repoId', 'path']);
      return value && isScmId(value['repoId']) && isWorktreePath(value['path']) ? { op, repoId: value['repoId'], path: value['path'] } : undefined;
    }
    case 'stage':
    case 'unstage':
    case 'discard':
    case 'addToGitignore': {
      const value = exact(raw, ['op', 'repoId', 'paths']);
      const paths = value ? repoPaths(value['paths']) : undefined;
      return value && isScmId(value['repoId']) && paths ? { op, repoId: value['repoId'], paths } : undefined;
    }
    case 'stageAll': {
      const value = exact(raw, ['op', 'repoId', 'scope']);
      return value && isScmId(value['repoId']) && oneOf(SCM_STAGE_ALL_SCOPES, value['scope']) ? { op, repoId: value['repoId'], scope: value['scope'] } : undefined;
    }
    case 'discardAll': {
      const value = exact(raw, ['op', 'repoId', 'scope']);
      return value && isScmId(value['repoId']) && oneOf(SCM_DISCARD_ALL_SCOPES, value['scope']) ? { op, repoId: value['repoId'], scope: value['scope'] } : undefined;
    }
    case 'reveal':
    case 'mention':
    case 'openFile':
    case 'openFileHead': {
      const value = exact(raw, ['op', 'repoId', 'path']);
      return value && isScmId(value['repoId']) && isRepoPath(value['path']) ? { op, repoId: value['repoId'], path: value['path'] } : undefined;
    }
    case 'openChanges': {
      const value = exact(raw, ['op', 'repoId', 'path', 'group']);
      return value && isScmId(value['repoId']) && isRepoPath(value['path']) && oneOf(SCM_GROUPS, value['group'])
        ? { op, repoId: value['repoId'], path: value['path'], group: value['group'] }
        : undefined;
    }
    case 'openGroupChanges': {
      const value = exact(raw, ['op', 'repoId', 'group']);
      return value && isScmId(value['repoId']) && oneOf(SCM_GROUPS, value['group']) ? { op, repoId: value['repoId'], group: value['group'] } : undefined;
    }
    case 'fetch': {
      const value = exact(raw, ['op', 'repoId', 'scope']);
      return value && isScmId(value['repoId']) && oneOf(SCM_FETCH_SCOPES, value['scope']) ? { op, repoId: value['repoId'], scope: value['scope'] } : undefined;
    }
    case 'pull':
    case 'sync': {
      const value = exact(raw, ['op', 'repoId', 'rebase']);
      return value && isScmId(value['repoId']) && typeof value['rebase'] === 'boolean' ? { op, repoId: value['repoId'], rebase: value['rebase'] } : undefined;
    }
    case 'push': {
      const value = exact(raw, ['op', 'repoId', 'to', 'force', 'followTags']);
      if (!value || !isScmId(value['repoId'])) return undefined;
      const { to, force, followTags } = value;
      return typeof to === 'boolean' && typeof force === 'boolean' && typeof followTags === 'boolean' ? { op, repoId: value['repoId'], to, force, followTags } : undefined;
    }
    case 'clone': {
      const value = exact(raw, ['op', 'recursive']);
      return value && typeof value['recursive'] === 'boolean' ? { op, recursive: value['recursive'] } : undefined;
    }
    default:
      return undefined;
  }
}

function parseCommitVariant(raw: unknown): ScmCommitVariant | undefined {
  const value = exact(raw, ['scope', 'amend', 'signoff', 'noVerify', 'empty']);
  if (!value || !oneOf(SCM_COMMIT_SCOPES, value['scope'])) return undefined;
  const { amend, signoff, noVerify, empty } = value;
  return typeof amend === 'boolean' && typeof signoff === 'boolean' && typeof noVerify === 'boolean' && typeof empty === 'boolean'
    ? { scope: value['scope'], amend, signoff, noVerify, empty }
    : undefined;
}

export function parseScmCommit(raw: unknown): ScmCommitRequest | undefined {
  const withPost = typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'postCommit');
  const value = exact(raw, withPost ? ['repoId', 'message', 'variant', 'postCommit'] : ['repoId', 'message', 'variant']);
  const message = value?.['message'];
  const variant = value ? parseCommitVariant(value['variant']) : undefined;
  const postCommit = value?.['postCommit'];
  if (withPost && !oneOf(SCM_POST_COMMITS, postCommit)) return undefined;
  return value && isScmId(value['repoId']) && typeof message === 'string' && message.length <= MAX_COMMIT_MESSAGE_CHARS && !message.includes('\0') && variant
    ? { repoId: value['repoId'], message, variant, ...(withPost ? { postCommit: postCommit as ScmPostCommit } : {}) }
    : undefined;
}

function parseDiffSource(raw: unknown): ScmDiffSource | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const kind = (raw as Record<string, unknown>)['kind'];
  if (kind === 'stash') {
    const value = exact(raw, ['kind', 'index', 'hash']);
    return value && isStashIndex(value['index']) && isHash(value['hash']) ? { kind, index: value['index'], hash: value['hash'] } : undefined;
  }
  if (kind === 'refs') {
    const value = exact(raw, ['kind', 'left', 'right']);
    return value && isHash(value['left']) && isHash(value['right']) ? { kind, left: value['left'], right: value['right'] } : undefined;
  }
  const value = exact(raw, ['kind']);
  return value && oneOf(SCM_GROUPS, value['kind']) ? { kind: value['kind'] } : undefined;
}

export function parseScmFileDiff(raw: unknown): ScmFileDiffRequest | undefined {
  const value = exact(raw, ['repoId', 'source', 'path']);
  const source = value ? parseDiffSource(value['source']) : undefined;
  return value && isScmId(value['repoId']) && source && isRepoPath(value['path']) ? { repoId: value['repoId'], source, path: value['path'] } : undefined;
}

// A path copied to the clipboard holds no control character on any platform, so a pasted name cannot run a second command.
// eslint-disable-next-line no-control-regex
const isCopyablePath = (value: unknown): value is string => isRepoPath(value) && !/[\u0000-\u001f\u007f]/.test(value);

// The row forms each copy kind may name.
const COPY_TARGETS: Readonly<Record<ScmCopyKind, (value: unknown) => boolean>> = {
  path: isCopyablePath,
  relativePath: isCopyablePath,
  stashName: isHash,
  branchName: (value) => isHash(value) || isFullRefName(value, ['refs/heads/']) || isWorktreePath(value),
  tagName: (value) => isFullRefName(value, ['refs/tags/']),
  commitHash: (value) => isFullRefName(value, ['refs/heads/', 'refs/tags/']) || isWorktreePath(value),
  worktreePath: isWorktreePath,
};

export function parseScmCopy(raw: unknown): ScmCopyRequest | undefined {
  const value = exact(raw, ['repoId', 'kind', 'value']);
  if (!value || !isScmId(value['repoId']) || !oneOf(SCM_COPY_KINDS, value['kind'])) return undefined;
  const kind = value['kind'];
  return COPY_TARGETS[kind](value['value']) ? { repoId: value['repoId'], kind, value: value['value'] as string } : undefined;
}

export function parseScmArtifacts(raw: unknown): ScmArtifactsRequest | undefined {
  const value = exact(raw, ['repoId', 'group']);
  return value && isScmId(value['repoId']) && oneOf(SCM_ARTIFACT_GROUPS, value['group']) ? { repoId: value['repoId'], group: value['group'] } : undefined;
}
