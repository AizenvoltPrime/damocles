import { randomUUID } from 'node:crypto';
import type {
  ChooseAccountAnswer,
  ChooseAccountRequest,
  ChooseAccountRows,
  ForgeGitOperation,
  HostDefaultsView,
  RemoteEndpoint,
  RemoteLocation,
  RepoAccountOption,
  RepoAccountsView,
  RepoServerAccounts,
} from '../../../shared/forge/bindings';
import { ForgeFileBrokenError } from '../forge-file';
import { matchServer } from '../remote-url';
import type { AccountRecord, ForgeServer } from '../types';
import type { BindingStore } from './binding-store';
import { FAST_PATH_MS, pickByAccess, preselectOf, resolveWithoutAccess, singlePusher, type AccessChecker, type AccessOutcome, type Settled } from './resolve';

// A project's accounts per server (the account chip), the ask once before the user's own git operation (the Choose account
// dialog) and the host defaults, over the binding store and the access checker (docs/invariants.md "GitHub and GitLab accounts", resolution).

export interface RepoAccountsInput {
  readonly projectKey: string;
  readonly authorityKey: string;
  readonly project: string;
  /** The current branch's upstream remote; origin when absent. */
  readonly pushRemote?: string;
  readonly endpoints: readonly RemoteEndpoint[];
  /** The account chip's Try again: the access check runs again instead of reusing its last answer. */
  readonly recheck?: boolean;
}

export interface PrepareGitOperationInput {
  readonly operation: ForgeGitOperation;
  /** Absent for a clone, whose project does not exist yet. */
  readonly projectKey?: string;
  readonly authorityKey: string;
  readonly project: string;
  /** The remotes the operation reaches; empty: every remote. */
  readonly remotes: readonly string[];
  readonly endpoints: readonly RemoteEndpoint[];
}

export interface PrepareGitOperationResult {
  /** False: the user cancelled, and the git operation must not run. */
  readonly proceed: boolean;
  /** "Sign in with another account…" was picked for this server. */
  readonly signInServerId?: string;
  /** A clone's explicit choice, which main binds to the new project once it is added. */
  readonly bind?: { readonly serverId: string; readonly accountId: string | null };
}

/** The Choose account dialog as core reaches it: the CoreRequest forge.chooseAccount and its row updates. */
export interface ChooseAccountUi {
  choose(request: ChooseAccountRequest, signal: AbortSignal): Promise<ChooseAccountAnswer>;
  rows(rows: ChooseAccountRows): void;
}

/** A credential request's Choose account dialog: the server, the repository path git sent and the project it maps to. */
export interface CredentialAskInput {
  readonly projectKey?: string;
  readonly authorityKey: string;
  readonly project: string;
  readonly server: ForgeServer;
  readonly repoPath: string;
}

/** An account id or null (Git's own credentials); cancelled; or "Sign in with another account…". */
export type CredentialAsked = { readonly kind: 'chosen'; readonly accountId: string | null } | { readonly kind: 'cancelled' } | { readonly kind: 'signInAnother' };

export interface BindingsChange {
  readonly projectKeys?: readonly string[];
  // operation: the git operation the choice runs; absent for a credential request's choice, which names none
  readonly chosen?: { readonly projectKey: string; readonly serverId: string; readonly accountId: string | null; readonly operation?: ForgeGitOperation };
}

export interface ProjectAccountsDeps {
  readonly servers: () => readonly ForgeServer[];
  readonly accounts: () => readonly AccountRecord[];
  readonly bindings: BindingStore;
  readonly checker: AccessChecker;
  /** The account's line without access facts: id, login, name, avatar key, needsSignIn. */
  readonly option: (account: AccountRecord) => RepoAccountOption;
  /** Core has read its forge files; false: the files could not be read at all. */
  readonly ready: () => 'loading' | 'ready' | 'failed';
  readonly changed: (change: BindingsChange) => void;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

export interface ProjectAccounts {
  repoAccounts(input: RepoAccountsInput): Promise<RepoAccountsView>;
  bindAccount(projectKey: string, serverId: string, accountId: string | null): Promise<boolean>;
  hostDefaults(authorityKey: string): HostDefaultsView;
  setHostDefault(authorityKey: string, serverId: string, accountId: string | null): Promise<boolean>;
  prepareGitOperation(input: PrepareGitOperationInput, ui: ChooseAccountUi, signal: AbortSignal): Promise<PrepareGitOperationResult>;
  /** The Choose account dialog for a git credential request nothing else settled; the choice is bound to projectKey when there is one. */
  askForCredential(input: CredentialAskInput, ui: ChooseAccountUi, signal: AbortSignal): Promise<CredentialAsked>;
  forgetProject(projectKey: string): Promise<void>;
  forgetHost(authorityKey: string): Promise<void>;
  /** Drops the bindings and host defaults of every remote authority outside kept; answers the authorities dropped. */
  keepHosts(kept: ReadonlySet<string>): Promise<readonly string[]>;
}

interface ServerGroup {
  readonly server: ForgeServer;
  readonly remotes: string[];
  repoPath: string;
  usernameHint?: string;
  isPush: boolean;
}

/** The managed servers the endpoints reach: pushes by each remote's push URL, fetches by its fetch URL. */
function groupsOf(endpoints: readonly RemoteEndpoint[], servers: readonly ForgeServer[], use: 'push' | 'fetch' | 'both', pushRemote: string | undefined): ServerGroup[] {
  const groups = new Map<string, ServerGroup>();
  for (const endpoint of endpoints) {
    const locations: RemoteLocation[] = [];
    const pushTo = endpoint.push ?? endpoint.fetch;
    if (use !== 'fetch' && pushTo) locations.push(pushTo);
    if (use !== 'push' && endpoint.fetch && !locations.includes(endpoint.fetch)) locations.push(endpoint.fetch);
    for (const location of locations) {
      const match = matchServer(location, servers);
      if (!match) continue;
      const isPush = endpoint.remote === pushRemote && location === pushTo;
      const group = groups.get(match.server.id);
      if (!group) {
        groups.set(match.server.id, { server: match.server, remotes: [endpoint.remote], repoPath: match.repoPath, ...(location.usernameHint !== undefined ? { usernameHint: location.usernameHint } : {}), isPush });
        continue;
      }
      if (!group.remotes.includes(endpoint.remote)) group.remotes.push(endpoint.remote);
      if (isPush && !group.isPush) {
        group.isPush = true;
        group.repoPath = match.repoPath;
      }
      if (group.usernameHint === undefined && location.usernameHint !== undefined) group.usernameHint = location.usernameHint;
    }
  }
  return [...groups.values()].sort((a, b) => Number(b.isPush) - Number(a.isPush) || a.server.id.localeCompare(b.server.id));
}

function withAccess(option: RepoAccountOption, outcome: AccessOutcome | undefined): RepoAccountOption {
  switch (outcome?.kind) {
    case 'checked': return { ...option, canPush: outcome.canPush, owner: outcome.owner };
    case 'ssoRequired': return { ...option, ssoRequired: true };
    case 'appNotApproved': return { ...option, appNotApproved: true };
    default: return option;
  }
}

export function createProjectAccounts(deps: ProjectAccountsDeps): ProjectAccounts {
  const serverAccounts = (serverId: string): AccountRecord[] => deps.accounts().filter((account) => account.serverId === serverId);

  function viewOf(group: ServerGroup, accounts: readonly AccountRecord[], settled: Settled | undefined, outcomes: ReadonlyMap<string, AccessOutcome | undefined>, checkFailed: boolean): RepoServerAccounts {
    const options = accounts.map((account) => withAccess(deps.option(account), outcomes.get(account.id) ?? deps.checker.cached(account.id, group.repoPath)));
    const base = { serverId: group.server.id, server: group.server.id, kind: group.server.kind, remotes: [...group.remotes], isPush: group.isPush, repoPath: group.repoPath, accounts: options, ...(checkFailed ? { checkFailed } : {}) };
    if (settled?.account === null) return { ...base, state: 'ownCredentials' };
    if (accounts.length === 0) return { ...base, state: 'signIn' };
    if (!settled) return { ...base, state: 'choose' };
    const account = options.find((option) => option.id === settled.account!.id)!;
    const state = account.needsSignIn ? 'signInAgain' : settled.how === 'bound' || settled.how === 'hostDefault' ? 'chosen' : 'auto';
    return { ...base, state, how: settled.how, account };
  }

  async function serverView(group: ServerGroup, input: RepoAccountsInput): Promise<RepoServerAccounts> {
    const accounts = serverAccounts(group.server.id);
    const target = { projectKey: input.projectKey, authorityKey: input.authorityKey, server: group.server, ...(group.usernameHint !== undefined ? { usernameHint: group.usernameHint } : {}) };
    const settled = resolveWithoutAccess(target, accounts, deps.bindings);
    if (accounts.length === 0) return viewOf(group, accounts, settled, new Map(), false);
    // the menu's "can push" hints and the account chip's check failure need the check even where an earlier step settled the account
    const running = deps.checker.run(accounts.filter((account) => !deps.option(account).needsSignIn), group.server, group.repoPath, input.recheck === true);
    const outcomes = new Map<string, AccessOutcome>();
    await Promise.all([...running].map(async ([accountId, outcome]) => outcomes.set(accountId, await outcome)));
    const checkFailed = [...outcomes.values()].some((outcome) => outcome.kind === 'unreachable');
    if (settled) return viewOf(group, accounts, settled, outcomes, checkFailed);
    const checkable = accounts.filter((account) => outcomes.has(account.id));
    const picked = pickByAccess(checkable, outcomes);
    return viewOf(group, accounts, picked ? { how: 'access', account: picked } : undefined, outcomes, checkFailed);
  }

  // operation: the git operation the choice goes on to run, which the binding's announcement names; undefined for a credential
  // request, which does not say whether git fetches or pushes
  async function ask(group: ServerGroup, accounts: readonly AccountRecord[], input: PrepareGitOperationInput, ui: ChooseAccountUi, signal: AbortSignal, operation: ForgeGitOperation | undefined): Promise<(PrepareGitOperationResult & { readonly chosen?: string | null }) | undefined> {
    const checkable = accounts.filter((account) => !deps.option(account).needsSignIn);
    const running = deps.checker.run(checkable, group.server, group.repoPath, false);
    const outcomes = new Map<string, AccessOutcome | undefined>(accounts.map((account) => [account.id, running.has(account.id) ? undefined : { kind: 'signInAgain' }]));
    const settledAll = Promise.all([...running].map(async ([accountId, outcome]) => outcomes.set(accountId, await outcome)));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([settledAll, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FAST_PATH_MS);
    })]);
    clearTimeout(timer);
    if (singlePusher(accounts, outcomes)) return undefined;

    const requestId = randomUUID();
    let open = true;
    const rows = (): ChooseAccountRows => {
      const preselectId = preselectOf(accounts, outcomes);
      return {
        requestId,
        accounts: accounts.map((account) => {
          const outcome = outcomes.get(account.id);
          return outcome === undefined ? { ...deps.option(account), checking: true } : withAccess(deps.option(account), outcome);
        }),
        checking: [...outcomes.values()].some((outcome) => outcome === undefined),
        ...(preselectId !== undefined ? { preselectId } : {}),
      };
    };
    for (const outcome of running.values()) {
      void outcome.then(() => {
        if (open) ui.rows(rows());
      });
    }
    let answer: ChooseAccountAnswer;
    try {
      answer = await ui.choose({ ...rows(), ...(input.projectKey !== undefined ? { projectKey: input.projectKey } : {}), project: input.project, serverId: group.server.id, server: group.server.id, kind: group.server.kind, repoPath: group.repoPath, operation: input.operation }, signal);
    } finally {
      open = false;
    }
    if (answer.kind === 'cancelled') return { proceed: false };
    if (answer.kind === 'signInAnother') return { proceed: false, signInServerId: group.server.id };
    const { accountId } = answer;
    if (accountId !== null && !accounts.some((account) => account.id === accountId)) throw new Error('The answer names an account of another server');
    if (input.projectKey === undefined) return { proceed: true, bind: { serverId: group.server.id, accountId }, chosen: accountId };
    try {
      await deps.bindings.bind(input.projectKey, group.server.id, accountId, deps.now());
    } catch (err) {
      // the choice still answers this operation; the Git hosting section's banner already says changes are not saved
      if (!(err instanceof ForgeFileBrokenError)) throw err;
      deps.log(`[forge] the choice for ${group.server.id} was not remembered: ${err.message}`);
      return { proceed: true, chosen: accountId };
    }
    deps.changed({ projectKeys: [input.projectKey], chosen: { projectKey: input.projectKey, serverId: group.server.id, accountId, ...(operation !== undefined ? { operation } : {}) } });
    return { proceed: true, chosen: accountId };
  }

  async function saved(what: string, work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (err) {
      if (!(err instanceof ForgeFileBrokenError)) throw err;
      deps.log(`[forge] ${what} was not saved: ${err.message}`);
      return false;
    }
  }

  return {
    async repoAccounts(input) {
      const groups = groupsOf(input.endpoints, deps.servers(), 'both', input.pushRemote ?? 'origin');
      if (!groups.some((group) => group.isPush) && groups[0]) groups[0].isPush = true;
      return { projectKey: input.projectKey, project: input.project, servers: await Promise.all(groups.map((group) => serverView(group, input))) };
    },

    async bindAccount(projectKey, serverId, accountId) {
      if (!deps.servers().some((server) => server.id === serverId)) throw new Error('No such server');
      if (accountId !== null && !serverAccounts(serverId).some((account) => account.id === accountId)) throw new Error('No such account on the server');
      const done = await saved(`the binding of ${serverId}`, () => deps.bindings.bind(projectKey, serverId, accountId, deps.now()));
      if (done) deps.changed({ projectKeys: [projectKey] });
      return done;
    },

    hostDefaults(authorityKey) {
      const ready = deps.ready();
      if (ready === 'loading') return { state: 'loading' };
      if (ready === 'failed') return { state: 'error' };
      const defaults = deps.bindings.hostDefaults(authorityKey);
      const servers = deps.servers().flatMap((server) => {
        const accounts = serverAccounts(server.id);
        if (accounts.length === 0) return [];
        const chosen = defaults[server.id];
        return [{
          serverId: server.id,
          server: server.id,
          kind: server.kind,
          gitHosts: [...server.record.gitHosts],
          accounts: accounts.map((account) => {
            const { avatarKey } = deps.option(account);
            return { id: account.id, login: account.login, ...(avatarKey !== undefined ? { avatarKey } : {}) };
          }),
          ...(chosen !== undefined && accounts.some((account) => account.id === chosen) ? { defaultAccountId: chosen } : {}),
        }];
      });
      return { state: 'ready', servers };
    },

    async setHostDefault(authorityKey, serverId, accountId) {
      if (authorityKey === 'local') throw new Error('Host defaults are for remote hosts');
      if (!deps.servers().some((server) => server.id === serverId)) throw new Error('No such server');
      if (accountId !== null && !serverAccounts(serverId).some((account) => account.id === accountId)) throw new Error('No such account on the server');
      const done = await saved(`the default of ${authorityKey} on ${serverId}`, () => deps.bindings.setHostDefault(authorityKey, serverId, accountId));
      if (done) deps.changed({});
      return done;
    },

    async prepareGitOperation(input, ui, signal) {
      const use = input.operation === 'push' || input.operation === 'publish' ? 'push' : 'fetch';
      const endpoints = input.remotes.length === 0 ? input.endpoints : input.endpoints.filter((endpoint) => input.remotes.includes(endpoint.remote));
      let bind: PrepareGitOperationResult['bind'];
      for (const group of groupsOf(endpoints, deps.servers(), use, undefined)) {
        const accounts = serverAccounts(group.server.id);
        if (accounts.length === 0) continue;
        const target = { ...(input.projectKey !== undefined ? { projectKey: input.projectKey } : {}), authorityKey: input.authorityKey, server: group.server, ...(group.usernameHint !== undefined ? { usernameHint: group.usernameHint } : {}) };
        if (resolveWithoutAccess(target, accounts, deps.bindings)) continue;
        const asked = await ask(group, accounts, input, ui, signal, input.operation);
        if (!asked) continue;
        if (!asked.proceed) return { proceed: false, ...(asked.signInServerId !== undefined ? { signInServerId: asked.signInServerId } : {}) };
        bind = asked.bind ?? bind;
      }
      return { proceed: true, ...(bind ? { bind } : {}) };
    },

    async askForCredential(input, ui, signal) {
      const accounts = serverAccounts(input.server.id);
      const group: ServerGroup = { server: input.server, remotes: [], repoPath: input.repoPath, isPush: true };
      // git's credential request does not say whether it fetches or pushes
      const asked = await ask(group, accounts, { operation: 'push', ...(input.projectKey !== undefined ? { projectKey: input.projectKey } : {}), authorityKey: input.authorityKey, project: input.project, remotes: [], endpoints: [] }, ui, signal, undefined);
      if (!asked) {
        // the access check singled out one account since the request's own check: it answers, as resolution would
        const again = deps.checker.run(accounts.filter((account) => !deps.option(account).needsSignIn), input.server, input.repoPath, false);
        const outcomes = new Map<string, AccessOutcome | undefined>();
        await Promise.all([...again].map(async ([accountId, outcome]) => outcomes.set(accountId, await outcome)));
        const pusher = singlePusher(accounts.filter((account) => outcomes.has(account.id)), outcomes);
        return pusher ? { kind: 'chosen', accountId: pusher.id } : { kind: 'cancelled' };
      }
      if (asked.signInServerId !== undefined) return { kind: 'signInAnother' };
      if (!asked.proceed || asked.chosen === undefined) return { kind: 'cancelled' };
      return { kind: 'chosen', accountId: asked.chosen };
    },

    async forgetProject(projectKey) {
      await deps.bindings.forgetProject(projectKey);
      deps.changed({ projectKeys: [projectKey] });
    },

    async forgetHost(authorityKey) {
      await deps.bindings.forgetHost(authorityKey);
      deps.changed({});
    },

    async keepHosts(kept) {
      const dropped = await deps.bindings.keepHosts(kept);
      if (dropped.length > 0) deps.changed({});
      return dropped;
    },
  };
}
