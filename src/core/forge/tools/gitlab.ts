// GitLab's pipelines, jobs, job logs, merge requests and issues for the agent tools. The pipeline, job and trace endpoints
// and the latest-attempt rule are adapted from GitLab Workflow for VS Code (https://gitlab.com/gitlab-org/gitlab-vscode-extension),
// src/desktop/gitlab/get_pipeline_and_mr_for_branch.ts, api/get_pipelines_for_ref.ts and gitlab_service.ts
// (getJobsForPipeline, cancelOrRetryJob, getJobTrace). Copyright (c) 2020-present GitLab Inc. Licensed under the MIT License
// (THIRD-PARTY-NOTICES.md).
import { field, numberField, stringField, type ForgeRequest, type ForgeTail } from '../http';
import { hasNextPage, readPages } from '../paging';
import { ForgeHttpError } from '../types';
import { decodeTail, MAX_JOB_LOG_BYTES, type ForgeRepoApi, type Issue, type Job, type MergeRequest, type Note, type Pipeline, type RepoContext } from './api';

const project = (ctx: RepoContext): string => `/projects/${encodeURIComponent(ctx.repoPath)}`;

async function getPage(ctx: RepoContext, path: string, template: string, query: Record<string, string>): Promise<{ readonly body: unknown; readonly next: boolean }> {
  const search = new URLSearchParams(query).toString();
  const response = await ctx.http.request({ server: ctx.server, url: `${project(ctx)}${path}${search ? `?${search}` : ''}`, template: `/projects/{path}${template}`, credential: { bearer: ctx.token }, signal: ctx.signal });
  return { body: response.body, next: hasNextPage(response.headers) };
}

async function get(ctx: RepoContext, path: string, template: string, query: Record<string, string> = {}): Promise<unknown> {
  return (await getPage(ctx, path, template, query)).body;
}

async function post(ctx: RepoContext, path: string, template: string, json?: unknown): Promise<unknown> {
  const request: ForgeRequest = { server: ctx.server, method: 'POST', url: `${project(ctx)}${path}`, template: `/projects/{path}${template}`, credential: { bearer: ctx.token }, signal: ctx.signal, ...(json !== undefined ? { json } : {}) };
  return (await ctx.http.request(request)).body;
}

const list = (body: unknown): unknown[] => (Array.isArray(body) ? body : []);

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new ForgeHttpError('server', `GitLab answered without ${what}`);
  return value;
}

function pipelineOf(body: unknown): Pipeline {
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  const name = stringField(body, 'name');
  const createdAt = stringField(body, 'created_at');
  const webUrl = stringField(body, 'web_url');
  return {
    id: required(numberField(body, 'id'), 'a pipeline id'),
    status: stringField(body, 'status') ?? 'unknown',
    ...(ref !== undefined ? { ref } : {}),
    ...(sha !== undefined ? { sha } : {}),
    ...(name ? { name } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(webUrl !== undefined ? { webUrl } : {}),
  };
}

function jobOf(body: unknown): Job {
  const stage = stringField(body, 'stage');
  const pipelineId = numberField(field(body, 'pipeline'), 'id');
  const duration = numberField(body, 'duration');
  const webUrl = stringField(body, 'web_url');
  return {
    id: required(numberField(body, 'id'), 'a job id'),
    name: stringField(body, 'name') ?? '',
    status: stringField(body, 'status') ?? 'unknown',
    ...(stage !== undefined ? { stage } : {}),
    ...(pipelineId !== undefined ? { pipelineId } : {}),
    ...(duration !== undefined ? { durationSeconds: Math.round(duration) } : {}),
    ...(webUrl !== undefined ? { webUrl } : {}),
  };
}

/** A retried job keeps its name; GitLab lists every attempt with include_retried, and the highest id is the latest. */
export function latestAttempts(jobs: readonly Job[]): Job[] {
  const byName = new Map<string, Job>();
  for (const job of jobs) {
    const seen = byName.get(job.name);
    if (!seen || seen.id < job.id) byName.set(job.name, job);
  }
  return [...byName.values()].sort((a, b) => a.id - b.id);
}

function mergeRequestOf(body: unknown): MergeRequest {
  const webUrl = stringField(body, 'web_url');
  const createdAt = stringField(body, 'created_at');
  return {
    number: required(numberField(body, 'iid'), 'a merge request iid'),
    title: stringField(body, 'title') ?? '',
    state: stringField(body, 'state') ?? 'unknown',
    draft: field(body, 'draft') === true || field(body, 'work_in_progress') === true,
    author: stringField(field(body, 'author'), 'username') ?? '',
    sourceBranch: stringField(body, 'source_branch') ?? '',
    targetBranch: stringField(body, 'target_branch') ?? '',
    description: stringField(body, 'description') ?? '',
    ...(webUrl !== undefined ? { webUrl } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function issueOf(body: unknown): Issue {
  const webUrl = stringField(body, 'web_url');
  const createdAt = stringField(body, 'created_at');
  return {
    number: required(numberField(body, 'iid'), 'an issue iid'),
    title: stringField(body, 'title') ?? '',
    state: stringField(body, 'state') ?? 'unknown',
    author: stringField(field(body, 'author'), 'username') ?? '',
    labels: list(field(body, 'labels')).filter((label): label is string => typeof label === 'string'),
    description: stringField(body, 'description') ?? '',
    ...(webUrl !== undefined ? { webUrl } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

/** The newest user notes of a newest-first page, oldest of them first; system notes ("added 1 commit") are left out. */
function notesOf(body: unknown, limit: number): Note[] {
  const notes = list(body).filter((note) => field(note, 'system') !== true).map((note): Note => {
    const createdAt = stringField(note, 'created_at');
    return { author: stringField(field(note, 'author'), 'username') ?? '', body: stringField(note, 'body') ?? '', ...(createdAt !== undefined ? { createdAt } : {}) };
  });
  return notes.slice(0, limit).reverse();
}

const GITLAB_STATE: Readonly<Record<string, string>> = { open: 'opened', closed: 'closed', merged: 'merged', all: 'all' };

export const gitlabRepoApi: ForgeRepoApi = {
  async pipelines(ctx, { ref, limit }) {
    const body = await get(ctx, '/pipelines', '/pipelines', { per_page: String(limit), order_by: 'id', sort: 'desc', ...(ref !== undefined ? { ref } : {}) });
    return list(body).map(pipelineOf);
  },

  async jobs(ctx, pipelineId) {
    // newest first, so a cut list loses the earliest stages
    const { items, truncated } = await readPages(async (page) => {
      const answer = await getPage(ctx, `/pipelines/${pipelineId}/jobs`, '/pipelines/{id}/jobs', { include_retried: 'true', per_page: '100', page: String(page) });
      return { items: list(answer.body), next: answer.next };
    });
    return { jobs: latestAttempts(items.map(jobOf)), truncated };
  },

  async job(ctx, jobId) {
    return jobOf(await get(ctx, `/jobs/${jobId}`, '/jobs/{id}'));
  },

  async jobLog(ctx, jobId) {
    const response = await ctx.http.request({ server: ctx.server, url: `${project(ctx)}/jobs/${jobId}/trace`, template: '/projects/{path}/jobs/{id}/trace', credential: { bearer: ctx.token }, as: 'tail', maxBytes: MAX_JOB_LOG_BYTES, signal: ctx.signal });
    return decodeTail(response.body as ForgeTail);
  },

  async mergeRequest(ctx, number) {
    return mergeRequestOf(await get(ctx, `/merge_requests/${number}`, '/merge_requests/{iid}'));
  },

  async mergeRequestNotes(ctx, number, limit) {
    return notesOf(await get(ctx, `/merge_requests/${number}/notes`, '/merge_requests/{iid}/notes', { sort: 'desc', order_by: 'created_at', per_page: '100' }), limit);
  },

  async mergeRequests(ctx, { state, limit }) {
    return list(await get(ctx, '/merge_requests', '/merge_requests', { state: GITLAB_STATE[state]!, per_page: String(limit), order_by: 'updated_at' })).map(mergeRequestOf);
  },

  async issue(ctx, number) {
    return issueOf(await get(ctx, `/issues/${number}`, '/issues/{iid}'));
  },

  async issueNotes(ctx, number, limit) {
    return notesOf(await get(ctx, `/issues/${number}/notes`, '/issues/{iid}/notes', { sort: 'desc', order_by: 'created_at', per_page: '100' }), limit);
  },

  async issues(ctx, { state, limit }) {
    return list(await get(ctx, '/issues', '/issues', { state: GITLAB_STATE[state]!, per_page: String(limit), order_by: 'updated_at' })).map(issueOf);
  },

  async defaultBranch(ctx) {
    return required(stringField(await get(ctx, '', ''), 'default_branch'), 'a default branch');
  },

  async jobAction(ctx, jobId, action) {
    return jobOf(await post(ctx, `/jobs/${jobId}/${action}`, `/jobs/{id}/${action}`));
  },

  async pipelineAction(ctx, pipelineId, action) {
    await post(ctx, `/pipelines/${pipelineId}/${action}`, `/pipelines/{id}/${action}`);
  },

  async openMergeRequest(ctx, request) {
    // across projects the merge request is created in the fork, naming the target project by its numeric id
    const fork = request.sourceRepoPath;
    const targetProjectId = fork !== undefined ? required(numberField(await get(ctx, '', ''), 'id'), 'a project id') : undefined;
    return mergeRequestOf(await post(fork !== undefined ? { ...ctx, repoPath: fork } : ctx, '/merge_requests', '/merge_requests', {
      source_branch: request.sourceBranch,
      target_branch: request.targetBranch,
      title: request.title,
      description: request.body,
      ...(targetProjectId !== undefined ? { target_project_id: targetProjectId } : {}),
    }));
  },

  async comment(ctx, on, number, body) {
    const path = on === 'mergeRequest' ? `/merge_requests/${number}/notes` : `/issues/${number}/notes`;
    const answer = await post(ctx, path, on === 'mergeRequest' ? '/merge_requests/{iid}/notes' : '/issues/{iid}/notes', { body });
    return { id: required(numberField(answer, 'id'), 'a note id') };
  },
};
