import type { BranchProtectionRule } from '../../../../shared/forge/branch-protection';
import { field, numberField, stringField, type ForgeHttp } from '../../http';
import type { ForgeServer } from '../../types';
import { gitlabProjectAccess, gitlabReadsAccessLevel } from './projects';

const MAX_PAGES = 10;
const PAGE_SIZE = 100;

/**
 * Whether one push_access_levels entry lets the user push: their own user entry, or a role entry (0 is "No one") at or below
 * their access level. A group or deploy key entry is not read as the user's, since its membership is unknown here.
 */
export function pushEntryAllows(entry: unknown, userId: number, level: number): boolean {
  const user = numberField(entry, 'user_id');
  if (user !== undefined) return user === userId;
  if (numberField(entry, 'group_id') !== undefined || numberField(entry, 'deploy_key_id') !== undefined) return false;
  const required = numberField(entry, 'access_level');
  return required !== undefined && required > 0 && level >= required;
}

/** The protected branch names (GitLab wildcards) whose push_access_levels exclude the user. */
export function gitlabProtectedNames(branches: readonly unknown[], userId: number, level: number): string[] {
  return branches.flatMap((branch) => {
    const name = stringField(branch, 'name');
    if (name === undefined) return [];
    const levels = field(branch, 'push_access_levels');
    const entries = Array.isArray(levels) ? levels : [];
    return entries.some((entry) => pushEntryAllows(entry, userId, level)) ? [] : [name];
  });
}

/**
 * GET /projects/:id/protected_branches against the user's highest role (GraphQL maxAccessLevel, 16.9 and later); none for an
 * account that cannot push to the project at all, whose refused push is the access check's, and none before 16.9.
 */
export async function gitlabBranchProtection(http: ForgeHttp, server: ForgeServer, token: string, userId: number, repoPath: string, signal: AbortSignal): Promise<readonly BranchProtectionRule[]> {
  if (!gitlabReadsAccessLevel(server)) return [];
  const access = await gitlabProjectAccess(http, server, token, repoPath, signal);
  if (!access.readable || !access.canPush || access.level === undefined) return [];
  const project = `/projects/${encodeURIComponent(repoPath)}`;
  const branches: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = (await http.request({ server, url: `${project}/protected_branches?per_page=${PAGE_SIZE}&page=${page}`, template: '/projects/{path}/protected_branches', credential: { bearer: token }, signal })).body;
    const items = Array.isArray(body) ? body : [];
    branches.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  const names = gitlabProtectedNames(branches, userId, access.level);
  return names.length > 0 ? [{ include: names, exclude: [], syntax: 'gitlab' }] : [];
}
