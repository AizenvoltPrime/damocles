import type { ForgeOrgAccessIssue } from '../../../shared/forge/accounts';
import type { BranchProtectionRule } from '../../../shared/forge/branch-protection';
import type { ForgeHttp } from '../http';
import { l } from '../../l10n';
import { ForgeHttpError, ForgeSignInError, type ForgeKind, type ForgeServer, type ForgeSignInRoute, type OAuthClient, type TokenSet } from '../types';
import { githubProvider } from './github/auth';
import { gitlabProvider } from './gitlab/auth';

/** A signed-in user as the server's GET /user answers. */
export interface ForgeUser {
  readonly id: string;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  /** GitLab: a group or project access token's bot user. */
  readonly bot?: boolean;
}

/** What a token grant gives: the tokens and the scopes the server granted. */
export interface TokenGrant {
  readonly tokens: TokenSet;
  readonly scopes: readonly string[];
}

export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** Seconds. */
  readonly expiresIn: number;
  readonly interval: number;
}

export type DevicePoll =
  | { readonly kind: 'pending' }
  | { readonly kind: 'slowDown'; readonly interval?: number }
  | { readonly kind: 'expired' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'granted'; readonly grant: TokenGrant };

/** A refresh the server refused for good (any OAuth error code): the account must sign in again. */
export class RefreshRefusedError extends Error {
  constructor() {
    super('The server refused the refresh token');
    this.name = 'RefreshRefusedError';
  }
}

export interface AuthorizeParams {
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
  /** GitHub "Sign in again": the account's login; otherwise GitHub asks which account. */
  readonly login?: string;
}

/** An organization access problem, with the authorization URL GitHub named for an SSO one (kept in core, opened on a click). */
export interface OrgAccessFinding extends ForgeOrgAccessIssue {
  readonly url?: string;
}

/** What the access check reads of a repository: visibility, push (GitLab level 30, GitHub push) and owner (GitLab 50, GitHub admin). */
export interface RepoAccess {
  /** The token sees the repository (a 404 does not). */
  readonly readable: boolean;
  readonly canPush: boolean;
  readonly owner: boolean;
  /** GitHub answered the repository without its permissions, so canPush and owner say nothing. */
  readonly permissionsUnread?: true;
}

/** One kind's endpoints and rules, implemented in providers/<kind>/. */
export interface ForgeProvider {
  readonly kind: ForgeKind;
  /** Scopes a browser or device sign-in requests. */
  readonly oauthScopes: readonly string[];
  /** Scopes the token page asks for, shown as chips. */
  readonly tokenScopes: readonly string[];
  authorizeUrl(server: ForgeServer, params: AuthorizeParams): string;
  exchangeCode(http: ForgeHttp, server: ForgeServer, client: OAuthClient, params: { readonly code: string; readonly redirectUri: string; readonly verifier: string }, signal: AbortSignal, now: () => number): Promise<TokenGrant>;
  /** Undefined: the server has no device flow (GitLab answers 404); throws clientRefusedError when it refused the client id. */
  startDevice(http: ForgeHttp, server: ForgeServer, client: OAuthClient, signal: AbortSignal): Promise<DeviceCode | undefined>;
  pollDevice(http: ForgeHttp, server: ForgeServer, client: OAuthClient, deviceCode: string, signal: AbortSignal, now: () => number): Promise<DevicePoll>;
  /** Throws RefreshRefusedError when the server refused the refresh token for good. */
  refresh(http: ForgeHttp, server: ForgeServer, client: OAuthClient, refreshToken: string, route: ForgeSignInRoute, now: () => number): Promise<TokenGrant>;
  /** False: the server offers no revoke for this token with what Damocles holds; the user revokes it on revokePage. */
  revoke(http: ForgeHttp, server: ForgeServer, client: OAuthClient | undefined, tokens: TokenSet): Promise<boolean>;
  revokePage(server: ForgeServer, clientId: string | undefined): string;
  tokenPage(server: ForgeServer): string;
  /** Checks a pasted token; throws ForgeSignInError with the refusal text. version: the server's, where the check read it. */
  validateToken(http: ForgeHttp, server: ForgeServer, token: string): Promise<{ readonly user: ForgeUser; readonly scopes: readonly string[]; readonly version?: string }>;
  currentUser(http: ForgeHttp, server: ForgeServer, token: string): Promise<ForgeUser>;
  /** The server's version for the badge and gates, and GHES's API version; empty where neither applies. */
  readVersion(http: ForgeHttp, server: ForgeServer, token: string): Promise<{ readonly version?: string; readonly apiVersion?: string }>;
  /** The git hosts one of the account's projects names in its clone URLs. */
  learnGitHosts(http: ForgeHttp, server: ForgeServer, token: string): Promise<readonly string[]>;
  /** The token's access to a repository (owner/repo, or a GitLab project path); SSO and app refusals throw ForgeHttpError. */
  repoAccess(http: ForgeHttp, server: ForgeServer, token: string, repoPath: string, signal: AbortSignal): Promise<RepoAccess>;
  /** The branches a commit should not land on directly, for the account with userId; none where the server gives no rules. */
  branchProtection(http: ForgeHttp, server: ForgeServer, token: string, userId: string, repoPath: string, signal: AbortSignal): Promise<readonly BranchProtectionRule[]>;
  /** GitHub only: organizations whose SSO or OAuth app policy keeps the account's token out. */
  orgAccess?(http: ForgeHttp, server: ForgeServer, token: string): Promise<readonly OrgAccessFinding[]>;
}

export function providerFor(kind: ForgeKind): ForgeProvider {
  return kind === 'github' ? githubProvider : gitlabProvider;
}

/** The hosts of the https and ssh clone URLs given, lowercase, with an https port kept. */
export function cloneUrlHosts(urls: readonly unknown[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    if (typeof url !== 'string') continue;
    const scp = /^[^@/\s]+@([^:/\s]+):/.exec(url);
    if (scp) hosts.add(scp[1]!.toLowerCase());
    else if (URL.canParse(url)) {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') hosts.add(parsed.host.toLowerCase());
      else if (parsed.protocol === 'ssh:') hosts.add(parsed.hostname.toLowerCase());
    }
  }
  return [...hosts];
}

/** The Git hosting section's refusal of a pasted token that lacks a scope, word for word. */
export function missingScopeError(scope: string): ForgeSignInError {
  return new ForgeSignInError('input', l('This token is missing the {0} scope. Create one with the scopes above and try again.', scope));
}

/** A device code request the server refused for the OAuth app's client id (invalid_client, unauthorized_client). */
export function clientRefusedError(): ForgeSignInError {
  return new ForgeSignInError('provider', l("The server refused the OAuth app's client id. Check the client id, or sign in with a token."));
}

/** A pasted token the server refused, or a request failure while checking it. */
export function tokenCheckError(err: unknown): Error {
  if (err instanceof ForgeHttpError && err.kind === 'unauthorized') {
    return new ForgeSignInError('input', l('The server refused this token. Check that you copied all of it and that it has not expired.'));
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** A token endpoint's JSON answer as tokens; `scopeSeparator` is GitHub's comma or GitLab's space. */
export function grantOf(body: unknown, scopeSeparator: ',' | ' ', now: number): TokenGrant {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const access = record['access_token'];
  if (typeof access !== 'string' || access === '') throw new ForgeHttpError('server', 'The token endpoint answered without an access token');
  const refresh = typeof record['refresh_token'] === 'string' && record['refresh_token'] !== '' ? record['refresh_token'] : undefined;
  const expiresIn = typeof record['expires_in'] === 'number' && record['expires_in'] > 0 ? record['expires_in'] : undefined;
  const refreshExpiresIn = typeof record['refresh_token_expires_in'] === 'number' && record['refresh_token_expires_in'] > 0 ? record['refresh_token_expires_in'] : undefined;
  const scope = typeof record['scope'] === 'string' ? record['scope'] : '';
  return {
    tokens: {
      access,
      tokenType: 'oauth',
      ...(refresh !== undefined ? { refresh } : {}),
      ...(expiresIn !== undefined ? { accessExpiresAt: now + expiresIn * 1000 } : {}),
      ...(refreshExpiresIn !== undefined ? { refreshExpiresAt: now + refreshExpiresIn * 1000 } : {}),
    },
    scopes: scope.split(scopeSeparator).map((item) => item.trim()).filter((item) => item !== ''),
  };
}
