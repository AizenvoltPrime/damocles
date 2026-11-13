// Adapted from GitLab Workflow for VS Code (https://gitlab.com/gitlab-org/gitlab-vscode-extension),
// src/desktop/accounts/auth_flows/oauth_flow.ts, pat_flow.ts, src/desktop/gitlab/token_exchange_service.ts and
// src/desktop/gitlab/gitlab_service.ts 981-1007.
// Copyright (c) 2020-present GitLab Inc. Licensed under the MIT License (THIRD-PARTY-NOTICES.md).
import { l } from '../../../l10n';
import { ForgeHttpError, ForgeSignInError } from '../../types';
import { numberField, stringField } from '../../http';
import { clientRefusedError, grantOf, missingScopeError, RefreshRefusedError, tokenCheckError, type DevicePoll, type ForgeProvider } from '../provider';
import { gitlabRepoAccess } from './projects';
import { gitlabBranchProtection } from './protection';
import { gitlabCurrentUser, gitlabGitHosts, gitlabUser, gitlabVersion, oldGitLabText, supportedGitLabVersion } from './user';
import { REGISTERED_REDIRECT_URI } from '../../oauth/loopback-receiver';

// git over HTTP needs write_repository explicitly: GitLab documents it under `api` for personal access tokens only
const OAUTH_SCOPES = ['api', 'write_repository'];
const TOKEN_SCOPES = ['api'];
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const OAUTH_ERROR_STATUSES = [400, 401, 403, 404];

function oauthError(body: unknown): string | undefined {
  return stringField(body, 'error');
}

export const gitlabProvider: ForgeProvider = {
  kind: 'gitlab',
  oauthScopes: OAUTH_SCOPES,
  tokenScopes: TOKEN_SCOPES,

  authorizeUrl(server, { client, redirectUri, state, challenge }) {
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      scope: OAUTH_SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${server.webUrl}/oauth/authorize?${params.toString()}`;
  },

  async exchangeCode(http, server, client, { code, redirectUri, verifier }, signal, now) {
    const response = await http.request({
      server,
      method: 'POST',
      url: `${server.webUrl}/oauth/token`,
      template: '/oauth/token',
      form: { client_id: client.clientId, code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier },
      acceptStatuses: OAUTH_ERROR_STATUSES,
      signal,
    });
    if (oauthError(response.body) !== undefined || response.status >= 400) throw new ForgeSignInError('provider', l('GitLab did not accept the sign-in. Start it again.'));
    return grantOf(response.body, ' ', now());
  },

  async startDevice(http, server, client, signal) {
    const response = await http.request({
      server,
      method: 'POST',
      url: `${server.webUrl}/oauth/authorize_device`,
      template: '/oauth/authorize_device',
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
      url: `${server.webUrl}/oauth/token`,
      template: '/oauth/token',
      form: { client_id: client.clientId, device_code: deviceCode, grant_type: DEVICE_GRANT },
      acceptStatuses: OAUTH_ERROR_STATUSES,
      signal,
    });
    switch (oauthError(response.body)) {
      case undefined:
        if (response.status >= 400) throw new ForgeSignInError('provider', l('GitLab did not accept the sign-in. Start it again.'));
        return { kind: 'granted', grant: grantOf(response.body, ' ', now()) };
      case 'authorization_pending': return { kind: 'pending' };
      case 'slow_down': return { kind: 'slowDown' };
      case 'expired_token': return { kind: 'expired' };
      case 'access_denied': return { kind: 'denied' };
      default: throw new ForgeSignInError('provider', l('GitLab did not accept the sign-in. Start it again.'));
    }
  },

  async refresh(http, server, client, refreshToken, _route, now) {
    const response = await http.request({
      server,
      method: 'POST',
      url: `${server.webUrl}/oauth/token`,
      template: '/oauth/token',
      // a non-confidential application: client_id only
      form: { client_id: client.clientId, grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: REGISTERED_REDIRECT_URI },
      acceptStatuses: OAUTH_ERROR_STATUSES,
    });
    // every OAuth error code is permanent (RFC 6749 section 5.2)
    if (oauthError(response.body) !== undefined) throw new RefreshRefusedError();
    if (response.status >= 400) throw new ForgeHttpError('server', 'The token endpoint answered no token', { status: response.status });
    return grantOf(response.body, ' ', now());
  },

  async revoke(http, server, client, tokens) {
    if (tokens.tokenType !== 'oauth' || client === undefined) return false;
    // GitLab documents a client secret here, which a non-confidential app has none of; some versions refuse
    await http.request({
      server,
      method: 'POST',
      url: `${server.webUrl}/oauth/revoke`,
      template: '/oauth/revoke',
      form: { client_id: client.clientId, token: tokens.access },
      as: 'none',
    });
    return true;
  },

  revokePage(server, clientId) {
    return clientId !== undefined ? `${server.webUrl}/-/user_settings/applications` : `${server.webUrl}/-/user_settings/personal_access_tokens`;
  },

  tokenPage(server) {
    return `${server.webUrl}/-/user_settings/personal_access_tokens?${new URLSearchParams({ name: 'Damocles', scopes: TOKEN_SCOPES.join(',') }).toString()}`;
  },

  async validateToken(http, server, token) {
    const credential = { bearer: token };
    try {
      const self = await http.request({ server, url: '/personal_access_tokens/self', template: '/personal_access_tokens/self', credential });
      const scopes = Array.isArray((self.body as Record<string, unknown> | undefined)?.['scopes'])
        ? ((self.body as Record<string, unknown>)['scopes'] as unknown[]).filter((scope): scope is string => typeof scope === 'string')
        : [];
      const user = gitlabUser((await http.request({ server, url: '/user', template: '/user', credential })).body);
      const { version } = await gitlabVersion(http, server, token);
      if (version !== undefined && !supportedGitLabVersion(version)) {
        throw new ForgeSignInError('input', oldGitLabText(version));
      }
      if (!scopes.includes('api')) throw missingScopeError('api');
      // a group or project access token's api scope does not cover git over HTTP
      if (user.bot === true && !scopes.includes('write_repository')) throw missingScopeError('write_repository');
      return { user, scopes, ...(version !== undefined ? { version } : {}) };
    } catch (err) {
      if (err instanceof ForgeSignInError) throw err;
      if (err instanceof ForgeHttpError && err.kind === 'forbidden') throw missingScopeError('api');
      throw tokenCheckError(err);
    }
  },

  currentUser: gitlabCurrentUser,
  readVersion: gitlabVersion,
  learnGitHosts: gitlabGitHosts,
  repoAccess: gitlabRepoAccess,
  branchProtection: (http, server, token, userId, repoPath, signal) => gitlabBranchProtection(http, server, token, Number(userId), repoPath, signal),
};
