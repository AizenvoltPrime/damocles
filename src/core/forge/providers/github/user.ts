import { GITHUB_API_VERSIONS, GITHUB_DEFAULT_API_VERSION, numberField, stringField, type ForgeHttp } from '../../http';
import { ForgeHttpError, type ForgeServer } from '../../types';
import { cloneUrlHosts, type ForgeUser, type OrgAccessFinding } from '../provider';

// GitHub's user, version and organization reads (github.com, *.ghe.com and GHES share the REST API).

/** Organizations probed per account; the rest are not checked. */
export const MAX_ORGS_CHECKED = 10;

// GitHub's own login rule; the login is written to accounts.json and shown in cards and tool headers
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function githubUser(body: unknown): ForgeUser {
  const id = numberField(body, 'id');
  const login = stringField(body, 'login');
  if (id === undefined || login === undefined) throw new ForgeHttpError('server', 'GET /user answered without an id or login');
  if (!GITHUB_LOGIN.test(login)) throw new ForgeHttpError('server', 'GET /user answered a login GitHub does not issue');
  const name = stringField(body, 'name');
  const avatarUrl = stringField(body, 'avatar_url');
  return { id: String(id), login, ...(name ? { name } : {}), ...(avatarUrl ? { avatarUrl } : {}) };
}

export async function githubCurrentUser(http: ForgeHttp, server: ForgeServer, token: string): Promise<ForgeUser> {
  const response = await http.request({ server, url: '/user', template: '/user', credential: { bearer: token } });
  return githubUser(response.body);
}

/**
 * GHES: its installed version (GET /meta) and the newest REST API version both sides speak (GET /versions), else the version
 * GitHub answers a request without one as.
 */
export async function githubVersion(http: ForgeHttp, server: ForgeServer, token: string): Promise<{ version?: string; apiVersion?: string }> {
  if (server.flavor !== 'ghes') return {};
  const meta = await http.request({ server, url: '/meta', template: '/meta', credential: { bearer: token } });
  const version = stringField(meta.body, 'installed_version');
  let apiVersion: string;
  try {
    const versions = await http.request({ server, url: '/versions', template: '/versions', credential: { bearer: token } });
    const listed = Array.isArray(versions.body) ? versions.body.filter((item): item is string => typeof item === 'string') : [];
    apiVersion = GITHUB_API_VERSIONS.find((candidate) => listed.includes(candidate)) ?? GITHUB_DEFAULT_API_VERSION;
  } catch (err) {
    // a GHES before 3.9 has no /versions and speaks only 2022-11-28
    if (!(err instanceof ForgeHttpError && err.kind === 'notFound')) throw err;
    apiVersion = GITHUB_DEFAULT_API_VERSION;
  }
  return { ...(version ? { version } : {}), apiVersion };
}

export async function githubGitHosts(http: ForgeHttp, server: ForgeServer, token: string): Promise<readonly string[]> {
  const response = await http.request({ server, url: '/user/repos?per_page=1&sort=pushed', template: '/user/repos', credential: { bearer: token } });
  const first: unknown = Array.isArray(response.body) ? response.body[0] : undefined;
  return first === undefined ? [] : cloneUrlHosts([stringField(first, 'clone_url'), stringField(first, 'ssh_url')]);
}

/**
 * The organizations whose SAML SSO the token is not authorized for, or whose OAuth app access restrictions keep it out:
 * GET /user/orgs, then GET /orgs/{org}/members?per_page=1 for the first MAX_ORGS_CHECKED, which GitHub answers with 403 and
 * X-GitHub-SSO, or 403 naming the app restrictions.
 */
export async function githubOrgAccess(http: ForgeHttp, server: ForgeServer, token: string): Promise<readonly OrgAccessFinding[]> {
  const response = await http.request({ server, url: '/user/orgs?per_page=100', template: '/user/orgs', credential: { bearer: token } });
  const orgs = (Array.isArray(response.body) ? response.body : []).map((org) => stringField(org, 'login')).filter((login): login is string => login !== undefined && /^[A-Za-z0-9-]{1,39}$/.test(login));
  const findings: OrgAccessFinding[] = [];
  for (const org of orgs.slice(0, MAX_ORGS_CHECKED)) {
    try {
      await http.request({ server, url: `/orgs/${org}/members?per_page=1`, template: '/orgs/{org}/members', credential: { bearer: token }, as: 'none' });
    } catch (err) {
      if (!(err instanceof ForgeHttpError)) throw err;
      if (err.kind === 'ssoRequired') findings.push({ kind: 'ssoRequired', org, ...(err.ssoUrl !== undefined ? { url: err.ssoUrl } : {}) });
      else if (err.kind === 'appNotApproved') findings.push({ kind: 'appNotApproved', org });
      else if (err.kind !== 'forbidden' && err.kind !== 'notFound') throw err;
    }
  }
  return findings;
}
