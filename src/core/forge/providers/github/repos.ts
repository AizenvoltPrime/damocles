import { field, type ForgeHttp } from '../../http';
import { ForgeHttpError, type ForgeServer } from '../../types';
import type { RepoAccess } from '../provider';

/** GET /repos/{owner}/{repo}: permissions.push and admin; a 404 is a repository the token cannot see. */
export async function githubRepoAccess(http: ForgeHttp, server: ForgeServer, token: string, repoPath: string, signal: AbortSignal): Promise<RepoAccess> {
  const [owner, repo] = repoPath.split('/');
  if (owner === undefined || repo === undefined) throw new Error('A GitHub repository path is owner/repo');
  try {
    const response = await http.request({ server, url: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, template: '/repos/{owner}/{repo}', credential: { bearer: token }, signal });
    const permissions = field(response.body, 'permissions');
    if (typeof permissions !== 'object' || permissions === null) return { readable: true, canPush: false, owner: false, permissionsUnread: true };
    return { readable: true, canPush: field(permissions, 'push') === true || field(permissions, 'admin') === true, owner: field(permissions, 'admin') === true };
  } catch (err) {
    if (err instanceof ForgeHttpError && err.kind === 'notFound') return { readable: false, canPush: false, owner: false };
    throw err;
  }
}
