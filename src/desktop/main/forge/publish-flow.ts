// Publish and fork on a denied push in main (docs/invariants.md "GitHub and GitLab accounts", publish and fork). Every
// git step runs on the repository's own core (scm client, by repository id); every server call on this computer's core. The
// dialogs get ids, names and step states; the URLs stay here, and a create page opens only through the guarded opener.
import { randomUUID } from 'node:crypto';
import { gitErrorText, pushFailureKind, RemoteCancelledError } from '../../../core/scm/errors';
import { forkRemotePlan, forkRestorePlan, type ForkRemotePlan } from '../../../core/scm/remotes';
import { l } from '../../../core/l10n';
import type { ForgeKind } from '../../../shared/forge/accounts';
import type { RemoteEndpoint, RemoteLocation } from '../../../shared/forge/bindings';
import {
  GITHUB_TEMPLATE_FILES,
  GITLAB_TEMPLATE_FILES,
  MAX_TEMPLATE_CHARS,
  PUBLISH_STEPS,
  FORK_STEPS,
  sanitizeRepositoryName,
  isRepositoryName,
  type FlowStart,
  type FlowStep,
  type ForkDialog,
  type ForkState,
  type PublishState,
  type PublishAccount,
  type PublishNamespace,
  type PublishOwnersAnswer,
  type PublishTarget,
  type PublishVisibility,
} from '../../../shared/forge/publish';
import type { LocalizedText } from '../../../shared/localized-text';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import type { CoreClient } from '../core-client';
import type { ScmServiceClient } from '../scm/scm-client';
import { dialogText, parseForkRequest, parseOwners, parsePublishRequest } from './publish-dialogs';

/** The daemon feature that serves scm.call renameRemote; a remote project on an older daemon is not offered a fork. */
export const RENAME_REMOTE_FEATURE = 'scm.renameRemote';

export interface PublishFlowDeps {
  /** This computer's core, waited for through a restart. */
  readonly core: <T>(label: string, work: (client: CoreClient) => Promise<T>) => Promise<T>;
  readonly scm: Pick<ScmServiceClient, 'repository' | 'remotes' | 'addRemote' | 'removeRemote' | 'renameRemote' | 'push'>;
  /** What the authority's daemon listed in its welcome; undefined for 'local' or a host not connected. */
  readonly features: (authorityKey: string) => readonly string[] | undefined;
  /** The repository's remote endpoints as forge-host reads them (ssh aliases resolved on its own host). */
  readonly endpoints: (repoId: string) => Promise<readonly RemoteEndpoint[]>;
  /** The kind of the server with an account that location names, as the forge mirror lists them; undefined when none does. */
  readonly serverKind: (location: RemoteLocation) => ForgeKind | undefined;
  /** The project's name as the project list shows it; undefined once it left the list, which happens before its repository closes. */
  readonly projectName: (projectKey: string) => string | undefined;
  /** Binds the project to the account the push authenticates as; unsaved: bindings.json does not parse; unlisted: the project left the list. */
  readonly bind: (projectKey: string, bind: { readonly serverId: string; readonly accountId: string }) => Promise<'saved' | 'unsaved' | 'unlisted'>;
  /** The guarded opener: https on a managed server's web origin, as the user's click; false when it refused. */
  readonly openOnServer: (url: string) => Promise<boolean>;
  /** Shows a dialog and settles with its answer; rejects when it cannot show. */
  readonly ask: (request: OverlayRequest) => Promise<OverlayAnswer>;
  readonly pushPublishState: (state: PublishState) => void;
  readonly pushForkState: (state: ForkState) => void;
  readonly render: (text: LocalizedText) => string;
  readonly notify: {
    info(message: string): void;
    warn(message: string, action: string): Promise<boolean>;
    error(message: string): void;
  };
  readonly log: (line: string) => void;
}

interface PublishSession {
  readonly repoId: string;
  readonly projectKey: string;
  // the branch git pushes, and the same with its hidden characters escaped, as the dialog shows it
  readonly branch: string;
  readonly shownBranch: string;
  readonly accounts: readonly PublishAccount[];
  // each account's listing in flight; the dialog's close aborts them
  readonly listings: Map<string, AbortController>;
  // each account's organizations or groups as its latest listing gave them to the dialog
  readonly offered: Map<string, readonly PublishNamespace[]>;
  running: boolean;
  cancellable: boolean;
  cancelled: boolean;
  closed: boolean;
  last?: PublishState;
}

interface ForkSession {
  readonly repoId: string;
  readonly projectKey: string;
  // what the dialog shows, hidden characters escaped; git and the server get the raw remote, branch and path below
  readonly dialog: ForkDialog;
  readonly remote: string;
  readonly branch: string;
  readonly path: string;
  readonly plan: ForkRemotePlan;
  readonly serverId: string;
  readonly accountId: string;
  readonly controller: AbortController;
  running: boolean;
  cancellable: boolean;
  closed: boolean;
  forkPath?: string;
  last?: ForkState;
}

/** Each step before at done, at itself active (or failed with failure), the rest pending; at past the last: all done. */
export function steps<Id extends string>(ids: readonly Id[], at: number, failure?: string): FlowStep<Id>[] {
  return ids.map((step, index) => {
    if (index < at) return { step, state: 'done' };
    if (index > at) return { step, state: 'pending' };
    return failure !== undefined ? { step, state: 'failed', failure } : { step, state: 'active' };
  });
}

/** The folder's last segment as the default name, sanitized; empty when nothing usable is left. */
function defaultName(root: string): string {
  const name = sanitizeRepositoryName(root.split(/[\\/]/).filter((segment) => segment !== '').pop() ?? '');
  return isRepositoryName(name) ? name : '';
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The create page's template HEAD holds (VS Code's PR_TEMPLATE_FILES; GitLab's Default.md); undefined when none, too long or unreadable. */
export async function mergeRequestTemplate(repo: { show(side: 'HEAD', relativePath: string): Promise<Buffer | 'tooLarge' | undefined> }, kind: ForgeKind, log: (line: string) => void): Promise<string | undefined> {
  try {
    for (const file of kind === 'github' ? GITHUB_TEMPLATE_FILES : GITLAB_TEMPLATE_FILES) {
      const bytes = await repo.show('HEAD', file);
      if (bytes === undefined) continue;
      const text = bytes === 'tooLarge' ? undefined : bytes.toString('utf8');
      if (text === undefined || text.length > MAX_TEMPLATE_CHARS) {
        log(`[forge] the template ${file} is over ${MAX_TEMPLATE_CHARS} characters; the create page opens without it`);
        return undefined;
      }
      return text;
    }
  } catch (err) {
    log(`[forge] reading the merge request template failed, so the create page opens without it: ${errorMessage(err)}`);
  }
  return undefined;
}

/** A pull or merge request's create page: from branch of forkPath into upstreamPath (its default branch unless targetBranch). */
export interface CreatePage {
  readonly repoId: string;
  readonly kind: ForgeKind;
  readonly serverId: string;
  readonly accountId: string;
  readonly upstreamPath: string;
  readonly forkPath: string;
  readonly branch: string;
  readonly targetBranch?: string;
}

export interface CreatePageDeps {
  readonly core: PublishFlowDeps['core'];
  readonly scm: Pick<ScmServiceClient, 'repository'>;
  readonly openOnServer: (url: string) => Promise<boolean>;
  readonly render: (text: LocalizedText) => string;
  readonly notify: { info(message: string): void; error(message: string): void };
  readonly log: (line: string) => void;
}

/** Opens the create page with the template HEAD holds through the guarded opener and tells the outcome (opened's text); never rejects. */
export async function openCreatePage(deps: CreatePageDeps, page: CreatePage, opened: (serverName: string) => LocalizedText): Promise<void> {
  const noLink = (): void => deps.notify.error(deps.render(l('Damocles cannot build a link for this repository.')));
  try {
    const ref = deps.scm.repository(page.repoId);
    const template = ref ? await mergeRequestTemplate(ref.repo, page.kind, deps.log) : undefined;
    const answer = await deps.core('forge openMergeRequest', (client) => client.forgeOpenMergeRequest({
      serverId: page.serverId,
      accountId: page.accountId,
      upstreamPath: page.upstreamPath,
      forkPath: page.forkPath,
      branch: page.branch,
      ...(page.targetBranch !== undefined ? { targetBranch: page.targetBranch } : {}),
      ...(template !== undefined ? { template } : {}),
    }));
    if ('unavailable' in answer) {
      deps.notify.error(deps.render(answer.unavailable));
      return;
    }
    if (!(await deps.openOnServer(answer.url))) {
      noLink();
      return;
    }
    deps.notify.info(deps.render(opened(answer.serverName)));
  } catch (err) {
    deps.log(`[forge] opening the create page failed: ${errorMessage(err)}`);
    noLink();
  }
}

export class PublishFlow {
  private readonly deps: PublishFlowDeps;
  private readonly publishes = new Map<string, PublishSession>();
  private readonly forks = new Map<string, ForkSession>();
  // ends the owner listings and the forks' polls when the window's forge host goes
  private readonly disposal = new AbortController();

  constructor(deps: PublishFlowDeps) {
    this.deps = deps;
  }

  // ---- Publish: a repository with no remote, while a Git hosting account exists

  /**
   * Opens the Publish dialog at once with each account's own namespace; the dialog asks for each account's organizations or
   * groups (publishOwners). noAccount when no signed-in account can publish (the caller keeps its zero-remote warning); closed
   * when the repository or its project is gone. A repository whose Publish dialog is open already gets no second one.
   */
  async publish(repoId: string, branch: string): Promise<'noAccount' | 'shown' | 'closed'> {
    if (!this.deps.scm.repository(repoId)) return 'closed';
    const { accounts } = await this.deps.core('forge publishAccounts', (client) => client.forgePublishAccounts());
    if (accounts.length === 0) return 'noAccount';
    const ref = this.deps.scm.repository(repoId);
    if (!ref) return 'closed';
    const project = this.deps.projectName(ref.projectKey);
    if (project === undefined) return 'closed';
    if ([...this.publishes.values()].some((open) => open.repoId === repoId)) {
      this.deps.log(`[forge] the Publish dialog of ${repoId} is open already; no second one is shown`);
      return 'shown';
    }
    const requestId = randomUUID();
    const request = parsePublishRequest({ requestId, project, branch, accounts, defaultOwner: accounts[0]!.personal.value, defaultName: defaultName(ref.repo.root) });
    if (!request) {
      this.deps.log('[forge] the Publish dialog is past the overlay bounds; nothing is shown');
      return 'noAccount';
    }
    const session: PublishSession = { repoId, projectKey: ref.projectKey, branch, shownBranch: request.dialog.branch, accounts: request.dialog.accounts, listings: new Map(), offered: new Map(), running: false, cancellable: false, cancelled: false, closed: false };
    this.publishes.set(requestId, session);
    void this.deps.ask(request).then(
      () => this.publishClosed(session),
      (err: unknown) => {
        this.deps.log(`[forge] the Publish dialog did not show: ${errorMessage(err)}`);
        this.deps.notify.error(this.deps.render(l('Publish could not open.')));
        this.publishClosed(session);
      },
    ).finally(() => this.publishes.delete(requestId));
    return 'shown';
  }

  /**
   * One account's organizations or groups for the open dialog of requestId. A newer request for the account aborts this one, as
   * the dialog's close aborts every one, and the abort reaches core's fetch; an aborted listing answers cancelled.
   */
  async publishOwners(requestId: string, accountId: string): Promise<PublishOwnersAnswer> {
    const session = this.publishes.get(requestId);
    if (!session || session.closed) return { status: 'cancelled' };
    const account = session.accounts.find((item) => item.accountId === accountId);
    if (!account) throw new Error('forge.publishOwners names an account the Publish dialog does not list');
    session.listings.get(accountId)?.abort();
    const listing = new AbortController();
    session.listings.set(accountId, listing);
    const failed = (): PublishOwnersAnswer => {
      session.offered.delete(accountId);
      return { status: 'error', message: dialogText(this.deps.render(l('Damocles could not list the organizations and groups of {0} on {1}.', account.login, account.serverName))) };
    };
    let answer: Awaited<ReturnType<CoreClient['forgePublishOwners']>>;
    try {
      answer = await this.deps.core('forge publishOwners', (client) => client.forgePublishOwners({ accountId }, AbortSignal.any([listing.signal, this.disposal.signal])));
    } catch (err) {
      // main's own abort (the dialog closed, or a newer request replaced this one), whichever error the request ended with
      if (listing.signal.aborted || this.disposal.signal.aborted) return { status: 'cancelled' };
      this.deps.log(`[forge] listing the owners of ${accountId} failed: ${errorMessage(err)}`);
      return failed();
    } finally {
      if (session.listings.get(accountId) === listing) session.listings.delete(accountId);
    }
    if (answer.status === 'cancelled' || listing.signal.aborted) return { status: 'cancelled' };
    if (answer.status === 'error') {
      session.offered.delete(accountId);
      return { status: 'error', message: dialogText(this.deps.render(answer.message)) };
    }
    const owners = parseOwners(answer.owners);
    if (!owners) {
      this.deps.log(`[forge] the owners of ${accountId} are past the overlay bounds; none are offered`);
      return failed();
    }
    session.offered.set(accountId, owners);
    return { status: 'loaded', owners, truncated: answer.truncated };
  }

  /** The dialog's submit: started, with the steps on the state pushes; ignored while one runs or once the dialog closed. */
  publishSubmit(requestId: string, owner: string, name: string, visibility: PublishVisibility): FlowStart {
    const session = this.publishes.get(requestId);
    if (!session || session.running || session.closed) return 'ignored';
    // an account's own namespace, or one its latest listing gave the dialog; core alone resolves the value for the server call
    const offered = (account: PublishAccount): readonly PublishNamespace[] => [account.personal, ...(session.offered.get(account.accountId) ?? [])];
    const account = session.accounts.find((item) => offered(item).some((namespace) => namespace.value === owner));
    const namespace = account && offered(account).find((item) => item.value === owner);
    if (!account || !namespace) throw new Error('forge.publishSubmit names an owner the dialog did not offer');
    session.running = true;
    session.cancellable = true;
    const target: PublishTarget = { serverName: account.serverName, path: `${namespace.path}/${sanitizeRepositoryName(name)}`, login: account.login, branch: session.shownBranch };
    void this.runPublish(requestId, session, target, { owner, name, visibility }).catch((err: unknown) => this.deps.log(`[forge] the publish failed: ${errorMessage(err)}`));
    return 'started';
  }

  private async runPublish(requestId: string, session: PublishSession, shown: PublishTarget, create: { readonly owner: string; readonly name: string; readonly visibility: PublishVisibility }): Promise<void> {
    const show = (state: PublishState): void => {
      session.last = state;
      if (!session.closed) this.deps.pushPublishState(state);
    };
    let target = shown;
    const fail = (at: number, failure: string): void => {
      show({ requestId, phase: 'failed', target, steps: steps(PUBLISH_STEPS, at, dialogText(failure)) });
      if (session.closed) this.deps.notify.error(failure);
    };
    show({ requestId, phase: 'running', target, steps: steps(PUBLISH_STEPS, 0), cancellable: true });
    // the create cannot be undone, so it runs only for the repository the dialog opened on, still without a remote
    let unchanged: boolean;
    try {
      unchanged = this.deps.scm.repository(session.repoId) !== undefined && (await this.deps.scm.remotes(session.repoId)).length === 0;
    } catch (err) {
      this.deps.log(`[forge] reading the remotes before the create failed: ${errorMessage(err)}`);
      unchanged = false;
    }
    if (!unchanged) {
      fail(0, this.deps.render(l('This repository changed since Publish opened.')));
      return;
    }
    if (session.cancelled) {
      this.deps.notify.info(this.deps.render(l('Publish canceled.')));
      return;
    }
    // the create is not aborted on Cancel: the server may have made the repository by then, and the user is told which
    let created: Awaited<ReturnType<CoreClient['forgeCreateRepository']>>;
    try {
      created = await this.deps.core('forge createRepository', (client) => client.forgeCreateRepository(create));
    } catch (err) {
      this.deps.log(`[forge] the create call failed: ${errorMessage(err)}`);
      fail(0, this.deps.render(l('{0} could not complete the request.', target.serverName)));
      return;
    }
    if (created.kind === 'refused') {
      session.running = false;
      if (session.cancelled) this.deps.notify.info(this.deps.render(l('Publish canceled.')));
      else show({ requestId, phase: 'refused', reason: dialogText(this.deps.render(created.reason)) });
      return;
    }
    if (created.kind === 'failed') {
      fail(0, this.deps.render(created.reason));
      return;
    }
    target = { ...target, path: created.path };
    if (created.kind === 'createdUnusable') {
      if (session.cancelled) this.deps.notify.info(this.deps.render(l('Publish canceled. {0} stays on {1}.', created.path, created.serverName)));
      else fail(1, this.deps.render(l('{0} exists on {1}, but Damocles cannot add it as origin: {2}', created.path, created.serverName, created.reason)));
      return;
    }
    if (session.cancelled) {
      this.deps.notify.info(this.deps.render(l('Publish canceled. {0} stays on {1}.', created.path, created.serverName)));
      return;
    }
    show({ requestId, phase: 'running', target, steps: steps(PUBLISH_STEPS, 1), cancellable: true });
    try {
      await this.deps.scm.addRemote(session.repoId, 'origin', created.url);
    } catch (err) {
      this.deps.log(`[forge] adding the published repository as origin failed: ${errorMessage(err)}`);
      fail(1, gitErrorText(err));
      return;
    }
    if (session.cancelled) {
      await this.removeOrigin(session.repoId);
      this.deps.notify.info(this.deps.render(l('Publish canceled. {0} stays on {1}.', created.path, created.serverName)));
      return;
    }
    session.cancellable = false;
    show({ requestId, phase: 'running', target, steps: steps(PUBLISH_STEPS, 2), cancellable: false });
    // the push authenticates as the chosen account: the binding is in place before git asks for a credential
    const unsaved = await this.bindForPush(session.projectKey, { serverId: created.serverId, accountId: created.accountId });
    if (unsaved !== undefined) {
      fail(2, unsaved);
      return;
    }
    try {
      await this.deps.scm.push(session.repoId, { remote: 'origin', branch: session.branch, setUpstream: true, followTags: false, force: false });
    } catch (err) {
      this.deps.log(`[forge] the publish push failed: ${errorMessage(err)}`);
      fail(2, err instanceof RemoteCancelledError ? this.deps.render(l('The push was canceled. {0} is origin; push again to publish {1}.', created.path, session.shownBranch)) : gitErrorText(err));
      return;
    }
    show({ requestId, phase: 'done', target, steps: steps(PUBLISH_STEPS, PUBLISH_STEPS.length) });
    if (session.closed) this.deps.notify.info(this.deps.render(l('Published {0}/{1}. This project now uses {2} on {3}.', created.serverName, created.path, created.login, created.serverName)));
  }

  private publishClosed(session: PublishSession): void {
    session.closed = true;
    for (const listing of session.listings.values()) listing.abort();
    session.listings.clear();
    if (session.running && session.cancellable) session.cancelled = true;
  }

  private async removeOrigin(repoId: string): Promise<void> {
    try {
      await this.deps.scm.removeRemote(repoId, 'origin');
    } catch (err) {
      this.deps.log(`[forge] removing the origin a canceled publish added failed: ${errorMessage(err)}`);
      this.deps.notify.error(this.deps.render(l('Damocles could not remove the origin remote it added: {0}', gitErrorText(err))));
    }
  }

  /** Binds the project to the account the push authenticates as; the failure text, or undefined once saved. */
  private async bindForPush(projectKey: string, bind: { readonly serverId: string; readonly accountId: string }): Promise<string | undefined> {
    try {
      const outcome = await this.deps.bind(projectKey, bind);
      if (outcome === 'saved') return undefined;
      if (outcome === 'unlisted') return this.deps.render(l('The project was removed, so nothing was pushed.'));
      return this.deps.render(l('Damocles could not save which account this project uses, so nothing was pushed. Settings › Models & accounts › Git hosting says why.'));
    } catch (err) {
      this.deps.log(`[forge] saving the account for the push failed: ${errorMessage(err)}`);
      return this.deps.render(l('Damocles could not save which account this project uses, so nothing was pushed.'));
    }
  }

  // ---- Fork on a denied push

  /**
   * A push of branch to remote failed. Only an authorization-class failure asks the server; the fork dialog opens only when the
   * server confirms the account can read but not push, and an organization's SSO or app policy shows its notice instead. False:
   * the caller shows the push's own failure.
   */
  async pushRefused(repoId: string, remote: string, branch: string, err: unknown): Promise<boolean> {
    if (pushFailureKind(err) !== 'authorization') return false;
    const ref = this.deps.scm.repository(repoId);
    if (!ref) return false;
    try {
      const endpoints = await this.deps.endpoints(repoId);
      const authority = ref.repo.authority;
      const renames = authority === 'local' || (this.deps.features(authority)?.includes(RENAME_REMOTE_FEATURE) ?? false);
      const plan = renames ? forkRemotePlan(remote, (await this.deps.scm.remotes(repoId)).map((item) => item.name)) : undefined;
      const noFork = !renames ? `${authority} cannot rename remotes; no fork is offered` : !plan ? `no fork is offered: the fork could not become origin beside the remotes of ${repoId}` : undefined;
      const endpoint = endpoints.find((item) => item.remote === remote);
      const location = endpoint?.push ?? endpoint?.fetch;
      // GitLab has no organization notice, so with no fork to follow its server is not asked
      if (noFork !== undefined && location !== undefined && this.deps.serverKind(location) === 'gitlab') {
        this.deps.log(`[forge] ${noFork}`);
        return false;
      }
      const access = await this.deps.core('forge pushAccess', (client) => client.forgePushAccess({ repo: { projectKey: ref.projectKey, authorityKey: authority, endpoints: [...endpoints] }, remote }, this.disposal.signal));
      if (access.access === 'orgAccess') {
        void this.deps.notify.warn(this.deps.render(access.text), this.deps.render(access.action)).then(async (chosen) => {
          if (!chosen) return;
          const opened = await this.deps.core('forge openOrgAccess', (client) => client.forgeOpenOrgAccess({ accountId: access.accountId, org: access.org }));
          if (!opened) this.deps.log('[forge] the organization page could not be opened');
        }).catch((failure: unknown) => this.deps.log(`[forge] the organization notice failed: ${errorMessage(failure)}`));
        return true;
      }
      if (access.access !== 'denied') return false;
      if (!plan) {
        this.deps.log(`[forge] ${noFork}`);
        return false;
      }
      const dialog: ForkDialog = { requestId: randomUUID(), serverName: access.serverName, kind: access.kind, path: access.path, login: access.login, branch, remote, upstreamName: plan.upstreamName, upstreamExists: plan.upstreamExists };
      const request = parseForkRequest(dialog);
      if (!request) return false;
      const controller = new AbortController();
      // the forge host's end aborts the fork while its dialog is open
      const open = new AbortController();
      this.disposal.signal.addEventListener('abort', () => controller.abort(), { once: true, signal: open.signal });
      const session: ForkSession = { repoId, projectKey: ref.projectKey, dialog: request.dialog, remote, branch, path: access.path, plan, serverId: access.serverId, accountId: access.accountId, controller, running: false, cancellable: false, closed: false };
      this.forks.set(dialog.requestId, session);
      void this.deps.ask(request).then(
        (answer) => this.forkClosed(session, answer),
        (failure: unknown) => {
          this.deps.log(`[forge] the fork dialog did not show: ${errorMessage(failure)}`);
          this.forkClosed(session, { kind: 'dismissed' });
        },
      ).finally(() => {
        open.abort();
        this.forks.delete(dialog.requestId);
      });
      return true;
    } catch (failure) {
      this.deps.log(`[forge] checking the refused push with the server failed: ${errorMessage(failure)}`);
      return false;
    }
  }

  /** Fork and Push: started, with the steps on the state pushes; ignored while one runs or once the dialog closed. */
  forkStart(requestId: string): FlowStart {
    const session = this.forks.get(requestId);
    if (!session || session.running || session.closed) return 'ignored';
    session.running = true;
    session.cancellable = true;
    void this.runFork(requestId, session).catch((err: unknown) => this.deps.log(`[forge] the fork failed: ${errorMessage(err)}`));
    return 'started';
  }

  /** Fork (cancellable), rename the pushed remote, add the fork as origin, push; a stop before the push restores the remotes. */
  private async runFork(requestId: string, session: ForkSession): Promise<void> {
    const { dialog, plan, repoId } = session;
    const show = (state: ForkState): void => {
      session.last = state;
      if (!session.closed) this.deps.pushForkState(state);
    };
    // the remote names before the fork, and whether a remote edit started, which a stop then undoes
    let before: readonly string[] = [];
    let edited = false;
    // the fork the server made, which a stop leaves there
    const server: { made?: string } = {};
    const stop = async (at: number, failure: string | undefined): Promise<void> => {
      const restoreFailure = edited ? await this.restore(repoId, plan, before) : undefined;
      const { made } = server;
      const stays = made === undefined ? undefined : this.deps.render(l('The fork {0} stays on {1}.', made, dialog.serverName));
      if (failure === undefined) {
        if (restoreFailure !== undefined) this.deps.notify.error(stays === undefined ? restoreFailure : `${restoreFailure} ${stays}`);
        else this.deps.notify.info(this.deps.render(made === undefined ? l('Fork canceled. Nothing changed on your remotes.') : l('Fork canceled. Your remotes are as they were; the fork {0} stays on {1}.', made, dialog.serverName)));
        return;
      }
      const text = [failure, restoreFailure, stays].filter((part) => part !== undefined).join(' ');
      show({ requestId, phase: 'failed', steps: steps(FORK_STEPS, at, dialogText(text)), ...(restoreFailure === undefined ? { restored: true } : { restored: false, restoreFailed: true }) });
      if (session.closed) this.deps.notify.error(text);
    };
    show({ requestId, phase: 'running', steps: steps(FORK_STEPS, 0), cancellable: true });
    // the server's fork cannot be undone, so it is made only while the remotes still allow the plan the dialog showed
    try {
      before = (await this.deps.scm.remotes(repoId)).map((item) => item.name);
    } catch (err) {
      this.deps.log(`[forge] reading the remotes before the fork failed: ${errorMessage(err)}`);
      return stop(0, gitErrorText(err));
    }
    if (forkRemotePlan(session.remote, before)?.upstreamName !== plan.upstreamName) {
      return stop(0, this.deps.render(l('The remotes of this repository changed since the dialog opened, so nothing was forked. Push again to start over.')));
    }
    if (session.controller.signal.aborted) return stop(0, undefined);
    let forked: Awaited<ReturnType<CoreClient['forgeFork']>>;
    try {
      forked = await this.deps.core('forge fork', (client) => client.forgeFork({ serverId: session.serverId, accountId: session.accountId, path: session.path }, session.controller.signal));
    } catch (err) {
      if (session.controller.signal.aborted) return stop(0, undefined);
      this.deps.log(`[forge] the fork failed: ${errorMessage(err)}`);
      return stop(0, this.deps.render(l('{0} could not complete the request.', dialog.serverName)));
    }
    // core never aborts the fork's POST, so a refusal can answer a fork already cancelled, which then made nothing
    if (forked.kind === 'failed') return stop(0, session.controller.signal.aborted ? undefined : this.deps.render(forked.reason));
    server.made = forked.path;
    if (forked.kind === 'cancelled' || session.controller.signal.aborted) return stop(0, undefined);
    session.forkPath = forked.path;
    const edit = async (at: number, work: () => Promise<void>): Promise<boolean> => {
      show({ requestId, phase: 'running', steps: steps(FORK_STEPS, at), cancellable: true });
      edited = true;
      try {
        await work();
      } catch (err) {
        this.deps.log(`[forge] a fork's remote step failed: ${errorMessage(err)}`);
        await stop(at, gitErrorText(err));
        return false;
      }
      if (!session.controller.signal.aborted) return true;
      await stop(at, undefined);
      return false;
    };
    if (!(await edit(1, () => this.deps.scm.renameRemote(repoId, plan.pushed, plan.upstreamName)))) return;
    if (!(await edit(2, () => this.deps.scm.addRemote(repoId, 'origin', forked.url)))) return;
    session.cancellable = false;
    show({ requestId, phase: 'running', steps: steps(FORK_STEPS, 3), cancellable: false });
    // the fork is the chosen account's: the push to it authenticates as that account
    const unsaved = await this.bindForPush(session.projectKey, { serverId: session.serverId, accountId: session.accountId });
    if (unsaved !== undefined) return stop(3, unsaved);
    try {
      await this.deps.scm.push(repoId, { remote: 'origin', branch: session.branch, setUpstream: true, followTags: false, force: false });
    } catch (err) {
      this.deps.log(`[forge] the push to the fork failed: ${errorMessage(err)}`);
      // the remotes keep the new layout: origin is the fork, the original keeps upstreamName
      const failure = err instanceof RemoteCancelledError ? this.deps.render(l('The push was canceled.')) : gitErrorText(err);
      show({ requestId, phase: 'failed', steps: steps(FORK_STEPS, 3, dialogText(failure)), restored: false });
      if (session.closed) this.deps.notify.error(failure);
      return;
    }
    show({
      requestId,
      phase: 'done',
      steps: steps(FORK_STEPS, FORK_STEPS.length),
      remotes: [{ name: 'origin', display: `${dialog.serverName}/${forked.path}` }, { name: plan.upstreamName, display: `${dialog.serverName}/${dialog.path}` }],
    });
    if (session.closed) this.deps.notify.info(this.deps.render(l('Pushed {0} to your fork {1} on {2}.', dialog.branch, forked.path, dialog.serverName)));
  }

  /**
   * Undoes what a stopped fork changed, in forkRestorePlan's order, judged from the remotes read now against before, so an edit
   * whose answer was lost is undone too; the failure text, or undefined once the remotes are as before.
   */
  private async restore(repoId: string, plan: ForkRemotePlan, before: readonly string[]): Promise<string | undefined> {
    const failed = (err: unknown): string => {
      this.deps.log(`[forge] restoring the remotes after a stopped fork failed: ${errorMessage(err)}`);
      return this.deps.render(l('Damocles could not put the remotes back as they were: {0}', gitErrorText(err)));
    };
    let now: ReadonlySet<string>;
    try {
      now = new Set((await this.deps.scm.remotes(repoId)).map((item) => item.name));
    } catch (err) {
      return failed(err);
    }
    const renamed = now.has(plan.upstreamName) && !before.includes(plan.upstreamName);
    for (const edit of forkRestorePlan(plan, { renamed, added: renamed && now.has(plan.pushed) })) {
      try {
        if (edit.op === 'remove') await this.deps.scm.removeRemote(repoId, edit.name);
        else await this.deps.scm.renameRemote(repoId, edit.from, edit.to);
      } catch (err) {
        return failed(err);
      }
    }
    return undefined;
  }

  private forkClosed(session: ForkSession, answer: OverlayAnswer): void {
    session.closed = true;
    // the question closed without Fork and Push: the push's own failure was not shown, so this says what happened
    if (!session.running) this.deps.notify.info(this.deps.render(l('Push not sent. Your commits are still on {0}.', session.dialog.branch)));
    if (session.running && session.cancellable) session.controller.abort();
    if (answer.kind === 'forgeFork' && session.last?.phase === 'done' && session.forkPath !== undefined) {
      const { dialog } = session;
      const forkPath = session.forkPath;
      void openCreatePage(this.deps, { repoId: session.repoId, kind: dialog.kind, serverId: session.serverId, accountId: session.accountId, upstreamPath: session.path, forkPath, branch: session.branch }, (serverName) => (dialog.kind === 'github'
        ? l('Opened the new pull request page on {0}, from {1}:{2} into {3}.', serverName, forkPath.split('/')[0]!, dialog.branch, dialog.path)
        : l('Opened the new merge request page on {0}, from {1}:{2} into {3}.', serverName, forkPath, dialog.branch, dialog.path)));
    }
  }

  dispose(): void {
    this.disposal.abort();
  }

  // ---- the overlay's channels (forge-overlay-channels.ts)

  isPublishOpen(requestId: string): boolean {
    return this.publishes.has(requestId);
  }

  isForkOpen(requestId: string): boolean {
    return this.forks.has(requestId);
  }
}
