import { describe, expect, it } from 'vitest';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import type { ScmHead, ScmOperation } from '../../preload/scm-channels';
import en from '../locales/en.json';
import el from '../locales/el.json';
import {
  branchMenu,
  branchRowMenu,
  commitMenu,
  folderMenu,
  groupMenu,
  moreActionsMenu,
  pickerMenu,
  pullPushMenu,
  remoteMenu,
  repositoryRowMenu,
  repositoryStashMenu,
  rowMenu,
  splitButtonMenu,
  stashMenu,
  stashRowMenu,
  tagRowMenu,
  tagsMenu,
  toOverlayMenu,
  worktreeRowMenu,
  worktreesMenu,
  type MoreActionsContext,
  type ScmMenuNode,
} from '../scm/scm-menus';

const reasons = (bundle: { scm: { disabled?: Record<string, string> } }): Record<string, string> => bundle.scm.disabled ?? {};
// The label function ScmSection passes: a key under scm in the English bundle, or the key itself where none exists.
const label = (key: string): string => {
  const value = key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined), en.scm);
  return typeof value === 'string' ? value : key;
};

const OPERATIONS: ReadonlyArray<ScmOperation | null> = [null, 'merge', 'rebase', 'cherryPick'];
const HEADS: ReadonlyArray<ScmHead['type'] | null> = ['branch', 'detached', 'unborn', null];

// Every More Actions context that disables something, and some that disable nothing.
function moreActionsContexts(): MoreActionsContext[] {
  const contexts: MoreActionsContext[] = [];
  for (const operation of OPERATIONS) {
    for (const head of HEADS) {
      for (const hasRemotes of [true, false]) {
        for (const hasCommit of [true, false]) {
          for (const stashes of [0, 2, null]) {
            for (const amending of [false, true]) {
              contexts.push({
                viewMode: 'list',
                sortKey: 'path',
                untrackedChanges: 'separate',
                openRepos: 2,
                closedCount: 1,
                commit: { operation, hasCommit, hasTemplate: true, allowNoVerifyCommit: true, amending },
                remote: { hasRemotes, allowForcePush: true, operation },
                refs: { head, stashStaged: true, stashes },
              });
            }
          }
        }
      }
    }
  }
  return contexts;
}

// Every menu builder over the contexts that disable its entries.
function everyMenu(): ScmMenuNode[][] {
  const commit = (operation: ScmOperation | null, hasCommit: boolean, amending: boolean) => ({ operation, hasCommit, hasTemplate: true, allowNoVerifyCommit: true, amending });
  const menus: ScmMenuNode[][] = moreActionsContexts().map(moreActionsMenu);
  for (const operation of OPERATIONS) {
    for (const hasCommit of [true, false]) {
      for (const amending of [false, true]) {
        menus.push(commitMenu(commit(operation, hasCommit, amending)));
        for (const head of HEADS) {
          for (const hasRemotes of [true, false]) menus.push(splitButtonMenu({ ...commit(operation, hasCommit, amending), head, hasRemotes }));
        }
      }
    }
    for (const hasRemotes of [true, false]) {
      for (const head of HEADS) menus.push(pullPushMenu({ hasRemotes, allowForcePush: true, operation, head }));
    }
  }
  for (const hasRemotes of [true, false]) {
    menus.push(remoteMenu({ hasRemotes }), tagsMenu({ hasRemotes }));
    for (const head of HEADS) menus.push(branchMenu({ head, hasRemotes }));
  }
  for (const stashes of [0, 1, null]) menus.push(stashMenu({ stashStaged: true, stashes }));
  for (const current of [true, false]) {
    menus.push(branchRowMenu({ current, commit: null }), tagRowMenu({ current, commit: null }));
    for (const main of [true, false]) menus.push(worktreeRowMenu({ main, current, branch: 'main', commit: null }));
  }
  menus.push(
    worktreesMenu(),
    stashRowMenu({ branch: 'main' }),
    repositoryRowMenu(2),
    repositoryStashMenu(true),
    rowMenu('workingTree', { path: 'a.ts', status: 'MODIFIED', letter: 'M', tone: 'modified', strike: false }),
    folderMenu('index'),
    groupMenu('untracked', 'separate'),
    pickerMenu({ openRepos: 2, closedCount: 1 }),
  );
  return menus;
}

const leaves = (items: readonly OverlayMenuItem[]): Array<Extract<OverlayMenuItem, { kind: 'item' }>> =>
  items.flatMap((item) => (item.kind === 'submenu' ? leaves(item.items) : item.kind === 'item' ? [item] : []));

describe('the Source control menus\' disabled reasons', () => {
  it('give every disabled entry of every menu a reason, shown as its English text', () => {
    const used = new Set<string>();
    let disabled = 0;
    for (const nodes of everyMenu()) {
      const walk = (list: readonly ScmMenuNode[]): void => {
        for (const node of list) {
          if ('submenu' in node) walk(node.items);
          else if ('action' in node && node.disabled !== undefined) used.add(node.disabled);
        }
      };
      walk(nodes);
      for (const item of leaves(toOverlayMenu(nodes, label))) {
        if (!item.disabled) {
          expect(item.disabledReason, item.id).toBeUndefined();
          continue;
        }
        disabled++;
        expect(Object.values(reasons(en)), item.id).toContain(item.disabledReason);
      }
    }
    expect(disabled).toBeGreaterThan(0);
    // each reason the menus use has its text, and none is left unused
    expect([...used].sort()).toEqual(Object.keys(reasons(en)).sort());
  });

  it('word each reason in English and Greek, short and sentence case', () => {
    expect(Object.keys(reasons(el)).sort()).toEqual(Object.keys(reasons(en)).sort());
    for (const [key, text] of [...Object.entries(reasons(en)), ...Object.entries(reasons(el))]) {
      expect(text.length, key).toBeGreaterThan(0);
      expect(text.length, key).toBeLessThanOrEqual(32);
      expect(text.endsWith('.'), key).toBe(false);
    }
    for (const text of Object.values(reasons(en))) expect(text[0], text).toBe(text[0]!.toUpperCase());
  });

  it('say why for each condition at the site that disables', () => {
    const reasonOf = (nodes: ScmMenuNode[], id: string): string | undefined => leaves(toOverlayMenu(nodes, label)).find((item) => item.id === id)?.disabledReason;
    expect(reasonOf(stashMenu({ stashStaged: true, stashes: 0 }), 'stashPopLatest')).toBe('No stashes');
    expect(reasonOf(pullPushMenu({ hasRemotes: false, allowForcePush: false, operation: 'rebase', head: 'branch' }), 'syncRebase')).toBe('No remotes');
    expect(reasonOf(pullPushMenu({ hasRemotes: true, allowForcePush: false, operation: 'rebase', head: 'branch' }), 'syncRebase')).toBe('Rebase in progress');
    expect(reasonOf(pullPushMenu({ hasRemotes: true, allowForcePush: false, operation: null, head: 'detached' }), 'sync')).toBe('Detached HEAD');
    expect(reasonOf(splitButtonMenu({ operation: null, hasCommit: true, amending: false, head: 'branch', hasRemotes: false }), 'commitPush')).toBe('No remotes');
    expect(reasonOf(splitButtonMenu({ operation: null, hasCommit: true, amending: false, head: 'detached', hasRemotes: true }), 'commitSync')).toBe('Detached HEAD');
    // no status yet is not a detached HEAD
    expect(reasonOf(branchMenu({ head: null, hasRemotes: true }), 'renameBranch')).toBeUndefined();
    expect(reasonOf(commitMenu({ operation: null, hasCommit: false, hasTemplate: false, allowNoVerifyCommit: false, amending: false }), 'undoLastCommit')).toBe('No commits yet');
    expect(reasonOf(commitMenu({ operation: 'merge', hasCommit: true, hasTemplate: false, allowNoVerifyCommit: false, amending: false }), 'commitAmend')).toBe('Merge in progress');
    expect(reasonOf(commitMenu({ operation: 'cherryPick', hasCommit: true, hasTemplate: false, allowNoVerifyCommit: false, amending: false }), 'abortRebase')).toBe('No rebase in progress');
    expect(reasonOf(splitButtonMenu({ operation: null, hasCommit: false, amending: false, head: 'unborn', hasRemotes: true }), 'toggleAmend')).toBe('No commits yet');
    expect(reasonOf(branchMenu({ head: 'detached', hasRemotes: true }), 'renameBranch')).toBe('Detached HEAD');
    expect(reasonOf(branchMenu({ head: 'unborn', hasRemotes: true }), 'publish')).toBe('No commits yet');
    expect(reasonOf(branchMenu({ head: 'branch', hasRemotes: false }), 'publish')).toBe('No remotes');
    expect(reasonOf(branchRowMenu({ current: true, commit: null }), 'checkoutRef')).toBe('Checked out');
    expect(reasonOf(tagRowMenu({ current: true, commit: null }), 'deleteRef')).toBe('Checked out');
    expect(reasonOf(worktreeRowMenu({ main: true, current: true, branch: 'main', commit: null }), 'deleteWorktreeRow')).toBe('Main worktree');
    expect(reasonOf(worktreeRowMenu({ main: false, current: true, branch: 'wt', commit: null }), 'deleteWorktreeRow')).toBe('Current worktree');
    expect(reasonOf(remoteMenu({ hasRemotes: false }), 'removeRemote')).toBe('No remotes');
  });
});
