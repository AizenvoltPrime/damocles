import type { OverlayIcon, OverlayMenuItem } from '../../preload/overlay-channels';
import { tidyMenu } from '../../preload/overlay-channels';
import type { ScmChange, ScmCommitVariant, ScmGroup, ScmOperation, ScmSettings } from '../../preload/scm-channels';

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
  | 'openChanges' | 'openFile' | 'openFileHead' | 'stage' | 'unstage' | 'discard' | 'addToGitignore'
  | 'copyPath' | 'copyRelativePath' | 'reveal' | 'mention'
  | ScmCommitAction | 'undoLastCommit' | 'abortRebase' | 'restoreCommitTemplate' | 'toggleAmend';

export interface ScmMenuEntry {
  readonly action: ScmAction;
  // a key under scm.action in the shell locales
  readonly label: ScmAction | 'openUntrackedChanges' | 'stageMerge' | AmendedLabel;
  readonly icon?: OverlayIcon;
  readonly danger?: true;
  readonly checked?: boolean;
  // with checked: one of mutually exclusive choices
  readonly radio?: true;
  readonly disabled?: boolean;
}
export type ScmMenuNode = ScmMenuEntry | { readonly separator: true } | { readonly submenu: 'viewSort' | 'commit' | 'changes' | 'repositories'; readonly icon: OverlayIcon; readonly items: readonly ScmMenuNode[] };

const SEPARATOR = { separator: true } as const;

/** The overlay menu for a node list, labelled by `label`; empty submenus drop out. */
export function toOverlayMenu(nodes: readonly ScmMenuNode[], label: (key: string) => string): OverlayMenuItem[] {
  const convert = (node: ScmMenuNode): OverlayMenuItem | undefined => {
    if ('separator' in node) return { kind: 'separator' };
    if ('submenu' in node) {
      const items = tidyMenu(node.items.flatMap((child) => convert(child) ?? []));
      return items.length === 0 ? undefined : { kind: 'submenu', id: `submenu:${node.submenu}`, label: label(`submenu.${node.submenu}`), icon: node.icon, items };
    }
    return {
      kind: 'item',
      id: node.action,
      label: label(`action.${node.label}`),
      ...(node.icon ? { icon: node.icon } : {}),
      ...(node.danger ? { danger: true } : {}),
      ...(node.checked !== undefined ? { checked: node.checked } : {}),
      ...(node.radio ? { radio: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
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
  const amendable = context.hasCommit && context.operation === null;
  const amend = (action: ScmCommitAction, icon: OverlayIcon = 'pencil-line'): ScmMenuEntry => ({ action, label: action, icon, ...(amendable ? {} : { disabled: true }) });
  return [
    entry('commit', 'check'),
    entry('commitStaged', 'check'),
    entry('commitAll', 'check-check'),
    { action: 'undoLastCommit', label: 'undoLastCommit', icon: 'undo-2', ...(context.hasCommit ? {} : { disabled: true }) },
    ...(context.hasTemplate ? [{ action: 'restoreCommitTemplate', label: 'restoreCommitTemplate', icon: 'file-text' } as const] : []),
    { action: 'abortRebase', label: 'abortRebase', icon: 'x', ...(context.operation === 'rebase' ? {} : { disabled: true }) },
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

/** The commit box's split button menu (prototype). Commit (Amend) enters amend mode, which Escape or the banner leaves. */
export function splitButtonMenu(context: Pick<CommitMenuContext, 'operation' | 'hasCommit' | 'amending'>): ScmMenuNode[] {
  return [
    commitEntry('commit', 'check', context.amending),
    ...(context.amending
      ? []
      : [{
          action: 'toggleAmend',
          label: 'commitAmend',
          icon: 'pencil-line',
          ...(context.hasCommit && context.operation === null ? {} : { disabled: true }),
        } as const]),
    SEPARATOR,
    commitEntry('commitSigned', 'signature', context.amending),
  ];
}

/** Views and More Actions… (VS Code's scm/title `...` menu with git's submenus). */
export function moreActionsMenu(context: MoreActionsContext): ScmMenuNode[] {
  const separate = context.untrackedChanges === 'separate';
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
  readonly icon: 'git-compare' | 'minus' | 'plus' | 'undo-2';
  readonly danger?: true;
}

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

/** A change row's context menu (scm/resourceState/context). */
export function rowMenu(group: ScmGroup, change: ScmChange): ScmMenuNode[] {
  return [
    { action: 'openChanges', label: 'openChanges', icon: 'git-compare' },
    { action: 'openFile', label: 'openFile', icon: 'file' },
    ...(NO_HEAD.has(change.status) ? [] : [{ action: 'openFileHead', label: 'openFileHead', icon: 'file-clock' } as const]),
    SEPARATOR,
    ...(group === 'index'
      ? [{ action: 'unstage', label: 'unstage', icon: 'minus' } as const]
      : group === 'merge'
        ? [{ action: 'stage', label: 'stageMerge', icon: 'plus' } as const]
        : [{ action: 'stage', label: 'stage', icon: 'plus' } as const, { action: 'discard', label: 'discard', icon: 'undo-2', danger: true } as const]),
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
  return groupActions(group, untrackedChanges).map((entry) => ({ action: entry.action, label: entry.label, icon: entry.icon, ...(entry.danger ? { danger: true as const } : {}) }));
}
