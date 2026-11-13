// Adapted from GitLab Workflow for VS Code (https://gitlab.com/gitlab-org/gitlab-vscode-extension),
// src/desktop/accounts/auth_flows/pat_flow.ts and src/common/platform/gitlab_account.ts.
// Copyright (c) 2020-present GitLab Inc. Licensed under the MIT License (THIRD-PARTY-NOTICES.md).
import type { LocalizedText } from '../../../../shared/localized-text';
import { l } from '../../../l10n';
import { numberField, stringField, type ForgeHttp } from '../../http';
import { ForgeHttpError, type ForgeServer } from '../../types';
import { cloneUrlHosts, type ForgeUser } from '../provider';

/** The oldest GitLab Damocles signs in to, by any route. */
export const MIN_GITLAB_VERSION: readonly [number, number] = [16, 1];

// GitLab's username characters; the login is written to accounts.json and shown in cards and tool headers
const GITLAB_USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;

export function gitlabUser(body: unknown): ForgeUser {
  const id = numberField(body, 'id');
  const login = stringField(body, 'username');
  if (id === undefined || login === undefined) throw new ForgeHttpError('server', 'GET /user answered without an id or username');
  if (!GITLAB_USERNAME.test(login)) throw new ForgeHttpError('server', 'GET /user answered a username GitLab does not issue');
  const name = stringField(body, 'name');
  const avatarUrl = stringField(body, 'avatar_url');
  return { id: String(id), login, ...(name ? { name } : {}), ...(avatarUrl ? { avatarUrl } : {}), ...(body !== null && typeof body === 'object' && (body as Record<string, unknown>)['bot'] === true ? { bot: true } : {}) };
}

export async function gitlabCurrentUser(http: ForgeHttp, server: ForgeServer, token: string): Promise<ForgeUser> {
  const response = await http.request({ server, url: '/user', template: '/user', credential: { bearer: token } });
  return gitlabUser(response.body);
}

export async function gitlabVersion(http: ForgeHttp, server: ForgeServer, token: string): Promise<{ version?: string }> {
  const response = await http.request({ server, url: '/version', template: '/version', credential: { bearer: token } });
  const version = stringField(response.body, 'version');
  return version ? { version } : {};
}

/** The refusal of a sign-in to a GitLab older than MIN_GITLAB_VERSION. */
export function oldGitLabText(version: string): LocalizedText {
  return l('This server runs GitLab {0}. Damocles needs GitLab 16.1 or later.', version);
}

/** The oldest GitLab with the OAuth device authorization grant. */
export const MIN_GITLAB_DEVICE_VERSION: readonly [number, number] = [17, 1];

/** False for a version older than least; a version Damocles cannot read passes. */
export function gitLabVersionAtLeast(version: string, least: readonly [number, number]): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return true;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > least[0] || (major === least[0] && minor >= least[1]);
}

/** False for a version older than MIN_GITLAB_VERSION; a version Damocles cannot read passes. */
export function supportedGitLabVersion(version: string): boolean {
  return gitLabVersionAtLeast(version, MIN_GITLAB_VERSION);
}

export async function gitlabGitHosts(http: ForgeHttp, server: ForgeServer, token: string): Promise<readonly string[]> {
  const response = await http.request({ server, url: '/projects?membership=true&simple=true&per_page=1&order_by=last_activity_at', template: '/projects', credential: { bearer: token } });
  const first: unknown = Array.isArray(response.body) ? response.body[0] : undefined;
  return first === undefined ? [] : cloneUrlHosts([stringField(first, 'http_url_to_repo'), stringField(first, 'ssh_url_to_repo')]);
}
