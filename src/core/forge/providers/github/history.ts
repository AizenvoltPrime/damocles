// Author pictures and the pull request that merged a commit on GitHub, adapted from VS Code's
// extensions/github/src/historyItemDetailsProvider.ts (GitHubSourceControlHistoryItemDetailsProvider: the assignableUsers and
// commitAuthor queries and the no-reply address), Copyright (c) Microsoft Corporation. Licensed under the MIT License
// (THIRD-PARTY-NOTICES.md).
import { FULL_SHA } from '../../../../shared/forge/links';
import { field, numberField, stringField } from '../../http';
import type { RepoContext } from '../../tools/api';
import { githubGraphql, graphqlFailure } from './graphql';

// pictures are asked at 64 px, the largest shown (1.75rem) at 2x, so main's 32 MiB cache holds more of them
const ASSIGNABLE_USERS_QUERY = `
query assignableUsers($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    assignableUsers(first: 100) { nodes { login name email avatarUrl(size: 64) } }
  }
}`;

// github.com's no-reply address carries the user id: <id>+<login>@users.noreply.github.com
const NO_REPLY = /^(\d{1,12})\+[^@\s]{1,100}@users\.noreply\.github\.com$/;

export interface AssignableUser {
  readonly login: string;
  readonly name?: string;
  /** The public email, lower-cased; GitHub answers '' when there is none. */
  readonly email?: string;
  readonly avatarUrl: string;
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

async function graphql(ctx: RepoContext, what: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const answer = await githubGraphql(ctx.http, ctx.server, ctx.token, what, query, variables, ctx.signal);
  const repository = field(answer.data, 'repository');
  if (typeof repository !== 'object' || repository === null) throw graphqlFailure(answer.errors, `GitHub answered ${what} without the repository`);
  return repository;
}

const ownerAndRepo = (ctx: RepoContext): { readonly owner: string; readonly repo: string } => {
  const [owner, repo] = ctx.repoPath.split('/');
  return { owner: owner!, repo: repo! };
};

/** The user id of github.com's no-reply address, else undefined. */
export function noReplyUserId(email: string): string | undefined {
  return NO_REPLY.exec(email)?.[1];
}

/** github.com's picture of a user id, which needs no API call. */
export const noReplyAvatarUrl = (userId: string): string => `https://avatars.githubusercontent.com/u/${userId}?s=64`;

/** The first 100 users who can be assigned in the repository: a page of likely authors in one query. */
export async function assignableUsers(ctx: RepoContext): Promise<AssignableUser[]> {
  const repository = await graphql(ctx, 'assignableUsers', ASSIGNABLE_USERS_QUERY, ownerAndRepo(ctx));
  return list(field(field(repository, 'assignableUsers'), 'nodes')).flatMap((node) => {
    const login = stringField(node, 'login');
    const avatarUrl = stringField(node, 'avatarUrl');
    if (login === undefined || avatarUrl === undefined) return [];
    const name = stringField(node, 'name');
    const email = stringField(node, 'email')?.toLowerCase();
    return [{ login, avatarUrl, ...(name ? { name } : {}), ...(email ? { email } : {}) }];
  });
}

/**
 * Each commit's author's picture in one query of aliased objects: a URL, or null for a commit whose author is no GitHub user.
 * A commit the server does not have (not pushed yet) is left out, since it says nothing about its author.
 */
export async function commitAuthorPictures(ctx: RepoContext, shas: readonly string[]): Promise<Map<string, string | null>> {
  const checked = shas.filter((sha) => FULL_SHA.test(sha));
  const pictures = new Map<string, string | null>();
  if (checked.length === 0) return pictures;
  const declared = checked.map((_sha, index) => `$c${index}: GitObjectID!`).join(', ');
  const objects = checked.map((_sha, index) => `    c${index}: object(oid: $c${index}) { ... on Commit { author { user { avatarUrl(size: 64) } } } }`).join('\n');
  const query = `query commitAuthors($owner: String!, $repo: String!, ${declared}) {\n  repository(owner: $owner, name: $repo) {\n${objects}\n  }\n}`;
  const variables: Record<string, unknown> = { ...ownerAndRepo(ctx) };
  checked.forEach((sha, index) => {
    variables[`c${index}`] = sha;
  });
  const repository = await graphql(ctx, 'commitAuthors', query, variables);
  checked.forEach((sha, index) => {
    const commit = field(repository, `c${index}`);
    if (typeof commit !== 'object' || commit === null) return;
    pictures.set(sha, stringField(field(field(commit, 'author'), 'user'), 'avatarUrl') ?? null);
  });
  return pictures;
}

/** The merged pull request that contains the commit, the first merged when several did; undefined for none. */
export async function mergedPullRequest(ctx: RepoContext, sha: string): Promise<number | undefined> {
  const response = await ctx.http.request({
    server: ctx.server,
    url: `/repos/${ctx.repoPath}/commits/${sha}/pulls?per_page=100`,
    template: '/repos/{owner}/{repo}/commits/{sha}/pulls',
    credential: { bearer: ctx.token },
    signal: ctx.signal,
  });
  const merged = list(response.body).flatMap((pull) => {
    const number = numberField(pull, 'number');
    const mergedAt = stringField(pull, 'merged_at');
    return number !== undefined && Number.isSafeInteger(number) && number > 0 && mergedAt !== undefined ? [{ number, mergedAt }] : [];
  });
  merged.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number);
  return merged[0]?.number;
}
