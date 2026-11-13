import { field, numberField, type ForgeHttp } from '../../http';
import { ForgeHttpError, type ForgeServer } from '../../types';
import type { RepoAccess } from '../provider';

// GitLab's access levels: 50 owner
const OWNER_LEVEL = 50;
/** The oldest GitLab whose GraphQL Project has maxAccessLevel; an older one is read for push access only. */
export const MIN_ACCESS_LEVEL_VERSION: readonly [number, number] = [16, 9];

/** gitlab.com runs the newest release; a self-managed server by the version read at sign-in, none read counting as older. */
export function gitlabReadsAccessLevel(server: ForgeServer): boolean {
  if (server.builtIn) return true;
  const match = /^(\d+)\.(\d+)/.exec(server.record.version ?? '');
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > MIN_ACCESS_LEVEL_VERSION[0] || (major === MIN_ACCESS_LEVEL_VERSION[0] && minor >= MIN_ACCESS_LEVEL_VERSION[1]);
}

const ACCESS_QUERY = `query DamoclesProjectAccess($fullPath: ID!) {
  project(fullPath: $fullPath) { userPermissions { pushCode } maxAccessLevel { integerValue } }
}`;
const PUSH_QUERY = `query DamoclesProjectPush($fullPath: ID!) {
  project(fullPath: $fullPath) { userPermissions { pushCode } }
}`;

/**
 * The account's access to a project: readable (GraphQL answers the project), canPush (userPermissions.pushCode, which counts
 * every source of access: membership, a group, a group the project is shared with, an instance administrator), and its
 * highest role (maxAccessLevel, 0 for a non-member of a public project) where the server has it.
 */
export interface GitlabProjectAccess {
  readonly readable: boolean;
  readonly canPush: boolean;
  readonly level?: number;
}

/** GraphQL project(fullPath): userPermissions.pushCode and, from 16.9, maxAccessLevel.integerValue. */
export async function gitlabProjectAccess(http: ForgeHttp, server: ForgeServer, token: string, repoPath: string, signal: AbortSignal): Promise<GitlabProjectAccess> {
  const withLevel = gitlabReadsAccessLevel(server);
  const response = await http.request({
    server,
    method: 'POST',
    url: `${server.webUrl}/api/graphql`,
    template: '/api/graphql project',
    credential: { bearer: token },
    json: { query: withLevel ? ACCESS_QUERY : PUSH_QUERY, variables: { fullPath: repoPath } },
    signal,
  });
  const data = field(response.body, 'data');
  if (data === undefined || data === null) throw new ForgeHttpError('server', 'GitLab answered the project query without data');
  // a project the token cannot see answers null, as a 404 does over REST
  const project = field(data, 'project');
  if (project === undefined || project === null) return { readable: false, canPush: false };
  const level = withLevel ? numberField(field(project, 'maxAccessLevel'), 'integerValue') : undefined;
  return { readable: true, canPush: field(field(project, 'userPermissions'), 'pushCode') === true, ...(level !== undefined ? { level } : {}) };
}

/** The access check's read: push from pushCode, owner from a role of 50; a project the token cannot see is not readable. */
export async function gitlabRepoAccess(http: ForgeHttp, server: ForgeServer, token: string, repoPath: string, signal: AbortSignal): Promise<RepoAccess> {
  const access = await gitlabProjectAccess(http, server, token, repoPath, signal);
  return { readable: access.readable, canPush: access.canPush, owner: (access.level ?? 0) >= OWNER_LEVEL };
}
