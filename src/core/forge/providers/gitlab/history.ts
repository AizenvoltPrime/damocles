// Author pictures and the merge request that merged a commit on GitLab: GET /avatar?email= per address, and a commit's merge
// requests.
import { numberField, stringField } from '../../http';
import type { RepoContext } from '../../tools/api';

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The picture GitLab names for an address (a user's upload or a Gravatar URL), or undefined. */
export async function avatarOfEmail(ctx: RepoContext, email: string): Promise<string | undefined> {
  const response = await ctx.http.request({
    server: ctx.server,
    url: `/avatar?email=${encodeURIComponent(email)}&size=64`,
    template: '/avatar',
    credential: { bearer: ctx.token },
    signal: ctx.signal,
  });
  return stringField(response.body, 'avatar_url');
}

/** The merged merge request that contains the commit, the first merged when several did; undefined for none. */
export async function mergedMergeRequest(ctx: RepoContext, sha: string): Promise<number | undefined> {
  const response = await ctx.http.request({
    server: ctx.server,
    url: `/projects/${encodeURIComponent(ctx.repoPath)}/repository/commits/${sha}/merge_requests?per_page=100`,
    template: '/projects/{path}/repository/commits/{sha}/merge_requests',
    credential: { bearer: ctx.token },
    signal: ctx.signal,
  });
  const merged = list(response.body).flatMap((request) => {
    const iid = numberField(request, 'iid');
    if (iid === undefined || !Number.isSafeInteger(iid) || iid <= 0 || stringField(request, 'state') !== 'merged') return [];
    return [{ iid, mergedAt: stringField(request, 'merged_at') ?? '' }];
  });
  merged.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.iid - b.iid);
  return merged[0]?.iid;
}
