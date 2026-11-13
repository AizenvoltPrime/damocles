// Remote URL parsing adapted from GitLab Workflow for VS Code (https://gitlab.com/gitlab-org/gitlab-vscode-extension),
// src/desktop/git/git_remote_parser.ts (normalizeSshRemote, parseGitLabRemote). Copyright (c) 2020-present GitLab Inc.
// Licensed under the MIT License (THIRD-PARTY-NOTICES.md). The GitHub form generalizes VS Code's extensions/github
// getRepositoryFromUrl (MIT, Copyright (c) Microsoft Corporation) from github.com to every GitHub server.
import type { RemoteEndpoint, RemoteLocation } from '../../shared/forge/bindings';
import type { ForgeKind } from '../../shared/forge/accounts';

// docs/invariants.md "GitHub and GitLab accounts", remote endpoints: a remote maps to the managed server by host and the
// longest GitLab path prefix; only https and ssh remotes map, and a password in a URL is never read.

/** User names a URL or git config carries that name no account (tokens' conventional users and the ssh service user). */
const PLACEHOLDER_USERS: ReadonlySet<string> = new Set(['oauth2', 'x-access-token', 'git', 'token']);
// a token written as the URL's user (GitHub documents https://<token>@github.com/...) is no login
const TOKEN_LIKE = /^(gh[pousr]_|github_pat_|glpat-|gldt-|glrt-)|^[0-9a-f]{40}$/i;
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const SSH_SCHEMES: ReadonlySet<string> = new Set(['ssh', 'git+ssh', 'ssh+git']);
// [user@host:port]:path, GitLab Workflow issue 309
const BRACKETED_SCP = /^\[(?:([^@\]/]+)@)?([^:\]/]+):(\d{1,5})\]:(.*)$/;
// [user@]host:path, git's scp-like syntax; a ':' must come before any '/' (git's url_is_local_not_ssh)
const SCP = /^(?:([^@/:]+)@)?([^@/:]+):(.*)$/;
const DOS_DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$|^\[[0-9a-f:.]+\]$/;
// an ssh host may be a Host alias of the user's ssh config, `github_work` included, which ssh -G resolves later
const SSH_HOST = /^[^/:@[\]\s]{1,255}$/;
const MAX_URL_CHARS = 2048;

/** A user name as a hint, or undefined for an empty or placeholder one. */
export function usernameHintOf(user: string | undefined): string | undefined {
  const value = user?.trim();
  if (value === undefined || value === '' || value.length > 255 || PLACEHOLDER_USERS.has(value.toLowerCase()) || TOKEN_LIKE.test(value)) return undefined;
  return value;
}

export interface ParsedRemoteUrl {
  readonly protocol: 'https' | 'ssh';
  /** The userinfo's user; never the password. */
  readonly user?: string;
  readonly host: string;
  readonly port?: number;
  /** Without leading or trailing slashes. */
  readonly path: string;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** An https or ssh remote URL (scheme form or scp-like) as its parts; undefined for a local path or another scheme. */
export function parseRemoteUrl(url: string): ParsedRemoteUrl | undefined {
  const raw = url.trim();
  // eslint-disable-next-line no-control-regex
  if (raw === '' || raw.length > MAX_URL_CHARS || /[\s\u0000-\u001f\u007f]/.test(raw)) return undefined;
  const scheme = SCHEME.exec(raw);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    const protocol = name === 'https' ? 'https' : SSH_SCHEMES.has(name) ? 'ssh' : undefined;
    if (protocol === undefined || !URL.canParse(raw)) return undefined;
    const parsed = new URL(raw);
    const path = decoded(parsed.pathname);
    const user = parsed.username === '' ? undefined : decoded(parsed.username);
    // ssh: is not a special scheme, so WHATWG URL keeps its host's case
    const host = parsed.hostname.toLowerCase();
    if (path === undefined || !(HOST.test(host) || (protocol === 'ssh' && SSH_HOST.test(host)))) return undefined;
    return {
      protocol,
      ...(user !== undefined ? { user } : {}),
      host,
      ...(parsed.port !== '' ? { port: Number(parsed.port) } : {}),
      path: trimSlashes(path),
    };
  }
  if (DOS_DRIVE.test(raw)) return undefined;
  const bracketed = BRACKETED_SCP.exec(raw);
  const scp = bracketed ? undefined : SCP.exec(raw);
  const match = bracketed ?? scp;
  if (!match) return undefined;
  const host = match[2]!.toLowerCase();
  if (!HOST.test(host) && !SSH_HOST.test(host)) return undefined;
  const port = bracketed ? Number(bracketed[3]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  return {
    protocol: 'ssh',
    ...(match[1] !== undefined ? { user: match[1] } : {}),
    host,
    ...(port !== undefined ? { port } : {}),
    path: trimSlashes(bracketed ? bracketed[4]! : scp![3]!),
  };
}

/** A parsed URL as an endpoint location, before any ssh -G: an https user is a hint, an ssh user never is. */
export function locationOf(parsed: ParsedRemoteUrl, credentialUsername?: string): RemoteLocation {
  const hint = parsed.protocol === 'https' ? usernameHintOf(parsed.user) ?? usernameHintOf(credentialUsername) : undefined;
  return {
    protocol: parsed.protocol,
    host: parsed.host,
    ...(parsed.port !== undefined && !(parsed.protocol === 'https' && parsed.port === 443) ? { port: parsed.port } : {}),
    path: parsed.path,
    ...(hint !== undefined ? { usernameHint: hint } : {}),
    aliasResolved: false,
  };
}

/** Endpoints from `git remote -v` URLs as they are, with no alias resolution and no credential.username: an older daemon's. */
export function endpointsFromRemotes(remotes: readonly { readonly name: string; readonly fetchUrl?: string; readonly pushUrl?: string }[]): RemoteEndpoint[] {
  return remotes.map((remote) => {
    const fetch = remote.fetchUrl !== undefined ? parseRemoteUrl(remote.fetchUrl) : undefined;
    const push = remote.pushUrl !== undefined && remote.pushUrl !== remote.fetchUrl ? parseRemoteUrl(remote.pushUrl) : undefined;
    return { remote: remote.name, ...(fetch ? { fetch: locationOf(fetch) } : {}), ...(push ? { push: locationOf(push) } : {}) };
  });
}

/** What remote matching reads of a managed server. */
export interface MatchableServer {
  readonly id: string;
  readonly kind: ForgeKind;
  /** https://host[:port][/prefix] */
  readonly webUrl: string;
  /** gitHosts: host[:port] entries, the web host among them. */
  readonly record: { readonly gitHosts: readonly string[] };
}

export interface ServerMatch<S extends MatchableServer> {
  readonly server: S;
  /** The repository's path on the server, without the server's path prefix or `.git`: "grp/sub/proj". */
  readonly repoPath: string;
}

function segments(value: string): string[] {
  return value.split('/').filter((segment) => segment !== '');
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

/** GitLab: namespace/.../project; GitHub: owner/repo. `.git` and a trailing slash dropped, as parseGitLabRemote does. */
function repoPathOf(kind: ForgeKind, rest: readonly string[]): string | undefined {
  const parts = [...rest];
  if (parts.length === 0) return undefined;
  parts[parts.length - 1] = parts[parts.length - 1]!.replace(/\.git$/, '');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return undefined;
  if (kind === 'github' ? parts.length !== 2 : parts.length < 2) return undefined;
  return parts.join('/');
}

/**
 * Which remote names a repository's server, as VS Code's GitHub extension splits it: 'tracking' (file and commit links, CI)
 * takes the tracking remote, then origin; 'upstream' (history, its references and merged changes) takes upstream, then
 * origin, since in a fork clone the issues and pull requests live on the repository the fork came from. Either falls back to
 * the first remote that maps.
 */
export type RemoteOrder = 'tracking' | 'upstream';

/** A repository's remote on one of servers in order's preference, fetch URL first. */
export function repoOnServer<S extends MatchableServer>(
  repo: { readonly endpoints: readonly RemoteEndpoint[]; readonly pushRemote?: string },
  servers: readonly S[],
  order: RemoteOrder,
): (ServerMatch<S> & { readonly remote: string; readonly usernameHint?: string }) | undefined {
  const located = repo.endpoints.flatMap((endpoint) => {
    const location = endpoint.fetch ?? endpoint.push;
    const match = location ? matchServer(location, servers) : undefined;
    return match ? [{ remote: endpoint.remote, ...match, ...(location!.usernameHint !== undefined ? { usernameHint: location!.usernameHint } : {}) }] : [];
  });
  const first = order === 'upstream' ? 'upstream' : (repo.pushRemote ?? 'origin');
  return located.find((item) => item.remote === first) ?? located.find((item) => item.remote === 'origin') ?? located[0];
}

/**
 * The managed server a location points at, and the repository path when the rest of its path names one. https: the web host
 * with its port, or a git host. ssh: the host name among the web and git hosts. The web URL's path prefix is required on the
 * https web host, the one place it scopes, and optional elsewhere (an ssh path, GitLab Workflow issue 103; a separate https
 * git host). The longest prefix the path starts with wins; with none, a server whose prefix is optional is meant only when
 * it alone claims the host. Two servers with the same host and prefix: neither is meant.
 */
export function locateServer<S extends MatchableServer>(location: RemoteLocation, servers: readonly S[]): { readonly server: S; readonly repoPath?: string } | undefined {
  const path = segments(location.path);
  const hostPort = location.port !== undefined ? `${location.host}:${location.port}` : location.host;
  const candidates: { readonly server: S; readonly prefix: string[]; readonly optional: boolean }[] = [];
  for (const server of servers) {
    const web = new URL(server.webUrl);
    const prefix = segments(decodeURIComponent(web.pathname));
    if (location.protocol === 'https') {
      if (hostPort === web.host) candidates.push({ server, prefix, optional: false });
      else if (server.record.gitHosts.includes(hostPort)) candidates.push({ server, prefix, optional: true });
    } else if ([web.host, ...server.record.gitHosts].some((host) => host === location.host || host.replace(/:\d+$/, '') === location.host)) {
      candidates.push({ server, prefix, optional: true });
    }
  }
  const prefixed = candidates.filter((candidate) => startsWith(path, candidate.prefix)).sort((a, b) => b.prefix.length - a.prefix.length);
  let chosen: { readonly server: S; readonly prefix: readonly string[] } | undefined = prefixed.length > 1 && prefixed[1]!.prefix.length === prefixed[0]!.prefix.length ? undefined : prefixed[0];
  if (prefixed.length === 0) {
    const optional = candidates.filter((candidate) => candidate.optional);
    if (optional.length === 1 && candidates.length === 1) chosen = { server: optional[0]!.server, prefix: [] };
  }
  if (!chosen) return undefined;
  const repoPath = repoPathOf(chosen.server.kind, path.slice(chosen.prefix.length));
  return { server: chosen.server, ...(repoPath !== undefined ? { repoPath } : {}) };
}

/** The managed server a location points at (locateServer), only when its path names a repository there. */
export function matchServer<S extends MatchableServer>(location: RemoteLocation, servers: readonly S[]): ServerMatch<S> | undefined {
  const located = locateServer(location, servers);
  return located?.repoPath !== undefined ? { server: located.server, repoPath: located.repoPath } : undefined;
}
