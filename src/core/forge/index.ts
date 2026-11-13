import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { SecretsStore } from '../../platform/secrets-store';
import type { SettingsStore } from '../../platform/settings-store';
import type {
  ForgeAccountsState,
  ForgeAccountSummary,
  ForgeKind,
  ForgeNotice,
  ForgeServerFormField,
  ForgeServerSummary,
  ForgeSignInRoute,
  ForgeSignInState,
} from '../../shared/forge/accounts';
import type { HostDefaultsView, RepoAccountOption, RepoAccountsView } from '../../shared/forge/bindings';
import type { LocalizedText } from '../../shared/localized-text';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { ProviderSignInError } from '../../shared/types/settings';
import { l } from '../l10n';
import type { GuardedFetch } from '../pi-session/web-access/safe-fetch';
import { createAccountStore } from './accounts/account-store';
import { assertWritable, createAccounts, type Accounts } from './accounts/accounts';
import { createRefresher, type Refresher } from './accounts/refresh';
import { createTokenStore } from './accounts/token-store';
import { avatarKey, fetchAvatar, type Avatar } from './avatars';
import { createBindingStore, type BindingStore } from './bindings/binding-store';
import {
  createProjectAccounts,
  type BindingsChange,
  type ChooseAccountUi,
  type PrepareGitOperationInput,
  type PrepareGitOperationResult,
  type ProjectAccounts,
  type RepoAccountsInput,
} from './bindings/project-accounts';
import { createAccessChecker, pickByAccess, resolveWithoutAccess, type AccessOutcome } from './bindings/resolve';
import { createCredentialPolicy, type AccessPick, type CredentialChoice, type CredentialContext, type CredentialPolicy, type CredentialResult, type ShellRefusal } from './credentials';
import type { Delegator } from './delegate';
import { knownSecrets } from './known-secrets';
import type { GitCredentialOrigin, GitCredentialRequest } from '../../shared/git-credential';
import type { TokenStore } from './accounts/token-store';
import { ForgeFileBrokenError } from './forge-file';
import { createForgeHttp, type ForgeHttp } from './http';
import { REGISTERED_REDIRECT_URI } from './oauth/loopback-receiver';
import { providerFor, type OrgAccessFinding } from './providers/provider';
import { createServerRegistry, type ServerEdit, type ServerFormOutcome, type ServerInput, type ServerRegistry } from './servers';
import { createForgeTools, type ForgeTools } from './tools/run';
import { checkedRepoPath } from './tools/api';
import { buildLink } from './links';
import { createClonePicker, type ClonePicker } from './clone-picker';
import { createPublisher, type Publisher } from './publish';
import type { ForgeLinkTarget } from '../../shared/forge/links';
import { createCiWatcher, type CiChangedEvent, type CiRepo, type CiResolution, type CiWatcher } from './ci-watch';
import { createBranchProtectionCache, type BranchProtectionCache, type ProtectionRepo, type PushProtection } from './branch-protection';
import type { RemoteBranchProtection } from '../../shared/forge/branch-protection';
import type { AuthorAvatars, ContainingChange, HistoryAuthor, HistoryForgeContext } from '../../shared/forge/history';
import { createHistoryDetails, type HistoryDetails } from './history';
import { githubCi } from './ci-github';
import { gitlabCi } from './ci-gitlab';
import { repoOnServer, type RemoteOrder } from './remote-url';
import type { ForgeApprovalAnswer, ForgeTarget, ForgeToolAnswer, ForgeToolRequest } from '../../shared/forge/tools';
import {
  FORGE_AGENT_READ_ANY_REPOSITORY_SETTING,
  FORGE_BRANCH_PROTECTION_SETTING,
  FORGE_CI_STATUS_SETTING,
  FORGE_CLONE_PROTOCOL_SETTING,
  FORGE_SHOW_AVATARS_SETTING,
  ForgeHttpError,
  ForgeSignInError,
  type AccountRecord,
  type ForgeBuildOAuth,
  type ForgeServer,
  type ForgeServerOverride,
} from './types';

// The Git hosting accounts of this computer's Damocles Core (docs/invariants.md "GitHub and GitLab accounts"). It runs only
// in the local desktop core; tokens never leave it except through the routes that section lists.

const ORG_ACCESS_MAX_AGE_MS = 60 * 60_000;
const VERSION_MAX_AGE_MS = 24 * 60 * 60_000;

/** What core posts to every chat and settings view. */
export type ForgeViewMessage = Extract<ExtensionToWebviewMessage, { type: 'forgeAccountsChanged' | 'forgeSignInState' }>;

/** The forge mirror main reads: managed servers and the avatar keys it may serve, never a login or a token. */
export interface ForgeMirror {
  readonly servers: readonly { readonly id: string; readonly kind: ForgeKind; readonly webUrl: string; readonly gitHosts: readonly string[]; readonly hasAccount: boolean }[];
  readonly avatarKeys: readonly string[];
}

export type ForgeOpenPage =
  | { readonly page: 'signIn'; readonly serverId: string }
  | { readonly page: 'token'; readonly serverId: string }
  | { readonly page: 'orgAccess'; readonly accountId: string; readonly org: string }
  | { readonly page: 'revoke'; readonly noticeId: string };

export type ServerFormResult = { readonly ok: true; readonly serverId: string } | { readonly ok: false; readonly field?: ForgeServerFormField; readonly message: LocalizedText };

/** What sign-out, the agent shells switch and Show file answer; a refusal names why in the view's language. */
export type ForgeActionResult = { readonly ok: true } | { readonly ok: false; readonly message: LocalizedText };

export interface ForgeSignInRequest {
  readonly serverId: string;
  readonly route: ForgeSignInRoute;
  readonly token?: string;
  readonly agentShells: boolean;
  readonly reauthAccountId?: string;
}

/** work's answer, or signal's reason once it aborts; the access check it waits on runs on for its other callers and is kept. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** What answering git's credential requests needs of the host: delegation, and the projects as source control knows them. */
export interface ForgeGitHost {
  readonly delegator: Delegator;
  /** The project of authorityKey (this computer's: 'local') whose repository has a remote on server at repoPath. */
  readonly projectByRemote: (authorityKey: string, server: ForgeServer, repoPath: string, cwd: string, signal: AbortSignal) => Promise<string | undefined>;
  readonly projectHolding: (authorityKey: string, cwd: string) => string | undefined;
  /** The project's name as the Choose account dialog's where-line shows it. */
  readonly projectLabel: (projectKey: string | undefined) => string;
  readonly ui: ChooseAccountUi;
}

/** Where an agent shell's or a tool's refusal was shown, for its notice's actions; org: the organization the account is kept out of. */
export interface RecordedRefusal {
  readonly projectKey?: string;
  readonly serverId: string;
  readonly accountId?: string;
  readonly org?: string;
}

/** A refusal as its chat shows it: the project by the name the Choose account dialog's where-line uses, '' outside a project. */
export type ShownRefusal = ShellRefusal & { readonly projectLabel: string };

const MAX_REFUSALS_PER_PANEL = 50;

export interface ForgeServiceDeps {
  /** <userData>/forge (CoreInit.paths.forge). */
  readonly forgeDir: string;
  readonly secrets: SecretsStore;
  readonly settings: Pick<SettingsStore, 'get' | 'onDidChange'>;
  readonly fetch: typeof fetch;
  readonly userAgent: string;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly writeClipboard: (text: string) => Promise<void>;
  readonly revealPath: (absolutePath: string) => Promise<void>;
  readonly buildOAuth: ForgeBuildOAuth;
  readonly overrides?: Readonly<Partial<Record<'github.com' | 'gitlab.com', ForgeServerOverride>>>;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  /** Reaches any origin but a server's own; the SSRF guard's fetch by default. */
  readonly publicFetch?: GuardedFetch;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ForgeService {
  load(): Promise<void>;
  /** Settles once load() read the forge files or failed to, before it reads any account's secret. */
  filesRead(): Promise<void>;
  state(): ForgeAccountsState;
  /** The single publisher of forgeAccountsChanged: to `to` alone (a view that asked), else to every listener. */
  publish(to?: (message: ForgeViewMessage) => void): void;
  /** Posts each running or settled sign-in's state to a view that (re)mounted. */
  postSignInStates(to: (message: ForgeViewMessage) => void): void;
  onMessage(listener: (message: ForgeViewMessage) => void): Disposable;
  /** Fires after every publish to all listeners; the forge mirror and the Tools status follow it. */
  onChange(listener: () => void): Disposable;
  mirror(): ForgeMirror;
  signIn(request: ForgeSignInRequest): Promise<void>;
  cancelSignIn(serverId: string): Promise<void>;
  signOut(accountId: string): Promise<ForgeActionResult>;
  setAgentShells(accountId: string, agentShells: boolean): Promise<ForgeActionResult>;
  addServer(input: ServerInput): Promise<ServerFormResult>;
  editServer(serverId: string, edit: ServerEdit): Promise<ServerFormResult>;
  removeServer(serverId: string): Promise<ServerFormResult>;
  /** A host learned from the server's clone URLs becomes one of its git hosts, after the claimed-host checks. */
  confirmGitHost(serverId: string, host: string): Promise<ServerFormResult>;
  /** A learned host is dropped and not proposed again. */
  dismissGitHost(serverId: string, host: string): Promise<ServerFormResult>;
  revealBrokenFile(): Promise<ForgeActionResult>;
  openPage(target: ForgeOpenPage): Promise<boolean>;
  copySignInCode(serverId: string): Promise<boolean>;
  copyRedirectUri(kind: ForgeKind, serverId?: string): Promise<boolean>;
  dismissNotice(noticeId: string): void;
  /** Settings opened: stale versions (a day) and GitHub organization access (an hour) are read again. */
  settingsOpened(): Promise<void>;
  avatar(key: string): Promise<Avatar | undefined>;
  /** The account chip: the project's servers and how each account was settled; undefined until the forge files are read. */
  repoAccounts(input: RepoAccountsInput): Promise<RepoAccountsView | undefined>;
  /** The chip's choice; false: bindings.json does not parse, so nothing was saved. */
  bindAccount(projectKey: string, serverId: string, accountId: string | null): Promise<boolean>;
  hostDefaults(authorityKey: string): HostDefaultsView;
  setHostDefault(authorityKey: string, serverId: string, accountId: string | null): Promise<boolean>;
  /** Before the user's own git operation: resolves each server it reaches and asks once (the Choose account dialog) where nothing settles it. */
  prepareGitOperation(input: PrepareGitOperationInput, ui: ChooseAccountUi, signal: AbortSignal): Promise<PrepareGitOperationResult>;
  forgetProject(projectKey: string): Promise<void>;
  forgetHost(authorityKey: string): Promise<void>;
  /** Drops the bindings and host defaults of every remote authority not in authorityKeys, once the forge files were read. */
  keepHosts(authorityKeys: readonly string[]): Promise<void>;
  /** A binding or host default changed. */
  onBindingsChanged(listener: (change: BindingsChange) => void): Disposable;
  /** The servers with an account whose takeover a git call of projectKey gets: none bound to Git's own credentials there. */
  managedServers(projectKey?: string): readonly { readonly webUrl: string; readonly gitHosts: readonly string[] }[];
  /** Connects git's credential requests to the host; until then gitCredential rejects. */
  connectGit(host: ForgeGitHost): void;
  /** One git credential request, answered by the policy in credentials.ts. */
  gitCredential(request: GitCredentialRequest, origin: GitCredentialOrigin, context: CredentialContext, signal: AbortSignal): Promise<CredentialResult>;
  /** An agent shell was refused credentials: the chat it ran in shows the refused notice. */
  onShellRefused(listener: (refusal: ShownRefusal) => void): Disposable;
  /** The notice a panel showed under toolCallId, for its actions; a panel not in livePanels closed, and its notices go. */
  recordRefusal(panelId: string, toolCallId: string, refusal: RecordedRefusal, livePanels: ReadonlySet<string>): void;
  refusalOf(panelId: string, toolCallId: string): RecordedRefusal | undefined;
  /** One agent tool call on a chat's repository (docs/invariants.md "GitHub and GitLab accounts", agent tools). */
  agentTool(request: ForgeToolRequest, signal: AbortSignal): Promise<ForgeToolAnswer>;
  /** A write's approval card and option 2's rule, resolved before its prompt shows. */
  agentToolApproval(request: ForgeToolRequest, signal: AbortSignal): Promise<ForgeApprovalAnswer>;
  /** The call's target as a settings rule names it, before the gate matches the rules. */
  agentToolTarget(request: ForgeToolRequest, signal: AbortSignal): Promise<{ readonly ok: true; readonly project: string; readonly target: ForgeTarget } | { readonly ok: false; readonly answer: ForgeToolAnswer }>;
  /** Whether any account exists: the agent tools are loadable only then. */
  hasAccount(): boolean;
  /** CI of projects' repositories: the chip, the job list, the job log tab and commit details (ci-watch.ts). */
  readonly ci: CiWatcher;
  /** A file or commit address of a repository on the managed server a remote points at, and that remote (links.ts); unavailable says why not. */
  link(repo: CiRepo, target: ForgeLinkTarget): { readonly url: string; readonly serverName: string; readonly remote: string } | { readonly unavailable: LocalizedText };
  /** The clone picker's listings, row keys and clone addresses (clone-picker.ts). */
  readonly clone: ClonePicker;
  /** Publish and fork on a denied push (publish.ts); each waits for the forge files, as the clone picker's accounts do. */
  readonly publishing: Publisher;
  onCiChanged(listener: (event: CiChangedEvent) => void): Disposable;
  /** The server branch protection held for the repository's remotes, answered at once (branch-protection.ts). */
  branchProtection(repo: ProtectionRepo): readonly RemoteBranchProtection[];
  /** Whether the server protects a refused push's branch for the push's account (branch-protection.ts). */
  pushProtection(repo: ProtectionRepo, remote: string, branch: string, signal: AbortSignal): Promise<PushProtection>;
  /** History details (history.ts): the repository's server, one page's author pictures, a commit's merged change. */
  historyContext(repo: CiRepo): HistoryForgeContext | null;
  authorAvatars(repo: CiRepo, authors: readonly HistoryAuthor[], signal: AbortSignal): Promise<AuthorAvatars>;
  containingChange(repo: CiRepo, sha: string, signal: AbortSignal): Promise<ContainingChange | null>;
  /** The author picture keys main may serve, apart from the mirror's account keys so a new page does not refresh every view. */
  authorAvatarKeys(): readonly string[];
  onAuthorAvatarKeys(listener: () => void): Disposable;
  dispose(): void;
}

interface SignInFlow {
  readonly serverId: string;
  readonly abort: AbortController;
  state: ForgeSignInState;
  /** The authorize page the browser route opened. */
  pageUrl?: string;
  run?: Promise<void>;
}

interface StoredNotice extends ForgeNotice {
  readonly page: string;
}

const cancelledError = (): ProviderSignInError => ({ kind: 'cancelled', message: l('Sign-in cancelled.') });

function signInFailure(err: unknown, server: string, aborted: boolean): ProviderSignInError {
  if (aborted) return cancelledError();
  if (err instanceof ForgeSignInError) return { kind: err.kind, message: err.text };
  if (err instanceof ForgeFileBrokenError) return { kind: 'provider', message: l('Damocles could not save the account because {0} does not parse.', path.basename(err.filePath)) };
  if (err instanceof ForgeHttpError) {
    switch (err.kind) {
      case 'network': return { kind: 'network', message: l('Could not reach {0}. Check the connection and try again.', server) };
      case 'tls': return { kind: 'network', message: l('{0} presented a certificate this computer does not trust.', server) };
      case 'rateLimited': return { kind: 'provider', message: l('{0} is limiting requests. Try again in a few minutes.', server) };
      case 'unauthorized': return { kind: 'provider', message: l('{0} refused the sign-in. Start it again.', server) };
      default: return err.status !== undefined
        ? { kind: 'provider', message: l('{0} could not complete the sign-in (HTTP {1}).', server, err.status), status: err.status }
        : { kind: 'provider', message: l('{0} could not complete the sign-in.', server) };
    }
  }
  return { kind: 'provider', message: l('{0} could not complete the sign-in.', server) };
}

function formResult(outcome: ServerFormOutcome): ServerFormResult {
  return outcome.ok ? { ok: true, serverId: outcome.server.id } : { ok: false, field: outcome.field, message: outcome.message };
}

function errorName(err: unknown): string {
  if (err instanceof ForgeHttpError) return `${err.name} ${err.kind}`;
  return err instanceof Error ? err.name : typeof err;
}

export function createForgeService(deps: ForgeServiceDeps): ForgeService {
  const now = deps.now ?? Date.now;
  const { log } = deps;
  const tokens = maskedTokens(createTokenStore(deps.secrets, log));
  const servers: ServerRegistry = createServerRegistry({ forgeDir: deps.forgeDir, tokens, buildOAuth: deps.buildOAuth, ...(deps.overrides ? { overrides: deps.overrides } : {}), log });
  const store = createAccountStore(deps.forgeDir, log);
  const bindings: BindingStore = createBindingStore(deps.forgeDir, log);
  const http: ForgeHttp = createForgeHttp({ fetch: deps.fetch, userAgent: deps.userAgent, log, now, ...(deps.publicFetch ? { publicFetch: deps.publicFetch } : {}) });
  const messageListeners = new Set<(message: ForgeViewMessage) => void>();
  const changeListeners = new Set<() => void>();
  // accounts whose secret this run cannot read: a volatile store after a restart, or a deleted secret
  const tokenless = new Set<string>();
  // accounts marked "Sign in again" in this run, held here too since accounts.json may refuse the write
  const signInAgain = new Set<string>();
  // servers being removed, which no sign-in may start on
  const removing = new Set<string>();
  const orgAccess = new Map<string, { readonly at: number; readonly findings: readonly OrgAccessFinding[] }>();
  const notices: StoredNotice[] = [];
  let loaded = false;
  // settles once load() read the forge files (true) or failed to (false); the clone picker's accounts wait for it
  let settleLoad: (ok: boolean) => void = () => undefined;
  const loadSettled = new Promise<boolean>((resolve) => {
    settleLoad = resolve;
  });
  let settleFilesRead: () => void = () => undefined;
  const filesRead = new Promise<void>((resolve) => {
    settleFilesRead = resolve;
  });
  // a read failed (not a parse failure): the section shows the error and changes nothing
  let loadFailed = false;
  let flow: SignInFlow | undefined;
  const settled = new Map<string, ForgeSignInState>();
  let checks: Promise<void> | undefined;
  let noticeCounter = 0;
  let settingsSubscription: Disposable | undefined;

  const refresher: Refresher = createRefresher({ http, tokens, log, now, needsSignIn: (accountId) => markNeedsSignIn(accountId) });
  const accounts: Accounts = createAccounts({ store, tokens, bindings, servers, http, refresher, openExternal: deps.openExternal, log, now, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  const bindingsListeners = new Set<(change: BindingsChange) => void>();
  const refusalListeners = new Set<(refusal: ShownRefusal) => void>();
  const refusals = new Map<string, Map<string, RecordedRefusal>>();
  let gitHost: ForgeGitHost | undefined;
  let policy: CredentialPolicy | undefined;
  const checker = createAccessChecker({
    check: (account, server, repoPath, signal) => {
      // a token goes only to its own server, whichever server a caller names
      if (account.serverId !== server.id) return Promise.reject(new Error(`${account.id} is not an account of ${server.id}`));
      return withToken(account, server, (token) => providerFor(server.kind).repoAccess(http, server, token, repoPath, signal));
    },
    now,
    log,
  });
  const tools: ForgeTools = createForgeTools({
    servers: () => servers.list(),
    accounts: () => accounts.list(),
    bindings,
    pickByAccess: (candidates, server, repoPath, signal) => accessPick(candidates, server, repoPath, signal),
    withToken: (account, server, run) => withToken(account, server, run),
    http,
    needsSignIn: (account) => accountOption(account).needsSignIn,
    avatarKey: (account) => accountOption(account).avatarKey,
    readAnyRepository: () => deps.settings.get<boolean>(FORGE_AGENT_READ_ANY_REPOSITORY_SETTING, false),
    noteOrgAccess,
    log,
  });
  const ciListeners = new Set<(event: CiChangedEvent) => void>();
  const ci: CiWatcher = createCiWatcher({
    resolve: (repo, signal) => ciResolve(repo, signal, 'tracking'),
    enabled: () => deps.settings.get<boolean>(FORGE_CI_STATUS_SETTING, true) !== false,
    emit: (event) => {
      for (const listener of ciListeners) listener(event);
    },
    secrets: { maskStreamed: (text, final) => knownSecrets().maskStreamed(text, final) },
    log,
    now,
  });
  const clone: ClonePicker = createClonePicker({
    servers: () => servers.list(),
    accounts: () => (loaded ? accounts.list() : []),
    loaded: () => loadSettled,
    http,
    withToken: (account, server, run) => withToken(account, server, run),
    needsSignIn: (account) => accountOption(account).needsSignIn,
    avatarKey: (account) => accountOption(account).avatarKey,
    protocol: () => (deps.settings.get<string>(FORGE_CLONE_PROTOCOL_SETTING, 'https') === 'ssh' ? 'ssh' : 'https'),
    log,
    now,
  });
  const publisher: Publisher = createPublisher({
    servers: () => servers.list(),
    accounts: () => (loaded ? accounts.list() : []),
    loaded: () => loadSettled,
    bindings,
    http,
    withToken: (account, server, run) => withToken(account, server, run),
    needsSignIn: (account) => accountOption(account).needsSignIn,
    pickByAccess: (candidates, server, repoPath) => accessPick(candidates, server, repoPath),
    noteOrgAccess,
    protocol: () => (deps.settings.get<string>(FORGE_CLONE_PROTOCOL_SETTING, 'https') === 'ssh' ? 'ssh' : 'https'),
    log,
    now,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const protection: BranchProtectionCache = createBranchProtectionCache({
    servers: () => servers.list(),
    accounts: () => accounts.list(),
    bindings,
    usable: (account) => !accountOption(account).needsSignIn,
    pickByAccess: (candidates, server, repoPath) => accessPick(candidates, server, repoPath),
    read: (account, server, repoPath, signal) => withToken(account, server, (token) => providerFor(server.kind).branchProtection(http, server, token, account.userId, repoPath, signal)),
    enabled: () => deps.settings.get<boolean>(FORGE_BRANCH_PROTECTION_SETTING, true) !== false,
    now,
    log,
  });
  const authorKeyListeners = new Set<() => void>();
  const history: HistoryDetails = createHistoryDetails({
    servers: () => serversWithAccounts(),
    resolve: (repo, signal) => ciResolve(repo, signal, 'upstream'),
    showAvatars: () => showAvatars(),
    keysAdded: () => {
      for (const listener of authorKeyListeners) listener();
    },
    log,
    now,
  });
  const projectAccounts: ProjectAccounts = createProjectAccounts({
    servers: () => servers.list(),
    accounts: () => accounts.list(),
    bindings,
    checker,
    option: accountOption,
    ready: () => (loadFailed ? 'failed' : loaded ? 'ready' : 'loading'),
    changed: (change) => {
      for (const listener of bindingsListeners) listener(change);
      ci.refresh();
    },
    now,
    log,
  });

  function noteOrgAccess(account: AccountRecord, finding: OrgAccessFinding): void {
    const held = orgAccess.get(account.id)?.findings.filter((item) => item.org !== finding.org) ?? [];
    orgAccess.set(account.id, { at: now(), findings: [...held, finding] });
  }

  /** Each candidate's access check answer, all run at once. */
  async function accessOutcomes(candidates: readonly AccountRecord[], server: ForgeServer, repoPath: string): Promise<Map<string, AccessOutcome | undefined>> {
    const outcomes = new Map<string, AccessOutcome | undefined>();
    await Promise.all([...checker.run(candidates, server, repoPath, false)].map(async ([accountId, outcome]) => outcomes.set(accountId, await outcome)));
    return outcomes;
  }

  /** The access check's one pick (push, else read) among candidates and whether it can push; an abort of signal rejects. */
  async function accessPickWithPush(candidates: readonly AccountRecord[], server: ForgeServer, repoPath: string, signal?: AbortSignal): Promise<AccessPick | undefined> {
    const pending = accessOutcomes(candidates, server, repoPath);
    const outcomes = await (signal ? untilAborted(pending, signal) : pending);
    const account = pickByAccess(candidates, outcomes);
    if (!account) return undefined;
    const outcome = outcomes.get(account.id);
    return { account, canPush: outcome?.kind === 'checked' && outcome.canPush };
  }

  async function accessPick(candidates: readonly AccountRecord[], server: ForgeServer, repoPath: string, signal?: AbortSignal): Promise<AccountRecord | undefined> {
    return (await accessPickWithPush(candidates, server, repoPath, signal))?.account;
  }

  /** The servers an account exists on: the one set links, CI and history map a repository's remotes against. */
  function serversWithAccounts(): ForgeServer[] {
    const withAccounts = new Set(accounts.list().map((account) => account.serverId));
    return servers.list().filter((server) => withAccounts.has(server.id));
  }

  /** A repository's server by order's remote (remote-url.ts RemoteOrder) among serversWithAccounts, and the account resolved there. */
  async function ciResolve(repo: CiRepo, signal: AbortSignal, order: RemoteOrder): Promise<CiResolution> {
    if (!loaded) return { kind: 'none' };
    const chosen = repoOnServer(repo, serversWithAccounts(), order);
    if (!chosen) return { kind: 'none' };
    const { server } = chosen;
    const repoPath = checkedRepoPath(server.kind, chosen.repoPath);
    const candidates = accounts.list().filter((account) => account.serverId === server.id);
    if (repoPath === undefined || candidates.length === 0) return { kind: 'none' };
    const resolved = resolveWithoutAccess({ ...(repo.projectKey !== undefined ? { projectKey: repo.projectKey } : {}), authorityKey: repo.authorityKey, server, ...(chosen.usernameHint !== undefined ? { usernameHint: chosen.usernameHint } : {}) }, candidates, bindings);
    if (resolved?.account === null) return { kind: 'none' };
    if (signal.aborted) throw signal.reason;
    let account = resolved?.account;
    if (!account) {
      const checkable = candidates.filter((candidate) => !accountOption(candidate).needsSignIn);
      const outcomes = await accessOutcomes(checkable, server, repoPath);
      account = pickByAccess(checkable, outcomes);
      // a check that decided nothing: the chip says why, and the next read resolves again
      const kinds = new Set(checkable.map((candidate) => outcomes.get(candidate.id)?.kind ?? 'unreachable'));
      if (!account && kinds.has('unreachable')) {
        return { kind: 'error', message: l('Could not reach {0}. Check the connection and try again.', server.id) };
      }
      if (!account && kinds.has('ssoRequired')) return { kind: 'error', message: l('{0} requires single sign-on for this organization. Authorize Damocles in Settings › Models & accounts › Git hosting.', server.id) };
      if (!account && kinds.has('appNotApproved')) return { kind: 'error', message: l('The organization has not approved Damocles on {0}. Request approval in Settings › Models & accounts › Git hosting.', server.id) };
      if (!account && (kinds.has('signInAgain') || checkable.length === 0)) return { kind: 'error', message: l('Sign in again to {0} to see CI.', server.id) };
    }
    if (!account) return { kind: 'none' };
    if (accountOption(account).needsSignIn) return { kind: 'error', message: l('Sign in again as {0} on {1} to see CI.', account.login, server.id) };
    return {
      kind: 'target',
      target: {
        server,
        repoPath,
        serverName: server.id,
        accountId: account.id,
        adapter: server.kind === 'github' ? githubCi : gitlabCi,
        run: (work, runSignal) => withToken(account, server, (token) => work({ http, server, token, repoPath, signal: runSignal })),
      },
    };
  }

  function accountOption(account: AccountRecord): RepoAccountOption {
    return {
      id: account.id,
      login: account.login,
      ...(account.name !== undefined ? { name: account.name } : {}),
      ...(account.avatarUrl !== undefined && showAvatars() ? { avatarKey: avatarKey(account.serverId, account.avatarUrl) } : {}),
      needsSignIn: mustSignIn(account),
    };
  }

  function mustSignIn(account: AccountRecord): boolean {
    return account.needsSignIn === true || tokenless.has(account.id) || signInAgain.has(account.id);
  }

  /** On the account's chain. Publishes only a new mark, since each publish reads every CI watch again. */
  async function markNeedsSignIn(accountId: string): Promise<void> {
    if (signInAgain.has(accountId)) return;
    signInAgain.add(accountId);
    try {
      await accounts.markNeedsSignIn(accountId);
    } catch (err) {
      log(`[forge] recording that ${accountId} must sign in again failed: ${errorName(err)}`);
    }
    publish();
  }

  /** The server refused refusedAccess: the account signs in again only while that token is still the stored one. */
  async function markRefused(account: AccountRecord, server: ForgeServer, refusedAccess: string): Promise<void> {
    await refresher.exclusive(account, server, async () => {
      if ((await tokens.get(account.id))?.access === refusedAccess) await markNeedsSignIn(account.id);
    });
  }

  function showAvatars(): boolean {
    return deps.settings.get<boolean>(FORGE_SHOW_AVATARS_SETTING, true);
  }

  function serverSummary(server: ForgeServer): ForgeServerSummary {
    return {
      id: server.id,
      kind: server.kind,
      flavor: server.flavor,
      host: server.id,
      baseUrl: server.webUrl,
      builtIn: server.builtIn,
      ...(!server.builtIn && server.record.version !== undefined ? { version: server.record.version } : {}),
      gitHosts: [...server.record.gitHosts],
      pendingGitHosts: [...(server.record.pendingGitHosts ?? [])],
      ...(!server.builtIn && server.oauth ? { oauthClientId: server.oauth.clientId } : {}),
      hasClientSecret: !server.builtIn && server.oauth?.clientSecret !== undefined,
      ...(!server.builtIn ? { redirectUri: REGISTERED_REDIRECT_URI } : {}),
      routes: servers.routes(server),
      tokenScopes: [...providerFor(server.kind).tokenScopes],
    };
  }

  function accountSummary(account: AccountRecord): ForgeAccountSummary {
    const needsSignIn = mustSignIn(account);
    return {
      id: account.id,
      serverId: account.serverId,
      login: account.login,
      ...(account.name !== undefined ? { name: account.name } : {}),
      ...(account.avatarUrl !== undefined ? { avatarKey: avatarKey(account.serverId, account.avatarUrl) } : {}),
      route: account.auth,
      scopes: [...account.scopes],
      agentShells: account.agentShells,
      needsSignIn,
      ...(needsSignIn && account.needsSignInAt !== undefined ? { needsSignInAt: account.needsSignInAt } : {}),
      addedAt: account.addedAt,
      bindings: { ...bindings.count(account.id) },
      orgAccess: (orgAccess.get(account.id)?.findings ?? []).map(({ kind, org }) => ({ kind, org })),
    };
  }

  function state(): ForgeAccountsState {
    const redirectUris = { github: REGISTERED_REDIRECT_URI, gitlab: REGISTERED_REDIRECT_URI };
    if (loadFailed) return { status: 'error', error: { kind: 'loadFailed', message: notLoadedText() }, servers: [], accounts: [], notices: [], redirectUris, showAvatars: showAvatars() };
    if (!loaded) return { status: 'loading', servers: [], accounts: [], notices: [], redirectUris, showAvatars: showAvatars() };
    const broken = [servers.file, store, bindings.file].find((file) => file.broken());
    const known = new Set(servers.list().map((server) => server.id));
    return {
      status: broken ? 'error' : 'ready',
      ...(broken ? { error: { kind: 'brokenFile', message: l('Damocles could not read {0}. Fix or remove the file, then restart Damocles. Until then, account changes are not saved.', path.basename(broken.filePath)) } } : {}),
      servers: servers.list().map(serverSummary),
      accounts: accounts.list().filter((account) => known.has(account.serverId)).map(accountSummary),
      notices: notices.map(({ id, kind, message }) => ({ id, kind, message })),
      redirectUris,
      showAvatars: showAvatars(),
    };
  }

  function publish(to?: (message: ForgeViewMessage) => void): void {
    const message: ForgeViewMessage = { type: 'forgeAccountsChanged', state: state() };
    if (to) {
      to(message);
      return;
    }
    for (const listener of messageListeners) listener(message);
    for (const listener of changeListeners) listener();
    // accounts or servers changed: each repository's CI target may have too
    ci.refresh();
  }

  function postSignInState(serverId: string, signInState: ForgeSignInState): void {
    for (const listener of messageListeners) listener({ type: 'forgeSignInState', serverId, state: signInState });
  }

  function setFlowState(current: SignInFlow, signInState: ForgeSignInState): void {
    if (flow !== current) return;
    current.state = signInState;
    postSignInState(current.serverId, signInState);
  }

  function settle(current: SignInFlow, signInState: ForgeSignInState): void {
    if (flow !== current) return;
    flow = undefined;
    settled.set(current.serverId, signInState);
    postSignInState(current.serverId, signInState);
  }

  async function withToken<T>(account: AccountRecord, server: ForgeServer, run: (token: string) => Promise<T>): Promise<T> {
    const token = await refresher.accessToken(account, server);
    try {
      return await run(token);
    } catch (err) {
      if (err instanceof ForgeHttpError && err.kind === 'unauthorized') await markRefused(account, server, token);
      throw err;
    }
  }

  async function checkOrgAccess(account: AccountRecord, server: ForgeServer): Promise<void> {
    const provider = providerFor(server.kind);
    if (!provider.orgAccess) return;
    const findings = await withToken(account, server, (token) => provider.orgAccess!(http, server, token));
    orgAccess.set(account.id, { at: now(), findings });
  }

  function versionFresh(server: ForgeServer): boolean {
    const checkedAt = server.record.versionCheckedAt;
    return server.builtIn || (checkedAt !== undefined && now() - checkedAt <= VERSION_MAX_AGE_MS);
  }

  async function checkVersion(account: AccountRecord, server: ForgeServer): Promise<void> {
    if (server.builtIn) return;
    const version = await withToken(account, server, (token) => providerFor(server.kind).readVersion(http, server, token));
    await servers.recordVersion(server.id, version, now());
  }

  async function learnGitHosts(account: AccountRecord, server: ForgeServer): Promise<void> {
    if (server.builtIn) return;
    const hosts = await withToken(account, server, (token) => providerFor(server.kind).learnGitHosts(http, server, token));
    await servers.learnGitHosts(server.id, hosts);
  }

  /** Each check's failure is logged and leaves the last result; the next sign-in or settings opening tries again. */
  async function runChecks(list: readonly (readonly [string, () => Promise<void>])[]): Promise<void> {
    for (const [what, check] of list) {
      try {
        await check();
      } catch (err) {
        log(`[forge] ${what} failed: ${errorName(err)}`);
      }
    }
  }

  async function afterSignIn(account: AccountRecord, server: ForgeServer): Promise<void> {
    await runChecks([
      ...(versionFresh(server) ? [] : [[`reading ${server.id}'s version`, () => checkVersion(account, server)] as const]),
      [`learning ${server.id}'s git hosts`, () => learnGitHosts(account, server)],
      [`checking ${account.id}'s organization access`, () => checkOrgAccess(account, server)],
    ]);
    publish();
  }

  async function runSignIn(current: SignInFlow, request: ForgeSignInRequest): Promise<void> {
    try {
      requireLoaded();
      const { account, server } = await accounts.signIn({
        ...request,
        signal: current.abort.signal,
        onState: (signInState) => setFlowState(current, signInState),
        onPage: (url) => {
          current.pageUrl = url;
        },
      });
      tokenless.delete(account.id);
      signInAgain.delete(account.id);
      settle(current, { phase: 'signedIn', accountId: account.id, login: account.login });
      publish();
      void afterSignIn(account, server);
    } catch (err) {
      const error = signInFailure(err, request.serverId, current.abort.signal.aborted);
      log(`[forge] sign-in to ${request.serverId} by ${request.route} ended: ${error.kind} (${errorName(err)})`);
      settle(current, { phase: 'idle', error });
      publish();
    }
  }

  /** Why nothing changes yet: the files are still being read, or reading them failed for this run. */
  function notLoadedText(): LocalizedText {
    return loadFailed ? l('Damocles could not read its Git hosting accounts. Restart Damocles to try again.') : l('Git hosting accounts are not loaded. Try again in a moment.');
  }

  /** Refuses a change before the files were read, or after reading them failed. */
  function requireLoaded(): void {
    if (!loaded) throw new ForgeSignInError('provider', notLoadedText());
  }

  function serverOrThrow(serverId: string): ForgeServer {
    const server = servers.get(serverId);
    if (!server) throw new ForgeSignInError('provider', l('This server is no longer in the list.'));
    return server;
  }

  /** A change's refusal: a file that does not parse or a sign-in refusal says why; anything else is logged by name. */
  function refusalOf(err: unknown, what: string, fallback: LocalizedText): { readonly ok: false; readonly message: LocalizedText } {
    if (err instanceof ForgeFileBrokenError) return { ok: false, message: l('Damocles could not save the change because {0} does not parse.', path.basename(err.filePath)) };
    if (err instanceof ForgeSignInError) return { ok: false, message: err.text };
    log(`[forge] ${what} failed: ${errorName(err)}`);
    return { ok: false, message: fallback };
  }

  const changeFailed = (): LocalizedText => l('Damocles could not save the change. Try again.');

  /** One settings change: its result, every throw answered as a refusal, then a publish, refused or not. */
  async function settingsChange<T>(what: string, change: () => Promise<T>): Promise<T | { readonly ok: false; readonly message: LocalizedText }> {
    try {
      return await change();
    } catch (err) {
      return refusalOf(err, what, changeFailed());
    } finally {
      publish();
    }
  }

  async function signOutWithNotice(accountId: string): Promise<void> {
    const { account, revokePage } = await accounts.signOut(accountId);
    tokenless.delete(accountId);
    signInAgain.delete(accountId);
    orgAccess.delete(accountId);
    checker.forgetAccount(accountId);
    clone.forgetAccount(accountId);
    protection.forgetAccount(accountId);
    if (revokePage !== undefined) {
      noticeCounter += 1;
      notices.push({
        id: `revoke-${noticeCounter}`,
        kind: 'revokeFailed',
        message: l('Signed out {0} on {1}, but Damocles could not revoke its token. Revoke it on {1}.', account.login, account.serverId),
        page: revokePage,
      });
    }
  }

  async function verifyAccount(account: AccountRecord, server: ForgeServer): Promise<void> {
    const token = await refresher.accessToken(account, server);
    try {
      await providerFor(server.kind).currentUser(http, server, token);
      log(`[forge] git refused a token of ${account.id}, but ${server.id} still accepts it`);
    } catch (err) {
      if (!(err instanceof ForgeHttpError) || err.kind !== 'unauthorized') throw err;
      // a refresh the server refuses marks the account "Sign in again" (refresh.ts)
      await refresher.refreshNow(account, server, token);
      log(`[forge] ${account.id} refreshed after ${server.id} refused its token`);
    }
  }

  function credentialPolicy(host: ForgeGitHost): CredentialPolicy {
    return createCredentialPolicy({
      servers: () => servers.list(),
      accounts: () => accounts.list(),
      bindings,
      pickByAccess: (candidates, server, repoPath, signal) => accessPickWithPush(candidates.filter((account) => !accountOption(account).needsSignIn), server, repoPath, signal),
      ask: async (input, signal): Promise<CredentialChoice> => {
        const asked = await projectAccounts.askForCredential({ ...input, project: host.projectLabel(input.projectKey) }, host.ui, signal);
        if (asked.kind !== 'chosen') return asked;
        if (asked.accountId === null) return { kind: 'own' };
        const account = accounts.get(asked.accountId);
        if (!account) throw new Error('The chosen account is gone');
        return { kind: 'account', account };
      },
      // read on the account's chain, so no rotation lands between the token and its set
      token: (account, server) => refresher.exclusive(account, server, async (token) => {
        const access = await token();
        const held = await tokens.get(account.id);
        if (held?.access !== access) throw new Error('The account secret changed on its chain');
        return held;
      }),
      verify: verifyAccount,
      delegator: host.delegator,
      projectByRemote: host.projectByRemote,
      projectHolding: host.projectHolding,
      refused: (refusal) => {
        const shown = { ...refusal, projectLabel: host.projectLabel(refusal.projectKey) };
        for (const listener of refusalListeners) listener(shown);
      },
      secrets: knownSecrets(),
      log,
      now,
    });
  }

  return {
    async load() {
      try {
        await servers.load();
        await store.load();
        await bindings.file.load();
        settleFilesRead();
        for (const account of accounts.list()) {
          // one unreadable secret (a locked keychain) asks that account to sign in again, never the whole section
          const set = await tokens.get(account.id).catch((err: unknown) => {
            log(`[forge] reading the secret of ${account.id} failed: ${errorName(err)}`);
            return undefined;
          });
          if (set === undefined) tokenless.add(account.id);
        }
      } catch (err) {
        loadFailed = true;
        settleFilesRead();
        settleLoad(false);
        publish();
        throw err;
      }
      loaded = true;
      settleLoad(true);
      settingsSubscription = deps.settings.onDidChange('damocles.desktop.forge', (change) => {
        if (change.affects(FORGE_SHOW_AVATARS_SETTING)) {
          publish();
          for (const listener of authorKeyListeners) listener();
        } else if (change.affects(FORGE_CI_STATUS_SETTING)) ci.refresh();
      });
      publish();
    },

    filesRead: () => filesRead,
    state,
    publish,

    postSignInStates(to) {
      if (flow) to({ type: 'forgeSignInState', serverId: flow.serverId, state: flow.state });
      for (const [serverId, signInState] of settled) {
        if (flow?.serverId !== serverId) to({ type: 'forgeSignInState', serverId, state: signInState });
      }
    },

    onMessage(listener) {
      messageListeners.add(listener);
      return { dispose: () => messageListeners.delete(listener) };
    },

    onChange(listener) {
      changeListeners.add(listener);
      return { dispose: () => changeListeners.delete(listener) };
    },

    mirror() {
      const withAccounts = new Set(accounts.list().map((account) => account.serverId));
      return {
        servers: servers.list().map((server) => ({ id: server.id, kind: server.kind, webUrl: server.webUrl, gitHosts: [...server.record.gitHosts], hasAccount: withAccounts.has(server.id) })),
        avatarKeys: showAvatars() ? accounts.list().flatMap((account) => (account.avatarUrl !== undefined ? [avatarKey(account.serverId, account.avatarUrl)] : [])) : [],
      };
    },

    async signIn(request) {
      if (flow?.serverId === request.serverId) return;
      if (removing.has(request.serverId)) {
        postSignInState(request.serverId, { phase: 'idle', error: { kind: 'provider', message: l('This server is no longer in the list.') } });
        return;
      }
      if (flow) {
        postSignInState(request.serverId, { phase: 'idle', error: { kind: 'input', message: l('Finish or cancel the sign-in to {0} first.', flow.serverId) } });
        return;
      }
      const current: SignInFlow = { serverId: request.serverId, abort: new AbortController(), state: { phase: 'starting' } };
      flow = current;
      settled.delete(request.serverId);
      postSignInState(request.serverId, current.state);
      current.run = runSignIn(current, request);
      await current.run;
    },

    async cancelSignIn(serverId) {
      if (flow?.serverId !== serverId) return;
      const current = flow;
      current.abort.abort();
      await current.run;
    },

    signOut(accountId) {
      return settingsChange(`signing out ${accountId}`, async (): Promise<ForgeActionResult> => {
        requireLoaded();
        await signOutWithNotice(accountId);
        return { ok: true };
      });
    },

    setAgentShells(accountId, agentShells) {
      return settingsChange(`setting the agent shells switch of ${accountId}`, async (): Promise<ForgeActionResult> => {
        requireLoaded();
        await accounts.setAgentShells(accountId, agentShells);
        return { ok: true };
      });
    },

    addServer(input) {
      return settingsChange('adding a server', async (): Promise<ServerFormResult> => {
        requireLoaded();
        assertWritable(servers.file);
        return formResult(await servers.add(input, now()));
      });
    },

    editServer(serverId, edit) {
      return settingsChange(`editing ${serverId}`, async (): Promise<ServerFormResult> => {
        requireLoaded();
        assertWritable(servers.file);
        return formResult(await servers.edit(serverId, edit));
      });
    },

    async removeServer(serverId) {
      try {
        return await settingsChange(`removing ${serverId}`, async (): Promise<ServerFormResult> => {
          requireLoaded();
          const server = serverOrThrow(serverId);
          if (server.builtIn) return { ok: false, message: l('Built-in servers cannot be removed.') };
          assertWritable(servers.file, store, bindings.file);
          removing.add(serverId);
          // a sign-in on this server ends before its accounts are listed, so it leaves no token behind
          if (flow?.serverId === serverId) {
            const running = flow;
            running.abort.abort();
            await running.run;
          }
          for (const account of accounts.list().filter((item) => item.serverId === serverId)) await signOutWithNotice(account.id);
          await servers.remove(serverId);
          return { ok: true, serverId };
        });
      } finally {
        removing.delete(serverId);
      }
    },

    confirmGitHost(serverId, host) {
      return settingsChange(`confirming a git host of ${serverId}`, async (): Promise<ServerFormResult> => {
        requireLoaded();
        assertWritable(servers.file);
        return formResult(await servers.confirmGitHost(serverId, host));
      });
    },

    dismissGitHost(serverId, host) {
      return settingsChange(`dismissing a git host of ${serverId}`, async (): Promise<ServerFormResult> => {
        requireLoaded();
        assertWritable(servers.file);
        return formResult(await servers.dismissGitHost(serverId, host));
      });
    },

    async revealBrokenFile() {
      const broken = [servers.file, store, bindings.file].find((file) => file.broken());
      if (!broken) return { ok: false, message: l('No Git hosting file needs fixing.') };
      try {
        await deps.revealPath(broken.filePath);
        return { ok: true };
      } catch (err) {
        return refusalOf(err, `showing ${path.basename(broken.filePath)}`, l('Damocles could not show the file.'));
      }
    },

    async openPage(target) {
      const url = pageUrl(target);
      if (url === undefined) {
        log(`[forge] no ${target.page} page to open`);
        return false;
      }
      return deps.openExternal(url);
    },

    async copySignInCode(serverId) {
      if (flow?.serverId !== serverId || flow.state.phase !== 'deviceCode') return false;
      await deps.writeClipboard(flow.state.userCode);
      return true;
    },

    async copyRedirectUri(kind, serverId) {
      const server = serverId !== undefined ? servers.get(serverId) : undefined;
      if (serverId !== undefined && (!server || server.kind !== kind)) return false;
      await deps.writeClipboard(REGISTERED_REDIRECT_URI);
      return true;
    },

    dismissNotice(noticeId) {
      const index = notices.findIndex((notice) => notice.id === noticeId);
      if (index < 0) return;
      notices.splice(index, 1);
      publish();
    },

    settingsOpened() {
      if (checks || !loaded) return checks ?? Promise.resolve();
      const due: [string, () => Promise<void>][] = [];
      const versionDue = new Set<string>();
      for (const account of accounts.list()) {
        const server = servers.get(account.serverId);
        if (!server || mustSignIn(account)) continue;
        if (!versionFresh(server) && !versionDue.has(server.id)) {
          versionDue.add(server.id);
          due.push([`reading ${server.id}'s version`, () => checkVersion(account, server)]);
        }
        const checked = orgAccess.get(account.id);
        if (server.kind === 'github' && (checked === undefined || now() - checked.at > ORG_ACCESS_MAX_AGE_MS)) {
          due.push([`checking ${account.id}'s organization access`, () => checkOrgAccess(account, server)]);
        }
      }
      if (due.length === 0) return Promise.resolve();
      checks = runChecks(due).then(() => publish()).finally(() => {
        checks = undefined;
      });
      return checks;
    },

    async avatar(key) {
      if (!showAvatars()) return undefined;
      const account = accounts.list().find((item) => item.avatarUrl !== undefined && avatarKey(item.serverId, item.avatarUrl) === key);
      if (account) {
        const server = servers.get(account.serverId);
        return server ? fetchAvatar(http, server, account.avatarUrl!, () => refresher.accessToken(account, server), log) : undefined;
      }
      const picture = history.picture(key);
      const server = picture ? servers.get(picture.serverId) : undefined;
      if (!picture || !server) return undefined;
      return fetchAvatar(http, server, picture.url, () => {
        // called only for a picture on the server's own origins
        const owner = accounts.get(picture.accountId);
        if (!owner) return Promise.reject(new Error(`The account that looked up a picture on ${server.id} signed out`));
        return refresher.accessToken(owner, server);
      }, log);
    },

    async repoAccounts(input) {
      if (!loaded) return undefined;
      return projectAccounts.repoAccounts(input);
    },

    async bindAccount(projectKey, serverId, accountId) {
      requireLoaded();
      return projectAccounts.bindAccount(projectKey, serverId, accountId);
    },

    hostDefaults: (authorityKey) => projectAccounts.hostDefaults(authorityKey),

    async setHostDefault(authorityKey, serverId, accountId) {
      requireLoaded();
      return projectAccounts.setHostDefault(authorityKey, serverId, accountId);
    },

    async prepareGitOperation(input, ui, signal) {
      if (!loaded) {
        log(`[forge] ${input.operation} runs before the Git hosting accounts were read; nothing is asked`);
        return { proceed: true };
      }
      return projectAccounts.prepareGitOperation(input, ui, signal);
    },

    async forgetProject(projectKey) {
      requireLoaded();
      await projectAccounts.forgetProject(projectKey);
    },

    async forgetHost(authorityKey) {
      requireLoaded();
      await projectAccounts.forgetHost(authorityKey);
    },

    async keepHosts(authorityKeys) {
      if (!(await loadSettled)) {
        log('[forge] the bindings were not read, so no forgotten host\'s bindings are dropped');
        return;
      }
      const dropped = await projectAccounts.keepHosts(new Set(authorityKeys));
      if (dropped.length > 0) log(`[forge] dropped the bindings and host defaults of ${dropped.length} forgotten host(s)`);
    },

    onBindingsChanged(listener) {
      bindingsListeners.add(listener);
      return { dispose: () => bindingsListeners.delete(listener) };
    },

    managedServers(projectKey) {
      if (!loaded) return [];
      const withAccounts = new Set(accounts.list().map((account) => account.serverId));
      return servers.list()
        .filter((server) => withAccounts.has(server.id) && (projectKey === undefined || bindings.binding(projectKey, server.id)?.account !== null))
        .map((server) => ({ webUrl: server.webUrl, gitHosts: [...server.record.gitHosts] }));
    },

    connectGit(host) {
      gitHost = host;
      policy = undefined;
    },

    async gitCredential(request, origin, context, signal) {
      // a terminal started before a core restart asks while the new core reads its files; load() always settles
      if (!(await loadSettled)) throw new Error('The Git hosting accounts could not be read');
      if (!gitHost) throw new Error('Git credentials are not connected');
      policy ??= credentialPolicy(gitHost);
      return policy.answer(request, origin, context, signal);
    },

    onShellRefused(listener) {
      refusalListeners.add(listener);
      return { dispose: () => refusalListeners.delete(listener) };
    },

    recordRefusal(panelId, toolCallId, refusal, livePanels) {
      for (const shown of [...refusals.keys()]) if (!livePanels.has(shown)) refusals.delete(shown);
      const held = refusals.get(panelId) ?? new Map<string, RecordedRefusal>();
      held.delete(toolCallId);
      held.set(toolCallId, refusal);
      while (held.size > MAX_REFUSALS_PER_PANEL) held.delete(held.keys().next().value!);
      refusals.set(panelId, held);
    },

    refusalOf: (panelId, toolCallId) => refusals.get(panelId)?.get(toolCallId),

    agentTool(request, signal) {
      if (!loaded) return Promise.resolve({ text: 'The GitHub and GitLab accounts are still loading. Try again in a moment.', isError: true });
      return tools.run(request, signal);
    },

    agentToolApproval(request, signal) {
      if (!loaded) return Promise.resolve({ ok: false, answer: { text: 'The GitHub and GitLab accounts are still loading. Try again in a moment.', isError: true } });
      return tools.approval(request, signal);
    },

    agentToolTarget(request, signal) {
      if (!loaded) return Promise.resolve({ ok: false, answer: { text: 'The GitHub and GitLab accounts are still loading. Try again in a moment.', isError: true } });
      return tools.target(request, signal);
    },

    hasAccount: () => loaded && accounts.list().some((account) => servers.get(account.serverId) !== undefined),

    ci,

    link(repo, target) {
      if (!loaded) return { unavailable: notLoadedText() };
      const outcome = buildLink(serversWithAccounts(), repo, target);
      if (outcome.ok) return { url: outcome.url, serverName: outcome.server.id, remote: outcome.remote };
      if (outcome.reason === 'noServer') return { unavailable: l('{0} has no remote on a GitHub or GitLab server you are signed in to.', repo.project) };
      log(`[forge] no link for ${repo.project}: ${outcome.reason}`);
      return { unavailable: l('Damocles cannot build a link for this repository.') };
    },

    clone,

    publishing: publisher,

    onCiChanged(listener) {
      ciListeners.add(listener);
      return { dispose: () => ciListeners.delete(listener) };
    },

    branchProtection: (repo) => (loaded ? protection.lookup(repo) : []),
    pushProtection: async (repo, remote, branch, signal) => ((await loadSettled) ? protection.pushProtection(repo, remote, branch, signal) : { protection: 'unknown' }),

    historyContext: (repo) => (loaded ? history.context(repo) : null),

    authorAvatars(repo, authors, signal) {
      return loaded ? history.avatars(repo, authors, signal) : Promise.resolve({});
    },

    containingChange(repo, sha, signal) {
      return loaded ? history.containing(repo, sha, signal) : Promise.resolve(null);
    },

    authorAvatarKeys: () => history.keys(),

    onAuthorAvatarKeys(listener) {
      authorKeyListeners.add(listener);
      return { dispose: () => authorKeyListeners.delete(listener) };
    },

    dispose() {
      ci.dispose();
      protection.dispose();
      ciListeners.clear();
      settingsSubscription?.dispose();
      bindingsListeners.clear();
      refusalListeners.clear();
      authorKeyListeners.clear();
      refusals.clear();
      flow?.abort.abort();
      messageListeners.clear();
      changeListeners.clear();
    },
  };

  function pageUrl(target: ForgeOpenPage): string | undefined {
    switch (target.page) {
      case 'signIn':
        if (flow?.serverId !== target.serverId) return undefined;
        if (flow.state.phase === 'deviceCode') return flow.state.verificationUri;
        return flow.state.phase === 'browser' ? flow.pageUrl : undefined;
      case 'token': {
        const server = servers.get(target.serverId);
        return server ? providerFor(server.kind).tokenPage(server) : undefined;
      }
      case 'orgAccess': {
        const account = accounts.get(target.accountId);
        const server = account ? servers.get(account.serverId) : undefined;
        const finding = orgAccess.get(target.accountId)?.findings.find((item) => item.org === target.org);
        if (!account || !server || !finding) return undefined;
        if (finding.kind === 'ssoRequired') {
          // only an https page on the server's own web origin, as GitHub names it in X-GitHub-SSO
          const url = finding.url !== undefined && URL.canParse(finding.url) ? new URL(finding.url) : undefined;
          return url && url.protocol === 'https:' && url.origin === new URL(server.webUrl).origin ? url.href : undefined;
        }
        const clientId = account.clientId ?? server.oauth?.clientId;
        return clientId !== undefined ? `${server.webUrl}/settings/connections/applications/${encodeURIComponent(clientId)}` : undefined;
      }
      case 'revoke':
        return notices.find((notice) => notice.id === target.noticeId)?.page;
    }
  }
}

/** The token store, registering each account's tokens with known-secret masking as they are read, written or deleted. */
function maskedTokens(store: TokenStore): TokenStore {
  const live = (accountId: string, set: { readonly access: string; readonly refresh?: string } | undefined): void => {
    knownSecrets().setLive(accountId, set ? [set.access, ...(set.refresh !== undefined ? [set.refresh] : [])] : []);
  };
  return {
    ...store,
    async get(accountId) {
      const set = await store.get(accountId);
      live(accountId, set);
      return set;
    },
    async set(accountId, set) {
      // masked before it is stored or used, so no result can carry it unmasked
      live(accountId, set);
      await store.set(accountId, set);
    },
    async delete(accountId) {
      await store.delete(accountId);
      live(accountId, undefined);
    },
  };
}

export type { Avatar } from './avatars';
export type { CredentialContext, CredentialResult, ShellRefusal } from './credentials';
export type { ForgeBuildOAuth, ForgeServerOverride } from './types';
export type { BindingsChange, ChooseAccountUi, PrepareGitOperationInput, PrepareGitOperationResult, RepoAccountsInput } from './bindings/project-accounts';
