import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import picomatch from 'picomatch';
import { answerCi, answerGithubLog, answerGithubToolsGraphql, CiUi, type StubWrite } from './forge-stub-ci';
import { answerGithubHistoryGraphql, answerHistory, answerSpecialPicture, HistoryUi, startPictures, STUB_PNG, type StubPictures } from './forge-stub-history';

// A GitHub and GitLab stand-in for the forge tests and the desktop e2e specs (re-exported by e2e/desktop/support/forge-stub.ts):
// the REST APIs Damocles reads, OAuth authorize and token endpoints with PKCE, the device flow, revoke, account and author
// pictures (with a third-party picture host, forge-stub-history.ts), smart-HTTP git through `git http-backend` and a Git LFS
// batch API, both taking a live access token as the password, and a revoke switch. Each server is its own https listener, on
// 127.0.0.1 unless the caller names an address, with the caller's certificate (e2e/desktop/support/certs.ts). Fixtures are
// sample data.
// It never logs a token, code or verifier; `requests` records method, path and the credential that came, in memory only, so a
// test can check that each token reached only its own server.

export type StubKind = 'github' | 'gitlab';

export interface StubUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly bot?: boolean;
  /** GitHub organizations the user belongs to. */
  readonly orgs?: readonly string[];
}

/** A personal access token the stub accepts: its user and scopes. */
export interface StubPat {
  readonly login: string;
  readonly scopes: readonly string[];
  /** GitHub: a fine-grained token answers without X-OAuth-Scopes. */
  readonly fineGrained?: boolean;
}

export interface StubServerSpec {
  readonly name: string;
  readonly kind: StubKind;
  readonly users: readonly StubUser[];
  readonly pats: Readonly<Record<string, StubPat>>;
  readonly clientId: string;
  /** GitHub apps: the secret the code exchange and the revoke need. */
  readonly clientSecret?: string;
  /** GitLab /version, or GHES /meta installed_version. */
  readonly version?: string;
  /** GHES GET /versions; undefined answers 404. A request whose X-GitHub-Api-Version is not among them is answered 400. */
  readonly apiVersions?: readonly string[];
  /** The clone URLs GET /projects or GET /user/repos names, from which Damocles learns git hosts. */
  readonly cloneUrls?: { readonly https: string; readonly ssh: string };
  /** Repositories by path ("grp/sub/proj", "owner/repo") and each login's access to them; a login missing has none (404). */
  readonly projects?: Readonly<Record<string, Readonly<Record<string, StubAccess>>>>;
  /** The clone picker's listings: GitHub GET /user/repos and /search/repositories, GitLab GET /projects and GraphQL projects. */
  readonly repos?: readonly StubRepo[];
  /** GitLab groups (nested ones by full path) and each login's level; Publish lists those at 30 or more (CREATE_PROJECTS). */
  readonly groups?: readonly StubGroup[];
}

export interface StubGroup {
  readonly path: string;
  readonly id: number;
  readonly members: Readonly<Record<string, number>>;
}

/** A repository the stub made: a Publish create or a fork, with its served bare repository when the stub has a gitRoot. */
export interface StubCreated {
  readonly path: string;
  readonly login: string;
  readonly visibility: string;
  /** The fork's upstream path; absent for a created repository. */
  readonly forkOf?: string;
}

/** One repository as the listings show it; its clone URLs are the stub's own (https://<stub>/<path>.git, git@<host>:<path>.git). */
export interface StubRepo {
  readonly path: string;
  readonly description?: string;
  readonly visibility: 'public' | 'private' | 'internal';
  /** Minutes before the stub started that it was last updated. */
  readonly ageMinutes: number;
  /** The logins that list it. */
  readonly members: readonly string[];
  readonly archived?: boolean;
  readonly fork?: boolean;
  /** GitLab: a repository with no commits, which the picker leaves out. */
  readonly empty?: boolean;
}

/** A GitHub ruleset; one with parent is the organization's, which the GraphQL rulesets answer only with includeParents. */
export interface StubRuleset {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  /** ACTIVE by default. */
  readonly enforcement?: 'ACTIVE' | 'DISABLED' | 'EVALUATE';
  /** BRANCH by default. */
  readonly target?: 'BRANCH' | 'TAG';
  /** It requires a pull request; true by default. */
  readonly pullRequest?: boolean;
  readonly parent?: boolean;
}

/** One entry of a GitLab protected branch's push_access_levels. */
export interface StubPushAccess {
  readonly access_level?: number;
  readonly user_id?: number;
  readonly group_id?: number;
}

/**
 * A repository's branch protection: GitHub rulesets and classic protected branch names (with the logins their rule lets push,
 * as an administrator past a rule that does not include administrators), GitLab protected branches.
 */
export interface StubProtection {
  readonly rulesets?: readonly StubRuleset[];
  readonly classic?: readonly string[];
  readonly classicPushers?: readonly string[];
  readonly protectedBranches?: readonly { readonly name: string; readonly push: readonly StubPushAccess[] }[];
}

/**
 * A login's access to a repository as GitLab levels: 10 guest, 20 reporter, 30 developer (push), 40 maintainer, 50 owner.
 * GitLab's REST answers project and group as project_access and group_access, and never shared (a group the project is
 * shared with), which GraphQL's maxAccessLevel and pushCode count; `{}` is a non-member who sees a public project. GitHub
 * answers the highest as permissions (pull below 30, push from 30, admin at 50).
 */
export type StubAccess = number | { readonly project?: number; readonly group?: number; readonly shared?: number };

/** The stub's sample data, which the forge e2e specs and screenshots replay. */
export const FORGE_FIXTURES = {
  github: {
    name: 'github.com',
    kind: 'github',
    clientId: 'Ov23stubDamoclesGitHub',
    clientSecret: 'stub-github-client-secret',
    users: [
      { id: 1001, login: 'astefanopoulos', name: 'Alexios Stefanopoulos', orgs: ['damocles-app', 'indigital'] },
      { id: 1002, login: 'astef-admin', name: 'Alexios (admin)', orgs: ['legacy-corp'] },
    ],
    pats: {
      ghp_stubAstefanopoulosRepo0000000001: { login: 'astefanopoulos', scopes: ['repo', 'read:org', 'workflow'] },
      ghp_stubAstefanopoulosNoRepo00000002: { login: 'astefanopoulos', scopes: ['read:user'] },
      github_pat_stubFineGrainedAstefAdmin000003: { login: 'astef-admin', scopes: [], fineGrained: true },
    },
    cloneUrls: { https: 'https://github.com/astefanopoulos/damocles.git', ssh: 'git@github.com:astefanopoulos/damocles.git' },
    projects: {
      'astefanopoulos/damocles': { astefanopoulos: 50, 'astef-admin': 20 },
      // an organization with SAML SSO (SSO_ORGS): astefanopoulos must authorize the token for it
      'indigital/portal': { astefanopoulos: 30 },
    },
    repos: [
      { path: 'astefanopoulos/damocles', description: 'Desktop agent shell', visibility: 'private', ageMinutes: 60, members: ['astefanopoulos'] },
      { path: 'astefanopoulos/dotfiles', description: 'Shell setup', visibility: 'public', ageMinutes: 43_200, members: ['astefanopoulos'] },
      { path: 'astefanopoulos/vscode', description: 'Code editing. Redefined.', visibility: 'public', ageMinutes: 86_400, members: ['astefanopoulos'], fork: true },
      { path: 'indigital/old-portal', description: 'The portal before 2024', visibility: 'private', ageMinutes: 525_600, members: ['astefanopoulos'], archived: true },
    ],
  },
  gitlab: {
    name: 'gitlab.com',
    kind: 'gitlab',
    clientId: 'stub-damocles-gitlab-application-id',
    version: '18.6.0-ee',
    users: [
      { id: 2001, login: 'alexios-s', name: 'Alexios S.' },
      { id: 2002, login: 'work-alexios', name: 'Alexios at Indigital' },
      { id: 2099, login: 'project_42_bot', name: 'CI bot', bot: true },
      // a username hint's account (https://alice@gitlab.com/...)
      { id: 2003, login: 'alice', name: 'Alice' },
    ],
    pats: {
      'glpat-stubWorkAlexiosApi000001': { login: 'work-alexios', scopes: ['api'] },
      'glpat-stubWorkAlexiosRead00002': { login: 'work-alexios', scopes: ['read_api', 'read_user'] },
      'glpat-stubProjectBotApiOnly003': { login: 'project_42_bot', scopes: ['api'] },
      'glpat-stubAlexiosSApi000000008': { login: 'alexios-s', scopes: ['api'] },
      'glpat-stubAliceApi00000000009': { login: 'alice', scopes: ['api'] },
    },
    cloneUrls: { https: 'https://gitlab.com/alexios-s/notes.git', ssh: 'git@gitlab.com:alexios-s/notes.git' },
    groups: [
      { path: 'indigital-oss', id: 301, members: { 'alexios-s': 40 } },
      // a group alexios-s only reads: Publish does not list it
      { path: 'readers', id: 302, members: { 'alexios-s': 20 } },
    ],
    projects: {
      // both accounts can push: resolution asks
      'alexios-s/damocles': { 'alexios-s': 50, 'work-alexios': 30 },
      // only work-alexios can push, through its group: the access check picks it
      'indigital/tools/deploy': { 'alexios-s': 20, 'work-alexios': { group: 40 } },
      'grp/sub/proj': { 'alexios-s': 30, 'work-alexios': 10 },
    },
    repos: [
      { path: 'alexios-s/damocles', description: 'Fork of grp/damocles', visibility: 'public', ageMinutes: 300, members: ['alexios-s'] },
      { path: 'alexios-s/personal-site', description: 'My website', visibility: 'public', ageMinutes: 20_160, members: ['alexios-s'] },
      { path: 'alexios-s/scratch', visibility: 'private', ageMinutes: 10, members: ['alexios-s'], empty: true },
    ],
  },
  /** A company's self-managed GitLab; its git host differs from its web host. */
  indigital: {
    name: 'gitlab.indigital.gr',
    kind: 'gitlab',
    clientId: 'stub-indigital-application-id',
    version: '17.9.1-ee',
    users: [
      { id: 31, login: 'work-alexios', name: 'Alexios at Indigital' },
      { id: 32, login: 'astefanopoulos', name: 'Alexios Stefanopoulos' },
      { id: 33, login: 'astef-admin', name: 'Alexios (admin)' },
    ],
    pats: {
      'glpat-stubIndigitalWorkApi00004': { login: 'work-alexios', scopes: ['api'] },
      'glpat-stubIndigitalAstefApi00006': { login: 'astefanopoulos', scopes: ['api'] },
      'glpat-stubIndigitalAdminApi00007': { login: 'astef-admin', scopes: ['api'] },
    },
    cloneUrls: { https: 'https://git.indigital.gr/platform/api.git', ssh: 'git@git.indigital.gr:platform/api.git' },
    groups: [
      { path: 'grp', id: 401, members: { astefanopoulos: 40, 'work-alexios': 30 } },
      { path: 'grp/platform', id: 402, members: { astefanopoulos: 40 } },
    ],
    projects: {
      'platform/api': { astefanopoulos: 30, 'astef-admin': 50, 'work-alexios': 20 },
      'platform/web': { astefanopoulos: 30, 'astef-admin': { group: 50 } },
      // the fork dialog: astefanopoulos reads it but cannot push (enforcePushAccess), and a Publish of grp/damocles is refused
      'grp/damocles': { astefanopoulos: 20, 'work-alexios': 30 },
    },
    repos: [
      { path: 'grp/damocles', description: 'Desktop agent shell', visibility: 'private', ageMinutes: 120, members: ['astefanopoulos', 'work-alexios'] },
      { path: 'grp/platform/intranet', description: 'Company intranet', visibility: 'internal', ageMinutes: 1440, members: ['astefanopoulos', 'work-alexios'] },
      { path: 'grp/platform/api-gateway', description: 'Edge routing for services', visibility: 'private', ageMinutes: 4320, members: ['astefanopoulos'] },
    ],
  },
  /** A GitHub Enterprise Server with its own OAuth app. */
  ghes: {
    name: 'github.indigital.gr',
    kind: 'github',
    clientId: 'Ov23stubIndigitalGhes',
    clientSecret: 'stub-ghes-client-secret',
    version: '3.17.2',
    apiVersions: ['2022-11-28'],
    users: [{ id: 501, login: 'astefanopoulos', name: 'Alexios Stefanopoulos', orgs: [] }],
    pats: {
      ghp_stubGhesAstefanopoulosRepo0000005: { login: 'astefanopoulos', scopes: ['repo'] },
    },
  },
  /** Remote host and CI sample data; the CI, merge request and issue data is forge-stub-ci.ts's CI_FIXTURES. */
  host: 'prod-1',
  pipeline: { iid: 4312, jobs: ['unit', 'e2e'] },
} as const satisfies Record<string, unknown>;

/** GitHub org rules the stub enforces on GET /orgs/{org}/members. */
const SSO_ORGS: ReadonlySet<string> = new Set(['indigital']);
const RESTRICTED_ORGS: ReadonlySet<string> = new Set(['legacy-corp']);

const AVATAR_PNG = STUB_PNG;

interface IssuedToken {
  readonly login: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  revoked: boolean;
}

interface PendingCode {
  readonly login: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly clientId: string;
}

interface PendingDevice {
  readonly userCode: string;
  state: 'pending' | 'approved' | 'denied';
  login?: string;
  polls: number;
}

export interface StubRequest {
  readonly method: string;
  /** Without the query. */
  readonly path: string;
  readonly authorized: boolean;
  /** The token or password the request carried; kept in memory for the own-server assertions, never logged. */
  readonly credential?: string;
  /** The user name of HTTP basic auth (git and Git LFS send one). */
  readonly username?: string;
  /** The server's web origin, https://127.0.0.1:<port>. */
  readonly origin: string;
  /** The X-GitHub-Api-Version header the request carried. */
  readonly apiVersion?: string;
}

export interface StubServer {
  readonly spec: StubServerSpec;
  /** https://127.0.0.1:<port> */
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly requests: StubRequest[];
  /** The authorize URLs' query parameters, without state and code_challenge. */
  readonly authorizeParams: Record<string, string>[];
  readonly counts: { exchanges: number; refreshes: number; revokes: number; devicePolls: number; gitServed: number; gitRefused: number };
  /** Every access and refresh token, authorization code, PKCE verifier and device code the stub issued or saw, its PATs and client secret: what a log scan looks for. */
  issuedSecrets(): string[];
  /** The login the next browser authorization signs in as (GitHub honors `login=` over it). */
  nextLogin: string;
  /** Access token lifetime in seconds for the next grants; undefined issues tokens that never expire. */
  tokenTtlSeconds: number | undefined;
  /** Revoke endpoints refuse while set. */
  failRevoke: boolean;
  /** The token endpoint answers 502 while set (a network-level failure seen as a server error). */
  failTokenEndpoint: boolean;
  /** Logins whose SAML SSO authorization for SSO_ORGS is in place. */
  readonly ssoAuthorized: Set<string>;
  /** Access by repository path and login, seeded from spec.projects; a test may change it. */
  readonly projectAccess: Map<string, Map<string, StubAccess>>;
  /** GET /repos and GET /projects/:path wait this long before answering (the Choose account dialog's checking state). */
  accessDelayMs: number;
  /** GET /repos and GET /projects/:path drop the connection while set (the account chip's check failure). */
  failAccess: boolean;
  /** Logins whose every token the API and git refuse with 401 (an account that must sign in again). */
  readonly refusedLogins: Set<string>;
  /** The REST and GraphQL APIs drop every connection while set (a server that does not answer); git is untouched. */
  unreachable: boolean;
  /** The clone picker's listings and searches wait this long before answering (its per-section loading row). */
  listingDelayMs: number;
  /** Publish's organization and group listings (GitHub GET /user/orgs, GitLab GraphQL groups) wait this long before answering. */
  namespaceDelayMs: number;
  /** Each GitHub /search/repositories q and GitLab GraphQL projects variables the stub received, in order. */
  readonly searchQueries: string[];
  readonly graphqlVariables: Record<string, unknown>[];
  /** GitLab: the query parameters of each GET /projects listing (not the git-host learning's simple read), in order. */
  readonly projectListings: Record<string, string>[];
  /**
   * The server revokes every access token it issued to login, so GET /user and git answer 401 for them; with refresh, its
   * refresh tokens stop working too. PATs are not touched.
   */
  revokeTokens(login: string, options?: { readonly refresh?: boolean }): void;
  /** The agent tools' writes the stub received (comments, job actions, opened merge requests), in order. */
  readonly forgeWrites: StubWrite[];
  /** The CI chip's pipeline, which a test may steer (forge-stub-ci.ts). */
  readonly ci: CiUi;
  /** History details: each commit's merge requests or pulls and GitHub commit authors, which a test may steer (forge-stub-history.ts). */
  readonly history: HistoryUi;
  /**
   * Every avatar request this server got, as "METHOD path" without the query: GET /api/v4/avatar, pictures under
   * /uploads/-/system/user/avatar/ and /avatars/, and GitHub's assignableUsers and commitAuthors as "POST /api/graphql <name>".
   */
  avatarRequests(): string[];
  /** Publish creates and forks the stub made, in order. */
  readonly created: StubCreated[];
  /**
   * git receive-pack answers 403 to a login below level 30 on a repository projectAccess lists (the denied push the fork dialog follows), and to a
   * push that updates a branch `protection` protects from the login.
   */
  enforcePushAccess: boolean;
  /** Branch protection by repository path, served by the APIs Damocles reads; empty until a test sets it. */
  readonly protection: Map<string, StubProtection>;
  /** Every GitHub GraphQL query name and variables the stub received, in order. */
  readonly graphqlQueries: { readonly name: string; readonly variables: Record<string, unknown> }[];
  /** GitLab: each project path the GraphQL project query (the access check's and the protection read's) asked about, in order. */
  readonly accessChecks: string[];
  /** GET polls a new fork answers as not ready (GitHub 404, GitLab import_status scheduled then started); Infinity never finishes. */
  forkPolls: number;
  /** The fork call answers HTTP 500. */
  failFork: boolean;
  /** Git LFS objects the batch API accepted, by repository path and oid: their bytes and the basic auth that uploaded them. */
  readonly lfsObjects: Map<string, Map<string, { readonly data: Buffer; readonly username: string; readonly credential: string }>>;
  /** The user code of the newest device authorization. */
  deviceUserCode(): string | undefined;
  approveDevice(login: string): void;
  denyDevice(): void;
  /** Plays the browser: follows the authorize URL to the loopback redirect and returns the callback's status. */
  completeBrowser(authorizeUrl: string): Promise<number>;
  /** Whether the token is live (issued or a PAT, not revoked or expired). */
  isLive(token: string): boolean;
  /** The login of a live access token or PAT; undefined for a refresh token, a revoked or expired token and anything else. */
  tokenLogin(token: string): string | undefined;
  revoked(): string[];
}

export interface ForgeStubOptions {
  readonly cert: string;
  readonly key: string;
  /** The CA that signed cert, which completeBrowser trusts. */
  readonly ca: string;
  /** Bare repositories served by smart HTTP at /<path>.git; none: git requests answer 401. */
  readonly gitRoot?: string;
  /** The address the servers listen on; 127.0.0.1 by default. */
  readonly listenAddress?: string;
  /** The host name in the servers' URLs, which cert must name (host.docker.internal for a container); 127.0.0.1 by default. */
  readonly publicHost?: string;
  /** The clock the CI chip's running log grows by; Date.now by default. */
  readonly now?: () => number;
}

/** GitHub's log storage stand-in: another origin, which job log redirects lead to. */
export interface StubLogStorage {
  /** https://127.0.0.1:<port> */
  readonly url: string;
  readonly requests: { readonly path: string; readonly authorized: boolean }[];
  /** How many of the next requests it ends by dropping the connection, unanswered. */
  dropNext: number;
}

export interface ForgeStub {
  readonly github: StubServer;
  readonly logStorage: StubLogStorage;
  /** The third-party picture host (a Gravatar stand-in) the authors' pictures may name; it must never see a credential. */
  readonly pictures: StubPictures;
  readonly gitlab: StubServer;
  readonly indigital: StubServer;
  readonly ghes: StubServer;
  /** DAMOCLES_E2E_FORGE_SERVERS for the app: github.com and gitlab.com pointed at this stub, with its OAuth clients. */
  e2eServersEnv(): string;
  close(): Promise<void>;
}

const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier, 'ascii').digest('base64url');

/** The redirect URI the stub's GitLab applications register, as Git Credential Manager's gitlab.com app does. */
const GITLAB_REGISTERED_REDIRECT = 'http://127.0.0.1/callback';

/** Doorkeeper's URIChecker.matches?: the port drops out when both URIs name a loopback IP literal (RFC 8252 7.3). */
function doorkeeperRedirectMatches(requested: string, registered: string): boolean {
  if (!URL.canParse(requested) || !URL.canParse(registered)) return false;
  const asked = new URL(requested);
  const known = new URL(registered);
  if (asked.hash !== '') return false;
  const loopbackIp = (url: URL): boolean => /^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]';
  if (loopbackIp(asked) && loopbackIp(known)) {
    asked.port = '';
    known.port = '';
  }
  if (known.search === '') asked.search = '';
  return asked.href === known.href;
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function bearerOf(request: import('node:http').IncomingMessage): string | undefined {
  const header = request.headers.authorization ?? '';
  const bearer = /^(?:Bearer|token) (.+)$/i.exec(header);
  if (bearer) return bearer[1];
  const basic = /^Basic (.+)$/i.exec(header);
  if (!basic) return undefined;
  const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
  return decoded.slice(decoded.indexOf(':') + 1);
}

/** The refs a receive-pack request updates: its pkt-line commands `<old> <new> <ref>`, up to the flush. */
function pushedRefs(body: Buffer): string[] {
  const refs: string[] = [];
  for (let at = 0; at + 4 <= body.length;) {
    const length = Number.parseInt(body.subarray(at, at + 4).toString('ascii'), 16);
    if (!Number.isInteger(length) || length < 4) break;
    const ref = body.subarray(at + 4, at + length).toString('utf8').split('\0')[0]!.trim().split(' ')[2];
    if (ref !== undefined) refs.push(ref);
    at += length;
  }
  return refs;
}

function basicOf(request: import('node:http').IncomingMessage): { user: string; password: string } | undefined {
  const basic = /^Basic (.+)$/i.exec(request.headers.authorization ?? '');
  if (!basic) return undefined;
  const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

async function startServer(spec: StubServerSpec, options: ForgeStubOptions, logStorage: string, picturesUrl: string): Promise<StubServer & { close(): Promise<void> }> {
  const issued = new Map<string, IssuedToken>();
  const refreshTokens = new Map<string, { login: string; scopes: readonly string[]; used: boolean }>();
  const codes = new Map<string, PendingCode>();
  const devices = new Map<string, PendingDevice>();
  const revokedTokens: string[] = [];
  // codes, verifiers and device codes, kept for issuedSecrets
  const seen: string[] = [];
  const sockets = new Set<Duplex>();
  const backends = new Set<ChildProcess>();
  let newestDevice: string | undefined;
  const apiPrefix = spec.kind === 'github' ? '/api/v3' : '/api/v4';

  const userByLogin = (login: string): StubUser => {
    const user = spec.users.find((item) => item.login === login);
    if (!user) throw new Error(`stub ${spec.name} has no user ${login}`);
    return user;
  };

  /** The user and scopes of a live token, else undefined. */
  const tokenInfo = (token: string | undefined): { login: string; scopes: readonly string[]; pat?: StubPat } | undefined => {
    if (token === undefined) return undefined;
    const pat = spec.pats[token];
    if (pat) return { login: pat.login, scopes: pat.scopes, pat };
    const oauth = issued.get(token);
    if (!oauth || oauth.revoked || oauth.expiresAt <= Date.now()) return undefined;
    return { login: oauth.login, scopes: oauth.scopes };
  };
  const liveTokenInfo = (token: string | undefined): ReturnType<typeof tokenInfo> => {
    const info = tokenInfo(token);
    return info && !server.refusedLogins.has(info.login) ? info : undefined;
  };

  const levelsOf = (path: string, login: string): { project?: number; group?: number; shared?: number } | undefined => {
    const access = server.projectAccess.get(path)?.get(login);
    if (access === undefined) return undefined;
    return typeof access === 'number' ? { project: access } : access;
  };
  const levelOf = (repoPath: string, login: string): number | undefined => {
    const levels = levelsOf(repoPath, login);
    return levels ? Math.max(levels.project ?? 0, levels.group ?? 0, levels.shared ?? 0) : undefined;
  };
  // each fork's polls left before it answers ready, and GitLab's numeric ids of the projects the stub made
  const forkPollsLeft = new Map<string, number>();
  const madeIds = new Map<number, string>();
  let nextId = 7000;
  const repoExists = (repoPath: string): boolean => server.projectAccess.has(repoPath) || (spec.repos ?? []).some((repo) => repo.path === repoPath);
  const urlsOf = (repoPath: string): { https: string; ssh: string } => ({ https: `${server.webUrl}/${repoPath}.git`, ssh: `git@${new URL(server.webUrl).hostname}:${repoPath}.git` });

  /** A served bare repository for repoPath: empty for a create, a copy of upstream's for a fork. */
  function serveBare(repoPath: string, upstream?: string): void {
    if (!options.gitRoot) return;
    const target = path.join(options.gitRoot, ...`${repoPath}.git`.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const source = upstream !== undefined ? path.join(options.gitRoot, ...`${upstream}.git`.split('/')) : undefined;
    const args = source !== undefined && fs.existsSync(source) ? ['clone', '--quiet', '--bare', source, target] : ['init', '--quiet', '--bare', '-b', 'main', target];
    const made = spawnSync('git', args, { windowsHide: true, encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`stub ${spec.name} could not serve ${repoPath}: ${made.stderr}`);
  }

  function made(repoPath: string, login: string, visibility: string, forkOf?: string): number {
    server.projectAccess.set(repoPath, new Map([[login, 50]]));
    server.created.push({ path: repoPath, login, visibility, ...(forkOf !== undefined ? { forkOf } : {}) });
    serveBare(repoPath, forkOf);
    const id = nextId++;
    madeIds.set(id, repoPath);
    return id;
  }

  /** Publish's create and the fork of a denied push; true when it answered. */
  function publishApi(method: string, apiPath: string, body: string, login: string, user: StubUser, response: import('node:http').ServerResponse): boolean {
    const input = method === 'POST' ? (JSON.parse(body || '{}') as Record<string, unknown>) : {};
    if (spec.kind === 'github') {
      const orgCreate = /^\/orgs\/([^/]+)\/repos$/.exec(apiPath);
      if (method === 'POST' && (apiPath === '/user/repos' || orgCreate)) {
        const owner = orgCreate ? orgCreate[1]! : login;
        if (orgCreate && !(user.orgs ?? []).includes(owner)) {
          json(response, 404, { message: 'Not Found' });
          return true;
        }
        if (orgCreate && SSO_ORGS.has(owner) && !server.ssoAuthorized.has(login)) {
          json(response, 403, { message: 'Resource protected by organization SAML enforcement.' }, { 'x-github-sso': `required; url=${server.webUrl}/orgs/${owner}/sso?authorization_request=stub` });
          return true;
        }
        const repoPath = `${owner}/${String(input['name'])}`;
        if (repoExists(repoPath)) {
          json(response, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
          return true;
        }
        const visibility = typeof input['visibility'] === 'string' ? input['visibility'] : input['private'] === false ? 'public' : 'private';
        made(repoPath, login, visibility);
        json(response, 201, { id: 1, full_name: repoPath, html_url: `${server.webUrl}/${repoPath}`, clone_url: urlsOf(repoPath).https, ssh_url: urlsOf(repoPath).ssh, visibility });
        return true;
      }
      const fork = /^\/repos\/([^/]+)\/([^/]+)\/forks$/.exec(apiPath);
      if (method === 'POST' && fork) {
        const upstream = `${fork[1]!}/${fork[2]!}`;
        if (server.failFork) {
          json(response, 500, { message: 'Server Error' });
          return true;
        }
        if (levelOf(upstream, login) === undefined) {
          json(response, 404, { message: 'Not Found' });
          return true;
        }
        const existing = server.created.find((item) => item.forkOf === upstream && item.login === login);
        let forkPath = existing?.path ?? `${login}/${fork[2]!}`;
        // GitHub names the fork <name>-1 when the account owns another repository of that name
        if (!existing) for (let n = 1; repoExists(forkPath); n++) forkPath = `${login}/${fork[2]!}-${n}`;
        if (!existing) {
          made(forkPath, login, 'private', upstream);
          forkPollsLeft.set(forkPath, server.forkPolls);
        }
        json(response, 202, { id: 2, full_name: forkPath, fork: true, clone_url: urlsOf(forkPath).https, ssh_url: urlsOf(forkPath).ssh });
        return true;
      }
      return false;
    }
    if (method === 'POST' && apiPath === '/projects') {
      const name = String(input['path'] ?? input['name']);
      const namespaceId = input['namespace_id'];
      const group = namespaceId === undefined ? undefined : (spec.groups ?? []).find((item) => item.id === namespaceId);
      if (namespaceId !== undefined && (!group || (group.members[login] ?? 0) < 30)) {
        json(response, 403, { message: '403 Forbidden' });
        return true;
      }
      const repoPath = `${group ? group.path : login}/${name}`;
      if (repoExists(repoPath)) {
        json(response, 400, { message: { name: ['has already been taken'], path: ['has already been taken'] } });
        return true;
      }
      const visibility = String(input['visibility'] ?? 'private');
      const id = made(repoPath, login, visibility);
      json(response, 201, { id, path_with_namespace: repoPath, web_url: `${server.webUrl}/${repoPath}`, http_url_to_repo: urlsOf(repoPath).https, ssh_url_to_repo: urlsOf(repoPath).ssh, visibility });
      return true;
    }
    const fork = /^\/projects\/([^/]+)\/fork$/.exec(apiPath);
    if (method === 'POST' && fork) {
      const upstream = decodeURIComponent(fork[1]!);
      if (server.failFork) {
        json(response, 500, { message: '500 Internal Server Error' });
        return true;
      }
      if (levelOf(upstream, login) === undefined) {
        json(response, 404, { message: '404 Project Not Found' });
        return true;
      }
      const forkPath = `${login}/${upstream.split('/').pop()!}`;
      if (repoExists(forkPath)) {
        json(response, 409, { message: { name: ['has already been taken'], path: ['has already been taken'] } });
        return true;
      }
      const id = made(forkPath, login, 'private', upstream);
      forkPollsLeft.set(forkPath, server.forkPolls);
      json(response, 201, { id, path_with_namespace: forkPath, import_status: 'scheduled', forked_from_project: { id: 42, path_with_namespace: upstream } });
      return true;
    }
    const byId = method === 'GET' ? /^\/projects\/(\d+)$/.exec(apiPath) : null;
    const madePath = byId ? madeIds.get(Number(byId[1])) : undefined;
    if (byId && madePath !== undefined) {
      const left = forkPollsLeft.get(madePath) ?? 0;
      if (left > 0) forkPollsLeft.set(madePath, left - 1);
      const forkOf = server.created.find((item) => item.path === madePath)?.forkOf;
      json(response, 200, {
        id: Number(byId[1]),
        path_with_namespace: madePath,
        import_status: left > 0 ? (left === server.forkPolls ? 'scheduled' : 'started') : 'finished',
        http_url_to_repo: urlsOf(madePath).https,
        ssh_url_to_repo: urlsOf(madePath).ssh,
        ...(forkOf !== undefined ? { forked_from_project: { id: 42, path_with_namespace: forkOf } } : {}),
      });
      return true;
    }
    return false;
  }

  /** GET /repos/{owner}/{repo} or GET /projects/:id; false when the path is neither. */
  async function repoAccess(path: string, login: string, response: import('node:http').ServerResponse): Promise<boolean> {
    const github = spec.kind === 'github' ? /^\/repos\/([^/]+)\/([^/]+)$/.exec(path) : null;
    const gitlab = spec.kind === 'gitlab' ? /^\/projects\/([^/]+)$/.exec(path) : null;
    if (!github && !gitlab) return false;
    if (server.accessDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.accessDelayMs));
    if (server.failAccess) {
      response.socket?.destroy();
      return true;
    }
    if (github) {
      const [owner, repo] = [github[1]!, github[2]!];
      const user = userByLogin(login);
      if (SSO_ORGS.has(owner) && (user.orgs ?? []).includes(owner) && !server.ssoAuthorized.has(login)) {
        json(response, 403, { message: 'Resource protected by organization SAML enforcement.' }, { 'x-github-sso': `required; url=${server.webUrl}/orgs/${owner}/sso?authorization_request=stub` });
        return true;
      }
      const levels = levelsOf(`${owner}/${repo}`, login);
      const left = forkPollsLeft.get(`${owner}/${repo}`) ?? 0;
      if (left > 0) forkPollsLeft.set(`${owner}/${repo}`, left - 1);
      if (!levels || left > 0) {
        json(response, 404, { message: 'Not Found' });
        return true;
      }
      const level = Math.max(levels.project ?? 0, levels.group ?? 0, levels.shared ?? 0);
      json(response, 200, { id: 77, full_name: `${owner}/${repo}`, private: true, default_branch: 'main', clone_url: urlsOf(`${owner}/${repo}`).https, ssh_url: urlsOf(`${owner}/${repo}`).ssh, permissions: { admin: level >= 50, maintain: level >= 40, push: level >= 30, triage: level >= 20, pull: true } });
      return true;
    }
    const projectPath = decodeURIComponent(gitlab![1]!);
    const levels = levelsOf(projectPath, login);
    if (!levels) {
      json(response, 404, { message: '404 Project Not Found' });
      return true;
    }
    const forkOf = server.created.find((item) => item.path === projectPath)?.forkOf;
    json(response, 200, {
      id: [...madeIds].find(([, made]) => made === projectPath)?.[0] ?? 42,
      path_with_namespace: projectPath,
      default_branch: 'main',
      ...(forkOf !== undefined ? { forked_from_project: { id: 42, path_with_namespace: forkOf } } : {}),
      permissions: {
        project_access: levels.project !== undefined ? { access_level: levels.project, notification_level: 3 } : null,
        group_access: levels.group !== undefined ? { access_level: levels.group, notification_level: 3 } : null,
      },
    });
    return true;
  }

  const startedAt = Date.now();
  const listedFor = (login: string): StubRepo[] => (spec.repos ?? []).filter((repo) => repo.members.includes(login)).sort((a, b) => a.ageMinutes - b.ageMinutes);
  const updatedAt = (repo: StubRepo): string => new Date(startedAt - repo.ageMinutes * 60_000).toISOString();
  const cloneUrlsOf = (repo: StubRepo): { https: string; ssh: string } => ({ https: `${server.webUrl}/${repo.path}.git`, ssh: `git@${new URL(server.webUrl).hostname}:${repo.path}.git` });
  const listingWait = async (): Promise<void> => {
    if (server.listingDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.listingDelayMs));
  };
  const namespaceWait = async (): Promise<void> => {
    if (server.namespaceDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.namespaceDelayMs));
  };
  const githubRepoJson = (repo: StubRepo): Record<string, unknown> => ({
    id: 5000 + (spec.repos ?? []).indexOf(repo),
    name: repo.path.split('/')[1],
    full_name: repo.path,
    owner: { login: repo.path.split('/')[0] },
    private: repo.visibility !== 'public',
    visibility: repo.visibility,
    description: repo.description ?? null,
    fork: repo.fork === true,
    archived: repo.archived === true,
    mirror_url: null,
    updated_at: updatedAt(repo),
    pushed_at: updatedAt(repo),
    html_url: `${server.webUrl}/${repo.path}`,
    clone_url: cloneUrlsOf(repo).https,
    ssh_url: cloneUrlsOf(repo).ssh,
  });

  /** GitHub GET /search/repositories: q's words without a ':' match the name, user:<owner> the owner. */
  function searchRepos(login: string, q: string): StubRepo[] {
    const words = q.split(/\s+/).filter((word) => word !== '');
    const owner = words.find((word) => word.startsWith('user:'))?.slice('user:'.length);
    const terms = words.filter((word) => !word.includes(':')).map((word) => word.toLowerCase());
    return listedFor(login).filter((repo) => (owner === undefined || repo.path.split('/')[0] === owner) && terms.every((term) => repo.path.split('/')[1]!.toLowerCase().includes(term)));
  }

  const DEFAULT_BRANCH = 'main';
  const viewerPermission = (level: number): string => (level >= 50 ? 'ADMIN' : level >= 40 ? 'MAINTAIN' : level >= 30 ? 'WRITE' : level >= 20 ? 'TRIAGE' : 'READ');
  const rulesetRef = (ref: string): string => (ref === '~ALL' ? '**/*' : ref === '~DEFAULT_BRANCH' ? DEFAULT_BRANCH : ref.replace(/^refs\/heads\//, ''));
  const gitlabPattern = (name: string): RegExp => new RegExp(`^${name.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

  /** Whether the server refuses login's push to branch of repoPath for its protection. */
  function protects(repoPath: string, login: string, branch: string): boolean {
    const protection = server.protection.get(repoPath);
    if (!protection) return false;
    if (spec.kind === 'github') {
      const ruled = (protection.rulesets ?? []).some((ruleset) => (ruleset.enforcement ?? 'ACTIVE') === 'ACTIVE' && (ruleset.target ?? 'BRANCH') === 'BRANCH' && ruleset.pullRequest !== false
        && picomatch(ruleset.include.map(rulesetRef))(branch) && !(ruleset.exclude ?? []).some((ref) => picomatch(rulesetRef(ref))(branch)));
      return ruled || ((protection.classic ?? []).includes(branch) && !(protection.classicPushers ?? []).includes(login));
    }
    const user = userByLogin(login);
    const level = levelOf(repoPath, login) ?? 0;
    return (protection.protectedBranches ?? []).some((rule) => gitlabPattern(rule.name).test(branch)
      && !rule.push.some((entry) => (entry.user_id !== undefined ? entry.user_id === user.id : entry.group_id === undefined && (entry.access_level ?? 0) > 0 && level >= entry.access_level!)));
  }

  /**
   * GitHub POST /api/graphql: the repository's viewerPermission and default branch, its rulesets (the organization's with
   * includeParents), and each named branch's refUpdateRule (a classic protected branch's; null for any other).
   */
  async function githubGraphql(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: string): Promise<void> {
    const info = liveTokenInfo(bearerOf(request));
    if (!info) return json(response, 401, { message: 'Bad credentials' });
    const parsed = JSON.parse(body || '{}') as { query?: string; variables?: { owner?: string; repo?: string; cursor?: string | null; limit?: number } & Record<string, unknown> };
    const query = parsed.query ?? '';
    const name = /query\s+(\w+)/.exec(query)?.[1] ?? '';
    server.graphqlQueries.push({ name, variables: { ...parsed.variables } });
    const owner = parsed.variables?.owner ?? '';
    // GitHub answers a SAML-protected repository with a FORBIDDEN error and the authorization page in x-github-sso
    if (SSO_ORGS.has(owner) && (userByLogin(info.login).orgs ?? []).includes(owner) && !server.ssoAuthorized.has(info.login)) {
      const message = 'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.';
      return json(response, 200, { data: { repository: null }, errors: [{ type: 'FORBIDDEN', path: ['repository'], message }] }, { 'x-github-sso': `required; url=${server.webUrl}/orgs/${owner}/sso?authorization_request=stub` });
    }
    const repoPath = `${owner}/${parsed.variables?.repo ?? ''}`;
    const level = levelOf(repoPath, info.login);
    if (level === undefined) return json(response, 200, { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a Repository with the name '${repoPath}'.` }] });
    if (query.includes('assignableUsers(')) await server.history.holdUsers?.();
    const history = answerGithubHistoryGraphql(query, parsed.variables ?? {}, server.webUrl, picturesUrl, server.history);
    if (history !== undefined) return json(response, 200, history);
    const lists = answerGithubToolsGraphql(query, parsed.variables ?? {}, server.webUrl);
    if (lists !== undefined) return json(response, 200, lists);
    if (query.includes('viewerPermission')) return json(response, 200, { data: { repository: { defaultBranchRef: { name: DEFAULT_BRANCH }, viewerPermission: viewerPermission(level) } } });
    if (query.includes('refUpdateRule')) {
      const protection = server.protection.get(repoPath);
      const refs = Object.entries(parsed.variables ?? {}).filter(([key]) => /^r\d+$/.test(key)).map(([key, ref]): [string, unknown] => {
        const branch = String(ref).replace(/^refs\/heads\//, '');
        const ruled = (protection?.classic ?? []).includes(branch);
        return [key, { refUpdateRule: ruled ? { viewerCanPush: (protection?.classicPushers ?? []).includes(info.login) } : null }];
      });
      return json(response, 200, { data: { repository: Object.fromEntries(refs) } });
    }
    if (!query.includes('rulesets(')) return json(response, 200, { errors: [{ message: 'The stub answers the repository and rulesets queries only' }] });
    const includeParents = /includeParents:\s*true/.test(query);
    const all = (server.protection.get(repoPath)?.rulesets ?? []).filter((ruleset) => includeParents || ruleset.parent !== true);
    const start = Number(parsed.variables?.cursor ?? 0);
    const limit = parsed.variables?.limit ?? 100;
    const nodes = all.slice(start, start + limit).map((ruleset) => ({
      name: ruleset.name,
      enforcement: ruleset.enforcement ?? 'ACTIVE',
      rules: { totalCount: ruleset.pullRequest === false ? 0 : 1 },
      conditions: { refName: { include: ruleset.include, exclude: ruleset.exclude ?? [] } },
      target: ruleset.target ?? 'BRANCH',
    }));
    const next = start + limit;
    json(response, 200, { data: { repository: { rulesets: { nodes, pageInfo: { endCursor: String(next), hasNextPage: next < all.length } } } } });
  }

  /**
   * GitLab POST /api/graphql: the projects query the clone picker sends (membership, search over the path, first), Publish's
   * groups query, and a project's userPermissions.pushCode and maxAccessLevel, which count a group share as REST does not.
   */
  async function graphql(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: string): Promise<void> {
    const info = liveTokenInfo(bearerOf(request));
    if (!info) return json(response, 401, { message: '401 Unauthorized' });
    const parsed = JSON.parse(body || '{}') as { query?: string; variables?: { search?: string | null; first?: number; membership?: boolean; searchNamespaces?: boolean; fullPath?: string } };
    if (parsed.query?.includes('project(fullPath:')) {
      server.accessChecks.push(parsed.variables?.fullPath ?? '');
      if (server.accessDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.accessDelayMs));
      if (server.failAccess) {
        response.socket?.destroy();
        return;
      }
      const level = levelOf(parsed.variables?.fullPath ?? '', info.login);
      if (level === undefined) return json(response, 200, { data: { project: null } });
      const maxAccessLevel = parsed.query.includes('maxAccessLevel') ? { maxAccessLevel: { integerValue: level } } : {};
      return json(response, 200, { data: { project: { userPermissions: { pushCode: level >= 30 }, ...maxAccessLevel } } });
    }
    if (parsed.query?.includes('groups(permissionScope: CREATE_PROJECTS')) {
      server.graphqlVariables.push({ ...parsed.variables });
      await namespaceWait();
      const nodes = (spec.groups ?? []).filter((group) => (group.members[info.login] ?? 0) >= 30).map((group) => ({ id: `gid://gitlab/Group/${group.id}`, fullPath: group.path }));
      return json(response, 200, { data: { currentUser: { groups: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
    }
    if (!parsed.query?.includes('projects(')) return json(response, 200, { errors: [{ message: 'The stub answers the projects and groups queries only' }] });
    server.graphqlVariables.push({ ...parsed.variables });
    await listingWait();
    const search = (parsed.variables?.search ?? '').toLowerCase();
    const nodes = listedFor(info.login)
      .filter((repo) => search === '' || repo.path.toLowerCase().includes(search))
      .slice(0, parsed.variables?.first ?? 20)
      .map((repo) => ({
        fullPath: repo.path,
        description: repo.description ?? null,
        visibility: repo.visibility,
        archived: repo.archived === true,
        lastActivityAt: updatedAt(repo),
        httpUrlToRepo: cloneUrlsOf(repo).https,
        sshUrlToRepo: cloneUrlsOf(repo).ssh,
        repository: { empty: repo.empty === true },
      }));
    json(response, 200, { data: { projects: { nodes } } });
  }

  const issue = (login: string, scopes: readonly string[]): Record<string, unknown> => {
    const prefix = spec.kind === 'github' ? 'gho_' : '';
    const access = `${prefix}stub${randomBytes(18).toString('hex')}`;
    const refresh = `${spec.kind === 'github' ? 'ghr_' : ''}stubrefresh${randomBytes(18).toString('hex')}`;
    const ttl = server.tokenTtlSeconds;
    issued.set(access, { login, scopes, expiresAt: ttl === undefined ? Number.MAX_SAFE_INTEGER : Date.now() + ttl * 1000, revoked: false });
    refreshTokens.set(refresh, { login, scopes, used: false });
    return {
      access_token: access,
      token_type: 'bearer',
      scope: scopes.join(spec.kind === 'github' ? ',' : ' '),
      refresh_token: refresh,
      ...(ttl !== undefined ? { expires_in: ttl } : {}),
      ...(spec.kind === 'github' && ttl !== undefined ? { refresh_token_expires_in: 15_811_200 } : {}),
      ...(spec.kind === 'gitlab' ? { created_at: Math.floor(Date.now() / 1000) } : {}),
    };
  };

  const oauthScopes = spec.kind === 'github' ? ['repo', 'workflow', 'read:user', 'user:email', 'read:org'] : ['api', 'write_repository'];
  const oauthError = (response: import('node:http').ServerResponse, error: string): void => json(response, spec.kind === 'github' ? 200 : 400, { error });

  async function tokenEndpoint(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(request));
    if (server.failTokenEndpoint) return json(response, 502, { message: 'bad gateway' });
    const grantType = form.get('grant_type') ?? (spec.kind === 'github' && form.has('code') ? 'authorization_code' : '');
    if (form.get('client_id') !== spec.clientId) return oauthError(response, 'invalid_client');
    if (grantType === 'authorization_code') {
      server.counts.exchanges += 1;
      if (spec.kind === 'github' && form.get('client_secret') !== spec.clientSecret) return oauthError(response, 'incorrect_client_credentials');
      seen.push(form.get('code') ?? '', form.get('code_verifier') ?? '');
      const pending = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const sameRedirect = spec.kind === 'gitlab' ? doorkeeperRedirectMatches(form.get('redirect_uri') ?? '', pending?.redirectUri ?? '') : pending?.redirectUri === form.get('redirect_uri');
      if (!pending || !sameRedirect || pkceChallenge(form.get('code_verifier') ?? '') !== pending.challenge) return oauthError(response, spec.kind === 'github' ? 'bad_verification_code' : 'invalid_grant');
      return json(response, 200, issue(pending.login, oauthScopes));
    }
    if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
      server.counts.devicePolls += 1;
      const device = devices.get(form.get('device_code') ?? '');
      if (!device) return oauthError(response, 'expired_token');
      device.polls += 1;
      if (device.state === 'denied') return oauthError(response, 'access_denied');
      if (device.state === 'pending') return oauthError(response, 'authorization_pending');
      devices.delete(form.get('device_code') ?? '');
      return json(response, 200, issue(device.login!, oauthScopes));
    }
    if (grantType === 'refresh_token') {
      server.counts.refreshes += 1;
      const held = refreshTokens.get(form.get('refresh_token') ?? '');
      if (!held || held.used) return oauthError(response, spec.kind === 'github' ? 'bad_refresh_token' : 'invalid_grant');
      // rotation: a refresh token works once
      held.used = true;
      return json(response, 200, issue(held.login, held.scopes));
    }
    return oauthError(response, 'unsupported_grant_type');
  }

  function authorize(url: URL, response: import('node:http').ServerResponse): void {
    const params = Object.fromEntries(url.searchParams);
    const { state: _state, code_challenge: _challenge, ...recorded } = params;
    server.authorizeParams.push(recorded);
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const redirectOk = spec.kind === 'gitlab' ? doorkeeperRedirectMatches(redirectUri, GITLAB_REGISTERED_REDIRECT) : /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri);
    if (url.searchParams.get('client_id') !== spec.clientId || url.searchParams.get('code_challenge_method') !== 'S256' || !redirectOk) {
      response.writeHead(400);
      response.end('bad authorize request');
      return;
    }
    const login = (spec.kind === 'github' ? url.searchParams.get('login') : null) ?? server.nextLogin;
    const code = `stubcode${randomBytes(12).toString('hex')}`;
    codes.set(code, { login, challenge: url.searchParams.get('code_challenge') ?? '', redirectUri, clientId: spec.clientId });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', url.searchParams.get('state') ?? '');
    response.writeHead(302, { location: target.href });
    response.end();
  }

  function deviceStart(response: import('node:http').ServerResponse, form: URLSearchParams): void {
    if (form.get('client_id') !== spec.clientId) return json(response, spec.kind === 'github' ? 200 : 401, { error: 'invalid_client' });
    const deviceCode = `stubdevice${randomBytes(12).toString('hex')}`;
    const userCode = spec.kind === 'github' ? 'WDJB-MJHT' : 'DMCL1234';
    devices.set(deviceCode, { userCode, state: 'pending', polls: 0 });
    seen.push(deviceCode);
    newestDevice = deviceCode;
    json(response, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${server.webUrl}${spec.kind === 'github' ? '/login/device' : '/oauth/device'}`,
      expires_in: 900,
      interval: 1,
    });
  }

  async function api(method: string, path: string, url: URL, request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: string): Promise<void> {
    const info = liveTokenInfo(bearerOf(request));
    if (method === 'DELETE' && spec.kind === 'github' && path === `/applications/${spec.clientId}/token`) {
      server.counts.revokes += 1;
      const basic = basicOf(request);
      if (server.failRevoke || basic?.user !== spec.clientId || basic.password !== spec.clientSecret) return json(response, 422, { message: 'Validation Failed' });
      const token = (JSON.parse(body || '{}') as { access_token?: string }).access_token ?? '';
      const held = issued.get(token);
      if (!held) return json(response, 404, { message: 'Not Found' });
      held.revoked = true;
      revokedTokens.push(token);
      response.writeHead(204);
      response.end();
      return;
    }
    if (method === 'GET' && path === '/meta' && spec.kind === 'github') return info ? json(response, 200, { installed_version: spec.version }) : json(response, 401, { message: 'Bad credentials' });
    if (method === 'GET' && path === '/versions' && spec.kind === 'github') return spec.apiVersions ? json(response, 200, spec.apiVersions) : json(response, 404, { message: 'Not Found' });
    if (!info) return json(response, 401, { message: spec.kind === 'github' ? 'Bad credentials' : '401 Unauthorized' });
    const user = userByLogin(info.login);
    if (publishApi(method, path, body, user.login, user, response)) return;
    if (method === 'GET' && (await repoAccess(path, user.login, response))) return;
    const scopeHeader: Record<string, string> = spec.kind === 'github' && !info.pat?.fineGrained ? { 'x-oauth-scopes': info.scopes.join(', ') } : {};
    if (method === 'GET' && path === '/user') {
      const avatar = spec.kind === 'github' ? `${server.webUrl}/avatars/${user.login}.png` : `${server.webUrl}/uploads/-/system/user/avatar/${user.id}/avatar.png`;
      const shape = spec.kind === 'github'
        ? { id: user.id, login: user.login, name: user.name, avatar_url: avatar }
        : { id: user.id, username: user.login, name: user.name, avatar_url: avatar, bot: user.bot === true };
      return json(response, 200, shape, scopeHeader);
    }
    if (spec.kind === 'gitlab') {
      if (method === 'GET' && path === '/personal_access_tokens/self') {
        return info.pat ? json(response, 200, { id: 1, name: 'Damocles', scopes: info.scopes, active: true, revoked: false, user_id: user.id }) : json(response, 404, { message: '404 Not Found' });
      }
      if (method === 'GET' && path === '/version') return json(response, 200, { version: spec.version, revision: 'stub' });
      if (method === 'GET' && path === '/projects' && url.searchParams.get('simple') === 'true') return json(response, 200, spec.cloneUrls ? [{ id: 7, http_url_to_repo: spec.cloneUrls.https, ssh_url_to_repo: spec.cloneUrls.ssh }] : []);
      if (method === 'GET' && path === '/projects') {
        server.projectListings.push(Object.fromEntries(url.searchParams));
        await listingWait();
        // GitLab's default order is by id, the spec's order here; only order_by=last_activity_at&sort=desc puts the newest first
        const newestFirst = url.searchParams.get('order_by') === 'last_activity_at' && url.searchParams.get('sort') === 'desc';
        const repos = newestFirst ? listedFor(user.login) : (spec.repos ?? []).filter((repo) => repo.members.includes(user.login));
        return json(response, 200, repos.slice(0, Number(url.searchParams.get('per_page') ?? '20')).map((repo) => ({
          id: 6000 + (spec.repos ?? []).indexOf(repo),
          path_with_namespace: repo.path,
          description: repo.description ?? null,
          visibility: repo.visibility,
          archived: repo.archived === true,
          last_activity_at: updatedAt(repo),
          http_url_to_repo: cloneUrlsOf(repo).https,
          ssh_url_to_repo: cloneUrlsOf(repo).ssh,
          empty_repo: repo.empty === true,
        })));
      }
      const protectedBranches = /^\/projects\/([^/]+)\/protected_branches$/.exec(path);
      if (method === 'GET' && protectedBranches) {
        const projectPath = decodeURIComponent(protectedBranches[1]!);
        if (levelOf(projectPath, user.login) === undefined) return json(response, 404, { message: '404 Project Not Found' });
        const perPage = Number(url.searchParams.get('per_page') ?? '20');
        const page = Number(url.searchParams.get('page') ?? '1');
        const rules = (server.protection.get(projectPath)?.protectedBranches ?? []).map((rule, index) => ({
          id: 100 + index,
          name: rule.name,
          push_access_levels: rule.push.map((entry) => ({ access_level: entry.access_level ?? 40, access_level_description: 'stub', user_id: entry.user_id ?? null, group_id: entry.group_id ?? null, deploy_key_id: null })),
          merge_access_levels: [{ access_level: 40, access_level_description: 'Maintainers', user_id: null, group_id: null }],
          allow_force_push: false,
        }));
        return json(response, 200, rules.slice((page - 1) * perPage, page * perPage));
      }
    } else {
      const branches = /^\/repos\/([^/]+)\/([^/]+)\/branches$/.exec(path);
      if (method === 'GET' && branches) {
        const repoPath = `${branches[1]!}/${branches[2]!}`;
        if (levelOf(repoPath, user.login) === undefined) return json(response, 404, { message: 'Not Found' });
        // GitHub lists a branch any active ruleset names as protected too, whatever its rules
        const protection = server.protection.get(repoPath);
        const ruled = (protection?.rulesets ?? []).filter((ruleset) => (ruleset.enforcement ?? 'ACTIVE') === 'ACTIVE' && (ruleset.target ?? 'BRANCH') === 'BRANCH')
          .flatMap((ruleset) => ruleset.include.filter((ref) => ref.startsWith('refs/heads/') && !/[*?[]/.test(ref)).map((ref) => ref.slice('refs/heads/'.length)));
        const names = url.searchParams.get('protected') === 'true' ? [...new Set([...(protection?.classic ?? []), ...ruled])] : [];
        return json(response, 200, names.map((branch) => ({ name: branch, protected: true, commit: { sha: '0'.repeat(40) } })));
      }
      if (method === 'GET' && path === '/user/repos') {
        if (!spec.repos) return json(response, 200, spec.cloneUrls ? [{ id: 7, clone_url: spec.cloneUrls.https, ssh_url: spec.cloneUrls.ssh }] : []);
        await listingWait();
        return json(response, 200, listedFor(user.login).slice(0, Number(url.searchParams.get('per_page') ?? '30')).map(githubRepoJson));
      }
      if (method === 'GET' && path === '/search/repositories') {
        const q = url.searchParams.get('q') ?? '';
        server.searchQueries.push(q);
        await listingWait();
        const items = searchRepos(user.login, q);
        return json(response, 200, { total_count: items.length, incomplete_results: false, items: items.map(githubRepoJson) });
      }
      if (method === 'GET' && path === '/user/orgs') {
        await namespaceWait();
        return json(response, 200, (user.orgs ?? []).map((login, index) => ({ id: 9000 + index, login })));
      }
      const members = /^\/orgs\/([^/]+)\/members$/.exec(path);
      if (method === 'GET' && members) {
        const org = members[1]!;
        if (!(user.orgs ?? []).includes(org)) return json(response, 404, { message: 'Not Found' });
        if (SSO_ORGS.has(org) && !server.ssoAuthorized.has(user.login)) {
          return json(response, 403, { message: 'Resource protected by organization SAML enforcement.' }, { 'x-github-sso': `required; url=${server.webUrl}/orgs/${org}/sso?authorization_request=stub` });
        }
        if (RESTRICTED_ORGS.has(org) && info.pat === undefined) {
          return json(response, 403, { message: `Although you appear to have the correct authorization credentials, the \`${org}\` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.` });
        }
        return json(response, 200, [{ login: user.login }]);
      }
    }
    const level = (repoPath: string): number | undefined => {
      const levels = levelsOf(repoPath, user.login);
      return levels ? Math.max(levels.project ?? 0, levels.group ?? 0, levels.shared ?? 0) : undefined;
    };
    const ssoBlocked = (owner: string): boolean => {
      if (!SSO_ORGS.has(owner) || !(user.orgs ?? []).includes(owner) || server.ssoAuthorized.has(user.login)) return false;
      json(response, 403, { message: 'Resource protected by organization SAML enforcement.' }, { 'x-github-sso': `required; url=${server.webUrl}/orgs/${owner}/sso?authorization_request=stub` });
      return true;
    };
    if (answerHistory({ kind: spec.kind, webUrl: server.webUrl, picturesUrl, method, path, url, response, level, ui: server.history })) return;
    const ifNoneMatch = request.headers['if-none-match'];
    if (answerCi({ kind: spec.kind, webUrl: server.webUrl, method, path, url, login: user.login, body, response, level, ssoBlocked, writes: server.forgeWrites, ui: server.ci, logStorage, ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}) })) return;
    json(response, 404, { message: 'Not Found' });
  }

  const lfsJson = (response: import('node:http').ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/vnd.git-lfs+json' });
    response.end(JSON.stringify(body));
  };

  /** The Git LFS batch API and object store under /<repo>.git/info/lfs, as GitLab serves it: actions carry the request's own basic auth. */
  async function lfs(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, repo: string, rest: string): Promise<void> {
    const basic = basicOf(request);
    if (!basic || !liveTokenInfo(basic.password)) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="stub"', 'content-type': 'application/vnd.git-lfs+json' });
      response.end(JSON.stringify({ message: 'Credentials needed' }));
      return;
    }
    const objects = server.lfsObjects.get(repo) ?? new Map<string, { readonly data: Buffer; readonly username: string; readonly credential: string }>();
    server.lfsObjects.set(repo, objects);
    const method = request.method ?? 'GET';
    if (method === 'POST' && rest === 'objects/batch') {
      const batch = JSON.parse(await readBody(request)) as { operation: 'upload' | 'download'; objects: { oid: string; size: number }[] };
      const href = (oid: string): string => `${server.webUrl}/${repo}.git/info/lfs/objects/${oid}`;
      const header = { Authorization: request.headers.authorization ?? '' };
      return lfsJson(response, 200, {
        transfer: 'basic',
        objects: batch.objects.map(({ oid, size }) => {
          if (batch.operation === 'upload') return objects.has(oid) ? { oid, size } : { oid, size, actions: { upload: { href: href(oid), header } } };
          return objects.has(oid) ? { oid, size, actions: { download: { href: href(oid), header } } } : { oid, size, error: { code: 404, message: 'Object does not exist' } };
        }),
      });
    }
    if (method === 'POST' && rest === 'locks/verify') return lfsJson(response, 200, { ours: [], theirs: [] });
    const object = /^objects\/([0-9a-f]{64})$/.exec(rest);
    if (object && method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      objects.set(object[1]!, { data: Buffer.concat(chunks), username: basic.user, credential: basic.password });
      response.writeHead(200);
      response.end();
      return;
    }
    if (object && method === 'GET') {
      const held = objects.get(object[1]!);
      if (!held) return lfsJson(response, 404, { message: 'Not Found' });
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(held.data);
      return;
    }
    lfsJson(response, 404, { message: 'Not Found' });
  }

  async function git(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL): Promise<void> {
    const basic = basicOf(request);
    if (!options.gitRoot || !basic || !liveTokenInfo(basic.password)) {
      server.counts.gitRefused += 1;
      response.writeHead(401, { 'www-authenticate': 'Basic realm="stub"', 'content-type': 'text/plain' });
      response.end('HTTP Basic: Access denied\n');
      return;
    }
    const pushing = url.searchParams.get('service') === 'git-receive-pack' || url.pathname.endsWith('/git-receive-pack');
    const repoPath = decodeURIComponent(url.pathname).replace(/^\//, '').replace(/\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/, '');
    const pusher = liveTokenInfo(basic.password)!.login;
    if (pushing && server.enforcePushAccess && server.projectAccess.has(repoPath) && (levelOf(repoPath, pusher) ?? 0) < 30) {
      server.counts.gitRefused += 1;
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end(spec.kind === 'github' ? `Permission to ${repoPath}.git denied to ${pusher}.\n` : 'You are not allowed to push code to this project.\n');
      return;
    }
    // a pack's ref updates come first, so the body is read whole before git sees it
    let held: Buffer | undefined;
    if (pushing && request.method === 'POST' && server.enforcePushAccess && server.protection.has(repoPath)) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      held = Buffer.concat(chunks);
      const commands = request.headers['content-encoding'] === 'gzip' ? gunzipSync(held) : held;
      const refused = pushedRefs(commands).find((ref) => ref.startsWith('refs/heads/') && protects(repoPath, pusher, ref.slice('refs/heads/'.length)));
      if (refused !== undefined) {
        server.counts.gitRefused += 1;
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end(spec.kind === 'github' ? `GH006: Protected branch update failed for ${refused}.\n` : 'You are not allowed to push code to protected branches on this project.\n');
        return;
      }
    }
    server.counts.gitServed += 1;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      SystemRoot: process.env['SystemRoot'],
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_PROJECT_ROOT: options.gitRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method ?? 'GET',
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      REMOTE_USER: basic.user,
      REMOTE_ADDR: '127.0.0.1',
      ...(request.headers['git-protocol'] ? { GIT_PROTOCOL: String(request.headers['git-protocol']) } : {}),
    };
    const backend = spawn('git', ['-c', 'http.receivepack=true', 'http-backend'], { env, windowsHide: true });
    backends.add(backend);
    backend.on('exit', () => backends.delete(backend));
    if (held) backend.stdin.end(held);
    else request.pipe(backend.stdin);
    backend.stdin.on('error', () => undefined);
    let header = Buffer.alloc(0);
    let headersSent = false;
    backend.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) {
        response.write(chunk);
        return;
      }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of header.subarray(0, end).toString('latin1').split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      headersSent = true;
      response.write(header.subarray(end + 4));
    });
    await new Promise<void>((resolve) => {
      backend.on('close', () => {
        if (!headersSent) response.writeHead(500);
        response.end();
        resolve();
      });
    });
  }

  async function handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', server.webUrl);
    const method = request.method ?? 'GET';
    const credential = bearerOf(request);
    const username = basicOf(request)?.user;
    const apiVersion = request.headers['x-github-api-version'];
    const sentVersion = typeof apiVersion === 'string' ? apiVersion : undefined;
    server.requests.push({ method, path: url.pathname, authorized: request.headers.authorization !== undefined, ...(credential !== undefined ? { credential } : {}), ...(username !== undefined ? { username } : {}), origin: server.webUrl, ...(sentVersion !== undefined ? { apiVersion: sentVersion } : {}) });
    if (spec.kind === 'github' && spec.apiVersions && sentVersion !== undefined && !spec.apiVersions.includes(sentVersion)) {
      return json(response, 400, { message: `API version ${sentVersion} is not supported.` });
    }
    const lfsPath = /^\/(.+)\.git\/info\/lfs\/(.+)$/.exec(url.pathname);
    if (lfsPath) return lfs(request, response, lfsPath[1]!, lfsPath[2]!);
    if (/\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(url.pathname)) return git(request, response, url);
    if (server.unreachable && (url.pathname.startsWith(apiPrefix) || url.pathname === '/api/graphql')) {
      response.socket?.destroy();
      return;
    }
    if (spec.kind === 'gitlab' && method === 'POST' && url.pathname === '/api/graphql') return graphql(request, response, await readBody(request));
    if (spec.kind === 'github' && method === 'POST' && url.pathname === '/api/graphql') return githubGraphql(request, response, await readBody(request));
    if (url.pathname.startsWith(apiPrefix)) return api(method, url.pathname.slice(apiPrefix.length), url, request, response, await readBody(request));
    if (spec.kind === 'github') {
      if (method === 'GET' && url.pathname === '/login/oauth/authorize') return authorize(url, response);
      if (method === 'POST' && url.pathname === '/login/oauth/access_token') return tokenEndpoint(request, response);
      if (method === 'POST' && url.pathname === '/login/device/code') return deviceStart(response, new URLSearchParams(await readBody(request)));
      if (method === 'GET' && answerSpecialPicture('github', url.pathname, response)) return;
      if (method === 'GET' && /^\/avatars\/[a-z0-9-]+\.png$/.test(url.pathname)) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(AVATAR_PNG);
        return;
      }
    } else {
      if (method === 'GET' && url.pathname === '/oauth/authorize') return authorize(url, response);
      if (method === 'POST' && url.pathname === '/oauth/token') return tokenEndpoint(request, response);
      if (method === 'POST' && url.pathname === '/oauth/authorize_device') return deviceStart(response, new URLSearchParams(await readBody(request)));
      if (method === 'POST' && url.pathname === '/oauth/revoke') {
        server.counts.revokes += 1;
        const form = new URLSearchParams(await readBody(request));
        // a non-confidential app has no secret; this stand-in refuses while failRevoke is set, as some GitLab versions do
        if (server.failRevoke || form.get('client_id') !== spec.clientId) return json(response, 401, { error: 'invalid_client' });
        const token = form.get('token') ?? '';
        const held = issued.get(token);
        if (held) {
          held.revoked = true;
          revokedTokens.push(token);
        }
        return json(response, 200, {});
      }
      if (method === 'GET' && /^\/uploads\/-\/system\/user\/avatar\/\d+\/avatar\.(?:png|svg)$/.test(url.pathname)) {
        if (!tokenInfo(bearerOf(request))) return json(response, 401, { message: '401 Unauthorized' });
        if (answerSpecialPicture('gitlab', url.pathname, response)) return;
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(AVATAR_PNG);
        return;
      }
    }
    // the pages Damocles opens in the browser: token, device, applications, SSO
    if (method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>stub</title>');
      return;
    }
    json(response, 404, { message: 'Not Found' });
  }

  const listener = https.createServer({ cert: options.cert, key: options.key }, (request, response) => {
    handle(request, response).catch((err: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(err instanceof Error ? err.name : 'error');
    });
  });
  listener.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, options.listenAddress ?? '127.0.0.1', () => resolve());
  });
  const webUrl = `https://${options.publicHost ?? '127.0.0.1'}:${(listener.address() as AddressInfo).port}`;

  const server: StubServer & { close(): Promise<void> } = {
    spec,
    webUrl,
    apiUrl: `${webUrl}${apiPrefix}`,
    requests: [],
    authorizeParams: [],
    counts: { exchanges: 0, refreshes: 0, revokes: 0, devicePolls: 0, gitServed: 0, gitRefused: 0 },
    issuedSecrets: () => [...issued.keys(), ...refreshTokens.keys(), ...seen, ...Object.keys(spec.pats), ...(spec.clientSecret !== undefined ? [spec.clientSecret] : [])],
    nextLogin: spec.users[0]!.login,
    tokenTtlSeconds: spec.kind === 'gitlab' ? 7200 : 28_800,
    failRevoke: false,
    failTokenEndpoint: false,
    ssoAuthorized: new Set(),
    projectAccess: new Map(Object.entries(spec.projects ?? {}).map(([path, logins]) => [path, new Map(Object.entries(logins))])),
    accessDelayMs: 0,
    failAccess: false,
    refusedLogins: new Set(),
    unreachable: false,
    listingDelayMs: 0,
    namespaceDelayMs: 0,
    searchQueries: [],
    graphqlVariables: [],
    projectListings: [],
    revokeTokens(login, revokeOptions = {}) {
      for (const [token, held] of issued) {
        if (held.login !== login || held.revoked) continue;
        held.revoked = true;
        revokedTokens.push(token);
      }
      if (revokeOptions.refresh) for (const held of refreshTokens.values()) if (held.login === login) held.used = true;
    },
    forgeWrites: [],
    ci: new CiUi(options.now),
    history: new HistoryUi(),
    avatarRequests() {
      const pictures = server.requests
        .filter((item) => item.path === `${apiPrefix}/avatar` || item.path.startsWith('/uploads/-/system/user/avatar/') || item.path.startsWith('/avatars/'))
        .map((item) => `${item.method} ${item.path}`);
      const queries = server.graphqlQueries.filter((item) => item.name === 'assignableUsers' || item.name === 'commitAuthors').map((item) => `POST /api/graphql ${item.name}`);
      return [...pictures, ...queries];
    },
    created: [],
    enforcePushAccess: false,
    protection: new Map(),
    graphqlQueries: [],
    accessChecks: [],
    forkPolls: 2,
    failFork: false,
    lfsObjects: new Map(),
    deviceUserCode: () => (newestDevice !== undefined ? devices.get(newestDevice)?.userCode : undefined),
    approveDevice(login) {
      const device = newestDevice !== undefined ? devices.get(newestDevice) : undefined;
      if (!device) throw new Error('no device authorization is pending');
      userByLogin(login);
      device.state = 'approved';
      device.login = login;
    },
    denyDevice() {
      const device = newestDevice !== undefined ? devices.get(newestDevice) : undefined;
      if (!device) throw new Error('no device authorization is pending');
      device.state = 'denied';
    },
    async completeBrowser(authorizeUrl) {
      const authorized = await new Promise<string>((resolve, reject) => {
        const request = https.get(authorizeUrl, { ca: options.ca }, (response) => {
          response.resume();
          const location = response.headers.location;
          if (response.statusCode !== 302 || location === undefined) reject(new Error(`authorize answered ${response.statusCode}`));
          else resolve(location);
        });
        request.on('error', reject);
      });
      const callback = await fetch(authorized, { redirect: 'manual' });
      await callback.body?.cancel();
      return callback.status;
    },
    isLive: (token) => tokenInfo(token) !== undefined,
    tokenLogin: (token) => tokenInfo(token)?.login,
    revoked: () => [...revokedTokens],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([...backends].map((backend) => new Promise<void>((resolve) => {
        backend.once('exit', () => resolve());
        if (backend.exitCode !== null || backend.signalCode !== null || !backend.kill()) resolve();
      })));
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
  return server;
}

/** GitHub's log storage on its own listener, so a log redirect crosses origins; it records whether a credential came. */
async function startLogStorage(options: ForgeStubOptions): Promise<StubLogStorage & { close(): Promise<void> }> {
  const requests: { readonly path: string; readonly authorized: boolean }[] = [];
  const sockets = new Set<Duplex>();
  const storage = {
    url: '',
    requests,
    dropNext: 0,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
  const listener = https.createServer({ cert: options.cert, key: options.key }, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://storage.invalid');
    requests.push({ path: url.pathname, authorized: request.headers.authorization !== undefined });
    if (storage.dropNext > 0) {
      storage.dropNext--;
      response.socket?.destroy();
      return;
    }
    if (!answerGithubLog(request, response, url)) {
      response.writeHead(404);
      response.end();
    }
  });
  listener.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, options.listenAddress ?? '127.0.0.1', () => resolve());
  });
  storage.url = `https://${options.publicHost ?? '127.0.0.1'}:${(listener.address() as AddressInfo).port}`;
  return storage;
}

/** Starts the four stub servers of FORGE_FIXTURES and GitHub's log storage. */
export async function startForgeStub(options: ForgeStubOptions): Promise<ForgeStub> {
  const logStorage = await startLogStorage(options);
  const pictures = await startPictures(options);
  const [github, gitlab, indigital, ghes] = await Promise.all([
    startServer(FORGE_FIXTURES.github, options, logStorage.url, pictures.url),
    startServer(FORGE_FIXTURES.gitlab, options, logStorage.url, pictures.url),
    startServer(FORGE_FIXTURES.indigital, options, logStorage.url, pictures.url),
    startServer(FORGE_FIXTURES.ghes, options, logStorage.url, pictures.url),
  ]);
  return {
    logStorage,
    pictures,
    github,
    gitlab,
    indigital,
    ghes,
    e2eServersEnv: () => JSON.stringify({
      'github.com': { webUrl: github.webUrl, apiUrl: github.apiUrl, oauth: { clientId: github.spec.clientId, clientSecret: github.spec.clientSecret } },
      'gitlab.com': { webUrl: gitlab.webUrl, apiUrl: gitlab.apiUrl, oauth: { clientId: gitlab.spec.clientId } },
    }),
    close: async () => {
      await Promise.all([github.close(), gitlab.close(), indigital.close(), ghes.close(), logStorage.close(), pictures.close()]);
    },
  };
}
