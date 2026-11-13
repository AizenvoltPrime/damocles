import { l } from '../../../l10n';
import { numberField, stringField } from '../../http';
import { ForgeHttpError, ForgeSignInError, type ForgeServer } from '../../types';
import { clientRefusedError, grantOf, missingScopeError, RefreshRefusedError, tokenCheckError, type DevicePoll, type ForgeProvider } from '../provider';
import { githubRepoAccess } from './repos';
import { githubBranchProtection } from './protection';
import { githubCurrentUser, githubGitHosts, githubOrgAccess, githubUser, githubVersion } from './user';

// GitHub's OAuth app endpoints, after VS Code's github-authentication flows.ts (loopback 288, device 389, token 525,
// login/prompt 253-258) and githubServer.ts 238-262 (revoke), MIT.

const OAUTH_SCOPES = ['repo', 'workflow', 'read:user', 'user:email', 'read:org', 'offline_access'];
const TOKEN_SCOPES = ['repo', 'workflow', 'read:user', 'user:email', 'read:org'];
// a classic token without it can neither push nor read private repositories
const REQUIRED_TOKEN_SCOPE = 'repo';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// GitHub answers its OAuth endpoints' errors as 200 with an `error` field, some as 400 or 401
const OAUTH_ERROR_STATUSES = [400, 401, 404];

function oauthError(body: unknown): string | undefined {
  return stringField(body, 'error');
}

export const githubProvider: ForgeProvider = {
  kind: 'github',
  oauthScopes: OAUTH_SCOPES,
  tokenScopes: TOKEN_SCOPES,

  authorizeUrl(server, { client, redirectUri, state, challenge, login }) {
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPES.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (login !== undefined) params.set('login', login);
    else params.set('prompt', 'select_account');
    return `${server.webUrl}/login/oauth/authorize?${params.toString()}`;
  },

  async exchangeCode(http, server, client, { code, redirectUri, verifier }, signal, now) {
    const response = await http.request({
      server,
      method: 'POST',
      url: `${server.webUrl}/login/oauth/access_token`,
      template: '/login/oauth/access_token',
      form: { client_id: client.clientId, ...(client.clientSecret !== undefined ? { client_secret: client.clientSecret } : {}), code, redirect_uri: redirectUri, code_verifier: verifier },
      acceptStatuses: OAUTH_ERROR_STATUSES,
      signal,
    });
    if (oauthError(response.body) !== undefined || response.status >= 400) throw new ForgeSignInError('provider', l('GitHub did not accept the sign-in. Start it again.'));
    return grantOf(response.body, ',', now());
  },

  async startDevice(http, server, client, signal) {
    const response = await http.request({
      server,
      method: 'POST',
      url: `${server.webUrl}/login/device/code`,
      template: '/login/device/code',
      form: { client_id: client.clientId, scope: OAUTH_SCOPES.join(' ') },
      acceptStatuses: OAUTH_ERROR_STATUSES,
      signal,
    });
    const error = oauthError(response.body);
    if (error === 'invalid_client' || error === 'unauthorized_client') throw clientRefusedError();
    if (error !== undefined || response.status >= 400) return undefined;
    const deviceCode = stringField(response.body, 'device_code');
    const userCode = stringField(response.body, 'user_code');
    const verificationUri = stringField(response.body, 'verification_uri');
    const expiresIn = numberField(response.body, 'expires_in');
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined || expiresIn === undefined) return undefined;
    return { deviceCode, userCode, verificationUri, expiresIn, interval: numberField(response.body, 'interval') ?? 5 };
  },

  async pollDevice(http, server, client, deviceCode, signal, now): Promise<DevicePoll> {
    const response = await http.request({
      server,
      method: 'POST',
      url: `${server.webUrl}/login/oauth/access_token`,
      template: '/login/oauth/access_token',
      form: { client_id: client.clientId, device_code: deviceCode, grant_type: DEVICE_GRANT },
      acceptStatuses: OAUTH_ERROR_STATUSES,
      signal,
    });
    switch (oauthError(response.body)) {
      case undefined: return { kind: 'granted', grant: grantOf(response.body, ',', now()) };
      case 'authorization_pending': return { kind: 'pending' };
      case 'slow_down': {
        const interval = numberField(response.body, 'interval');
        return interval !== undefined ? { kind: 'slowDown', interval } : { kind: 'slowDown' };
      }
      case 'expired_token': return { kind: 'expired' };
      case 'access_denied': return { kind: 'denied' };
      default: throw new ForgeSignInError('provider', l('GitHub did not accept the sign-in. Start it again.'));
    }
  },

  async refresh(http, server, client, refreshToken, route, now) {
    const response = await http.request({
      server,
      method: 'POST',
      url: `${server.webUrl}/login/oauth/access_token`,
      template: '/login/oauth/access_token',
      // GitHub needs no secret for a device-flow token's refresh
      form: { client_id: client.clientId, grant_type: 'refresh_token', refresh_token: refreshToken, ...(route === 'browser' && client.clientSecret !== undefined ? { client_secret: client.clientSecret } : {}) },
      acceptStatuses: OAUTH_ERROR_STATUSES,
    });
    // every OAuth error code is permanent (RFC 6749 section 5.2, and GitHub's own such as incorrect_client_credentials)
    if (oauthError(response.body) !== undefined) throw new RefreshRefusedError();
    if (response.status >= 400) throw new ForgeHttpError('server', 'The token endpoint answered no token', { status: response.status });
    return grantOf(response.body, ',', now());
  },

  async revoke(http, server, client, tokens) {
    if (tokens.tokenType !== 'oauth' || client?.clientSecret === undefined) return false;
    await http.request({
      server,
      method: 'DELETE',
      url: `/applications/${encodeURIComponent(client.clientId)}/token`,
      template: '/applications/{client_id}/token',
      credential: { basic: { user: client.clientId, password: client.clientSecret } },
      json: { access_token: tokens.access },
      as: 'none',
    });
    return true;
  },

  revokePage(server: ForgeServer, clientId: string | undefined) {
    return clientId !== undefined ? `${server.webUrl}/settings/connections/applications/${encodeURIComponent(clientId)}` : `${server.webUrl}/settings/tokens`;
  },

  tokenPage(server) {
    return `${server.webUrl}/settings/tokens/new?${new URLSearchParams({ description: 'Damocles', scopes: TOKEN_SCOPES.join(',') }).toString()}`;
  },

  async validateToken(http, server, token) {
    let response;
    try {
      response = await http.request({ server, url: '/user', template: '/user', credential: { bearer: token } });
    } catch (err) {
      throw tokenCheckError(err);
    }
    const user = githubUser(response.body);
    // a fine-grained token has no X-OAuth-Scopes; GET /user is its whole check
    const header = response.headers.get('x-oauth-scopes');
    if (header === null) return { user, scopes: [] };
    const scopes = header.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '');
    if (!scopes.includes(REQUIRED_TOKEN_SCOPE)) throw missingScopeError(REQUIRED_TOKEN_SCOPE);
    return { user, scopes };
  },

  currentUser: githubCurrentUser,
  readVersion: githubVersion,
  learnGitHosts: githubGitHosts,
  orgAccess: githubOrgAccess,
  repoAccess: githubRepoAccess,
  branchProtection: (http, server, token, _userId, repoPath, signal) => githubBranchProtection(http, server, token, repoPath, signal),
};
