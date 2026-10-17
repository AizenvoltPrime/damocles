// Branch, stash, tag and worktree flows, ported from VS Code's extensions/git/src/commands.ts: the pickers, inputs
// and questions run here, and core runs git. Every ref, stash and worktree a renderer names is looked up in main's own fresh
// list first, and the pickers answer with ids main issued, so no renderer text reaches git.
import * as path from 'node:path';
import type { ArtifactCommit, BranchArtifact, RemoteBranchArtifact, StashArtifact, TagArtifact, WorktreeArtifact } from '../../../core/scm/artifacts';
import { sanitizeBranchName, type CheckoutTarget } from '../../../core/scm/branches';
import { isInside, samePath } from '../../../core/scm/discovery';
import { redactUrls } from '../../../core/scm/git-runner';
import { isRemoteName, type Remote } from '../../../core/scm/remotes';
import type { Repository } from '../../../core/scm/repository';
import { gitErrorText, RemoteCancelledError } from '../../../core/scm/scm-service';
import { SCM_SETTING_KEYS, type PromptToSaveFilesBeforeStash } from '../../../core/scm/settings-keys';
import { canStashStaged, type StashScope } from '../../../core/scm/stash';
import { defaultWorktreePath, worktreeName } from '../../../core/scm/worktrees';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { inputProblem } from '../../../shared/input-validation';
import { visibleLines, visibleText } from '../../../shared/visible-text';
import { fitsQuickPick, MAX_QUICK_PICK_BYTES, MAX_QUICK_PICK_ITEMS, quickPickItemBytes, type OverlayQuickPickIcon } from '../../preload/overlay-channels';
import { isWorktreePath, type ScmRunRequest, type ScmRunResult, type ScmStashChoice, type ScmStashTarget } from '../../preload/scm-channels';
import type { Project } from '../documents/confine';
import { parseRootKey } from '../../preload/folder-root';
import type { ScmHostDeps, ScmQuickPickItem } from './scm-host';

export const OK: ScmRunResult = { ok: true };
export const CANCELLED: ScmRunResult = { ok: false, reason: 'cancelled' };
// main told the user why nothing ran
export const TOLD: ScmRunResult = { ok: false, reason: 'failed' };

/** A remote operation's result: a cancel, or false (the user declined a force push), answers cancelled with no notice; any other failure reaches runRequest's notice. */
export async function remote(work: () => Promise<unknown>): Promise<ScmRunResult> {
  try {
    return (await work()) === false ? CANCELLED : OK;
  } catch (err) {
    if (err instanceof RemoteCancelledError) return CANCELLED;
    throw err;
  }
}

export interface PickEntry<T> {
  readonly value: T;
  readonly item: Omit<ScmQuickPickItem, 'id'>;
}

/**
 * A quick pick over values main holds: each item's id is its index, so the answer names an entry and never renderer text,
 * whatever a value's length; the filter text comes back beside it, for a create item that uses it.
 */
export async function pickEntry<T>(quickPick: ScmHostDeps['quickPick'], placeholder: string, entries: ReadonlyArray<PickEntry<T>>): Promise<{ readonly value: T; readonly query: string } | undefined> {
  const picked = await quickPick(placeholder, entries.map((entry, index) => ({ ...entry.item, id: `${index}` })));
  const entry = picked === undefined ? undefined : entries[Number(picked.id)];
  return entry && picked ? { value: entry.value, query: picked.query } : undefined;
}

// What the flows need of ScmHost.
export interface RefFlowHost {
  readonly deps: ScmHostDeps;
  repo(repoId: string): Repository;
  setting<T>(key: string, fallback: T): T;
  // the stash's View Stash tabs, now that it left the stash list
  closeStashTabs(repoId: string, hash: string): Promise<void>;
  openStash(repoId: string, stash: StashArtifact): Promise<ScmRunResult>;
  openRefsChanges(repoId: string, left: { readonly hash: string; readonly label: string }, right: { readonly hash: string; readonly label: string }): Promise<ScmRunResult>;
  // the registered project whose folder the worktree holds
  worktreeProject(repoId: string, worktreePath: string): Project | undefined;
  // a run op as the shell sends it, its failure told
  runRequest(request: ScmRunRequest): Promise<ScmRunResult>;
}

type RefRow =
  | { readonly kind: 'branch'; readonly row: BranchArtifact }
  | { readonly kind: 'remote'; readonly row: RemoteBranchArtifact }
  | { readonly kind: 'tag'; readonly row: TagArtifact };

// The row closing a ref picker the overlay's bounds cut short; main never accepts it as an answer.
const MORE = { kind: 'more' } as const;

// VS Code's git.branchWhitespaceChar default, which sanitizeBranchName puts in place of each refused sequence
const BRANCH_WHITESPACE_CHAR = '-';

// Picker text as a branch name; text that is only whitespace and dashes is nothing typed, where sanitizeBranchName would
// answer a lone whitespace character.
function typedBranchName(typed: string): string {
  return typed.trim().replace(/^-+/, '') === '' ? '' : sanitizeBranchName(typed, BRANCH_WHITESPACE_CHAR);
}

// A typed branch name behind branchPrefix, unless it already starts with it; nothing typed leaves the prefix alone.
function withPrefix(name: string, prefix: string): string {
  if (name === '') return prefix;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

// VS Code's artifact description: the 7-character hash and the subject
function commitDescription(commit: ArtifactCommit | null): string | undefined {
  return commit ? `${commit.hash.slice(0, 7)} \u2022 ${commit.subject}` : undefined;
}

export class RefFlows {
  private readonly host: RefFlowHost;

  constructor(host: RefFlowHost) {
    this.host = host;
  }

  private get deps(): ScmHostDeps {
    return this.host.deps;
  }

  private t(message: string, ...args: Array<string | number>): string {
    return this.deps.t(message, ...args);
  }

  private async pick<T>(placeholder: string, entries: ReadonlyArray<PickEntry<T>>): Promise<T | undefined> {
    return (await pickEntry(this.deps.quickPick, placeholder, entries))?.value;
  }

  /**
   * A ref picker: head (its commands) first, then every row the overlay's bounds hold. Past them it keeps every local branch,
   * fills with the newest remote branches and tags, each group still in core's order, and ends with a row naming how many
   * refs it left out.
   */
  private async pickRef<C = never>(placeholder: string, rows: readonly RefRow[], group: boolean, head: ReadonlyArray<PickEntry<C>> = []): Promise<{ readonly value: C | RefRow; readonly query: string } | undefined> {
    const refs = rows.map((entry) => this.refItem(entry, group));
    const all: Array<PickEntry<C | RefRow | typeof MORE>> = [...head, ...refs];
    const shown = fitsQuickPick(all.map((entry, index) => ({ ...entry.item, id: `${index}` }))) ? all : this.cutRefs(head, refs);
    const picked = await pickEntry(this.deps.quickPick, placeholder, shown);
    return picked === undefined || picked.value === MORE ? undefined : (picked as { readonly value: C | RefRow; readonly query: string });
  }

  private cutRefs<C>(head: ReadonlyArray<PickEntry<C>>, refs: ReadonlyArray<PickEntry<RefRow>>): Array<PickEntry<C | RefRow | typeof MORE>> {
    const more = (left: number): PickEntry<typeof MORE> => ({
      value: MORE,
      item: { label: left === 1 ? this.t('1 more ref not shown') : this.t('{0} more refs not shown', left), alwaysShow: true, info: true },
    });
    // every id is at most as long as the largest index, which each size below counts
    const idBytes = quickPickItemBytes({ id: `${head.length + refs.length}` });
    const size = (item: Omit<ScmQuickPickItem, 'id'>): number => quickPickItemBytes(item) + idBytes;
    let count = head.length + 1;
    let bytes = head.reduce((sum, entry) => sum + size(entry.item), size(more(refs.length).item));
    const kept = new Set<PickEntry<RefRow>>();
    const keep = (entry: PickEntry<RefRow>): boolean => {
      const cost = size(entry.item);
      if (count + 1 > MAX_QUICK_PICK_ITEMS || bytes + cost > MAX_QUICK_PICK_BYTES) return false;
      count++;
      bytes += cost;
      kept.add(entry);
      return true;
    };
    const date = (entry: PickEntry<RefRow>): number => entry.value.row.commit?.date ?? 0;
    for (const entry of refs.filter((candidate) => candidate.value.kind === 'branch')) if (!keep(entry)) break;
    for (const entry of refs.filter((candidate) => candidate.value.kind !== 'branch').sort((a, b) => date(b) - date(a))) if (!keep(entry)) break;
    this.deps.log(`[scm] a ref picker shows ${kept.size} of ${refs.length} refs, as many as the overlay's bounds hold`);
    return [...head, ...refs.filter((entry) => kept.has(entry)), more(refs.length - kept.size)];
  }

  private refItem(entry: RefRow, group: boolean): PickEntry<RefRow> {
    const icons: Record<RefRow['kind'], OverlayQuickPickIcon> = { branch: 'branch', remote: 'remoteBranch', tag: 'tag' };
    const groups: Record<RefRow['kind'], string> = { branch: this.t('branches'), remote: this.t('remote branches'), tag: this.t('tags') };
    const description = commitDescription(entry.row.commit);
    const hint = entry.kind === 'branch' ? (entry.row.upstream ? `${entry.row.upstream.behind}\u2193 ${entry.row.upstream.ahead}\u2191` : this.t('local')) : undefined;
    return {
      value: entry,
      item: {
        label: entry.row.name,
        icon: icons[entry.kind],
        ...(description !== undefined ? { description } : {}),
        ...(hint !== undefined ? { hint } : {}),
        ...(group ? { group: groups[entry.kind] } : {}),
        ...(entry.kind !== 'remote' && entry.row.current ? { current: true } : {}),
      },
    };
  }

  // Local branches, remote branches and tags, each a group in core's order, newest first (for-each-ref --sort=-creatordate),
  // as VS Code's git.branchSortOrder default committerdate lists them.
  private async refRows(repoId: string, kinds: ReadonlyArray<RefRow['kind']>): Promise<RefRow[]> {
    const service = this.deps.service;
    const [branches, remotes, tags] = await Promise.all([
      kinds.includes('branch') ? service.artifacts(repoId, 'branches') : undefined,
      kinds.includes('remote') ? service.artifacts(repoId, 'remoteBranches') : undefined,
      kinds.includes('tag') ? service.artifacts(repoId, 'tags') : undefined,
    ]);
    const rows: RefRow[] = [];
    if (branches?.group === 'branches') rows.push(...branches.rows.map((row) => ({ kind: 'branch' as const, row })));
    if (remotes?.group === 'remoteBranches') rows.push(...remotes.rows.map((row) => ({ kind: 'remote' as const, row })));
    if (tags?.group === 'tags') rows.push(...tags.rows.map((row) => ({ kind: 'tag' as const, row })));
    return rows;
  }

  // A full refname a renderer sent, found in main's fresh lists; undefined (and the user told) when the ref is gone.
  private async findRef(repoId: string, ref: string): Promise<RefRow | undefined> {
    const kind = ref.startsWith('refs/heads/') ? 'branch' : ref.startsWith('refs/remotes/') ? 'remote' : 'tag';
    const found = (await this.refRows(repoId, [kind])).find((entry) => entry.row.ref === ref);
    if (!found) void this.deps.notify.warn(this.t('"{0}" is no longer in this repository.', visibleText(ref)));
    return found;
  }

  private async headBranch(repoId: string): Promise<BranchArtifact | undefined> {
    const branches = await this.deps.service.artifacts(repoId, 'branches');
    return branches.group === 'branches' ? branches.rows.find((row) => row.current) : undefined;
  }

  // VS Code's RefItemsProcessor skipCurrentBranch and skipCurrentBranchRemote
  private withoutHead(rows: readonly RefRow[], head: BranchArtifact | undefined): RefRow[] {
    const upstream = head?.upstream ? `${head.upstream.remote}/${head.upstream.branch}` : undefined;
    return rows.filter((entry) => !(entry.kind === 'branch' && entry.row.current) && !(entry.kind === 'remote' && entry.row.name === upstream));
  }

  // VS Code's _checkout: the branch picker, then the picked ref; a ref skips the picker.
  async checkout(repoId: string, detached: boolean, ref?: string): Promise<ScmRunResult> {
    if (ref !== undefined) {
      const found = await this.findRef(repoId, ref);
      return found ? this.checkoutRow(repoId, found, detached) : TOLD;
    }
    const t = this.t.bind(this);
    const CREATE = { kind: 'create' } as const;
    const CREATE_FROM = { kind: 'createFrom' } as const;
    const DETACHED = { kind: 'detached' } as const;
    type Command = typeof CREATE | typeof CREATE_FROM | typeof DETACHED;
    // Checkout to (Detached)... lists no tags and no commands, as VS Code's detached picker does
    const rows = await this.refRows(repoId, detached ? ['branch', 'remote'] : ['branch', 'remote', 'tag']);
    if (detached && rows.length === 0) {
      void this.deps.notify.info(t('This repository has no other branches.'));
      return TOLD;
    }
    const commands: ReadonlyArray<PickEntry<Command>> = detached
      ? []
      : [
          { value: CREATE, item: { label: t('Create new branch...'), icon: 'add', alwaysShow: true, echoQuery: true } },
          { value: CREATE_FROM, item: { label: t('Create new branch from...'), icon: 'add', alwaysShow: true, echoQuery: true } },
          { value: DETACHED, item: { label: t('Checkout detached...'), icon: 'detached', alwaysShow: true } },
        ];
    const picked = await this.pickRef(detached ? t('Select a branch to checkout in detached mode') : t('Select a branch or tag to checkout'), rows, true, commands);
    if (picked === undefined) return CANCELLED;
    const choice = picked.value;
    // VS Code's _checkout passes the picker's text to _branch as the new branch's name
    if (choice === CREATE) return this.createBranch(repoId, false, undefined, picked.query);
    if (choice === CREATE_FROM) return this.createBranch(repoId, true, undefined, picked.query);
    if (choice === DETACHED) return this.checkout(repoId, true);
    return this.checkoutRow(repoId, choice as RefRow, detached);
  }

  // The Graph's Checkout (Detached) on a commit main checked, with the dirty work tree's question.
  checkoutCommit(repoId: string, commit: string): Promise<ScmRunResult> {
    return this.runCheckout(repoId, { kind: 'detached', revision: commit });
  }

  // CheckoutItem, CheckoutRemoteHeadItem and CheckoutTagItem's run: a remote branch checks out the local branch tracking it,
  // else a new tracking branch; pullBeforeCheckout fast-forwards a local branch first.
  private async checkoutRow(repoId: string, entry: RefRow, detached: boolean): Promise<ScmRunResult> {
    let target: CheckoutTarget;
    if (detached || entry.kind === 'tag') target = { kind: 'detached', revision: entry.row.commit?.hash ?? entry.row.ref };
    else if (entry.kind === 'branch') {
      target = { kind: 'branch', name: entry.row.name };
      const upstream = entry.row.upstream;
      // VS Code's setting fast-forwards "a branch that does not have outgoing commits"
      if (upstream && upstream.ahead === 0 && !entry.row.current && this.host.setting(SCM_SETTING_KEYS.pullBeforeCheckout, false)) {
        const fastForward = await this.fastForward(repoId, entry.row.name, upstream);
        if (fastForward !== OK) return fastForward;
      }
    } else {
      const branches = await this.deps.service.artifacts(repoId, 'branches');
      const tracking = branches.group === 'branches' ? branches.rows.find((row) => row.upstream !== null && `${row.upstream.remote}/${row.upstream.branch}` === entry.row.name) : undefined;
      target = tracking ? { kind: 'branch', name: tracking.name } : { kind: 'track', ref: entry.row.ref };
    }
    return this.runCheckout(repoId, target);
  }

  // VS Code's fastForwardBranch inside checkout: a refused fast-forward is no failure, and any other failure leaves the branch
  // as it is and the checkout goes on, as VS Code's checkout ignores it; the Git log keeps git's words. A cancel stops.
  private async fastForward(repoId: string, branch: string, upstream: { readonly remote: string; readonly branch: string }): Promise<ScmRunResult> {
    try {
      await this.deps.service.fastForward(repoId, branch, upstream);
      return OK;
    } catch (err) {
      if (err instanceof RemoteCancelledError) return CANCELLED;
      this.deps.gitLog(`[scm] ${branch} was not fast-forwarded before the checkout: ${err instanceof Error ? err.message : String(err)}`);
      return OK;
    }
  }

  // VS Code's DirtyWorkTree question: Stash & Checkout, Migrate Changes (stash, checkout, pop) or Force Checkout (discard,
  // with its own confirmation, then checkout).
  private async runCheckout(repoId: string, target: CheckoutTarget): Promise<ScmRunResult> {
    const first = await this.checkoutUnlessHeld(repoId, target);
    if (first !== 'dirty') return first;
    const t = this.t.bind(this);
    const choice = await this.deps.ask({
      severity: 'warning',
      message: t('Your local changes would be overwritten by checkout.'),
      actions: [t('Stash & Checkout'), t('Migrate Changes'), t('Force Checkout')],
      cancelLabel: t('Cancel'),
      defaultAction: 0,
    });
    if (choice === undefined) return CANCELLED;
    if (choice === 2) {
      if (!(await this.deps.service.discardAll(repoId, 'all'))) return CANCELLED;
    } else if ((await this.stash(repoId, 'includeUntracked')) !== OK) return CANCELLED;
    const second = await this.checkoutUnlessHeld(repoId, target);
    if (second === 'dirty') {
      void this.deps.notify.error(t('Please clean your repository working tree before checkout.'));
      return TOLD;
    }
    if (second !== OK) return second;
    return choice === 1 ? this.stashApply(repoId, true, 'latest') : OK;
  }

  // A checkout git refused while another worktree holds the branch offers that worktree, read from the worktree list after
  // the refusal (VS Code's WorktreeBranchAlreadyUsed); any other failure is git's own.
  private async checkoutUnlessHeld(repoId: string, target: CheckoutTarget): Promise<ScmRunResult | 'dirty'> {
    try {
      return (await this.deps.service.checkout(repoId, target)) === 'ok' ? OK : 'dirty';
    } catch (err) {
      const branch = target.kind === 'branch' ? target.name : undefined;
      const holder = branch === undefined ? undefined : (await this.worktrees(repoId)).find((worktree) => !worktree.current && worktree.branch === branch);
      if (branch === undefined || !holder) throw err;
      return this.offerWorktree(repoId, branch, holder.path);
    }
  }

  // VS Code's handleWorktreeConflict, with the worktree row's Open in place of its two window choices (D58).
  private async offerWorktree(repoId: string, branch: string, worktreePath: string): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    const choice = await this.deps.ask({
      severity: 'warning',
      message: t('Branch "{0}" is already checked out in the worktree at "{1}".', visibleText(branch), visibleText(worktreePath)),
      actions: [t('Open Worktree')],
      cancelLabel: t('Cancel'),
      defaultAction: 0,
    });
    return choice === 0 ? this.host.runRequest({ op: 'openWorktree', repoId, path: worktreePath }) : CANCELLED;
  }

  // VS Code's promptForBranchName: the box starts with branchPrefix and the caret after it, or with a picker's text, cleaned by
  // sanitizeBranchName and behind the prefix, selected so the user confirms or retypes it; rename starts with the current
  // name, and keeping it renames nothing. A name a branch has is refused.
  private async branchName(repoId: string, prefill: { readonly typed: string } | { readonly current: string } = { typed: '' }): Promise<string | undefined> {
    const t = this.t.bind(this);
    const prefix = this.host.setting(SCM_SETTING_KEYS.branchPrefix, '');
    const value = 'current' in prefill ? prefill.current : withPrefix(typedBranchName(prefill.typed), prefix);
    const answer = (
      await this.deps.askInput({
        prompt: t('Please provide a new branch name'),
        placeholder: t('Branch name'),
        value,
        ...(value.startsWith(prefix) ? { valueSelection: [prefix.length, value.length] as const } : {}),
        validation: 'branchName',
      })
    )?.trim();
    if (!answer || ('current' in prefill && answer === prefill.current)) return undefined;
    const branches = await this.deps.service.artifacts(repoId, 'branches');
    if (branches.group === 'branches' && branches.rows.some((row) => row.name === answer)) {
      void this.deps.notify.error(t('A branch named "{0}" already exists', visibleText(answer)));
      return undefined;
    }
    if (!(await this.host.repo(repoId).isValidBranchName(answer))) {
      void this.deps.notify.error(t('Invalid branch name'));
      return undefined;
    }
    return answer;
  }

  // VS Code's _branch: Create Branch... at HEAD, Create Branch From... at a picked ref (HEAD first), the row's ref or the
  // Graph's commit (at, which main checked); typed is the text of the picker the flow came from, which the name box starts with
  // (the ref picker's own text only filters).
  async createBranch(repoId: string, from: boolean, ref?: string, typed = '', at?: string): Promise<ScmRunResult> {
    let start = at ?? 'HEAD';
    if (ref !== undefined) {
      const found = await this.findRef(repoId, ref);
      if (!found) return TOLD;
      start = found.row.ref;
    } else if (from) {
      const HEAD = { kind: 'head' } as const;
      const head = this.host.repo(repoId).lastStatus?.commit?.hash;
      const rows = await this.refRows(repoId, ['branch', 'remote', 'tag']);
      const choice = (await this.pickRef<typeof HEAD>(this.t('Select a ref to create the branch from'), rows, true, [
        { value: HEAD, item: { label: 'HEAD', alwaysShow: true, ...(head ? { description: head.slice(0, 7) } : {}) } },
      ]))?.value;
      if (choice === undefined) return CANCELLED;
      if (choice !== HEAD) start = (choice as RefRow).row.ref;
    }
    const name = await this.branchName(repoId, { typed });
    if (name === undefined) return CANCELLED;
    await this.deps.service.createBranch(repoId, name, start);
    return OK;
  }

  // VS Code's renameBranch: the box starts with the branch's name.
  async renameBranch(repoId: string): Promise<ScmRunResult> {
    const head = this.host.repo(repoId).lastStatus?.head;
    const name = await this.branchName(repoId, head?.type === 'branch' ? { current: head.name } : undefined);
    if (name === undefined) return CANCELLED;
    await this.deps.service.renameBranch(repoId, name);
    return OK;
  }

  // VS Code's _deleteBranch: a picker of the other local branches, or a row (with git.repositories.deleteBranch's question
  // first); an unmerged branch asks before -D.
  async deleteBranch(repoId: string, ref?: string): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    let branch: BranchArtifact;
    if (ref !== undefined) {
      const found = await this.findRef(repoId, ref);
      if (found?.kind !== 'branch') return TOLD;
      branch = found.row;
      if (branch.current) {
        void this.deps.notify.info(t('The active branch cannot be deleted.'));
        return TOLD;
      }
      const choice = await this.deps.ask({
        severity: 'warning',
        message: t('Are you sure you want to delete branch "{0}"? This action will permanently remove the branch reference from the repository.', visibleText(branch.name)),
        actions: [t('Delete Branch')],
        cancelLabel: t('Cancel'),
        defaultAction: 0,
      });
      if (choice !== 0) return CANCELLED;
    } else {
      const rows = this.withoutHead(await this.refRows(repoId, ['branch']), undefined);
      if (rows.length === 0) {
        void this.deps.notify.info(t('This repository has no other branches.'));
        return TOLD;
      }
      const choice = (await this.pickRef(t('Select a branch to delete'), rows, false))?.value;
      if (choice?.kind !== 'branch') return CANCELLED;
      branch = choice.row;
    }
    if ((await this.deps.service.deleteBranch(repoId, branch.name, false)) === 'ok') return OK;
    const force = await this.deps.ask({
      severity: 'danger',
      message: t('The branch "{0}" is not fully merged. Delete anyway?', visibleText(branch.name)),
      actions: [t('Delete Branch')],
      cancelLabel: t('Cancel'),
    });
    if (force !== 0) return CANCELLED;
    await this.deps.service.deleteBranch(repoId, branch.name, true);
    return OK;
  }

  // VS Code's deleteRemoteBranch: the remote branches but HEAD's upstream, deleted on the remote with push --delete; a
  // Graph badge's ref skips the picker, and HEAD's upstream is refused (VS Code's git.graph.deleteBranch).
  async deleteRemoteBranch(repoId: string, ref?: string): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    const head = await this.headBranch(repoId);
    let choice: RefRow | undefined;
    if (ref !== undefined) {
      choice = await this.findRef(repoId, ref);
      if (choice?.kind !== 'remote') return TOLD;
      if (head?.upstream && `${head.upstream.remote}/${head.upstream.branch}` === choice.row.name) {
        void this.deps.notify.info(t('The remote branch of the active branch cannot be deleted.'));
        return TOLD;
      }
      // the badge skips the picker, the palette's one deliberate step, so the delete on the remote asks first
      const confirmed = await this.deps.ask({
        severity: 'danger',
        message: t('Are you sure you want to delete the remote branch "{0}"? This action will permanently remove the branch from the remote "{1}".', visibleText(choice.row.name), visibleText(choice.row.remote)),
        actions: [t('Delete Remote Branch')],
        cancelLabel: t('Cancel'),
      });
      if (confirmed !== 0) return CANCELLED;
    } else {
      const rows = this.withoutHead(await this.refRows(repoId, ['remote']), head);
      if (rows.length === 0) {
        void this.deps.notify.info(t('This repository has no remote branches.'));
        return TOLD;
      }
      choice = (await this.pickRef(t('Select a remote branch to delete'), rows, false))?.value;
    }
    if (choice?.kind !== 'remote') return CANCELLED;
    if (!isRemoteName(choice.row.remote)) {
      void this.deps.notify.warn(t('Remote name format invalid'));
      return TOLD;
    }
    const branch = choice.row.name.slice(choice.row.remote.length + 1);
    return remote(() => this.deps.service.deleteRemoteRef(repoId, choice.row.remote, `refs/heads/${branch}`));
  }

  // VS Code's merge and rebase: every branch and tag (rebase: no tags, HEAD's upstream first as "(upstream)") but HEAD's own.
  async integrate(repoId: string, command: 'merge' | 'rebase', ref?: string): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    let chosen: RefRow;
    if (ref !== undefined) {
      const found = await this.findRef(repoId, ref);
      if (!found) return TOLD;
      chosen = found;
    } else {
      const head = await this.headBranch(repoId);
      const all = await this.refRows(repoId, command === 'merge' ? ['branch', 'remote', 'tag'] : ['branch', 'remote']);
      const rows = this.withoutHead(all, head);
      const upstreamName = head?.upstream ? `${head.upstream.remote}/${head.upstream.branch}` : undefined;
      const upstream = command === 'rebase' ? all.find((entry) => entry.kind === 'remote' && entry.row.name === upstreamName) : undefined;
      const first: Array<PickEntry<RefRow>> = upstream ? [{ value: upstream, item: { label: upstream.row.name, icon: 'remoteBranch', description: t('(upstream)') } }] : [];
      if (first.length + rows.length === 0) {
        void this.deps.notify.info(t('This repository has no other branches.'));
        return TOLD;
      }
      const choice = (await this.pickRef(command === 'merge' ? t('Select a branch or tag to merge from') : t('Select a branch to rebase onto'), rows, true, first))?.value;
      if (choice === undefined) return CANCELLED;
      chosen = choice;
    }
    // the full refname, since git resolves a short name to a tag before a branch of the same name
    if ((await this.deps.service.integrate(repoId, command, chosen.row.ref)) === 'conflict') {
      void this.deps.notify.warn(t('There are merge conflicts. Please resolve them before committing your changes.'));
    }
    return OK;
  }

  // VS Code's git.repositories.compareRef on a branch or tag row: every other branch, remote branch and tag to pick, the
  // picked one on the left and the row's on the right, as one multi-file diff tab.
  async compareRef(repoId: string, ref: string): Promise<ScmRunResult> {
    const found = await this.findRef(repoId, ref);
    if (!found) return TOLD;
    const right = found.row.commit;
    const rows = (await this.refRows(repoId, ['branch', 'remote', 'tag'])).filter((entry) => entry.row.ref !== ref && entry.row.commit !== null);
    if (!right || rows.length === 0) {
      void this.deps.notify.info(this.t('This repository has no other branches or tags to compare with.'));
      return TOLD;
    }
    const choice = (await this.pickRef(this.t('Select a reference to compare with'), rows, true))?.value;
    if (!choice?.row.commit) return CANCELLED;
    return this.host.openRefsChanges(repoId, { hash: choice.row.commit.hash, label: choice.row.name }, { hash: right.hash, label: found.row.name });
  }

  // VS Code's git.graph.compareRef on a commit main checked: every branch, remote branch and tag to pick, the picked one on
  // the left and the commit on the right, as one multi-file diff tab.
  async compareCommit(repoId: string, commit: string): Promise<ScmRunResult> {
    const rows = (await this.refRows(repoId, ['branch', 'remote', 'tag'])).filter((entry) => entry.row.commit !== null);
    if (rows.length === 0) {
      void this.deps.notify.info(this.t('This repository has no branches or tags to compare with.'));
      return TOLD;
    }
    const choice = (await this.pickRef(this.t('Select a reference to compare with'), rows, true))?.value;
    if (!choice?.row.commit) return CANCELLED;
    return this.host.openRefsChanges(repoId, { hash: choice.row.commit.hash, label: choice.row.name }, { hash: commit, label: commit.slice(0, 7) });
  }

  // VS Code's _stash: refuse with nothing to stash, the save-before-stash question, the optional message, then the stash.
  async stash(repoId: string, scope: StashScope, paths: readonly string[] = []): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    const repo = this.host.repo(repoId);
    if (scope === 'staged' && !canStashStaged(repo.gitVersion)) {
      void this.deps.notify.error(t('Stash Staged needs git 2.35 or later.'));
      return TOLD;
    }
    const status = await this.deps.service.currentStatus(repoId);
    const groups = status.groups;
    const noUnstaged = groups.workingTree.length === 0 && (scope !== 'includeUntracked' || groups.untracked.length === 0);
    const noStaged = groups.index.length === 0;
    if (scope === 'staged' ? noStaged : noUnstaged && noStaged && paths.length === 0) {
      void this.deps.notify.info(scope === 'staged' ? t('There are no staged changes to stash.') : t('There are no changes to stash.'));
      return TOLD;
    }
    if (!(await this.saveBeforeStash(repo.root, groups.index.map((change) => change.path), paths))) return CANCELLED;
    const message = await this.deps.askInput({ prompt: t('Optionally provide a stash message'), placeholder: t('Stash message') });
    if (message === undefined) return CANCELLED;
    const outcome = await this.deps.service.stash(repoId, scope, message, paths);
    if (outcome === 'noCommits') void this.deps.notify.info(t('The repository does not have any commits. Please make an initial commit before creating a stash.'));
    else if (outcome === 'noChanges') void this.deps.notify.info(t('There are no changes to stash.'));
    return outcome === 'ok' ? OK : TOLD;
  }

  // Stash Changes on files: only paths of the repository's fresh status, with untracked ones included.
  async stashChanges(repoId: string, paths: readonly string[]): Promise<ScmRunResult> {
    const status = await this.deps.service.currentStatus(repoId);
    const changes = [...status.groups.index, ...status.groups.workingTree, ...status.groups.untracked];
    const known = paths.filter((file) => changes.some((change) => change.path === file));
    if (known.length === 0) {
      void this.deps.notify.info(this.t('There are no changes to stash.'));
      return TOLD;
    }
    const untracked = changes.some((change) => known.includes(change.path) && change.status === 'UNTRACKED');
    return this.stash(repoId, untracked ? 'includeUntracked' : 'default', known);
  }

  // VS Code's save prompt in _stash: unsaved files under the root, only the staged ones at 'staged' or when something is
  // staged; Stash Changes asks only about its own files.
  private async saveBeforeStash(root: string, staged: readonly string[], paths: readonly string[]): Promise<boolean> {
    const mode = this.host.setting<PromptToSaveFilesBeforeStash>(SCM_SETTING_KEYS.promptToSaveFilesBeforeStash, 'always');
    if (mode === 'never') return true;
    const keyed = (files: readonly string[]): Set<string> => new Set(files.map((file) => folderKey(path.join(root, ...file.split('/')))));
    let documents = (await this.deps.editorPane.dirtyFiles()).filter((document) => isInside(root, document.path));
    if (mode === 'staged' || staged.length > 0) documents = documents.filter((document) => keyed(staged).has(folderKey(document.path)));
    if (paths.length > 0) documents = documents.filter((document) => keyed(paths).has(folderKey(document.path)));
    if (documents.length === 0) return true;
    const t = this.t.bind(this);
    const one = documents.length === 1;
    const choice = await this.deps.ask({
      severity: 'warning',
      message: one
        ? t('The following file has unsaved changes which won\'t be included in the stash if you proceed: {0}.', path.basename(documents[0]!.path))
        : t('There are {0} unsaved files.', documents.length),
      detail: one ? t('Would you like to save it before stashing?') : t('Would you like to save them before stashing?'),
      actions: [t('Save All & Stash'), t('Stash Anyway')],
      cancelLabel: t('Cancel'),
      defaultAction: 0,
    });
    if (choice === undefined) return false;
    if (choice === 0 && !(await this.deps.editorPane.saveDocuments(documents.map((document) => document.documentId)))) {
      throw new Error(t('The unsaved files could not be saved, so nothing was stashed.'));
    }
    return true;
  }

  private async stashes(repoId: string): Promise<StashArtifact[]> {
    const listed = await this.deps.service.artifacts(repoId, 'stashes');
    return listed.group === 'stashes' ? [...listed.rows] : [];
  }

  // VS Code's pickStash, the latest stash, or the one a row or tab names (by its commit, wherever it now sits); told: the
  // user was told why there is none, undefined: the picker was dismissed
  private async chooseStash(repoId: string, choice: ScmStashChoice, placeholder: string): Promise<StashArtifact | 'told' | undefined> {
    const t = this.t.bind(this);
    const stashes = await this.stashes(repoId);
    if (typeof choice === 'object') {
      const found = stashes.find((stash) => stash.hash === choice.hash);
      if (found) return found;
      void this.deps.notify.warn(t('The stash is no longer in this repository.'));
      return 'told';
    }
    if (stashes.length === 0) {
      void this.deps.notify.info(choice === 'latest' ? t('There are no stashes in the repository.') : t('This repository has no stashes.'));
      return 'told';
    }
    if (choice === 'latest') return stashes[0];
    return this.pick(
      placeholder,
      stashes.map((stash) => ({ value: stash, item: { label: `#${stash.index}: ${stash.description}`, icon: 'stash' as const, ...(stash.branch !== null ? { description: stash.branch } : {}) } })),
    );
  }

  // Apply Latest Stash, Apply Stash..., Pop Latest Stash, Pop Stash... and a row's or tab's Apply and Pop.
  async stashApply(repoId: string, pop: boolean, choice: ScmStashChoice): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    const stash = await this.chooseStash(repoId, choice, pop ? t('Pick a stash to pop') : t('Pick a stash to apply'));
    if (stash === undefined) return CANCELLED;
    if (stash === 'told') return TOLD;
    const outcome = await this.deps.service.stashApply(repoId, { index: stash.index, hash: stash.hash }, pop);
    if (outcome === 'moved') {
      void this.deps.notify.warn(t('The stash is no longer in this repository.'));
      return TOLD;
    }
    if (outcome === 'conflict') void this.deps.notify.warn(t('There are merge conflicts while applying the stash. Please resolve them before committing your changes.'));
    if (pop && outcome === 'ok') await this.host.closeStashTabs(repoId, stash.hash);
    return OK;
  }

  // VS Code's _stashDrop: always confirmed, as a danger question whose Cancel takes focus, since a dropped stash is as hard to
  // recover as Drop All's; the dropped stash's View Stash tab closes, as git.stashDropEditor closes it.
  async stashDrop(repoId: string, target: 'pick' | ScmStashTarget): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    const stash = await this.chooseStash(repoId, target, t('Pick a stash to drop'));
    if (stash === undefined) return CANCELLED;
    if (stash === 'told') return TOLD;
    const choice = await this.deps.ask({ severity: 'danger', message: t('Are you sure you want to drop the stash: {0}?', visibleText(stash.description)), actions: [t('Yes')], cancelLabel: t('Cancel') });
    if (choice !== 0) return CANCELLED;
    if ((await this.deps.service.stashDrop(repoId, { index: stash.index, hash: stash.hash })) === 'moved') {
      void this.deps.notify.warn(t('The stash is no longer in this repository.'));
      return TOLD;
    }
    await this.host.closeStashTabs(repoId, stash.hash);
    return OK;
  }

  // VS Code's stashDropAll, as a danger question whose Cancel takes focus.
  async stashDropAll(repoId: string): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    const stashes = await this.stashes(repoId);
    if (stashes.length === 0) {
      void this.deps.notify.info(t('There are no stashes in the repository.'));
      return TOLD;
    }
    const choice = await this.deps.ask({
      severity: 'danger',
      message: stashes.length === 1
        ? t('Are you sure you want to drop ALL stashes? There is 1 stash that will be subject to pruning, and MAY BE IMPOSSIBLE TO RECOVER.')
        : t('Are you sure you want to drop ALL stashes? There are {0} stashes that will be subject to pruning, and MAY BE IMPOSSIBLE TO RECOVER.', stashes.length),
      actions: [t('Yes')],
      cancelLabel: t('Cancel'),
    });
    if (choice !== 0) return CANCELLED;
    await this.deps.service.stashClear(repoId);
    for (const stash of stashes) await this.host.closeStashTabs(repoId, stash.hash);
    return OK;
  }

  async viewStash(repoId: string, target: 'pick' | ScmStashTarget): Promise<ScmRunResult> {
    const stash = await this.chooseStash(repoId, target, this.t('Pick a stash to view'));
    if (stash === undefined) return CANCELLED;
    if (stash === 'told') return TOLD;
    return this.host.openStash(repoId, stash);
  }

  // VS Code's _createTag: a name, then a message; a message makes the tag annotated, and Escape on it a lightweight tag. At
  // HEAD, or at the Graph's commit, which main checked.
  async createTag(repoId: string, commit?: string): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    const name = (await this.deps.askInput({ prompt: t('Please provide a tag name'), placeholder: t('Tag name'), validation: 'tagName' }))?.trim();
    if (!name) return CANCELLED;
    if (inputProblem('tagName', name, { windows: this.deps.platform === 'win32' }) !== undefined) {
      void this.deps.notify.error(t('Invalid tag name'));
      return TOLD;
    }
    const message = await this.deps.askInput({ prompt: t('Please provide a message to annotate the tag'), placeholder: t('Message') });
    await this.deps.service.createTag(repoId, name, message ?? '', commit);
    return OK;
  }

  // VS Code's deleteTag, or a row (with git.repositories.deleteTag's question first).
  async deleteTag(repoId: string, ref?: string): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    let tag: TagArtifact;
    if (ref !== undefined) {
      const found = await this.findRef(repoId, ref);
      if (found?.kind !== 'tag') return TOLD;
      tag = found.row;
      const choice = await this.deps.ask({
        severity: 'warning',
        message: t('Are you sure you want to delete tag "{0}"? This action will permanently remove the tag reference from the repository.', visibleText(tag.name)),
        actions: [t('Delete Tag')],
        cancelLabel: t('Cancel'),
        defaultAction: 0,
      });
      if (choice !== 0) return CANCELLED;
    } else {
      const rows = await this.refRows(repoId, ['tag']);
      if (rows.length === 0) {
        void this.deps.notify.info(t('This repository has no tags.'));
        return TOLD;
      }
      const choice = (await this.pickRef(t('Select a tag to delete'), rows, false))?.value;
      if (choice?.kind !== 'tag') return CANCELLED;
      tag = choice.row;
    }
    await this.deps.service.deleteTag(repoId, tag.name);
    return OK;
  }

  // VS Code's deleteRemoteTag: a remote with a push URL (picked when there are several), then one of its tags.
  async deleteRemoteTag(repoId: string): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    const remotes = (await this.deps.service.remotes(repoId)).filter((entry) => entry.pushUrl !== undefined);
    if (remotes.length === 0) {
      void this.deps.notify.error(t('Your repository has no remotes configured to push to.'));
      return TOLD;
    }
    const chosen: Remote | undefined = remotes.length === 1
      ? remotes[0]
      : await this.pick(t('Select a remote to delete a tag from'), remotes.map((entry) => ({ value: entry, item: { label: entry.name, icon: 'remote' as const, ...(entry.fetchUrl !== undefined ? { description: redactUrls(entry.fetchUrl) } : {}) } })));
    if (!chosen) return CANCELLED;
    let tags;
    try {
      tags = await this.deps.service.remoteTags(repoId, chosen.name);
    } catch (err) {
      if (err instanceof RemoteCancelledError) return CANCELLED;
      throw err;
    }
    if (tags.length === 0) {
      void this.deps.notify.info(t('Remote "{0}" has no tags.', visibleText(chosen.name)));
      return TOLD;
    }
    const tag = await this.pick(t('Select a remote tag to delete'), tags.map((entry) => ({ value: entry, item: { label: entry.name, icon: 'tag' as const, description: t('Remote tag at {0}', entry.commit.slice(0, 7)) } })));
    if (!tag) return CANCELLED;
    return remote(() => this.deps.service.deleteRemoteRef(repoId, chosen.name, `refs/tags/${tag.name}`));
  }

  // VS Code's pushTags: every tag to the remote git picks; no remote offers Add Remote, as Push does.
  async pushTags(repoId: string, addRemote: () => void): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    if ((await this.deps.service.remotes(repoId)).length === 0) {
      const add = t('Add Remote');
      void this.deps.notify.warn(t('Your repository has no remotes configured to push to.'), add).then((choice) => {
        if (choice === add) addRemote();
      });
      return TOLD;
    }
    return remote(() => this.deps.service.pushTags(repoId));
  }

  // VS Code's _createWorktree: a new branch or a ref to check out, then the folder, then `worktree add`.
  async createWorktree(repoId: string): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    const CREATE = { kind: 'create' } as const;
    const rows = await this.refRows(repoId, ['branch', 'remote', 'tag']);
    const picked = await this.pickRef<typeof CREATE>(t('Select a branch or tag to create the new worktree from'), rows, true, [
      { value: CREATE, item: { label: t('Create new branch...'), icon: 'add', alwaysShow: true, echoQuery: true } },
    ]);
    if (picked === undefined) return CANCELLED;
    const choice = picked.value;
    let commitish = 'HEAD';
    let label = 'HEAD';
    let branch: string | undefined;
    if (choice === CREATE) {
      branch = await this.branchName(repoId, { typed: picked.query });
      if (branch === undefined) return CANCELLED;
    } else {
      const entry = choice as RefRow;
      if (entry.kind === 'branch' && entry.row.current) {
        const create = await this.deps.ask({ severity: 'warning', message: t('Branch "{0}" is already checked out in the current repository.', visibleText(entry.row.name)), actions: [t('Create New Branch')], cancelLabel: t('Cancel'), defaultAction: 0 });
        if (create !== 0) return CANCELLED;
        branch = await this.branchName(repoId);
        if (branch === undefined) return CANCELLED;
      } else {
        const worktrees = await this.worktrees(repoId);
        const holder = entry.kind === 'branch' ? worktrees.find((worktree) => worktree.branch === entry.row.name) : undefined;
        if (holder) return this.offerWorktree(repoId, entry.row.name, holder.path);
        // a branch by name checks it out; a tag by its commit, detached there, since worktree add prefers a branch of the tag's
        // name; a remote branch by its full refname, detached
        commitish = entry.kind === 'branch' ? entry.row.name : entry.kind === 'tag' ? entry.row.commit?.hash ?? entry.row.ref : entry.row.ref;
        label = entry.row.name;
      }
    }
    const repo = this.host.repo(repoId);
    const name = worktreeName(branch ?? label, this.host.setting(SCM_SETTING_KEYS.branchPrefix, ''));
    const remembered = this.deps.service.worktreeFolder(repoId);
    const suggested = remembered !== undefined ? path.join(remembered, name) : defaultWorktreePath(repo.root, name, !samePath(repo.info.gitDir, repo.info.commonDir));
    const nameSelected = (value: string): readonly [number, number] => [value.length - name.length, value.length];
    // VS Code's getWorktreePath folder button: the OS folder picker, at the remembered folder or the repository's parent
    const pick = async (): Promise<{ readonly value: string; readonly valueSelection: readonly [number, number] } | undefined> => {
      const folder = await this.deps.pickFolder(remembered ?? path.dirname(repo.root), t('Select Worktree Destination'), t('Select as Worktree Destination'));
      if (folder === undefined) return undefined;
      const value = path.join(folder, name);
      return { value, valueSelection: nameSelected(value) };
    };
    const typed = (await this.deps.askInput({
      prompt: t('Please provide a worktree path'),
      placeholder: t('Worktree path'),
      value: suggested,
      valueSelection: nameSelected(suggested),
      browse: { tooltip: t('Select Worktree Destination'), pick },
    }))?.trim();
    if (!typed) return CANCELLED;
    const target = await this.worktreePath(repoId, typed);
    if (target === undefined) return TOLD;
    await this.deps.service.addWorktree(repoId, target, commitish, branch);
    const owner = this.deps.service.repository(repoId);
    const projectKey = owner ? parseRootKey(owner.projectKey)?.projectKey : undefined;
    // the branch the new worktree has checked out: the one it created, or the local branch it took
    const checkedOut = branch ?? (choice !== CREATE && (choice as RefRow).kind === 'branch' ? (choice as RefRow).row.name : undefined);
    if (projectKey !== undefined) await this.deps.worktrees.adoptCreated(projectKey, repo.root, target, checkedOut);
    return OK;
  }

  // A typed worktree folder: absolute and local, as the validator takes a worktree row's path (no UNC share, which would send
  // the user's credentials, and no root-relative path, which git resolves against its working folder's drive), with a taken
  // worktree path made unique with -1, -2..., as VS Code's createWorktree does.
  private async worktreePath(repoId: string, typed: string): Promise<string | undefined> {
    if (!isWorktreePath(typed, this.deps.platform)) {
      void this.deps.notify.warn(this.t('"{0}" is not an absolute folder path on this computer.', visibleText(typed)));
      return undefined;
    }
    const wanted = path.normalize(typed);
    const taken = (await this.worktrees(repoId)).map((worktree) => worktree.path);
    let candidate = wanted;
    for (let counter = 1; taken.some((existing) => samePath(existing, candidate)); counter++) candidate = `${wanted}-${counter}`;
    return candidate;
  }

  private async worktrees(repoId: string): Promise<WorktreeArtifact[]> {
    const listed = await this.deps.service.artifacts(repoId, 'worktrees');
    return listed.group === 'worktrees' ? [...listed.rows] : [];
  }

  // VS Code's deleteWorktree: a picker of the linked worktrees (never the main one or this one), or a row's path. A chat
  // worktree takes D33's path. Any other always asks first, since git deletes the folder's ignored files too, naming the
  // project the folder holds; then (slice 12a rule 14) that project and its chats close before `git worktree remove`, and a
  // dirty worktree asks again, then removes with --force. Its chats are then listed read-only under the main project.
  async deleteWorktree(repoId: string, worktreePath?: string): Promise<ScmRunResult> {
    const t = this.t.bind(this);
    const removable = (await this.worktrees(repoId)).filter((worktree) => !worktree.main && !worktree.current);
    let worktree: WorktreeArtifact | undefined;
    if (worktreePath !== undefined) {
      worktree = removable.find((candidate) => samePath(candidate.path, worktreePath));
      if (!worktree) {
        void this.deps.notify.warn(t('"{0}" is not a worktree that can be deleted.', visibleText(worktreePath)));
        return TOLD;
      }
    } else {
      if (removable.length === 0) {
        void this.deps.notify.info(t('This repository has no worktrees.'));
        return TOLD;
      }
      worktree = await this.pick(
        t('Select a worktree to delete'),
        removable.map((entry) => {
          const description = [entry.branch ?? t('detached'), entry.commit?.hash.slice(0, 7), entry.commit?.subject].filter((part) => part !== undefined).join(' \u2022 ');
          return { value: entry, item: { label: entry.name, icon: 'worktree' as const, description, hint: entry.path } };
        }),
      );
      if (!worktree) return CANCELLED;
    }
    if (await this.deps.worktrees.deleteChatWorktreeAt(worktree.path)) return OK;
    const project = this.host.worktreeProject(repoId, worktree.path);
    const main = (await this.worktrees(repoId)).find((candidate) => candidate.main);
    const mainProject = main ? this.host.worktreeProject(repoId, main.path) : undefined;
    const confirmed = await this.deps.ask({
      severity: 'danger',
      message: !project
        ? t('Are you sure you want to delete the worktree "{0}"?', visibleText(worktree.path))
        : mainProject
          ? t('Are you sure you want to delete the worktree "{0}"? The project "{1}" is in it and will be closed, and its chats will then be listed under "{2}", read-only.', visibleText(worktree.path), visibleText(project.name), visibleText(mainProject.name))
          : t('Are you sure you want to delete the worktree "{0}"? The project "{1}" is in it and will be closed, and its chats will no longer be listed.', visibleText(worktree.path), visibleText(project.name)),
      detail: t('Its ignored files, such as .env and node_modules, are deleted too.'),
      actions: [t('Delete Worktree')],
      cancelLabel: t('Cancel'),
    });
    if (confirmed !== 0) return CANCELLED;
    // rule 14's order: every question before the project closes, so a Cancel leaves it open
    const dirty = await this.deps.service.worktreeDirty(repoId, worktree.path);
    if (dirty && !(await this.confirmForceDelete(worktree.path))) return CANCELLED;
    if (project) await this.deps.worktrees.adopt(project, worktree, main?.path ?? this.host.repo(repoId).root, mainProject);
    if (project) {
      const closed = await this.deps.worktrees.closeProject(project.key);
      if (closed === 'cancelled') return CANCELLED;
      if (closed !== 'closed') {
        void this.deps.notify.warn(t('The worktree was not deleted, because its project "{0}" could not be closed: {1}', visibleText(project.name), visibleLines(closed.reason)));
        return TOLD;
      }
    }
    // once the project closed nothing asks again: a refusal names the path and the closed project, and Retry runs the whole
    // order again, as for a chat worktree
    const failed = (reason: string): ScmRunResult => {
      const retry = t('Retry');
      const message = project ? t('Could not delete the worktree "{0}", and its project "{1}" was closed: {2}', visibleText(worktree.path), visibleText(project.name), reason) : t('Could not delete the worktree "{0}": {1}', visibleText(worktree.path), reason);
      void this.deps.notify.error(message, retry).then((choice) => {
        if (choice === retry) void this.host.runRequest({ op: 'deleteWorktree', repoId, path: worktree.path });
      });
      return TOLD;
    };
    try {
      if ((await this.deps.service.removeWorktree(repoId, worktree.path, dirty)) === 'dirty') {
        if (project) return failed(t('Files were added to it after you confirmed.'));
        // files that appeared after the question make git refuse, and with nothing closed yet the user is asked again
        if (!(await this.confirmForceDelete(worktree.path))) return CANCELLED;
        await this.deps.service.removeWorktree(repoId, worktree.path, true);
      }
    } catch (err) {
      return failed(gitErrorText(err));
    }
    await this.deps.worktrees.markRemoved(worktree.path);
    return OK;
  }

  private async confirmForceDelete(worktreePath: string): Promise<boolean> {
    const t = this.t.bind(this);
    const force = await this.deps.ask({
      severity: 'danger',
      message: t('The worktree contains modified or untracked files. Do you want to force delete?'),
      detail: t('Worktree: {0}', visibleText(worktreePath)),
      actions: [t('Force Delete')],
      cancelLabel: t('Cancel'),
    });
    return force === 0;
  }
}
