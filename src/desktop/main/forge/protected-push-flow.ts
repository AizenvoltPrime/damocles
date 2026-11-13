// A push the server refused on a branch it protects for the account (docs/invariants.md "GitHub and GitLab accounts",
// protected branch on push). The server's rules decide on this computer's core; every git step runs on the repository's own
// core. The local branch is never moved or reset: the new branch starts at HEAD and the push may only create it on the remote.
import { randomUUID } from 'node:crypto';
import { l } from '../../../core/l10n';
import { gitErrorText, pushFailureKind, RemoteCancelledError } from '../../../core/scm/errors';
import type { RemoteEndpoint } from '../../../shared/forge/bindings';
import { MAX_BRANCH_NAME_CHARS, PROTECTED_PUSH_STEPS, type BranchNameCheck, type BranchNameProblem, type ProtectedBranchDialog, type ProtectedPushState } from '../../../shared/forge/protected-push';
import type { FlowStart } from '../../../shared/forge/publish';
import type { LocalizedText } from '../../../shared/localized-text';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import type { CoreClient } from '../core-client';
import type { ScmServiceClient } from '../scm/scm-client';
import { dialogText, parseProtectedBranchRequest } from './publish-dialogs';
import { openCreatePage, steps } from './publish-flow';

/** The daemon feature whose push honours createOnly; a remote project on an older daemon is not offered a new branch. */
export const PUSH_CREATE_ONLY_FEATURE = 'scm.push.createOnly';
/** The daemon feature that counts the commits a remote lacks, which the dialog names. */
export const UNPUSHED_COUNT_FEATURE = 'scm.unpushedCount';
/** The daemon feature that reads core.ignorecase; on an older daemon names are compared in their own letter case. */
export const IGNORE_CASE_FEATURE = 'scm.ignoreCase';
/** The suggested names tried after "<login>/<branch>": "-2" up to this suffix. */
const MAX_SUGGESTION_SUFFIX = 9;

export interface ProtectedPushDeps {
  /** This computer's core, waited for through a restart. */
  readonly core: <T>(label: string, work: (client: CoreClient) => Promise<T>) => Promise<T>;
  readonly scm: Pick<ScmServiceClient, 'repository' | 'currentStatus' | 'artifacts' | 'remoteBranches' | 'createBranch' | 'push'>;
  /** What the authority's daemon listed in its welcome; undefined for 'local' or a host not connected. */
  readonly features: (authorityKey: string) => readonly string[] | undefined;
  /** The repository's remote endpoints as forge-host reads them (ssh aliases resolved on its own host). */
  readonly endpoints: (repoId: string) => Promise<readonly RemoteEndpoint[]>;
  /** The guarded opener: https on a managed server's web origin, as the user's click; false when it refused. */
  readonly openOnServer: (url: string) => Promise<boolean>;
  /** Shows a dialog and settles with its answer; rejects when it cannot show. */
  readonly ask: (request: OverlayRequest) => Promise<OverlayAnswer>;
  readonly pushState: (state: ProtectedPushState) => void;
  readonly render: (text: LocalizedText) => string;
  readonly notify: {
    info(message: string): void;
    error(message: string): void;
  };
  readonly log: (line: string) => void;
}

interface ProtectedSession {
  readonly repoId: string;
  // what the dialog shows, hidden characters escaped; git and the server get the raw names below
  readonly dialog: ProtectedBranchDialog;
  readonly branch: string;
  readonly localBranch: string;
  readonly remote: string;
  readonly serverId: string;
  readonly accountId: string;
  /** The repository's path on the server: the pull or merge request's source and target project. */
  readonly path: string;
  /** core.ignorecase: git takes two names that differ only in letter case for one. */
  readonly ignoresCase: boolean;
  started: boolean;
  running: boolean;
  closed: boolean;
  pushed?: string;
  last?: ProtectedPushState;
}

/** The local branches and the remote's branches as last fetched, a new name is checked against. */
export interface BranchNames {
  readonly local: readonly string[];
  readonly remote: readonly string[];
}

const isFolderOf = (folder: string, name: string): boolean => name.startsWith(`${folder}/`);

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Why a name git accepts is taken: a branch of the same name, or one git cannot hold beside it ("a" and "a/b"); with
 * ignoresCase, names that differ only in letter case are the same name.
 */
export function takenProblem(name: string, names: BranchNames, ignoresCase: boolean): BranchNameProblem | undefined {
  const key = (value: string): string => (ignoresCase ? value.toLowerCase() : value);
  const wanted = key(name);
  const local = names.local.map(key);
  const remote = names.remote.map(key);
  if (local.includes(wanted)) return 'existsLocally';
  if (remote.includes(wanted)) return 'existsOnRemote';
  return [...local, ...remote].some((existing) => isFolderOf(existing, wanted) || isFolderOf(wanted, existing)) ? 'conflicts' : undefined;
}

export class ProtectedPushFlow {
  private readonly deps: ProtectedPushDeps;
  private readonly sessions = new Map<string, ProtectedSession>();
  // ends the protection reads when the window's forge host goes
  private readonly disposal = new AbortController();

  constructor(deps: ProtectedPushDeps) {
    this.deps = deps;
  }

  /**
   * A push of localBranch to branch on remote failed. A refused push (authorization, or a ref the server's hook declined) asks
   * this computer's core whether the server protects branch for the push's account; the dialog opens only when it does.
   * False: the caller goes on to the fork check or the push's own failure.
   */
  async pushRefused(repoId: string, remote: string, branch: string, localBranch: string, err: unknown): Promise<boolean> {
    const kind = pushFailureKind(err);
    if (kind !== 'authorization' && kind !== 'rejected') return false;
    const ref = this.deps.scm.repository(repoId);
    if (!ref) return false;
    const authority = ref.repo.authority;
    const features = authority === 'local' ? undefined : this.deps.features(authority) ?? [];
    if (features && !(features.includes(PUSH_CREATE_ONLY_FEATURE) && features.includes(UNPUSHED_COUNT_FEATURE))) {
      this.deps.log(`[forge] ${authority} cannot push a branch only as new or count the commits ${remote} lacks; the server's branch rules are not read for its refused push`);
      return false;
    }
    let decision: Awaited<ReturnType<CoreClient['forgePushProtection']>>;
    try {
      const endpoints = await this.deps.endpoints(repoId);
      decision = await this.deps.core('forge pushProtection', (client) => client.forgePushProtection({ repo: { projectKey: ref.projectKey, authorityKey: authority, endpoints: [...endpoints] }, remote, branch }, this.disposal.signal));
    } catch (failure) {
      this.deps.log(`[forge] reading the server's branch rules for a refused push failed: ${errorMessage(failure)}`);
      return false;
    }
    if (decision.protection !== 'protected') {
      this.deps.log(`[forge] the refused push to ${branch}: the server's branch rules say ${decision.protection}`);
      return false;
    }
    let unpushedCount: number;
    let suggestedName: string;
    let ignoresCase: boolean;
    try {
      let names: BranchNames;
      [names, unpushedCount, ignoresCase] = await Promise.all([
        this.branchNames(repoId, remote),
        ref.repo.unpushedCount(remote),
        features === undefined || features.includes(IGNORE_CASE_FEATURE) ? ref.repo.ignoresCase() : Promise.resolve(false),
      ]);
      suggestedName = await this.suggestedName(repoId, `${decision.login}/${branch}`, names, ignoresCase);
    } catch (failure) {
      this.deps.log(`[forge] reading the branches and commits for the protected-branch dialog failed: ${errorMessage(failure)}`);
      return false;
    }
    const dialog: ProtectedBranchDialog = {
      requestId: randomUUID(),
      branch,
      serverName: decision.serverName,
      kind: decision.kind,
      login: decision.login,
      remote,
      localBranch,
      unpushedCount,
      suggestedName,
    };
    const request = parseProtectedBranchRequest(dialog);
    if (!request) {
      this.deps.log('[forge] the protected-branch dialog is past the overlay bounds; nothing is shown');
      return false;
    }
    const session: ProtectedSession = { repoId, dialog: request.dialog, branch, localBranch, remote, serverId: decision.serverId, accountId: decision.accountId, path: decision.path, ignoresCase, started: false, running: false, closed: false };
    this.sessions.set(dialog.requestId, session);
    void this.deps.ask(request).then(
      (answer) => this.closed(session, answer),
      (failure: unknown) => {
        this.deps.log(`[forge] the protected-branch dialog did not show: ${errorMessage(failure)}`);
        this.closed(session, { kind: 'dismissed' });
      },
    ).finally(() => this.sessions.delete(dialog.requestId));
    return true;
  }

  /** The name step's check against git's ref rules and the branches as they are now, read again for each check. */
  async checkName(requestId: string, name: string): Promise<BranchNameCheck> {
    const session = this.sessions.get(requestId);
    if (!session) throw new Error('forge.protectedCheckName names a protected-branch dialog main does not hold');
    const problem = await this.problem(session.repoId, name, await this.branchNames(session.repoId, session.remote), session.ignoresCase);
    return problem === undefined ? { name } : { name, problem };
  }

  /** Push to a New Branch: started, with the steps on the state pushes; ignored while one runs, after a push or once the dialog closed. */
  push(requestId: string, name: string): FlowStart {
    const session = this.sessions.get(requestId);
    if (!session || session.running || session.closed || session.pushed !== undefined) return 'ignored';
    session.running = true;
    void this.runPush(requestId, session, name).catch((err: unknown) => this.deps.log(`[forge] the push to a new branch failed: ${errorMessage(err)}`));
    return 'started';
  }

  /** The name checked again, the branch made at HEAD and switched to, then pushed as new with upstream. */
  private async runPush(requestId: string, session: ProtectedSession, name: string): Promise<void> {
    const { repoId } = session;
    const show = (state: ProtectedPushState): void => {
      session.last = state;
      if (!session.closed) this.deps.pushState(state);
    };
    const fail = (at: number, failure: string): void => {
      session.running = false;
      show({ requestId, phase: 'failed', name, steps: steps(PROTECTED_PUSH_STEPS, at, dialogText(failure)) });
      if (session.closed) this.deps.notify.error(failure);
    };
    // a close before the branch step has been told "Push not sent" (closed), so the flow ends there with nothing changed
    const leftBeforeStart = (): boolean => {
      if (!session.closed || session.started) return false;
      session.running = false;
      return true;
    };
    let problem: BranchNameProblem | undefined;
    try {
      problem = await this.problem(repoId, name, await this.branchNames(repoId, session.remote), session.ignoresCase);
    } catch (err) {
      this.deps.log(`[forge] checking the new branch's name failed: ${errorMessage(err)}`);
      if (leftBeforeStart()) return;
      fail(0, gitErrorText(err));
      return;
    }
    if (leftBeforeStart()) return;
    if (problem !== undefined) {
      session.running = false;
      show({ requestId, phase: 'refused', name, problem });
      return;
    }
    show({ requestId, phase: 'running', name, steps: steps(PROTECTED_PUSH_STEPS, 0) });
    try {
      // the branch starts at the commit HEAD's branch holds now, read on the project's core: another switch since the dialog opened refuses
      const now = await this.deps.scm.currentStatus(repoId);
      if (leftBeforeStart()) return;
      if (now.head?.type !== 'branch' || now.head.name !== session.localBranch || now.commit === null) {
        fail(0, this.deps.render(l('The repository is no longer on {0}, so no branch was created. Switch back to {0} and push again.', session.dialog.localBranch)));
        return;
      }
      session.started = true;
      await this.deps.scm.createBranch(repoId, name, now.commit.hash);
    } catch (err) {
      this.deps.log(`[forge] creating the new branch failed: ${errorMessage(err)}`);
      if (leftBeforeStart()) return;
      fail(0, gitErrorText(err));
      return;
    }
    show({ requestId, phase: 'running', name, steps: steps(PROTECTED_PUSH_STEPS, 1) });
    try {
      await this.deps.scm.push(repoId, { remote: session.remote, branch: name, setUpstream: true, followTags: false, force: false, createOnly: true });
    } catch (err) {
      this.deps.log(`[forge] pushing the new branch failed: ${errorMessage(err)}`);
      fail(1, err instanceof RemoteCancelledError ? this.deps.render(l('The push was canceled.')) : gitErrorText(err));
      return;
    }
    session.running = false;
    session.pushed = name;
    show({ requestId, phase: 'done', name, steps: steps(PROTECTED_PUSH_STEPS, PROTECTED_PUSH_STEPS.length) });
    if (session.closed) this.deps.notify.info(this.deps.render(l('Pushed {0} to {1}. {2} is unchanged.', name, session.dialog.remote, session.dialog.localBranch)));
  }

  private async branchNames(repoId: string, remote: string): Promise<BranchNames> {
    const [branches, remoteBranches] = await Promise.all([this.deps.scm.artifacts(repoId, 'branches'), this.deps.scm.remoteBranches(repoId, remote)]);
    return { local: branches.group === 'branches' ? branches.rows.map((row) => row.name) : [], remote: remoteBranches };
  }

  private async problem(repoId: string, name: string, names: BranchNames, ignoresCase: boolean): Promise<BranchNameProblem | undefined> {
    if (name === '') return 'empty';
    const ref = this.deps.scm.repository(repoId);
    if (!ref) throw new Error('The repository of the protected-branch dialog is closed');
    if (!(await ref.repo.isValidBranchName(name))) return 'invalid';
    return takenProblem(name, names, ignoresCase);
  }

  /** "<login>/<branch>", else the first of "-2" to "-9" after it that fits, git accepts and no branch takes; '' when none does. */
  private async suggestedName(repoId: string, base: string, names: BranchNames, ignoresCase: boolean): Promise<string> {
    for (let suffix = 1; suffix <= MAX_SUGGESTION_SUFFIX; suffix++) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      if (candidate.length > MAX_BRANCH_NAME_CHARS) return '';
      if ((await this.problem(repoId, candidate, names, ignoresCase)) === undefined) return candidate;
    }
    return '';
  }

  private closed(session: ProtectedSession, answer: OverlayAnswer): void {
    session.closed = true;
    // the question closed before any step ran: the push's own failure was not shown, so this says what happened
    if (!session.started) this.deps.notify.info(this.deps.render(l('Push not sent. Your commits are still on {0}.', session.dialog.localBranch)));
    if (answer.kind === 'forgeProtectedBranch' && session.last?.phase === 'done' && session.pushed !== undefined) {
      const { dialog } = session;
      const name = session.pushed;
      // the create page from the new branch into the protected one of the same repository
      void openCreatePage(this.deps, { repoId: session.repoId, kind: dialog.kind, serverId: session.serverId, accountId: session.accountId, upstreamPath: session.path, forkPath: session.path, branch: name, targetBranch: session.branch }, (serverName) => (dialog.kind === 'github'
        ? l('Opened the new pull request page on {0}, from {1} into {2}.', serverName, name, dialog.branch)
        : l('Opened the new merge request page on {0}, from {1} into {2}.', serverName, name, dialog.branch)));
    }
  }

  dispose(): void {
    this.disposal.abort();
  }

  isOpen(requestId: string): boolean {
    return this.sessions.has(requestId);
  }
}
