// Publish and fork on a denied push, adapted from VS Code's extensions/github/src/publish.ts and pushErrorHandler.ts
// (the flow, the name sanitizer and PR_TEMPLATE_FILES), Copyright (c) Microsoft Corporation, and GitLab Workflow for VS Code's
// src/desktop/gitlab/api/get_namespaces_where_user_can_create_projects.ts and create_project.ts (the namespace lookup and the
// project creation), Copyright (c) 2020-present GitLab Inc. Both licensed under the MIT License (THIRD-PARTY-NOTICES.md).
import { setTimeout as sleepFor } from 'node:timers/promises';
import type { RemoteEndpoint } from '../../shared/forge/bindings';
import { MAX_OWNER_VALUE_CHARS, MAX_REASON_CHARS, isRepositoryName, sanitizeRepositoryName, type PublishAccount, type PublishNamespace, type PublishNamespaceKind, type PublishOwnersAnswerOf, type PublishVisibility } from '../../shared/forge/publish';
import type { LocalizedText } from '../../shared/localized-text';
import { boundedVisible } from '../../shared/visible-text';
import { l } from '../l10n';
import type { BindingStore } from './bindings/binding-store';
import { resolveWithoutAccess } from './bindings/resolve';
import { checkedCloneUrl, listingErrorOf, type ListingContext } from './clone-sources';
import { field, numberField, stringField, type ForgeHttp, type ForgeResponse } from './http';
import { providerFor } from './providers/provider';
import { matchServer } from './remote-url';
import { checkedBranch, checkedRepoPath } from './tools/api';
import { ForgeHttpError, type AccountRecord, type ForgeServer } from './types';

// docs/invariants.md "GitHub and GitLab accounts", publish and fork: an Owner value resolves only against the namespaces core
// listed itself; every URL a server returns passes checkedCloneUrl before main adds it as a remote; a fork is offered only after
// the server's access check says the account can read but not push.

/** The user's own namespace in an Owner value. */
export const PERSONAL = 'personal';
/** The polls of a fork give up after this long. */
export const FORK_LIMIT_MS = 120_000;
/** The create page's address bound; browsers and servers refuse much longer ones. */
export const MAX_CREATE_PAGE_URL_CHARS = 8_000;
const FORK_POLL_FIRST_MS = 1_000;
const FORK_POLL_MAX_MS = 5_000;
const NAMESPACE_PAGE = 100;
/** A namespace listing's bound, ten pages (docs/invariants.md "Publish creates the repository on a namespace core listed"). */
export const MAX_NAMESPACE_PAGES = 10;
// the server's answers to a create or a fork it refused, read for their reason instead of thrown
const REFUSAL_STATUSES: readonly number[] = [400, 403, 404, 409, 422];

/**
 * "<server>|<login>|personal" for the user's own namespace, "<server>|<login>|<full path>" otherwise; an organization or group
 * whose full path is "personal" is "~personal", since '~' is in no GitHub or GitLab namespace path.
 */
export function ownerValue(serverName: string, login: string, kind: PublishNamespaceKind, path: string): string {
  const namespace = kind === 'personal' ? PERSONAL : path === PERSONAL ? `~${PERSONAL}` : path;
  return `${serverName}|${login}|${namespace}`;
}

/** Internal is a visibility of every GitLab namespace and of a GitHub Enterprise Server organization only. */
export function offersInternal(server: Pick<ForgeServer, 'kind' | 'flavor'>, kind: PublishNamespaceKind): boolean {
  return server.kind === 'gitlab' || (server.flavor === 'ghes' && kind === 'org');
}

/** An organization or group where the account may create a repository; id is GitLab's namespace_id. */
export interface ListedNamespace {
  readonly kind: 'org' | 'group';
  readonly path: string;
  readonly id?: number;
}

/** A namespace listing; cut: the server had more than MAX_NAMESPACE_PAGES pages. */
export interface NamespaceListing {
  readonly namespaces: readonly ListedNamespace[];
  readonly cut: boolean;
}

/** GET /user/orgs page by page: the organizations the account belongs to, which GitHub's create page offers as owners too. */
export async function githubNamespaces(ctx: ListingContext): Promise<NamespaceListing> {
  const namespaces: ListedNamespace[] = [];
  for (let page = 1; page <= MAX_NAMESPACE_PAGES; page++) {
    const response = await ctx.http.request({ server: ctx.server, url: `/user/orgs?per_page=${NAMESPACE_PAGE}&page=${page}`, template: '/user/orgs', credential: { bearer: ctx.token }, signal: ctx.signal });
    if (!Array.isArray(response.body)) throw new ForgeHttpError('server', 'GET /user/orgs answered without a list');
    for (const org of response.body) {
      const login = stringField(org, 'login');
      if (login !== undefined && /^[A-Za-z0-9-]{1,39}$/.test(login)) namespaces.push({ kind: 'org', path: login });
    }
    if (response.body.length < NAMESPACE_PAGE) return { namespaces, cut: false };
  }
  return { namespaces, cut: true };
}

/** A group's full path a create request may carry: up to 20 segments of letters, digits, '_', '.' and '-', never '.' or '..'. */
function isNamespacePath(value: string): boolean {
  const segments = value.split('/');
  return segments.length <= 20 && segments.every((segment) => /^[A-Za-z0-9_.-]{1,255}$/.test(segment) && segment !== '.' && segment !== '..');
}

const GITLAB_NAMESPACES_QUERY = `query DamoclesPublishNamespaces($first: Int, $after: String) {
  currentUser { groups(permissionScope: CREATE_PROJECTS, first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { id fullPath } } }
}`;

/** GraphQL currentUser.groups(permissionScope: CREATE_PROJECTS) page by page: every group, nested ones included, where the user may create a project. */
export async function gitlabNamespaces(ctx: ListingContext): Promise<NamespaceListing> {
  const namespaces: ListedNamespace[] = [];
  let after: string | null = null;
  for (let page = 1; page <= MAX_NAMESPACE_PAGES; page++) {
    const response: ForgeResponse = await ctx.http.request({
      server: ctx.server,
      method: 'POST',
      url: `${ctx.server.webUrl}/api/graphql`,
      template: '/api/graphql groups',
      credential: { bearer: ctx.token },
      json: { query: GITLAB_NAMESPACES_QUERY, variables: { first: NAMESPACE_PAGE, after } },
      signal: ctx.signal,
    });
    const groups = field(field(field(response.body, 'data'), 'currentUser'), 'groups');
    const nodes = field(groups, 'nodes');
    if (!Array.isArray(nodes)) throw new ForgeHttpError('server', 'GraphQL groups answered without nodes');
    for (const node of nodes) {
      const fullPath = stringField(node, 'fullPath');
      const id = /^gid:\/\/gitlab\/Group\/(\d{1,15})$/.exec(stringField(node, 'id') ?? '');
      if (fullPath !== undefined && isNamespacePath(fullPath) && id) namespaces.push({ kind: 'group', path: fullPath, id: Number(id[1]) });
    }
    const pageInfo = field(groups, 'pageInfo');
    const cursor = stringField(pageInfo, 'endCursor');
    if (field(pageInfo, 'hasNextPage') !== true || cursor === undefined) return { namespaces, cut: false };
    after = cursor;
  }
  return { namespaces, cut: true };
}

/** A server's own words for a refusal: GitHub's errors[].message, else message; GitLab's message (a string or field: words), else error. */
export function serverReason(body: unknown): string | undefined {
  const errors = field(body, 'errors');
  const listed = Array.isArray(errors) ? errors.flatMap((item) => (typeof item === 'string' ? [item] : stringField(item, 'message') ?? [])) : [];
  let text: string | undefined = listed.length > 0 ? listed.join('; ') : undefined;
  const message = field(body, 'message');
  if (text === undefined && typeof message === 'string') text = message;
  if (text === undefined && typeof message === 'object' && message !== null && !Array.isArray(message)) {
    const parts = Object.entries(message as Record<string, unknown>).flatMap(([key, value]) => {
      const words = (Array.isArray(value) ? value : [value]).filter((word): word is string => typeof word === 'string');
      return words.length > 0 ? [`${key} ${words.join(', ')}`] : [];
    });
    if (parts.length > 0) text = parts.join('; ');
  }
  text ??= stringField(body, 'error');
  // eslint-disable-next-line no-control-regex
  const line = text?.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return line ? boundedVisible(line, MAX_REASON_CHARS) : undefined;
}

/** Whether a create refusal is about the name (GitHub 422 on the name field, GitLab 400 on name or path), which the Name field shows. */
export function refusesName(status: number, body: unknown): boolean {
  const errors = field(body, 'errors');
  if (status === 422 && Array.isArray(errors)) return errors.some((item) => stringField(item, 'field') === 'name');
  const message = field(body, 'message');
  return status === 400 && typeof message === 'object' && message !== null && !Array.isArray(message) && ['name', 'path'].some((key) => Object.hasOwn(message, key));
}

export interface CreatedRepository {
  readonly path: string;
  readonly httpsUrl?: unknown;
  readonly sshUrl?: unknown;
}

/**
 * POST /user/repos or /orgs/{org}/repos (GitHub), POST /projects with namespace_id (GitLab); a refusal answers its reason. A
 * success whose answer names no repository path is unnamed, with the path the request asked for.
 */
export async function createOnServer(
  ctx: ListingContext,
  namespace: { readonly kind: PublishNamespaceKind; readonly path: string; readonly id?: number },
  name: string,
  visibility: PublishVisibility,
): Promise<{ readonly created: CreatedRepository } | { readonly unnamed: string } | { readonly refused: string | undefined; readonly nameTaken: boolean; readonly status: number }> {
  let response: ForgeResponse;
  if (ctx.server.kind === 'github') {
    const personal = namespace.kind === 'personal';
    response = await ctx.http.request({
      server: ctx.server,
      method: 'POST',
      url: personal ? '/user/repos' : `/orgs/${encodeURIComponent(namespace.path)}/repos`,
      template: personal ? '/user/repos' : '/orgs/{org}/repos',
      credential: { bearer: ctx.token },
      json: personal ? { name, private: visibility !== 'public' } : { name, visibility },
      acceptStatuses: REFUSAL_STATUSES,
      signal: ctx.signal,
    });
  } else {
    response = await ctx.http.request({
      server: ctx.server,
      method: 'POST',
      url: '/projects',
      template: '/projects',
      credential: { bearer: ctx.token },
      json: { name, path: name, visibility, ...(namespace.id !== undefined ? { namespace_id: namespace.id } : {}) },
      acceptStatuses: REFUSAL_STATUSES,
      signal: ctx.signal,
    });
  }
  if (response.status >= 400) return { refused: serverReason(response.body), nameTaken: refusesName(response.status, response.body), status: response.status };
  const github = ctx.server.kind === 'github';
  const path = stringField(response.body, github ? 'full_name' : 'path_with_namespace');
  const checked = path !== undefined ? checkedRepoPath(ctx.server.kind, path) : undefined;
  if (checked === undefined) return { unnamed: `${namespace.path}/${name}` };
  return { created: { path: checked, httpsUrl: field(response.body, github ? 'clone_url' : 'http_url_to_repo'), sshUrl: field(response.body, github ? 'ssh_url' : 'ssh_url_to_repo') } };
}

export interface ForkTiming {
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** cancelled: the caller aborted after the server accepted the fork, which stays there as path. */
export type ForkOnServer = { readonly forked: CreatedRepository } | { readonly failed: LocalizedText } | { readonly cancelled: { readonly path: string } };

function grownDelay(delay: number): number {
  return Math.min(delay * 2, FORK_POLL_MAX_MS);
}

/**
 * Waits for poll to answer, with growing pauses, until FORK_LIMIT_MS from start; the limit's failure names the server. The
 * server accepted the fork as path, so an abort meanwhile answers cancelled with it.
 */
async function pollFork(ctx: ListingContext, timing: ForkTiming, start: number, path: string, poll: () => Promise<CreatedRepository | 'pending' | { readonly failed: LocalizedText }>): Promise<ForkOnServer> {
  let delay = FORK_POLL_FIRST_MS;
  try {
    for (;;) {
      const answer = await poll();
      if (answer !== 'pending') return 'failed' in answer ? answer : { forked: answer };
      if (timing.now() - start + delay > FORK_LIMIT_MS) return { failed: l('The fork is taking longer than {0} minutes on {1}.', FORK_LIMIT_MS / 60_000, ctx.server.id) };
      await timing.sleep(delay, ctx.signal);
      delay = grownDelay(delay);
    }
  } catch (err) {
    if (ctx.signal.aborted) return { cancelled: { path } };
    throw err;
  }
}

/** GitHub: POST /repos/{owner}/{repo}/forks, then GET /repos/{fork} until the fork exists; the fork is the path GitHub answered. */
async function githubFork(ctx: ListingContext, timing: ForkTiming, upstream: string, login: string): Promise<ForkOnServer> {
  const start = timing.now();
  const [owner, repo] = upstream.split('/') as [string, string];
  const created = await ctx.http.request({ server: ctx.server, method: 'POST', url: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/forks`, template: '/repos/{owner}/{repo}/forks', credential: { bearer: ctx.token }, json: {}, acceptStatuses: REFUSAL_STATUSES, signal: ctx.signal });
  if (created.status >= 400) return { failed: refusedFork(ctx.server, upstream, serverReason(created.body)) };
  const named = stringField(created.body, 'full_name');
  const path = named !== undefined ? checkedRepoPath('github', named) : undefined;
  if (path === undefined || path.split('/')[0]!.toLowerCase() !== login.toLowerCase()) throw new ForgeHttpError('server', 'The fork answer named no repository of the account');
  const [forkOwner, forkRepo] = path.split('/') as [string, string];
  return pollFork(ctx, timing, start, path, async () => {
    const got = await ctx.http.request({ server: ctx.server, url: `/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(forkRepo)}`, template: '/repos/{owner}/{repo}', credential: { bearer: ctx.token }, acceptStatuses: [404], signal: ctx.signal });
    return got.status === 404 ? 'pending' : { path, httpsUrl: field(got.body, 'clone_url'), sshUrl: field(got.body, 'ssh_url') };
  });
}

/** GitLab: POST /projects/:id/fork, then GET /projects/:fork until import_status is finished; an existing fork of upstream is reused. */
async function gitlabFork(ctx: ListingContext, timing: ForkTiming, upstream: string, login: string): Promise<ForkOnServer> {
  const start = timing.now();
  const created = await ctx.http.request({ server: ctx.server, method: 'POST', url: `/projects/${encodeURIComponent(upstream)}/fork`, template: '/projects/{id}/fork', credential: { bearer: ctx.token }, json: {}, acceptStatuses: REFUSAL_STATUSES, signal: ctx.signal });
  let fork = created.body;
  if (created.status === 409 || (created.status === 400 && /already been taken/i.test(serverReason(created.body) ?? ''))) {
    // a fork made before: reused only when it is this account's fork of upstream; GitLab paths are case-insensitive
    const name = upstream.split('/').pop()!;
    const existing = await ctx.http.request({ server: ctx.server, url: `/projects/${encodeURIComponent(`${login}/${name}`)}`, template: '/projects/{path}', credential: { bearer: ctx.token }, acceptStatuses: [404], signal: ctx.signal });
    const forkedFrom = stringField(field(existing.body, 'forked_from_project'), 'path_with_namespace');
    if (existing.status === 404 || forkedFrom?.toLowerCase() !== upstream.toLowerCase()) return { failed: refusedFork(ctx.server, upstream, serverReason(created.body)) };
    fork = existing.body;
  } else if (created.status >= 400) {
    return { failed: refusedFork(ctx.server, upstream, serverReason(created.body)) };
  }
  const forkId = numberField(fork, 'id');
  const named = stringField(fork, 'path_with_namespace');
  const forkPath = named !== undefined ? checkedRepoPath('gitlab', named) : undefined;
  if (forkId === undefined || !Number.isSafeInteger(forkId) || forkPath === undefined) throw new ForgeHttpError('server', 'The fork answer named no project id or path');
  return pollFork(ctx, timing, start, forkPath, async () => {
    const got = await ctx.http.request({ server: ctx.server, url: `/projects/${forkId}`, template: '/projects/{id}', credential: { bearer: ctx.token }, signal: ctx.signal });
    const status = stringField(got.body, 'import_status');
    if (status === 'failed' || status === 'canceled') return { failed: l('{0} could not copy {1}.', ctx.server.id, upstream) };
    if (status !== undefined && status !== 'finished' && status !== 'none') return 'pending';
    const named = stringField(got.body, 'path_with_namespace');
    const path = named !== undefined ? checkedRepoPath('gitlab', named) : undefined;
    if (path === undefined || path.split('/')[0]!.toLowerCase() !== login.toLowerCase()) throw new ForgeHttpError('server', 'The fork answer named no project of the account');
    return { path, httpsUrl: field(got.body, 'http_url_to_repo'), sshUrl: field(got.body, 'ssh_url_to_repo') };
  });
}

function refusedFork(server: ForgeServer, upstream: string, reason: string | undefined): LocalizedText {
  return reason !== undefined ? l('{0} refused to fork {1}: {2}', server.id, upstream, reason) : l('{0} refused to fork {1}.', server.id, upstream);
}

/** Forks upstream into the account's own namespace and waits until the server has copied it (FORK_LIMIT_MS at most). */
export function forkOnServer(ctx: ListingContext, timing: ForkTiming, upstream: string, login: string): Promise<ForkOnServer> {
  return ctx.server.kind === 'github' ? githubFork(ctx, timing, upstream, login) : gitlabFork(ctx, timing, upstream, login);
}

function encodedBranch(branch: string): string {
  return branch.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * The create page of a pull request (GitHub: the upstream's compare page from <fork owner>:<branch>, into targetBranch or the
 * default branch, body the template) or a merge request (GitLab: the fork's new merge request page into the upstream project's
 * id and targetBranch, description the template); undefined when any part fails its check or the address leaves the server's
 * web origin.
 */
export function mergeRequestUrl(server: Pick<ForgeServer, 'kind' | 'webUrl'>, request: { readonly upstreamPath: string; readonly forkPath: string; readonly branch: string; readonly targetBranch?: string; readonly template?: string; readonly targetProjectId?: number }): string | undefined {
  const upstream = checkedRepoPath(server.kind, request.upstreamPath);
  const fork = checkedRepoPath(server.kind, request.forkPath);
  const branch = checkedBranch(request.branch);
  const target = request.targetBranch !== undefined ? checkedBranch(request.targetBranch) : undefined;
  if (upstream === undefined || fork === undefined || branch === undefined || (request.targetBranch !== undefined && target === undefined)) return undefined;
  let url: string;
  if (server.kind === 'github') {
    const query = new URLSearchParams({ expand: '1', ...(request.template !== undefined ? { body: request.template } : {}) });
    const base = target !== undefined ? `${encodedBranch(target)}...` : '';
    url = `${server.webUrl}/${upstream}/compare/${base}${encodeURIComponent(fork.split('/')[0]!)}:${encodedBranch(branch)}?${query.toString()}`;
  } else {
    if (request.targetProjectId === undefined || !Number.isSafeInteger(request.targetProjectId) || request.targetProjectId < 1) return undefined;
    const query = new URLSearchParams({
      'merge_request[source_branch]': branch,
      'merge_request[target_project_id]': String(request.targetProjectId),
      ...(target !== undefined ? { 'merge_request[target_branch]': target } : {}),
      ...(request.template !== undefined ? { 'merge_request[description]': request.template } : {}),
    });
    url = `${server.webUrl}/${fork}/-/merge_requests/new?${query.toString()}`;
  }
  const built = URL.canParse(url) ? new URL(url) : undefined;
  if (!built || built.protocol !== 'https:' || built.origin !== new URL(server.webUrl).origin) return undefined;
  // percent-encoding can grow a template ninefold; past the bound the page opens without it
  if (built.href.length > MAX_CREATE_PAGE_URL_CHARS && request.template !== undefined) {
    const { template: _template, ...bare } = request;
    return mergeRequestUrl(server, bare);
  }
  return built.href;
}

export type PublishAccountsView = { readonly accounts: readonly PublishAccount[] };

/** createdUnusable: the server created path, but its answer gives no address Damocles may add as origin. */
export type CreateRepositoryOutcome =
  | { readonly kind: 'created'; readonly url: string; readonly serverId: string; readonly accountId: string; readonly serverName: string; readonly login: string; readonly path: string }
  | { readonly kind: 'createdUnusable'; readonly serverName: string; readonly path: string; readonly reason: LocalizedText }
  | { readonly kind: 'refused'; readonly reason: LocalizedText }
  | { readonly kind: 'failed'; readonly reason: LocalizedText };

/** The repository a push went to, as main knows it: the project, its remotes' endpoints, and the remote pushed to. */
export interface PushedRepo {
  readonly projectKey?: string;
  readonly authorityKey: string;
  readonly endpoints: readonly RemoteEndpoint[];
}

/**
 * The server's answer for a refused push. canPush: the account may push, so the refusal was something else; unknown: no
 * account, Git's own credentials, or no answer; denied: the account can read but not push (the fork dialog); orgAccess: an
 * organization's SSO or app policy keeps the token out (the refused notice's organization variant).
 */
export type PushAccessOutcome =
  | { readonly access: 'canPush' | 'unknown' }
  | { readonly access: 'denied'; readonly serverId: string; readonly serverName: string; readonly kind: 'github' | 'gitlab'; readonly accountId: string; readonly login: string; readonly path: string }
  | { readonly access: 'orgAccess'; readonly accountId: string; readonly org: string; readonly text: LocalizedText; readonly action: LocalizedText };

/** cancelled: the caller aborted after the server accepted the fork, which stays there as path. */
export type ForkOutcome =
  | { readonly kind: 'forked'; readonly url: string; readonly path: string }
  | { readonly kind: 'cancelled'; readonly path: string }
  | { readonly kind: 'failed'; readonly reason: LocalizedText };

export type MergeRequestPage = { readonly url: string; readonly serverName: string } | { readonly unavailable: LocalizedText };

export interface PublisherDeps {
  readonly servers: () => readonly ForgeServer[];
  readonly accounts: () => readonly AccountRecord[];
  /** Settles once the forge files were read: true, or false when reading them failed. */
  readonly loaded: () => Promise<boolean>;
  readonly bindings: BindingStore;
  readonly http: ForgeHttp;
  readonly withToken: <T>(account: AccountRecord, server: ForgeServer, run: (token: string) => Promise<T>) => Promise<T>;
  readonly needsSignIn: (account: AccountRecord) => boolean;
  /** The access check's one pick among candidates (push, else read). */
  readonly pickByAccess: (candidates: readonly AccountRecord[], server: ForgeServer, repoPath: string) => Promise<AccountRecord | undefined>;
  /** An organization policy the access check met, so Settings and the org page action know it. */
  readonly noteOrgAccess: (account: AccountRecord, finding: { readonly kind: 'ssoRequired' | 'appNotApproved'; readonly org: string; readonly url?: string }) => void;
  readonly protocol: () => 'https' | 'ssh';
  readonly log: (line: string) => void;
  readonly now: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface Publisher {
  /** Every signed-in account with its own namespace; no server is asked. */
  accounts(): Promise<PublishAccountsView>;
  /** One account's organizations or groups; the Owner values a create accepts for the account are those of its latest listing. */
  owners(accountId: string, signal: AbortSignal): Promise<PublishOwnersAnswerOf<LocalizedText>>;
  createRepository(input: { readonly owner: string; readonly name: string; readonly visibility: PublishVisibility }, signal: AbortSignal): Promise<CreateRepositoryOutcome>;
  pushAccess(repo: PushedRepo, remote: string, signal: AbortSignal): Promise<PushAccessOutcome>;
  fork(input: { readonly serverId: string; readonly accountId: string; readonly path: string }, signal: AbortSignal): Promise<ForkOutcome>;
  mergeRequestPage(input: { readonly serverId: string; readonly accountId: string; readonly upstreamPath: string; readonly forkPath: string; readonly branch: string; readonly targetBranch?: string; readonly template?: string }, signal: AbortSignal): Promise<MergeRequestPage>;
}

interface IssuedOwner {
  readonly accountId: string;
  readonly kind: PublishNamespaceKind;
  readonly path: string;
  readonly id?: number;
}

function failureText(err: unknown, server: ForgeServer, account: AccountRecord): LocalizedText {
  if (err instanceof ForgeHttpError) {
    if (err.kind === 'rateLimited') return l('{0} is limiting requests. Try again in a few minutes.', server.id);
    if (err.kind === 'unauthorized') return l('{0} must sign in again on {1}.', account.login, server.id);
    if (err.kind === 'network' || err.kind === 'tls') return l('Could not reach {0}. Check the connection and try again.', server.id);
    if (err.status !== undefined) return l('{0} could not complete the request (HTTP {1}).', server.id, err.status);
  }
  return l('{0} could not complete the request.', server.id);
}

/** Why an organization's SAML SSO or OAuth app policy keeps the account out of org. */
function orgAccessText(kind: 'ssoRequired' | 'appNotApproved', org: string, server: ForgeServer, account: AccountRecord): LocalizedText {
  return kind === 'ssoRequired'
    ? l('The {0} organization on {1} requires single sign-on, and the token of {2} is not authorized for it.', org, server.id, account.login)
    : l('The {0} organization on {1} has not approved Damocles, so the token of {2} cannot see its repositories.', org, server.id, account.login);
}

export function createPublisher(deps: PublisherDeps): Publisher {
  // per account, the Owner values of its latest listing; a value resolves only against these or an account's own namespace
  const listed = new Map<string, Map<string, IssuedOwner>>();
  // per account, the listing started last: only it may replace the account's values
  const latest = new Map<string, number>();
  let listings = 0;
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => sleepFor(ms, undefined, { signal }));

  const usable = (): { account: AccountRecord; server: ForgeServer }[] => {
    const byId = new Map(deps.servers().map((server) => [server.id, server]));
    return deps.accounts().flatMap((account) => {
      const server = byId.get(account.serverId);
      return server && !deps.needsSignIn(account) ? [{ account, server }] : [];
    });
  };

  const found = (serverId: string, accountId: string): { account: AccountRecord; server: ForgeServer } | undefined => {
    const hit = usable().find((item) => item.account.id === accountId);
    // a token goes only to its own server, whichever server a caller names
    return hit && hit.server.id === serverId ? hit : undefined;
  };

  const personalValue = (account: AccountRecord, server: ForgeServer): string => ownerValue(server.id, account.login, 'personal', account.login);

  /** The account and namespace an Owner value names: an account's own namespace, else a value of that account's latest listing. */
  const resolveOwner = (value: string): { account: AccountRecord; server: ForgeServer; owner: IssuedOwner } | undefined => {
    for (const { account, server } of usable()) {
      if (personalValue(account, server) === value) return { account, server, owner: { accountId: account.id, kind: 'personal', path: account.login } };
      const owner = listed.get(account.id)?.get(value);
      if (owner) return { account, server, owner };
    }
    return undefined;
  };

  async function listOwners(account: AccountRecord, server: ForgeServer, signal: AbortSignal): Promise<PublishOwnersAnswerOf<LocalizedText>> {
    const listing = ++listings;
    latest.set(account.id, listing);
    let error: LocalizedText;
    try {
      const answer = await deps.withToken(account, server, (token) => {
        const ctx: ListingContext = { http: deps.http, server, token, signal };
        return server.kind === 'github' ? githubNamespaces(ctx) : gitlabNamespaces(ctx);
      });
      if (signal.aborted) return { status: 'cancelled' };
      const values = new Map<string, IssuedOwner>();
      // ordinal, so the order does not follow core's locale
      const sorted = [...answer.namespaces].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const named = sorted.map((item) => ({ item, value: ownerValue(server.id, account.login, item.kind, item.path) }));
      // a value past the wire's bound would make main refuse the whole listing
      const fitting = named.filter(({ value }) => value.length <= MAX_OWNER_VALUE_CHARS);
      if (fitting.length < named.length) deps.log(`[forge] ${named.length - fitting.length} of ${account.id}'s namespaces have paths too long to offer`);
      const owners = fitting.map(({ item, value }): PublishNamespace => {
        values.set(value, { accountId: account.id, kind: item.kind, path: item.path, ...(item.id !== undefined ? { id: item.id } : {}) });
        return { value, kind: item.kind, path: item.path, internal: offersInternal(server, item.kind) };
      });
      // a listing another caller started later answers too, but only the latest replaces the values core resolves
      if (latest.get(account.id) === listing) listed.set(account.id, values);
      return { status: 'loaded', owners, truncated: answer.cut };
    } catch (err) {
      // the caller's abort ends the listing, whichever error its fetch or body read ended with
      if (signal.aborted) return { status: 'cancelled' };
      if (!(err instanceof ForgeHttpError)) throw err;
      deps.log(`[forge] listing ${account.id}'s namespaces failed: ${err.kind}`);
      const kind = listingErrorOf(err);
      error = kind === 'signInAgain'
        ? l('{0} must sign in again on {1}.', account.login, server.id)
        : kind === 'refused'
          ? l('{0} did not list the organizations and groups of {1}.', server.id, account.login)
          : l('Could not reach {0}. Check the connection and try again.', server.id);
    }
    // the failed listing is the latest: none of the account's earlier values stay valid
    if (latest.get(account.id) === listing) listed.delete(account.id);
    return { status: 'error', message: error };
  }

  return {
    async accounts() {
      if (!(await deps.loaded())) return { accounts: [] };
      return {
        accounts: usable().map(({ account, server }): PublishAccount => ({
          accountId: account.id,
          serverName: server.id,
          login: account.login,
          kind: server.kind,
          personal: { value: personalValue(account, server), kind: 'personal', path: account.login, internal: offersInternal(server, 'personal') },
        })),
      };
    },

    async owners(accountId, signal) {
      if (!(await deps.loaded())) return { status: 'error', message: l('This account is signed out. Open Publish again.') };
      const hit = usable().find((item) => item.account.id === accountId);
      if (!hit) return { status: 'error', message: l('This account is signed out. Open Publish again.') };
      return listOwners(hit.account, hit.server, signal);
    },

    async createRepository(input, signal) {
      const hit = resolveOwner(input.owner);
      if (!hit) return { kind: 'failed', reason: l('This owner is no longer listed. Open Publish again.') };
      const { owner, account, server } = hit;
      const name = sanitizeRepositoryName(input.name);
      if (!isRepositoryName(name)) return { kind: 'refused', reason: l('Use letters, digits, dots, dashes or underscores.') };
      if (input.visibility === 'internal' && !offersInternal(server, owner.kind)) return { kind: 'failed', reason: l('{0} offers no internal visibility here. Choose Private or Public.', server.id) };
      try {
        const answer = await deps.withToken(account, server, (token) => createOnServer({ http: deps.http, server, token, signal }, owner, name, input.visibility));
        if ('refused' in answer) {
          deps.log(`[forge] ${server.id} refused to create a repository (HTTP ${answer.status})`);
          const reason = answer.refused !== undefined ? l('{0} refused: {1}', server.id, answer.refused) : l('{0} refused to create {1}.', server.id, name);
          // only a name the server refuses goes back to the Name field; any other refusal is the create step's failure
          return { kind: answer.nameTaken ? 'refused' : 'failed', reason };
        }
        if ('unnamed' in answer) {
          deps.log(`[forge] ${server.id} created a repository but its answer named no repository path`);
          return { kind: 'createdUnusable', serverName: server.id, path: answer.unnamed, reason: l('{0} answered without the repository\'s path.', server.id) };
        }
        const protocol = deps.protocol();
        const url = checkedCloneUrl(server, protocol === 'ssh' ? answer.created.sshUrl : answer.created.httpsUrl, answer.created.path);
        if (url === undefined) return { kind: 'createdUnusable', serverName: server.id, path: answer.created.path, reason: l('{0} gave no {1} clone address on its own hosts for {2}.', server.id, protocol, answer.created.path) };
        return { kind: 'created', url, serverId: server.id, accountId: account.id, serverName: server.id, login: account.login, path: answer.created.path };
      } catch (err) {
        if (signal.aborted) throw err;
        deps.log(`[forge] creating a repository on ${server.id} failed: ${err instanceof ForgeHttpError ? err.kind : err instanceof Error ? err.name : typeof err}`);
        if (err instanceof ForgeHttpError && (err.kind === 'ssoRequired' || err.kind === 'appNotApproved')) return { kind: 'failed', reason: orgAccessText(err.kind, owner.path, server, account) };
        return { kind: 'failed', reason: failureText(err, server, account) };
      }
    },

    async pushAccess(repo, remote, signal) {
      const endpoint = repo.endpoints.find((item) => item.remote === remote);
      const location = endpoint?.push ?? endpoint?.fetch;
      const withAccounts = new Set(deps.accounts().map((account) => account.serverId));
      const match = location ? matchServer(location, deps.servers().filter((server) => withAccounts.has(server.id))) : undefined;
      const path = match ? checkedRepoPath(match.server.kind, match.repoPath) : undefined;
      if (!match || path === undefined) return { access: 'unknown' };
      const { server } = match;
      const candidates = deps.accounts().filter((account) => account.serverId === server.id);
      const settled = resolveWithoutAccess({ ...(repo.projectKey !== undefined ? { projectKey: repo.projectKey } : {}), authorityKey: repo.authorityKey, server, ...(location!.usernameHint !== undefined ? { usernameHint: location!.usernameHint } : {}) }, candidates, deps.bindings);
      if (settled?.account === null) return { access: 'unknown' };
      const account = settled?.account ?? await deps.pickByAccess(candidates.filter((candidate) => !deps.needsSignIn(candidate)), server, path);
      if (!account || deps.needsSignIn(account)) return { access: 'unknown' };
      try {
        const access = await deps.withToken(account, server, (token) => providerFor(server.kind).repoAccess(deps.http, server, token, path, signal));
        if (access.canPush) return { access: 'canPush' };
        if (!access.readable || access.permissionsUnread === true) return { access: 'unknown' };
        return { access: 'denied', serverId: server.id, serverName: server.id, kind: server.kind, accountId: account.id, login: account.login, path };
      } catch (err) {
        if (signal.aborted || !(err instanceof ForgeHttpError)) throw err;
        if (err.kind === 'ssoRequired' || err.kind === 'appNotApproved') {
          const org = path.split('/')[0]!;
          deps.noteOrgAccess(account, { kind: err.kind, org, ...(err.ssoUrl !== undefined ? { url: err.ssoUrl } : {}) });
          const action = err.kind === 'ssoRequired' ? l('Authorize Damocles for {0}', org) : l('Request approval from {0}', org);
          return { access: 'orgAccess', accountId: account.id, org, text: orgAccessText(err.kind, org, server, account), action };
        }
        deps.log(`[forge] the push access check of ${account.id} on ${server.id} ended: ${err.kind}`);
        return { access: 'unknown' };
      }
    },

    async fork(input, signal) {
      const hit = found(input.serverId, input.accountId);
      if (!hit) return { kind: 'failed', reason: l('The account for {0} is signed out. Sign in again in Settings › Models & accounts › Git hosting, then push again.', input.serverId) };
      const upstream = checkedRepoPath(hit.server.kind, input.path);
      if (upstream === undefined) throw new Error('fork names no repository path');
      const { account, server } = hit;
      try {
        const answer = await deps.withToken(account, server, (token) => forkOnServer({ http: deps.http, server, token, signal }, { now: deps.now, sleep }, upstream, account.login));
        if ('failed' in answer) return { kind: 'failed', reason: answer.failed };
        if ('cancelled' in answer) return { kind: 'cancelled', path: answer.cancelled.path };
        const protocol = deps.protocol();
        const url = checkedCloneUrl(server, protocol === 'ssh' ? answer.forked.sshUrl : answer.forked.httpsUrl, answer.forked.path);
        if (url === undefined) return { kind: 'failed', reason: l('{0} gave no {1} clone address on its own hosts for {2}.', server.id, protocol, answer.forked.path) };
        return { kind: 'forked', url, path: answer.forked.path };
      } catch (err) {
        if (signal.aborted) throw err;
        deps.log(`[forge] forking ${upstream} on ${server.id} failed: ${err instanceof ForgeHttpError ? err.kind : err instanceof Error ? err.name : typeof err}`);
        if (err instanceof ForgeHttpError && (err.kind === 'ssoRequired' || err.kind === 'appNotApproved')) return { kind: 'failed', reason: orgAccessText(err.kind, upstream.split('/')[0]!, server, account) };
        return { kind: 'failed', reason: failureText(err, server, account) };
      }
    },

    async mergeRequestPage(input, signal) {
      const hit = found(input.serverId, input.accountId);
      if (!hit) return { unavailable: l('The account for {0} is signed out. Sign in again in Settings › Models & accounts › Git hosting.', input.serverId) };
      const { account, server } = hit;
      let targetProjectId: number | undefined;
      if (server.kind === 'gitlab') {
        const upstream = checkedRepoPath('gitlab', input.upstreamPath);
        if (upstream === undefined) return { unavailable: l('Damocles cannot build a link for this repository.') };
        try {
          const project = await deps.withToken(account, server, (token) => deps.http.request({ server, url: `/projects/${encodeURIComponent(upstream)}`, template: '/projects/{path}', credential: { bearer: token }, signal }));
          targetProjectId = numberField(project.body, 'id');
        } catch (err) {
          if (signal.aborted || !(err instanceof ForgeHttpError)) throw err;
          deps.log(`[forge] reading ${server.id}'s project id for a merge request failed: ${err.kind}`);
          return { unavailable: failureText(err, server, account) };
        }
      }
      const url = mergeRequestUrl(server, { upstreamPath: input.upstreamPath, forkPath: input.forkPath, branch: input.branch, ...(input.targetBranch !== undefined ? { targetBranch: input.targetBranch } : {}), ...(input.template !== undefined ? { template: input.template } : {}), ...(targetProjectId !== undefined ? { targetProjectId } : {}) });
      return url !== undefined ? { url, serverName: server.id } : { unavailable: l('Damocles cannot build a link for this repository.') };
    },
  };
}
