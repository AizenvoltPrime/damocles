// The clone picker's repository listings, adapted from VS Code's extensions/github/src/remoteSourceProvider.ts
// (GithubRemoteSourceProvider), Copyright (c) Microsoft Corporation, and GitLab Workflow for VS Code's
// src/desktop/gitlab/clone/gitlab_remote_source.ts and gitlab/api/get_projects_with_repository_info.ts, Copyright (c)
// 2020-present GitLab Inc. Both licensed under the MIT License (THIRD-PARTY-NOTICES.md).
import { isRemoteUrl } from '../../shared/clone-address';
import type { ClonePill, CloneSearchError, CloneVisibility } from '../../shared/forge/clone';
import { boundedVisible } from '../../shared/visible-text';
import { field, stringField, type ForgeHttp } from './http';
import { locationOf, matchServer, parseRemoteUrl } from './remote-url';
import { checkedRepoPath } from './tools/api';
import { ForgeHttpError, type ForgeServer } from './types';

// docs/invariants.md "GitHub and GitLab accounts", clone picker: a listed clone URL is kept only when it points at the
// account's own server (its web host or one of its git hosts) at the listed repository path.

/** GitHub's listing and search pages, GitLab's listing and search size (docs/invariants.md "The clone picker keeps every clone address in core"). */
export const GITHUB_LISTING_SIZE = 100;
export const GITHUB_SEARCH_SIZE = 30;
export const GITLAB_SEARCH_SIZE = 30;
const MAX_DESCRIPTION_CHARS = 300;

/** One repository the account can see, with the clone URLs core keeps to itself. */
export interface ListedRepo {
  /** "grp/platform/intranet" or "owner/repo", checked by checkedRepoPath. */
  readonly path: string;
  readonly description?: string;
  readonly visibility: CloneVisibility;
  readonly pill?: ClonePill;
  readonly updatedAt?: string;
  readonly httpsUrl?: string;
  readonly sshUrl?: string;
}

export interface ListingContext {
  readonly http: ForgeHttp;
  readonly server: ForgeServer;
  readonly token: string;
  readonly signal: AbortSignal;
}

/** A listing's failure as the user can act on it: sign in again, a refusal of the server or an organization, or no answer. */
export function listingErrorOf(err: ForgeHttpError): CloneSearchError {
  if (err.kind === 'unauthorized') return 'signInAgain';
  return err.kind === 'forbidden' || err.kind === 'ssoRequired' || err.kind === 'appNotApproved' ? 'refused' : 'unreachable';
}

// an ssh user git passes to ssh as user@host: never an option, never a shell or ssh_config metacharacter
const SSH_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/**
 * A listed clone URL, kept only when git may take it as argv (isRemoteUrl), it parses as an https or ssh remote on server at
 * repoPath, its ssh user is a plain name, it carries no https user or password, and names nothing else; undefined otherwise.
 */
export function checkedCloneUrl(server: ForgeServer, url: unknown, repoPath: string): string | undefined {
  if (typeof url !== 'string' || !isRemoteUrl(url) || url !== url.trim()) return undefined;
  const parsed = parseRemoteUrl(url);
  if (!parsed) return undefined;
  if (parsed.protocol === 'ssh' && parsed.user !== undefined && !SSH_USER.test(parsed.user)) return undefined;
  if (parsed.protocol === 'https') {
    const https = URL.canParse(url) ? new URL(url) : undefined;
    if (!https || https.username !== '' || https.password !== '' || https.search !== '' || https.hash !== '') return undefined;
  }
  return matchServer(locationOf(parsed), [server])?.repoPath === repoPath ? url : undefined;
}

const VISIBILITIES: ReadonlySet<string> = new Set(['public', 'private', 'internal']);

// line breaks and tabs read as spaces; every other hidden character shows as its escape
function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ').trim();
  return line === '' ? undefined : boundedVisible(line, MAX_DESCRIPTION_CHARS);
}

function isoTime(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function githubRepo(server: ForgeServer, raw: unknown): ListedRepo | undefined {
  const fullName = stringField(raw, 'full_name');
  const path = fullName !== undefined ? checkedRepoPath('github', fullName) : undefined;
  if (path === undefined) return undefined;
  const declared = stringField(raw, 'visibility');
  const visibility: CloneVisibility = declared !== undefined && VISIBILITIES.has(declared) ? (declared as CloneVisibility) : field(raw, 'private') === true ? 'private' : 'public';
  const pill: ClonePill | undefined = field(raw, 'archived') === true ? 'archived' : typeof field(raw, 'mirror_url') === 'string' ? 'mirror' : field(raw, 'fork') === true ? 'fork' : undefined;
  const description = cleanDescription(field(raw, 'description'));
  // the time sort=updated orders by
  const updatedAt = isoTime(field(raw, 'updated_at'));
  const httpsUrl = checkedCloneUrl(server, field(raw, 'clone_url'), path);
  const sshUrl = checkedCloneUrl(server, field(raw, 'ssh_url'), path);
  return { path, visibility, ...(pill ? { pill } : {}), ...(description !== undefined ? { description } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}), ...(httpsUrl !== undefined ? { httpsUrl } : {}), ...(sshUrl !== undefined ? { sshUrl } : {}) };
}

/** GET /user/repos?sort=updated&per_page=100: the repositories the account owns, collaborates on or reaches through an organization. */
export async function githubUserRepos(ctx: ListingContext): Promise<ListedRepo[]> {
  const response = await ctx.http.request({ server: ctx.server, url: `/user/repos?sort=updated&per_page=${GITHUB_LISTING_SIZE}`, template: '/user/repos', credential: { bearer: ctx.token }, signal: ctx.signal });
  if (!Array.isArray(response.body)) throw new ForgeHttpError('server', 'GET /user/repos answered without a list');
  return response.body.flatMap((raw) => githubRepo(ctx.server, raw) ?? []);
}

/**
 * The search terms of a typed query: letters, digits and . _ - only, so no search qualifier comes from the user; "owner/name"
 * searches name under owner, as getRepositoryFromQuery does.
 */
export function githubSearchQuery(query: string, login: string): string | undefined {
  // an Enterprise Managed User's login is handle_shortcode
  const owned = /^([A-Za-z0-9_-]{1,39})\/([A-Za-z0-9_.-]*)$/.exec(query.trim());
  const terms = (owned ? owned[2]! : query).split(/[^A-Za-z0-9_.-]+/).filter((term) => term !== '').slice(0, 5);
  if (terms.length === 0 && !owned) return undefined;
  return [...terms, 'in:name', 'fork:true', `user:${owned ? owned[1]! : login}`].join(' ');
}

/** GET /search/repositories for a typed query, the account's own (or the typed owner's) repositories by name. */
export async function githubSearchRepos(ctx: ListingContext, query: string, login: string): Promise<ListedRepo[]> {
  const q = githubSearchQuery(query, login);
  if (q === undefined) return [];
  const params = new URLSearchParams({ q, per_page: String(GITHUB_SEARCH_SIZE) });
  const response = await ctx.http.request({ server: ctx.server, url: `/search/repositories?${params.toString()}`, template: '/search/repositories', credential: { bearer: ctx.token }, signal: ctx.signal });
  const items = field(response.body, 'items');
  if (!Array.isArray(items)) throw new ForgeHttpError('server', 'GET /search/repositories answered without items');
  return items.flatMap((raw) => githubRepo(ctx.server, raw) ?? []);
}

/** Whether a listed repository matches a typed query: every word in its path or description, ignoring case. */
export function matchesQuery(repo: ListedRepo, query: string): boolean {
  const haystack = `${repo.path} ${repo.description ?? ''}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter((word) => word !== '').every((word) => haystack.includes(word));
}

const GITLAB_PROJECTS_QUERY = `query DamoclesCloneProjects($search: String, $membership: Boolean, $first: Int, $searchNamespaces: Boolean) {
  projects(search: $search, membership: $membership, first: $first, searchNamespaces: $searchNamespaces) {
    nodes { fullPath description visibility archived lastActivityAt httpUrlToRepo sshUrlToRepo repository { empty } }
  }
}`;

/** One GitLab project's fields, named as GraphQL's projects and REST's GET /projects each name them. */
interface GitlabProjectFields {
  readonly fullPath: unknown;
  readonly description: unknown;
  readonly visibility: unknown;
  readonly archived: unknown;
  readonly lastActivityAt: unknown;
  readonly httpUrl: unknown;
  readonly sshUrl: unknown;
}

function gitlabProject(server: ForgeServer, fields: GitlabProjectFields): ListedRepo | undefined {
  const path = typeof fields.fullPath === 'string' ? checkedRepoPath('gitlab', fields.fullPath) : undefined;
  if (path === undefined) return undefined;
  const visibility: CloneVisibility = typeof fields.visibility === 'string' && VISIBILITIES.has(fields.visibility) ? (fields.visibility as CloneVisibility) : 'private';
  const description = cleanDescription(fields.description);
  const updatedAt = isoTime(fields.lastActivityAt);
  const httpsUrl = checkedCloneUrl(server, fields.httpUrl, path);
  const sshUrl = checkedCloneUrl(server, fields.sshUrl, path);
  return { path, visibility, ...(fields.archived === true ? { pill: 'archived' as const } : {}), ...(description !== undefined ? { description } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}), ...(httpsUrl !== undefined ? { httpsUrl } : {}), ...(sshUrl !== undefined ? { sshUrl } : {}) };
}

/**
 * GET /projects?membership=true&order_by=last_activity_at&sort=desc&per_page=30, the newest by activity: GraphQL's projects
 * documents no activity sort on GitLab 16.1 (docs/invariants.md "The clone picker keeps every clone address in core").
 */
async function gitlabRecentProjects(ctx: ListingContext): Promise<ListedRepo[]> {
  const response = await ctx.http.request({ server: ctx.server, url: `/projects?membership=true&order_by=last_activity_at&sort=desc&per_page=${GITLAB_SEARCH_SIZE}`, template: '/projects', credential: { bearer: ctx.token }, signal: ctx.signal });
  if (!Array.isArray(response.body)) throw new ForgeHttpError('server', 'GET /projects answered without a list');
  return response.body
    .filter((raw) => field(raw, 'empty_repo') !== true)
    .flatMap((raw) => gitlabProject(ctx.server, { fullPath: field(raw, 'path_with_namespace'), description: field(raw, 'description'), visibility: field(raw, 'visibility'), archived: field(raw, 'archived'), lastActivityAt: field(raw, 'last_activity_at'), httpUrl: field(raw, 'http_url_to_repo'), sshUrl: field(raw, 'ssh_url_to_repo') }) ?? []);
}

/**
 * The account's projects, empty repositories left out, newest activity first: the recent listing for an empty query, else
 * GraphQL projects(search, membership: true, first: 30, searchNamespaces: true).
 */
export async function gitlabProjects(ctx: ListingContext, query: string): Promise<ListedRepo[]> {
  const search = query.trim();
  if (search === '') return gitlabRecentProjects(ctx);
  const response = await ctx.http.request({
    server: ctx.server,
    method: 'POST',
    url: `${ctx.server.webUrl}/api/graphql`,
    template: '/api/graphql projects',
    credential: { bearer: ctx.token },
    json: { query: GITLAB_PROJECTS_QUERY, variables: { search, membership: true, first: GITLAB_SEARCH_SIZE, searchNamespaces: true } },
    signal: ctx.signal,
  });
  const nodes = field(field(field(response.body, 'data'), 'projects'), 'nodes');
  if (!Array.isArray(nodes)) throw new ForgeHttpError('server', 'GraphQL projects answered without nodes');
  const listed = nodes
    .filter((raw) => field(field(raw, 'repository'), 'empty') !== true)
    .flatMap((raw) => gitlabProject(ctx.server, { fullPath: field(raw, 'fullPath'), description: field(raw, 'description'), visibility: field(raw, 'visibility'), archived: field(raw, 'archived'), lastActivityAt: field(raw, 'lastActivityAt'), httpUrl: field(raw, 'httpUrlToRepo'), sshUrl: field(raw, 'sshUrlToRepo') }) ?? []);
  return listed.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
