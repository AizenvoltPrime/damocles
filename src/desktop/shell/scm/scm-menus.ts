import type { OverlayIcon, OverlayMenuItem } from '../../preload/overlay-channels';
import { tidyMenu } from '../../preload/overlay-channels';
import type {
  ScmBranchArtifact,
  ScmChange,
  ScmCommitVariant,
  ScmCopyRequest,
  ScmGroup,
  ScmHead,
  ScmOperation,
  ScmRunRequest,
  ScmSettings,
  ScmStashArtifact,
  ScmTagArtifact,
  ScmWorktreeArtifact,
} from '../../preload/scm-channels';

// Source control's menus, as VS Code's extensions/git/package.json `menus` lays them out.

// The commit commands of VS Code's git.commit submenu, each with the variant it sends (contract: ScmCommitVariant).
const COMMIT = { scope: 'auto', amend: false, signoff: false, noVerify: false, empty: false } as const;
export const COMMIT_VARIANTS = {
  commit: COMMIT,
  commitStaged: { ...COMMIT, scope: 'staged' },
  commitAll: { ...COMMIT, scope: 'all' },
  commitNoVerify: { ...COMMIT, noVerify: true },
  commitStagedNoVerify: { ...COMMIT, scope: 'staged', noVerify: true },
  commitAllNoVerify: { ...COMMIT, scope: 'all', noVerify: true },
  commitAmend: { ...COMMIT, amend: true },
  commitStagedAmend: { ...COMMIT, scope: 'staged', amend: true },
  commitAllAmend: { ...COMMIT, scope: 'all', amend: true },
  commitAmendNoVerify: { ...COMMIT, amend: true, noVerify: true },
  commitStagedAmendNoVerify: { ...COMMIT, scope: 'staged', amend: true, noVerify: true },
  commitAllAmendNoVerify: { ...COMMIT, scope: 'all', amend: true, noVerify: true },
  commitSigned: { ...COMMIT, signoff: true },
  commitStagedSigned: { ...COMMIT, scope: 'staged', signoff: true },
  commitAllSigned: { ...COMMIT, scope: 'all', signoff: true },
  commitSignedNoVerify: { ...COMMIT, signoff: true, noVerify: true },
  commitStagedSignedNoVerify: { ...COMMIT, scope: 'staged', signoff: true, noVerify: true },
  commitAllSignedNoVerify: { ...COMMIT, scope: 'all', signoff: true, noVerify: true },
} as const satisfies Record<string, ScmCommitVariant>;
export type ScmCommitAction = keyof typeof COMMIT_VARIANTS;

// In amend mode every commit action amends (CommitBox.commit), and each non-amend item is labelled as the amend it runs.
const AMENDED_LABELS = {
  commit: 'commitAmend',
  commitStaged: 'commitStagedAmend',
  commitAll: 'commitAllAmend',
  commitNoVerify: 'commitAmendNoVerify',
  commitStagedNoVerify: 'commitStagedAmendNoVerify',
  commitAllNoVerify: 'commitAllAmendNoVerify',
  commitSigned: 'commitAmendSigned',
  commitStagedSigned: 'commitStagedAmendSigned',
  commitAllSigned: 'commitAllAmendSigned',
  commitSignedNoVerify: 'commitAmendSignedNoVerify',
  commitStagedSignedNoVerify: 'commitStagedAmendSignedNoVerify',
  commitAllSignedNoVerify: 'commitAllAmendSignedNoVerify',
} as const satisfies Partial<Record<ScmCommitAction, string>>;
type AmendableAction = keyof typeof AMENDED_LABELS;
type AmendedLabel = (typeof AMENDED_LABELS)[AmendableAction];

export type ScmViewMode = 'list' | 'tree';
export type ScmSortKey = 'name' | 'path' | 'status';

// Every action a source control menu or inline button runs; ScmSection maps each to its damocles:scm:* call.
export type ScmAction =
  | 'viewAsTree' | 'viewAsList' | 'sortByName' | 'sortByPath' | 'sortByStatus'
  | 'stageAll' | 'unstageAll' | 'discardAll' | 'stageAllTracked' | 'stageAllUntracked' | 'discardAllTracked' | 'discardAllUntracked'
  | 'stageAllMerge' | 'openGroupChanges'
  | 'closeRepository' | 'closeOtherRepositories' | 'reopenClosed' | 'showOutput'
  | 'openChanges' | 'compareWithWorkspace' | 'openFile' | 'openFileHead' | 'stage' | 'unstage' | 'discard' | 'addToGitignore'
  | 'copyPath' | 'copyRelativePath' | 'reveal' | 'mention'
  | 'resolveInMergeEditor' | 'acceptAllCurrent' | 'acceptAllIncoming' | 'openTimeline'
  | ScmCommitAction | 'undoLastCommit' | 'abortRebase' | 'restoreCommitTemplate' | 'toggleAmend' | 'commitPush' | 'commitSync'
  | RemoteAction | 'clone' | RefAction | StashAction | StashRowAction | 'stashChanges' | ArtifactAction | GraphCommitAction | GraphRefAction;

// A Graph commit row's actions (VS Code's scm/historyItem/context, in the plan's order), each on that row's commit.
export type GraphCommitAction =
  | 'openCommit' | 'checkoutCommit' | 'createBranchAtCommit' | 'createTagAtCommit' | 'cherryPick'
  | 'compareCommit' | 'compareWithRemote' | 'compareWithMergeBase' | 'copyCommitId' | 'copyCommitMessage' | 'addCommitToChat' | 'explainCommit';

// A Graph ref badge's actions (VS Code's scm/historyItemRef/context, with Delete Remote Branch split out).
export type GraphRefAction = 'checkoutRef' | 'deleteBranchRef' | 'deleteRemoteBranchRef' | 'deleteTagRef';

// A Repositories branch, tag or worktree row's actions (D58, VS Code's scm/artifact/context), each on that row.
export type ArtifactAction =
  | 'checkoutRef' | 'checkoutRefDetached' | 'mergeRef' | 'rebaseRef' | 'createBranchFromRef' | 'deleteRef' | 'compareRef'
  | 'copyBranchName' | 'copyTagName' | 'copyCommitHash' | 'openWorktree' | 'deleteWorktreeRow' | 'copyWorktreePath' | 'newChatInWorktree';

// The commands of VS Code's git.pullpush and git.remotes submenus.
export type RemoteAction =
  | 'sync' | 'syncRebase' | 'pull' | 'pullRebase' | 'pullFrom' | 'push' | 'pushForce' | 'pushTo' | 'pushToForce'
  | 'fetch' | 'fetchPrune' | 'fetchAll' | 'addRemote' | 'removeRemote';

// The commands of VS Code's git.branch, git.tags and git.worktrees submenus, and Checkout to...
export type RefAction =
  | 'checkout' | 'merge' | 'rebase' | 'createBranch' | 'createBranchFrom' | 'renameBranch' | 'deleteBranch' | 'deleteRemoteBranch' | 'publish'
  | 'createTag' | 'deleteTag' | 'deleteRemoteTag' | 'pushTags' | 'createWorktree' | 'deleteWorktree';

// The commands of VS Code's git.stash submenu; the pickers (Apply Stash... and the like) ask main for the stash.
export type StashAction =
  | 'stash' | 'stashIncludeUntracked' | 'stashStaged' | 'stashApplyLatest' | 'stashApply' | 'stashPopLatest' | 'stashPop'
  | 'stashDrop' | 'stashDropAll' | 'stashView';

// A stash row's actions (D58, VS Code's scm/artifact/context for a stash), each on that row's stash.
export type StashRowAction = 'applyStash' | 'viewStash' | 'popStash' | 'dropStash' | 'copyBranchName' | 'copyStashName';

// Why a menu entry is disabled; each is a key under scm.disabled in the shell locales, shown beside the entry.
export type ScmDisabledReason =
  | 'noCommits'
  | 'noRemotes'
  | 'noStashes'
  | 'detachedHead'
  | 'noRebase'
  | 'mergeInProgress'
  | 'rebaseInProgress'
  | 'cherryPickInProgress'
  | 'checkedOut'
  | 'mainWorktree'
  | 'currentWorktree'
  | 'noUpstream'
  | 'noBaseRef'
  | 'currentUpstream';

export interface ScmMenuEntry {
  readonly action: ScmAction;
  // a key under scm.action in the shell locales
  readonly label: ScmAction | 'openUntrackedChanges' | 'stageMerge' | AmendedLabel;
  readonly icon?: OverlayIcon;
  readonly danger?: true;
  readonly checked?: boolean;
  // with checked: one of mutually exclusive choices
  readonly radio?: true;
  // present: the entry is disabled, for this reason
  readonly disabled?: ScmDisabledReason;
}

const OPERATION_REASONS: Readonly<Record<ScmOperation, ScmDisabledReason>> = {
  merge: 'mergeInProgress',
  rebase: 'rebaseInProgress',
  cherryPick: 'cherryPickInProgress',
};

// The entry's disabled field: the first reason that holds, or none.
const disabledBy = (...reasons: ReadonlyArray<ScmDisabledReason | false>): { readonly disabled?: ScmDisabledReason } => {
  const reason = reasons.find((candidate): candidate is ScmDisabledReason => candidate !== false);
  return reason === undefined ? {} : { disabled: reason };
};

// HEAD is not on a branch: before the first commit, or detached; null (no status yet) claims neither
const notOnBranch = (head: ScmHead['type'] | null): ScmDisabledReason | false => (head === 'unborn' ? 'noCommits' : head === 'detached' && 'detachedHead');
export type ScmMenuNode =
  | ScmMenuEntry
  | { readonly separator: true }
  | {
    readonly submenu: 'viewSort' | 'commit' | 'changes' | 'pullPush' | 'branch' | 'remote' | 'stash' | 'tags' | 'worktrees' | 'repositories';
    readonly icon: OverlayIcon;
    readonly items: readonly ScmMenuNode[];
    // its items' overlay ids are `<submenu>:<action>`: the overlay wants ids unique across a menu's levels, and this submenu
    // repeats commands the menu's top level has (VS Code lists Pull, Push and Fetch in both)
    readonly scoped?: true;
  };

const SEPARATOR = { separator: true } as const;

/** The action an overlay menu answer names: an item id is the action, or `<submenu>:<action>` inside a scoped submenu. */
export const actionOf = (itemId: string): ScmAction => itemId.slice(itemId.indexOf(':') + 1) as ScmAction;

/** The overlay menu for a node list, labelled by `label` (a disabled entry's reason too); empty submenus drop out. */
export function toOverlayMenu(nodes: readonly ScmMenuNode[], label: (key: string) => string): OverlayMenuItem[] {
  const convert = (node: ScmMenuNode, scope?: string): OverlayMenuItem | undefined => {
    if ('separator' in node) return { kind: 'separator' };
    if ('submenu' in node) {
      const items = tidyMenu(node.items.flatMap((child) => convert(child, node.scoped ? node.submenu : undefined) ?? []));
      return items.length === 0 ? undefined : { kind: 'submenu', id: `submenu:${node.submenu}`, label: label(`submenu.${node.submenu}`), icon: node.icon, items };
    }
    return {
      kind: 'item',
      id: scope === undefined ? node.action : `${scope}:${node.action}`,
      label: label(`action.${node.label}`),
      ...(node.icon ? { icon: node.icon } : {}),
      ...(node.danger ? { danger: true } : {}),
      ...(node.checked !== undefined ? { checked: node.checked } : {}),
      ...(node.radio ? { radio: true } : {}),
      ...(node.disabled !== undefined ? { disabled: true, disabledReason: label(`disabled.${node.disabled}`) } : {}),
    };
  };
  return tidyMenu(nodes.flatMap((node) => convert(node) ?? []));
}

export interface MoreActionsContext {
  readonly viewMode: ScmViewMode;
  readonly sortKey: ScmSortKey;
  readonly untrackedChanges: ScmSettings['untrackedChanges'];
  readonly openRepos: number;
  readonly closedCount: number;
  readonly commit: CommitMenuContext;
  readonly remote: RemoteMenuContext;
  readonly refs: RefMenuContext;
}

export interface RefMenuContext {
  // what HEAD is on, null before the status says; Rename Branch..., Publish Branch... and Sync need a branch with a commit
  readonly head: ScmHead['type'] | null;
  // git 2.35 or later (ScmCapabilities.stashStaged)
  readonly stashStaged: boolean;
  // the repository's stash count once the Stashes group read it; null before
  readonly stashes: number | null;
}

export interface CommitMenuContext {
  readonly operation: ScmOperation | null;
  // HEAD has a commit (not an unborn branch)
  readonly hasCommit: boolean;
  readonly hasTemplate: boolean;
  readonly allowNoVerifyCommit: boolean;
  // the commit box is in amend mode (and git can amend now)
  readonly amending: boolean;
}

const commitEntry = (action: AmendableAction, icon: OverlayIcon, amending: boolean): ScmMenuEntry => ({ action, label: amending ? AMENDED_LABELS[action] : action, icon });

/**
 * Commit › (VS Code's git.commit submenu, its groups in order); the No Verify groups only while allowNoVerifyCommit is on. In
 * amend mode the amend groups are left out, since every other item amends.
 */
export function commitMenu(context: CommitMenuContext): ScmMenuNode[] {
  const noVerify = context.allowNoVerifyCommit;
  const entry = (action: AmendableAction, icon: OverlayIcon): ScmMenuEntry => commitEntry(action, icon, context.amending);
  // git cannot amend while a merge, rebase or cherry-pick is in progress, nor before the first commit
  const notAmendable = disabledBy(!context.hasCommit && 'noCommits', context.operation !== null && OPERATION_REASONS[context.operation]);
  const amend = (action: ScmCommitAction, icon: OverlayIcon = 'pencil-line'): ScmMenuEntry => ({ action, label: action, icon, ...notAmendable });
  return [
    entry('commit', 'check'),
    entry('commitStaged', 'check'),
    entry('commitAll', 'check-check'),
    { action: 'undoLastCommit', label: 'undoLastCommit', icon: 'undo-2', ...disabledBy(!context.hasCommit && 'noCommits') },
    ...(context.hasTemplate ? [{ action: 'restoreCommitTemplate', label: 'restoreCommitTemplate', icon: 'file-text' } as const] : []),
    { action: 'abortRebase', label: 'abortRebase', icon: 'x', ...disabledBy(context.operation !== 'rebase' && 'noRebase') },
    ...(noVerify ? [SEPARATOR, entry('commitNoVerify', 'shield-off'), entry('commitStagedNoVerify', 'shield-off'), entry('commitAllNoVerify', 'shield-off')] : []),
    ...(context.amending
      ? []
      : [
          SEPARATOR,
          amend('commitAmend'),
          amend('commitStagedAmend'),
          amend('commitAllAmend'),
          ...(noVerify ? [SEPARATOR, amend('commitAmendNoVerify', 'shield-off'), amend('commitStagedAmendNoVerify', 'shield-off'), amend('commitAllAmendNoVerify', 'shield-off')] : []),
        ]),
    SEPARATOR,
    entry('commitSigned', 'signature'),
    entry('commitStagedSigned', 'signature'),
    entry('commitAllSigned', 'signature'),
    ...(noVerify ? [SEPARATOR, entry('commitSignedNoVerify', 'shield-off'), entry('commitStagedSignedNoVerify', 'shield-off'), entry('commitAllSignedNoVerify', 'shield-off')] : []),
  ];
}

/**
 * The commit box's split button menu (prototype). Commit (Amend) enters amend mode, which Escape or the banner leaves. Commit &
 * Push and Commit & Sync are left out in amend mode, where a plain push of the rewritten commit would be refused, and off where
 * main would refuse the push after the commit landed: no remote, or a detached HEAD (an unborn branch has one once it commits).
 */
export function splitButtonMenu(context: Pick<CommitMenuContext, 'operation' | 'hasCommit' | 'amending'> & Pick<RefMenuContext, 'head'> & Pick<RemoteMenuContext, 'hasRemotes'>): ScmMenuNode[] {
  const pushes = disabledBy(!context.hasRemotes && 'noRemotes', context.head === 'detached' && 'detachedHead');
  return [
    commitEntry('commit', 'check', context.amending),
    ...(context.amending
      ? []
      : [
          {
            action: 'toggleAmend',
            label: 'commitAmend',
            icon: 'pencil-line',
            ...disabledBy(!context.hasCommit && 'noCommits', context.operation !== null && OPERATION_REASONS[context.operation]),
          } as const,
          SEPARATOR,
          { action: 'commitPush', label: 'commitPush', icon: 'cloud-upload', ...pushes } as const,
          { action: 'commitSync', label: 'commitSync', icon: 'refresh-cw', ...pushes } as const,
        ]),
    SEPARATOR,
    commitEntry('commitSigned', 'signature', context.amending),
  ];
}

export interface RemoteMenuContext {
  // the repository has at least one remote; every item but Add Remote... needs one
  readonly hasRemotes: boolean;
  // force variants exist only while damocles.desktop.git.allowForcePush is on
  readonly allowForcePush: boolean;
  readonly operation: ScmOperation | null;
}

/** Pull, Push › (VS Code's git.pullpush submenu, its groups in order). Sync needs a branch with a commit, as main's push does. */
export function pullPushMenu(context: RemoteMenuContext & Pick<RefMenuContext, 'head'>): ScmMenuNode[] {
  const noRemotes = !context.hasRemotes && 'noRemotes';
  const entry = (action: RemoteAction, icon: OverlayIcon, ...reasons: ReadonlyArray<ScmDisabledReason | false>): ScmMenuEntry => ({ action, label: action, icon, ...disabledBy(noRemotes, ...reasons) });
  const branch = notOnBranch(context.head);
  return [
    entry('sync', 'refresh-cw', branch),
    // VS Code's when-clause gitState == idle: no merge, rebase or cherry-pick in progress
    entry('syncRebase', 'refresh-cw', branch, context.operation !== null && OPERATION_REASONS[context.operation]),
    SEPARATOR,
    entry('pull', 'arrow-down-to-line'),
    entry('pullRebase', 'arrow-down-to-line'),
    entry('pullFrom', 'arrow-down-to-line'),
    SEPARATOR,
    entry('push', 'arrow-up-from-line'),
    ...(context.allowForcePush ? [entry('pushForce', 'arrow-up-from-line')] : []),
    entry('pushTo', 'arrow-up-from-line'),
    ...(context.allowForcePush ? [entry('pushToForce', 'arrow-up-from-line')] : []),
    SEPARATOR,
    entry('fetch', 'cloud-download'),
    entry('fetchPrune', 'cloud-download'),
    entry('fetchAll', 'cloud-download'),
  ];
}

/** Remote › (VS Code's git.remotes submenu). */
export function remoteMenu(context: Pick<RemoteMenuContext, 'hasRemotes'>): ScmMenuNode[] {
  return [
    { action: 'addRemote', label: 'addRemote', icon: 'plus' },
    { action: 'removeRemote', label: 'removeRemote', icon: 'minus', ...disabledBy(!context.hasRemotes && 'noRemotes') },
  ];
}

/** Branch › (VS Code's git.branch submenu, its groups in order). */
export function branchMenu(context: Pick<RefMenuContext, 'head'> & Pick<RemoteMenuContext, 'hasRemotes'>): ScmMenuNode[] {
  const needsBranch = disabledBy(notOnBranch(context.head));
  const needsRemote = disabledBy(!context.hasRemotes && 'noRemotes');
  return [
    { action: 'merge', label: 'merge', icon: 'git-merge' },
    { action: 'rebase', label: 'rebase', icon: 'git-pull-request-arrow' },
    SEPARATOR,
    { action: 'createBranch', label: 'createBranch', icon: 'git-branch-plus' },
    { action: 'createBranchFrom', label: 'createBranchFrom', icon: 'git-branch-plus' },
    SEPARATOR,
    { action: 'renameBranch', label: 'renameBranch', icon: 'pencil', ...needsBranch },
    { action: 'deleteBranch', label: 'deleteBranch', icon: 'trash-2' },
    { action: 'deleteRemoteBranch', label: 'deleteRemoteBranch', icon: 'trash-2', ...needsRemote },
    SEPARATOR,
    { action: 'publish', label: 'publish', icon: 'cloud-upload', ...disabledBy(notOnBranch(context.head), !context.hasRemotes && 'noRemotes') },
  ];
}

/** Stash › (VS Code's git.stash submenu); Stash Staged only with git 2.35 or later, and the stash pickers off with no stashes. */
export function stashMenu(context: Pick<RefMenuContext, 'stashStaged' | 'stashes'>): ScmMenuNode[] {
  const needsStash = disabledBy(context.stashes === 0 && 'noStashes');
  return [
    { action: 'stash', label: 'stash', icon: 'archive' },
    { action: 'stashIncludeUntracked', label: 'stashIncludeUntracked', icon: 'archive' },
    ...(context.stashStaged ? [{ action: 'stashStaged', label: 'stashStaged', icon: 'archive' } as const] : []),
    SEPARATOR,
    { action: 'stashApplyLatest', label: 'stashApplyLatest', icon: 'archive-restore', ...needsStash },
    { action: 'stashApply', label: 'stashApply', icon: 'archive-restore', ...needsStash },
    SEPARATOR,
    { action: 'stashPopLatest', label: 'stashPopLatest', icon: 'arrow-up-from-line', ...needsStash },
    { action: 'stashPop', label: 'stashPop', icon: 'arrow-up-from-line', ...needsStash },
    SEPARATOR,
    { action: 'stashDrop', label: 'stashDrop', icon: 'trash-2', ...needsStash },
    { action: 'stashDropAll', label: 'stashDropAll', icon: 'trash-2', danger: true, ...needsStash },
    SEPARATOR,
    { action: 'stashView', label: 'stashView', icon: 'eye', ...needsStash },
  ];
}

/** Tags › (VS Code's git.tags submenu). */
export function tagsMenu(context: Pick<RemoteMenuContext, 'hasRemotes'>): ScmMenuNode[] {
  const needsRemote = disabledBy(!context.hasRemotes && 'noRemotes');
  return [
    { action: 'createTag', label: 'createTag', icon: 'tag' },
    { action: 'deleteTag', label: 'deleteTag', icon: 'trash-2' },
    { action: 'deleteRemoteTag', label: 'deleteRemoteTag', icon: 'trash-2', ...needsRemote },
    SEPARATOR,
    { action: 'pushTags', label: 'pushTags', icon: 'cloud-upload', ...needsRemote },
  ];
}

/** Worktrees › (VS Code's git.worktrees submenu). */
export function worktreesMenu(): ScmMenuNode[] {
  return [
    { action: 'createWorktree', label: 'createWorktree', icon: 'folder-plus' },
    { action: 'deleteWorktree', label: 'deleteWorktree', icon: 'trash-2' },
  ];
}

/**
 * A stash row's menu (D58), shared by Source control's Stashes group and the Repositories section's stash rows: Apply Stash is
 * also the row's inline action. Copy Branch Name only for a stash that names its branch.
 */
export function stashRowMenu(stash: Pick<ScmStashArtifact, 'branch'>): ScmMenuNode[] {
  return [
    { action: 'applyStash', label: 'applyStash', icon: 'archive-restore' },
    { action: 'viewStash', label: 'viewStash', icon: 'eye' },
    { action: 'popStash', label: 'popStash', icon: 'arrow-up-from-line' },
    { action: 'dropStash', label: 'dropStash', icon: 'trash-2', danger: true },
    SEPARATOR,
    ...(stash.branch === null ? [] : [{ action: 'copyBranchName', label: 'copyBranchName', icon: 'copy' } as const]),
    { action: 'copyStashName', label: 'copyStashName', icon: 'copy' },
  ];
}

/** What a row action calls: the damocles:scm:* operation Source control's menus call for the same action. */
export type ScmRowCall = { readonly run: ScmRunRequest } | { readonly copy: ScmCopyRequest };

/** A stash row's action on that row's stash (D58), pinned by its hash so a shifted index never reaches another stash. */
export function stashRowCall(action: StashRowAction, repoId: string, stash: Pick<ScmStashArtifact, 'index' | 'hash'>): ScmRowCall {
  const target = { index: stash.index, hash: stash.hash };
  switch (action) {
    case 'applyStash': return { run: { op: 'stashApply', repoId, pop: false, target } };
    case 'popStash': return { run: { op: 'stashApply', repoId, pop: true, target } };
    case 'dropStash': return { run: { op: 'stashDrop', repoId, target } };
    case 'viewStash': return { run: { op: 'viewStash', repoId, target } };
    case 'copyBranchName': return { copy: { repoId, kind: 'branchName', value: stash.hash } };
    case 'copyStashName': return { copy: { repoId, kind: 'stashName', value: stash.hash } };
  }
}

const STASH_ROW_ACTIONS: ReadonlySet<ScmAction> = new Set<StashRowAction>(['applyStash', 'viewStash', 'popStash', 'dropStash', 'copyBranchName', 'copyStashName']);
export const isStashRowAction = (action: ScmAction): action is StashRowAction => STASH_ROW_ACTIONS.has(action);

/**
 * A branch row's menu (VS Code's scm/artifact/context for branches, its groups in order). Checkout and Delete are off on the
 * branch HEAD is on (VS Code's !scmArtifactIsHistoryItemRef).
 */
export function branchRowMenu(branch: Pick<ScmBranchArtifact, 'current' | 'commit'>): ScmMenuNode[] {
  const head = disabledBy(branch.current && 'checkedOut');
  return [
    { action: 'checkoutRef', label: 'checkoutRef', icon: 'check', ...head },
    { action: 'checkoutRefDetached', label: 'checkoutRefDetached', icon: 'circle-dot' },
    SEPARATOR,
    { action: 'mergeRef', label: 'mergeRef', icon: 'git-merge' },
    { action: 'rebaseRef', label: 'rebaseRef', icon: 'git-pull-request-arrow' },
    SEPARATOR,
    { action: 'createBranchFromRef', label: 'createBranchFromRef', icon: 'git-branch-plus' },
    { action: 'deleteRef', label: 'deleteRef', icon: 'trash-2', danger: true, ...head },
    SEPARATOR,
    { action: 'compareRef', label: 'compareRef', icon: 'git-compare' },
    SEPARATOR,
    { action: 'copyBranchName', label: 'copyBranchName', icon: 'copy' },
    ...(branch.commit ? [{ action: 'copyCommitHash', label: 'copyCommitHash', icon: 'hash' } as const] : []),
  ];
}

/** A tag row's menu (VS Code's scm/artifact/context for tags). */
export function tagRowMenu(tag: Pick<ScmTagArtifact, 'current' | 'commit'>): ScmMenuNode[] {
  const head = disabledBy(tag.current && 'checkedOut');
  return [
    { action: 'checkoutRef', label: 'checkoutRef', icon: 'check', ...head },
    { action: 'checkoutRefDetached', label: 'checkoutRefDetached', icon: 'circle-dot' },
    SEPARATOR,
    { action: 'deleteRef', label: 'deleteRef', icon: 'trash-2', danger: true, ...head },
    SEPARATOR,
    { action: 'compareRef', label: 'compareRef', icon: 'git-compare' },
    SEPARATOR,
    { action: 'copyTagName', label: 'copyTagName', icon: 'copy' },
    ...(tag.commit ? [{ action: 'copyCommitHash', label: 'copyCommitHash', icon: 'hash' } as const] : []),
  ];
}

/**
 * A worktree row's menu (D58: Open in place of VS Code's two Open Worktree commands). Delete is off on the main worktree and
 * on the repository's own, which git cannot remove; the copies need a branch and a commit.
 */
export function worktreeRowMenu(worktree: Pick<ScmWorktreeArtifact, 'main' | 'current' | 'branch' | 'commit' | 'newChatIn'>): ScmMenuNode[] {
  return [
    ...(worktree.newChatIn ? [{ action: 'newChatInWorktree', label: 'newChatInWorktree', icon: 'plus' } as const] : []),
    { action: 'openWorktree', label: 'openWorktree', icon: 'arrow-up-right' },
    SEPARATOR,
    { action: 'deleteWorktreeRow', label: 'deleteRef', icon: 'trash-2', danger: true, ...disabledBy(worktree.main && 'mainWorktree', worktree.current && 'currentWorktree') },
    SEPARATOR,
    ...(worktree.branch === null ? [] : [{ action: 'copyBranchName', label: 'copyBranchName', icon: 'copy' } as const]),
    ...(worktree.commit ? [{ action: 'copyCommitHash', label: 'copyCommitHash', icon: 'hash' } as const] : []),
    { action: 'copyWorktreePath', label: 'copyWorktreePath', icon: 'copy' },
  ];
}

/** A repository row's menu (VS Code's repository context menu). */
export function repositoryRowMenu(openRepos: number): ScmMenuNode[] {
  return [
    { action: 'closeRepository', label: 'closeRepository', icon: 'x' },
    ...(openRepos > 1 ? [{ action: 'closeOtherRepositories', label: 'closeOtherRepositories', icon: 'copy-x' } as const] : []),
  ];
}

/** The Stashes group's Stash menu in the Repositories section (VS Code's git.repositories.stash submenu). */
export function repositoryStashMenu(stashStaged: boolean): ScmMenuNode[] {
  return [
    { action: 'stash', label: 'stash', icon: 'archive' },
    SEPARATOR,
    ...(stashStaged ? [{ action: 'stashStaged', label: 'stashStaged', icon: 'archive' } as const] : []),
    { action: 'stashIncludeUntracked', label: 'stashIncludeUntracked', icon: 'archive' },
  ];
}

/** A Repositories group's inline action (VS Code's scm/artifactGroup/context inline group); Stash opens its menu. */
export const REPOSITORY_GROUP_ACTIONS: Readonly<Record<'branches' | 'stashes' | 'tags' | 'worktrees', GroupInlineAction>> = {
  branches: { action: 'createBranch', label: 'createBranch', icon: 'plus' },
  stashes: { action: 'stash', label: 'stash', icon: 'archive' },
  tags: { action: 'createTag', label: 'createTag', icon: 'plus' },
  worktrees: { action: 'createWorktree', label: 'createWorktree', icon: 'plus' },
};

/** A branch, tag or worktree row's action as the operation it calls; the row's full refname or path names it to main. */
export function artifactRowCall(
  action: ArtifactAction,
  repoId: string,
  row: { readonly kind: 'branch'; readonly branch: Pick<ScmBranchArtifact, 'ref'> } | { readonly kind: 'tag'; readonly tag: Pick<ScmTagArtifact, 'ref'> } | { readonly kind: 'worktree'; readonly worktree: Pick<ScmWorktreeArtifact, 'path'> },
): ScmRowCall | undefined {
  if (row.kind === 'worktree') {
    const path = row.worktree.path;
    switch (action) {
      case 'openWorktree': return { run: { op: 'openWorktree', repoId, path } };
      case 'deleteWorktreeRow': return { run: { op: 'deleteWorktree', repoId, path } };
      case 'copyBranchName': return { copy: { repoId, kind: 'branchName', value: path } };
      case 'copyCommitHash': return { copy: { repoId, kind: 'commitHash', value: path } };
      case 'copyWorktreePath': return { copy: { repoId, kind: 'worktreePath', value: path } };
      default: return undefined;
    }
  }
  const ref = row.kind === 'branch' ? row.branch.ref : row.tag.ref;
  switch (action) {
    case 'checkoutRef': return { run: { op: 'checkout', repoId, detached: false, ref } };
    case 'checkoutRefDetached': return { run: { op: 'checkout', repoId, detached: true, ref } };
    case 'mergeRef': return { run: { op: 'merge', repoId, ref } };
    case 'rebaseRef': return { run: { op: 'rebase', repoId, ref } };
    case 'createBranchFromRef': return { run: { op: 'createBranch', repoId, from: true, ref } };
    case 'deleteRef': return { run: row.kind === 'branch' ? { op: 'deleteBranch', repoId, ref } : { op: 'deleteTag', repoId, ref } };
    case 'compareRef': return { run: { op: 'compareRef', repoId, ref } };
    case 'copyBranchName': return row.kind === 'branch' ? { copy: { repoId, kind: 'branchName', value: ref } } : undefined;
    case 'copyTagName': return row.kind === 'tag' ? { copy: { repoId, kind: 'tagName', value: ref } } : undefined;
    case 'copyCommitHash': return { copy: { repoId, kind: 'commitHash', value: ref } };
    default: return undefined;
  }
}

/** Views and More Actions… (VS Code's scm/title `...` menu with git's submenus, in its 1_header, 2_main and 3_footer groups). */
export function moreActionsMenu(context: MoreActionsContext): ScmMenuNode[] {
  const separate = context.untrackedChanges === 'separate';
  const needsRemote = disabledBy(!context.remote.hasRemotes && 'noRemotes');
  return [
    {
      submenu: 'viewSort',
      icon: 'list-filter',
      items: [
        { action: 'viewAsTree', label: 'viewAsTree', checked: context.viewMode === 'tree', radio: true },
        { action: 'viewAsList', label: 'viewAsList', checked: context.viewMode === 'list', radio: true },
        // a tree sorts folders first, then by name, so Sort by applies to the list only
        ...(context.viewMode === 'list'
          ? [
              SEPARATOR,
              { action: 'sortByName', label: 'sortByName', checked: context.sortKey === 'name', radio: true } as const,
              { action: 'sortByPath', label: 'sortByPath', checked: context.sortKey === 'path', radio: true } as const,
              { action: 'sortByStatus', label: 'sortByStatus', checked: context.sortKey === 'status', radio: true } as const,
            ]
          : []),
      ],
    },
    SEPARATOR,
    { action: 'pull', label: 'pull', icon: 'arrow-down-to-line', ...needsRemote },
    { action: 'push', label: 'push', icon: 'arrow-up-from-line', ...needsRemote },
    { action: 'clone', label: 'clone', icon: 'copy-plus' },
    { action: 'checkout', label: 'checkout', icon: 'git-branch' },
    { action: 'fetch', label: 'fetch', icon: 'cloud-download', ...needsRemote },
    SEPARATOR,
    { submenu: 'commit', icon: 'git-commit-horizontal', items: commitMenu(context.commit) },
    {
      submenu: 'changes',
      icon: 'files',
      items: [
        { action: 'stageAll', label: 'stageAll', icon: 'plus' },
        { action: 'unstageAll', label: 'unstageAll', icon: 'minus' },
        { action: 'discardAll', label: 'discardAll', icon: 'undo-2', danger: true },
        ...(separate
          ? [
              SEPARATOR,
              { action: 'stageAllTracked', label: 'stageAllTracked', icon: 'plus' } as const,
              { action: 'stageAllUntracked', label: 'stageAllUntracked', icon: 'plus' } as const,
              { action: 'discardAllTracked', label: 'discardAllTracked', icon: 'undo-2', danger: true } as const,
              { action: 'discardAllUntracked', label: 'discardAllUntracked', icon: 'undo-2', danger: true } as const,
            ]
          : []),
      ],
    },
    { submenu: 'pullPush', icon: 'arrow-down-up', items: pullPushMenu({ ...context.remote, head: context.refs.head }), scoped: true },
    { submenu: 'branch', icon: 'git-branch', items: branchMenu({ head: context.refs.head, hasRemotes: context.remote.hasRemotes }) },
    { submenu: 'remote', icon: 'cloud', items: remoteMenu(context.remote) },
    { submenu: 'stash', icon: 'archive', items: stashMenu(context.refs) },
    { submenu: 'tags', icon: 'tag', items: tagsMenu(context.remote) },
    { submenu: 'worktrees', icon: 'folder-tree', items: worktreesMenu() },
    { submenu: 'repositories', icon: 'folder-git-2', items: repositoryItems(context) },
    SEPARATOR,
    { action: 'showOutput', label: 'showOutput', icon: 'square-terminal' },
  ];
}

function repositoryItems(context: Pick<MoreActionsContext, 'openRepos' | 'closedCount'>): ScmMenuNode[] {
  return [
    ...(context.openRepos > 0 ? [{ action: 'closeRepository', label: 'closeRepository', icon: 'x' } as const] : []),
    ...(context.openRepos > 1 ? [{ action: 'closeOtherRepositories', label: 'closeOtherRepositories', icon: 'copy-x' } as const] : []),
    ...(context.closedCount > 0 ? [{ action: 'reopenClosed', label: 'reopenClosed', icon: 'history' } as const] : []),
  ];
}

/** The repository picker's own commands, below its list of repositories. */
export function pickerMenu(context: Pick<MoreActionsContext, 'openRepos' | 'closedCount'>): ScmMenuNode[] {
  return repositoryItems(context);
}

export interface GroupInlineAction {
  readonly action: ScmAction;
  readonly label: ScmMenuEntry['label'];
  readonly icon: 'git-compare' | 'minus' | 'plus' | 'undo-2' | 'archive';
  readonly danger?: true;
}

/** The Stashes group's inline action (A.3). */
export const STASH_GROUP_ACTIONS: readonly GroupInlineAction[] = [{ action: 'stashIncludeUntracked', label: 'stashIncludeUntracked', icon: 'archive' }];

/** A group header's inline actions (scm/resourceGroup/inline), in VS Code's order. */
export function groupActions(group: ScmGroup, untrackedChanges: ScmSettings['untrackedChanges']): GroupInlineAction[] {
  switch (group) {
    case 'merge':
      return [{ action: 'stageAllMerge', label: 'stageAllMerge', icon: 'plus' }];
    case 'index':
      return [{ action: 'openGroupChanges', label: 'openGroupChanges', icon: 'git-compare' }, { action: 'unstageAll', label: 'unstageAll', icon: 'minus' }];
    case 'workingTree':
      return untrackedChanges === 'separate'
        ? [
            { action: 'openGroupChanges', label: 'openGroupChanges', icon: 'git-compare' },
            { action: 'discardAllTracked', label: 'discardAllTracked', icon: 'undo-2', danger: true },
            { action: 'stageAllTracked', label: 'stageAllTracked', icon: 'plus' },
          ]
        : [
            { action: 'openGroupChanges', label: 'openGroupChanges', icon: 'git-compare' },
            { action: 'discardAll', label: 'discardAll', icon: 'undo-2', danger: true },
            { action: 'stageAll', label: 'stageAll', icon: 'plus' },
          ];
    case 'untracked':
      return [
        { action: 'openGroupChanges', label: 'openUntrackedChanges', icon: 'git-compare' },
        { action: 'discardAllUntracked', label: 'discardAllUntracked', icon: 'undo-2', danger: true },
        { action: 'stageAllUntracked', label: 'stageAllUntracked', icon: 'plus' },
      ];
  }
}

export interface RowInlineAction {
  readonly action: 'openFile' | 'stage' | 'unstage' | 'discard';
  readonly label: ScmMenuEntry['label'];
  readonly icon: 'file-symlink' | 'plus' | 'minus' | 'undo-2';
}

/** A change row's inline actions (scm/resourceState/inline). */
export function rowActions(group: ScmGroup): RowInlineAction[] {
  if (group === 'merge') return [{ action: 'openFile', label: 'openFile', icon: 'file-symlink' }, { action: 'stage', label: 'stageMerge', icon: 'plus' }];
  if (group === 'index') return [{ action: 'openFile', label: 'openFile', icon: 'file-symlink' }, { action: 'unstage', label: 'unstage', icon: 'minus' }];
  return [{ action: 'openFile', label: 'openFile', icon: 'file-symlink' }, { action: 'discard', label: 'discard', icon: 'undo-2' }, { action: 'stage', label: 'stage', icon: 'plus' }];
}

// No HEAD side: the file is new in this change.
const NO_HEAD = new Set<ScmChange['status']>(['UNTRACKED', 'INDEX_ADDED', 'INTENT_TO_ADD', 'ADDED_BY_US', 'ADDED_BY_THEM', 'BOTH_ADDED']);
// The index holds all three stages (UU, AA), so the merge editor has both inputs; any other merge row keeps its file actions.
export const MERGE_EDITOR_STATUSES: ReadonlySet<ScmChange['status']> = new Set(['BOTH_MODIFIED', 'BOTH_ADDED']);

/** A change row's context menu (scm/resourceState/context); inWorktree adds B40's Compare with Workspace. */
export function rowMenu(group: ScmGroup, change: ScmChange, inWorktree = false): ScmMenuNode[] {
  return [
    { action: 'openChanges', label: 'openChanges', icon: 'git-compare' },
    ...(inWorktree && change.status !== 'DELETED' ? [{ action: 'compareWithWorkspace', label: 'compareWithWorkspace', icon: 'columns-2' } as const] : []),
    { action: 'openFile', label: 'openFile', icon: 'file' },
    ...(NO_HEAD.has(change.status) ? [] : [{ action: 'openFileHead', label: 'openFileHead', icon: 'file-clock' } as const]),
    { action: 'openTimeline', label: 'openTimeline', icon: 'history' },
    SEPARATOR,
    // VS Code's git.openMergeEditor and merge-conflict's scm/resourceState/context items on the Merge Changes group
    ...(group === 'merge'
      ? [
          ...(MERGE_EDITOR_STATUSES.has(change.status) ? [{ action: 'resolveInMergeEditor', label: 'resolveInMergeEditor', icon: 'git-merge' } as const] : []),
          { action: 'acceptAllCurrent', label: 'acceptAllCurrent', icon: 'circle-dot' } as const,
          { action: 'acceptAllIncoming', label: 'acceptAllIncoming', icon: 'arrow-down-to-line' } as const,
          SEPARATOR,
        ]
      : []),
    ...(group === 'index'
      ? [{ action: 'unstage', label: 'unstage', icon: 'minus' } as const]
      : group === 'merge'
        ? [{ action: 'stage', label: 'stageMerge', icon: 'plus' } as const]
        : [{ action: 'stage', label: 'stage', icon: 'plus' } as const, { action: 'discard', label: 'discard', icon: 'undo-2', danger: true } as const]),
    SEPARATOR,
    // a conflicted file cannot be stashed
    ...(group === 'merge' ? [] : [{ action: 'stashChanges', label: 'stashChanges', icon: 'archive' } as const]),
    SEPARATOR,
    ...(group === 'workingTree' || group === 'untracked' ? [{ action: 'addToGitignore', label: 'addToGitignore', icon: 'eye-off' } as const] : []),
    SEPARATOR,
    { action: 'copyPath', label: 'copyPath', icon: 'copy' },
    { action: 'copyRelativePath', label: 'copyRelativePath', icon: 'copy' },
    { action: 'reveal', label: 'reveal', icon: 'folder-search' },
    SEPARATOR,
    { action: 'mention', label: 'mention', icon: 'at-sign' },
  ];
}

/** A folder row's context menu (tree view): the group's actions on every change under the folder. */
export function folderMenu(group: ScmGroup): ScmMenuNode[] {
  if (group === 'index') return [{ action: 'unstage', label: 'unstage', icon: 'minus' }];
  if (group === 'merge') return [{ action: 'stage', label: 'stageMerge', icon: 'plus' }];
  return [{ action: 'stage', label: 'stage', icon: 'plus' }, { action: 'discard', label: 'discard', icon: 'undo-2', danger: true }];
}

/** A group header's context menu: its inline actions as menu items. */
export function groupMenu(group: ScmGroup, untrackedChanges: ScmSettings['untrackedChanges']): ScmMenuNode[] {
  return actionsMenu(groupActions(group, untrackedChanges));
}

/** Inline actions as menu items, for a header's context menu. */
export function actionsMenu(actions: readonly GroupInlineAction[]): ScmMenuNode[] {
  return actions.map((entry) => ({ action: entry.action, label: entry.label, icon: entry.icon, ...(entry.danger ? { danger: true as const } : {}) }));
}

export interface GraphCommitMenuContext {
  // HEAD's branch has an upstream (VS Code's scmCurrentHistoryItemRefHasRemote)
  readonly hasUpstream: boolean;
  // HEAD's branch has a base ref other than its upstream (scmCurrentHistoryItemRefHasBase)
  readonly hasBase: boolean;
  // a merge, rebase or cherry-pick in progress, during which git cannot cherry-pick (the palette command's rule)
  readonly operation: ScmOperation | null;
}

/**
 * A Graph commit row's menu (A.4): Open Changes, then VS Code's scm/historyItem/context groups in the plan's order, its chat
 * group last.
 */
export function graphCommitMenu(context: GraphCommitMenuContext): ScmMenuNode[] {
  return [
    { action: 'openCommit', label: 'openChanges', icon: 'git-compare' },
    SEPARATOR,
    { action: 'checkoutCommit', label: 'checkoutRefDetached', icon: 'circle-dot' },
    { action: 'createBranchAtCommit', label: 'createBranch', icon: 'git-branch-plus' },
    { action: 'createTagAtCommit', label: 'createTag', icon: 'tag' },
    { action: 'cherryPick', label: 'cherryPick', icon: 'cherry', ...disabledBy(context.operation !== null && OPERATION_REASONS[context.operation]) },
    SEPARATOR,
    { action: 'compareCommit', label: 'compareRef', icon: 'git-compare' },
    { action: 'compareWithRemote', label: 'compareWithRemote', icon: 'cloud', ...disabledBy(!context.hasUpstream && 'noUpstream') },
    { action: 'compareWithMergeBase', label: 'compareWithMergeBase', icon: 'git-fork', ...disabledBy(!context.hasBase && 'noBaseRef') },
    SEPARATOR,
    { action: 'copyCommitId', label: 'copyCommitId', icon: 'copy' },
    { action: 'copyCommitMessage', label: 'copyCommitMessage', icon: 'copy' },
    SEPARATOR,
    { action: 'addCommitToChat', label: 'addCommitToChat', icon: 'message-square-plus' },
    { action: 'explainCommit', label: 'explainCommit', icon: 'sparkles' },
  ];
}

/** A Graph commit row's action on that row's commit, by its full hash, which main checks is a commit of the repository. */
export function graphCommitCall(action: GraphCommitAction, repoId: string, commit: string): ScmRowCall {
  switch (action) {
    case 'openCommit': return { run: { op: 'openCommit', repoId, commit } };
    case 'checkoutCommit': return { run: { op: 'checkout', repoId, detached: true, commit } };
    case 'createBranchAtCommit': return { run: { op: 'createBranch', repoId, from: false, commit } };
    case 'createTagAtCommit': return { run: { op: 'createTag', repoId, commit } };
    case 'cherryPick': return { run: { op: 'cherryPick', repoId, commit } };
    case 'compareCommit': return { run: { op: 'compareCommit', repoId, commit } };
    case 'compareWithRemote': return { run: { op: 'compareWithRemote', repoId, commit } };
    case 'compareWithMergeBase': return { run: { op: 'compareWithMergeBase', repoId, commit } };
    case 'copyCommitId': return { copy: { repoId, kind: 'commitId', value: commit } };
    case 'copyCommitMessage': return { copy: { repoId, kind: 'commitMessage', value: commit } };
    case 'addCommitToChat': return { run: { op: 'addCommitToChat', repoId, commit } };
    case 'explainCommit': return { run: { op: 'explainCommit', repoId, commit } };
  }
}

const GRAPH_COMMIT_ACTIONS: ReadonlySet<ScmAction> = new Set<GraphCommitAction>([
  'openCommit', 'checkoutCommit', 'createBranchAtCommit', 'createTagAtCommit', 'cherryPick',
  'compareCommit', 'compareWithRemote', 'compareWithMergeBase', 'copyCommitId', 'copyCommitMessage', 'addCommitToChat', 'explainCommit',
]);
export const isGraphCommitAction = (action: ScmAction): action is GraphCommitAction => GRAPH_COMMIT_ACTIONS.has(action);

// What a ref badge names: a full refname, or 'HEAD' for a detached HEAD, which has no menu.
const refKindOf = (id: string): 'branch' | 'remote' | 'tag' | undefined =>
  id.startsWith('refs/heads/') ? 'branch' : id.startsWith('refs/remotes/') ? 'remote' : id.startsWith('refs/tags/') ? 'tag' : undefined;

export interface GraphRefMenuTarget {
  // full refname
  readonly id: string;
  // HEAD's branch
  readonly current: boolean;
}

/**
 * A Graph ref badge's menu (A.4): Checkout, then Delete Branch, Delete Remote Branch or Delete Tag by the ref's kind. HEAD's
 * branch can be neither checked out nor deleted, and HEAD's upstream is not deleted from here, as VS Code refuses it.
 */
export function graphRefMenu(ref: GraphRefMenuTarget, upstream: string | undefined): ScmMenuNode[] {
  const kind = refKindOf(ref.id);
  if (kind === undefined) return [];
  const head = disabledBy(ref.current && 'checkedOut');
  const remove: ScmMenuEntry = kind === 'branch'
    ? { action: 'deleteBranchRef', label: 'deleteBranchRef', icon: 'trash-2', danger: true, ...head }
    : kind === 'remote'
      ? { action: 'deleteRemoteBranchRef', label: 'deleteRemoteBranchRef', icon: 'trash-2', danger: true, ...disabledBy(ref.id === upstream && 'currentUpstream') }
      : { action: 'deleteTagRef', label: 'deleteTagRef', icon: 'trash-2', danger: true };
  return [{ action: 'checkoutRef', label: 'checkoutRef', icon: 'check', ...head }, SEPARATOR, remove];
}

/** A Graph ref badge's action on that ref, through slice 11b's flows and confirmations. */
export function graphRefCall(action: GraphRefAction, repoId: string, ref: string): ScmRowCall {
  switch (action) {
    case 'checkoutRef': return { run: { op: 'checkout', repoId, detached: false, ref } };
    case 'deleteBranchRef': return { run: { op: 'deleteBranch', repoId, ref } };
    case 'deleteRemoteBranchRef': return { run: { op: 'deleteRemoteBranch', repoId, ref } };
    case 'deleteTagRef': return { run: { op: 'deleteTag', repoId, ref } };
  }
}

const GRAPH_REF_ACTIONS: ReadonlySet<ScmAction> = new Set<GraphRefAction>(['checkoutRef', 'deleteBranchRef', 'deleteRemoteBranchRef', 'deleteTagRef']);
export const isGraphRefAction = (action: ScmAction): action is GraphRefAction => GRAPH_REF_ACTIONS.has(action);
