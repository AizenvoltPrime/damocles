import { field, numberField, stringField, type ForgeRequest, type ForgeTail } from '../http';
import { hasNextPage, readPages } from '../paging';
import { githubGraphql, graphqlFailure } from '../providers/github/graphql';
import { ForgeHttpError } from '../types';
import { decodeTail, InputError, MAX_JOB_LOG_BYTES, type ForgeRepoApi, type Issue, type Job, type MergeRequest, type Note, type Pipeline, type RepoContext } from './api';

// A workflow run is the tools' pipeline and a pull request their merge request.

const repo = (ctx: RepoContext): string => {
  const [owner, name] = ctx.repoPath.split('/');
  return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
};

async function getPage(ctx: RepoContext, path: string, template: string, query: Record<string, string>): Promise<{ readonly body: unknown; readonly next: boolean }> {
  const search = new URLSearchParams(query).toString();
  const response = await ctx.http.request({ server: ctx.server, url: `${repo(ctx)}${path}${search ? `?${search}` : ''}`, template: `/repos/{owner}/{repo}${template}`, credential: { bearer: ctx.token }, signal: ctx.signal });
  return { body: response.body, next: hasNextPage(response.headers) };
}

async function get(ctx: RepoContext, path: string, template: string, query: Record<string, string> = {}): Promise<unknown> {
  return (await getPage(ctx, path, template, query)).body;
}

/** A workflow run's jobs, every page up to the cap: of its latest attempt, or of every attempt. */
function runJobs(ctx: RepoContext, runId: number, filter: 'latest' | 'all'): Promise<{ readonly items: unknown[]; readonly truncated: boolean }> {
  return readPages(async (page) => {
    const answer = await getPage(ctx, `/actions/runs/${runId}/jobs`, '/actions/runs/{id}/jobs', { filter, per_page: '100', page: String(page) });
    return { items: list(field(answer.body, 'jobs')), next: answer.next };
  });
}

/**
 * The attempt of a rerun job among its run's jobs of every attempt: the same name, the newest run_attempt past the job's own,
 * and the same place among the jobs of that name, by id; undefined when there is none yet or the places do not line up.
 */
export function newerAttempt(job: unknown, jobs: readonly unknown[]): unknown {
  const name = stringField(job, 'name');
  const attempt = numberField(job, 'run_attempt');
  const id = numberField(job, 'id');
  if (name === undefined || attempt === undefined || id === undefined) return undefined;
  const named = jobs.filter((each) => stringField(each, 'name') === name);
  const ofAttempt = (number: number): unknown[] => named.filter((each) => numberField(each, 'run_attempt') === number).sort((a, b) => (numberField(a, 'id') ?? 0) - (numberField(b, 'id') ?? 0));
  const newest = named.reduce<number>((best, each) => Math.max(best, numberField(each, 'run_attempt') ?? 0), 0);
  if (newest <= attempt) return undefined;
  const before = ofAttempt(attempt);
  const place = before.findIndex((each) => numberField(each, 'id') === id);
  const after = ofAttempt(newest);
  return place >= 0 && after.length === before.length ? after[place] : undefined;
}

async function post(ctx: RepoContext, path: string, template: string, json?: unknown): Promise<unknown> {
  const request: ForgeRequest = { server: ctx.server, method: 'POST', url: `${repo(ctx)}${path}`, template: `/repos/{owner}/{repo}${template}`, credential: { bearer: ctx.token }, signal: ctx.signal, ...(json !== undefined ? { json } : {}) };
  return (await ctx.http.request(request)).body;
}

const list = (body: unknown): unknown[] => (Array.isArray(body) ? body : []);

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new ForgeHttpError('server', `GitHub answered without ${what}`);
  return value;
}

/** A finished run or job reads as its conclusion (success, failure, cancelled), a running one as its status. */
const statusOf = (body: unknown): string => stringField(body, 'conclusion') ?? stringField(body, 'status') ?? 'unknown';

function runOf(body: unknown): Pipeline {
  const ref = stringField(body, 'head_branch');
  const sha = stringField(body, 'head_sha');
  const name = stringField(body, 'display_title') ?? stringField(body, 'name');
  const createdAt = stringField(body, 'created_at');
  const webUrl = stringField(body, 'html_url');
  return {
    id: required(numberField(body, 'id'), 'a run id'),
    status: statusOf(body),
    ...(ref !== undefined ? { ref } : {}),
    ...(sha !== undefined ? { sha } : {}),
    ...(name ? { name } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(webUrl !== undefined ? { webUrl } : {}),
  };
}

function jobOf(body: unknown): Job {
  const runId = numberField(body, 'run_id');
  const started = Date.parse(stringField(body, 'started_at') ?? '');
  const completed = Date.parse(stringField(body, 'completed_at') ?? '');
  const webUrl = stringField(body, 'html_url');
  return {
    id: required(numberField(body, 'id'), 'a job id'),
    name: stringField(body, 'name') ?? '',
    status: statusOf(body),
    ...(runId !== undefined ? { pipelineId: runId } : {}),
    ...(Number.isFinite(started) && Number.isFinite(completed) ? { durationSeconds: Math.round((completed - started) / 1000) } : {}),
    ...(webUrl !== undefined ? { webUrl } : {}),
  };
}

function pullOf(body: unknown): MergeRequest {
  const webUrl = stringField(body, 'html_url');
  const createdAt = stringField(body, 'created_at');
  const merged = stringField(body, 'merged_at') !== undefined;
  return {
    number: required(numberField(body, 'number'), 'a pull request number'),
    title: stringField(body, 'title') ?? '',
    state: merged ? 'merged' : stringField(body, 'state') ?? 'unknown',
    draft: field(body, 'draft') === true,
    author: stringField(field(body, 'user'), 'login') ?? '',
    sourceBranch: stringField(field(body, 'head'), 'ref') ?? '',
    targetBranch: stringField(field(body, 'base'), 'ref') ?? '',
    description: stringField(body, 'body') ?? '',
    ...(webUrl !== undefined ? { webUrl } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function issueOf(body: unknown): Issue {
  const webUrl = stringField(body, 'html_url');
  const createdAt = stringField(body, 'created_at');
  return {
    number: required(numberField(body, 'number'), 'an issue number'),
    title: stringField(body, 'title') ?? '',
    state: stringField(body, 'state') ?? 'unknown',
    author: stringField(field(body, 'user'), 'login') ?? '',
    labels: list(field(body, 'labels')).map((label) => stringField(label, 'name')).filter((name): name is string => name !== undefined),
    description: stringField(body, 'body') ?? '',
    ...(webUrl !== undefined ? { webUrl } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function commentsOf(body: unknown): Note[] {
  return list(body).map((comment): Note => {
    const createdAt = stringField(comment, 'created_at');
    return { author: stringField(field(comment, 'user'), 'login') ?? '', body: stringField(comment, 'body') ?? '', ...(createdAt !== undefined ? { createdAt } : {}) };
  });
}

const COMMENTS_PER_PAGE = 100;

/** The newest comments of an issue or pull request: issue comments list oldest first, so the pages are read from its count. */
async function latestComments(ctx: RepoContext, number: number, limit: number): Promise<Note[]> {
  const count = numberField(await get(ctx, `/issues/${number}`, '/issues/{number}'), 'comments') ?? 0;
  const last = Math.max(1, Math.ceil(count / COMMENTS_PER_PAGE));
  const page = async (index: number): Promise<Note[]> => commentsOf(await get(ctx, `/issues/${number}/comments`, '/issues/{number}/comments', { per_page: String(COMMENTS_PER_PAGE), page: String(index) }));
  const notes = await page(last);
  const earlier = notes.length < limit && last > 1 ? await page(last - 1) : [];
  return [...earlier, ...notes].slice(-limit);
}

/** GitHub's issue endpoints also answer pull requests, which carry a pull_request field. */
const isPullRequest = (body: unknown): boolean => field(body, 'pull_request') !== undefined;

// GraphQL lists only the kind and states asked for, where a REST page holds pull requests among issues and closed among merged
const ISSUES_QUERY = `query ForgeToolIssues($owner: String!, $repo: String!, $states: [IssueState!], $first: Int!) {
  repository(owner: $owner, name: $repo) {
    issues(states: $states, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title state url createdAt author { login } labels(first: 20) { nodes { name } } }
    }
  }
}`;

const PULL_REQUESTS_QUERY = `query ForgeToolPullRequests($owner: String!, $repo: String!, $states: [PullRequestState!], $first: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: $states, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title state isDraft url createdAt headRefName baseRefName author { login } }
    }
  }
}`;

/** The nodes of repository.<connection> a GraphQL list query answered. */
async function graphqlNodes(ctx: RepoContext, what: string, query: string, connection: string, variables: Record<string, unknown>): Promise<unknown[]> {
  const [owner, repo] = ctx.repoPath.split('/');
  const answer = await githubGraphql(ctx.http, ctx.server, ctx.token, what, query, { owner, repo, ...variables }, ctx.signal);
  const repository = field(answer.data, 'repository');
  if (repository === null || repository === undefined) throw graphqlFailure(answer.errors, `GitHub answered no repository for its ${what}`, answer.ssoUrl);
  return list(field(field(repository, connection), 'nodes'));
}

const lowerState = (node: unknown): string => stringField(node, 'state')?.toLowerCase() ?? 'unknown';

function graphqlIssueOf(node: unknown): Issue {
  const webUrl = stringField(node, 'url');
  const createdAt = stringField(node, 'createdAt');
  return {
    number: required(numberField(node, 'number'), 'an issue number'),
    title: stringField(node, 'title') ?? '',
    state: lowerState(node),
    author: stringField(field(node, 'author'), 'login') ?? '',
    labels: list(field(field(node, 'labels'), 'nodes')).map((label) => stringField(label, 'name')).filter((name): name is string => name !== undefined),
    description: '',
    ...(webUrl !== undefined ? { webUrl } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function graphqlPullOf(node: unknown): MergeRequest {
  const webUrl = stringField(node, 'url');
  const createdAt = stringField(node, 'createdAt');
  return {
    number: required(numberField(node, 'number'), 'a pull request number'),
    title: stringField(node, 'title') ?? '',
    state: lowerState(node),
    draft: field(node, 'isDraft') === true,
    author: stringField(field(node, 'author'), 'login') ?? '',
    sourceBranch: stringField(node, 'headRefName') ?? '',
    targetBranch: stringField(node, 'baseRefName') ?? '',
    description: '',
    ...(webUrl !== undefined ? { webUrl } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

export const githubRepoApi: ForgeRepoApi = {
  async pipelines(ctx, { ref, limit }) {
    const body = await get(ctx, '/actions/runs', '/actions/runs', { per_page: String(limit), ...(ref !== undefined ? { branch: ref } : {}) });
    return list(field(body, 'workflow_runs')).map(runOf);
  },

  async jobs(ctx, runId) {
    const { items, truncated } = await runJobs(ctx, runId, 'latest');
    return { jobs: items.map(jobOf), truncated };
  },

  async job(ctx, jobId) {
    return jobOf(await get(ctx, `/actions/jobs/${jobId}`, '/actions/jobs/{id}'));
  },

  async jobLog(ctx, jobId) {
    // GitHub answers with a redirect to its log storage, which http.ts follows without the token
    const response = await ctx.http.request({ server: ctx.server, url: `${repo(ctx)}/actions/jobs/${jobId}/logs`, template: '/repos/{owner}/{repo}/actions/jobs/{id}/logs', credential: { bearer: ctx.token }, as: 'tail', maxBytes: MAX_JOB_LOG_BYTES, signal: ctx.signal });
    return decodeTail(response.body as ForgeTail);
  },

  async mergeRequest(ctx, number) {
    return pullOf(await get(ctx, `/pulls/${number}`, '/pulls/{number}'));
  },

  mergeRequestNotes(ctx, number, limit) {
    return latestComments(ctx, number, limit);
  },

  async mergeRequests(ctx, { state, limit }) {
    if (state === 'merged' || state === 'closed') {
      const nodes = await graphqlNodes(ctx, 'pull requests', PULL_REQUESTS_QUERY, 'pullRequests', { states: [state === 'merged' ? 'MERGED' : 'CLOSED'], first: limit });
      return nodes.map(graphqlPullOf);
    }
    const body = await get(ctx, '/pulls', '/pulls', { state, per_page: String(limit), sort: 'updated', direction: 'desc' });
    return list(body).map(pullOf);
  },

  async issue(ctx, number) {
    const body = await get(ctx, `/issues/${number}`, '/issues/{number}');
    if (isPullRequest(body)) throw new ForgeHttpError('notFound', `#${number} is a pull request, not an issue`);
    return issueOf(body);
  },

  issueNotes(ctx, number, limit) {
    return latestComments(ctx, number, limit);
  },

  async issues(ctx, { state, limit }) {
    const states = state === 'all' ? null : [state === 'open' ? 'OPEN' : 'CLOSED'];
    return (await graphqlNodes(ctx, 'issues', ISSUES_QUERY, 'issues', { states, first: limit })).map(graphqlIssueOf);
  },

  async defaultBranch(ctx) {
    return required(stringField(await get(ctx, '', ''), 'default_branch'), 'a default branch');
  },

  async jobAction(ctx, jobId, action) {
    if (action === 'retry') {
      const before = await get(ctx, `/actions/jobs/${jobId}`, '/actions/jobs/{id}');
      const runId = required(numberField(before, 'run_id'), 'the job\'s run');
      await post(ctx, `/actions/jobs/${jobId}/rerun`, '/actions/jobs/{id}/rerun');
      // a rerun is a new attempt with a new id, which GitHub may not list yet
      const attempt = newerAttempt(before, (await runJobs(ctx, runId, 'all')).items);
      return attempt === undefined ? null : jobOf(attempt);
    }
    // GitHub cancels a whole workflow run, never one job
    const job = await this.job(ctx, jobId);
    if (job.pipelineId === undefined) throw new ForgeHttpError('server', 'GitHub answered a job without its run');
    await post(ctx, `/actions/runs/${job.pipelineId}/cancel`, '/actions/runs/{id}/cancel');
    return this.job(ctx, jobId);
  },

  async pipelineAction(ctx, runId, action) {
    const verb = action === 'retry' ? 'rerun-failed-jobs' : 'cancel';
    await post(ctx, `/actions/runs/${runId}/${verb}`, `/actions/runs/{id}/${verb}`);
  },

  async openMergeRequest(ctx, request) {
    // a branch of a fork in the same network is named <owner>:<branch>
    const head = request.sourceRepoPath !== undefined ? `${request.sourceRepoPath.split('/')[0]!}:${request.sourceBranch}` : request.sourceBranch;
    return pullOf(await post(ctx, '/pulls', '/pulls', { title: request.title, head, base: request.targetBranch, body: request.body, draft: request.draft }));
  },

  async comment(ctx, on, number, body) {
    const isPull = isPullRequest(await get(ctx, `/issues/${number}`, '/issues/{number}'));
    if (isPull !== (on === 'mergeRequest')) throw new InputError(isPull ? `#${number} is a pull request; comment on it with on: "mergeRequest".` : `#${number} is an issue; comment on it with on: "issue".`);
    return { id: required(numberField(await post(ctx, `/issues/${number}/comments`, '/issues/{number}/comments', { body }), 'id'), 'a comment id') };
  },
};
