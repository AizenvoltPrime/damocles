// GitLab CI for the chip, the job list and the job log tab. The pipeline choice (the branch's merge request, then its pipelines,
// then branch and tag pipelines), the latest-attempt rule and the trace refresh are adapted from GitLab Workflow for VS Code
// (https://gitlab.com/gitlab-org/gitlab-vscode-extension), src/desktop/gitlab/get_pipeline_and_mr_for_branch.ts and
// src/desktop/ci/job_log_refresher.ts, Copyright (c) 2020-present GitLab Inc. Licensed under the MIT License
// (THIRD-PARTY-NOTICES.md).
import { MAX_JOB_LOG_BYTES, type CiJobView, type CiPipelineView, type CiState } from '../../shared/forge/ci';
import { getCached, getCachedList, isActive, isoOf, isRetriable, jobCounts, seconds, type CiAdapter, type CiContext } from './ci-adapter';
import { field, numberField, stringField, type ForgeTail } from './http';
import { cleanLine } from './tools/output';
import { gitlabRepoApi } from './tools/gitlab';
import { ForgeHttpError } from './types';

const PAGE = '100';
const CANDIDATES = '20';

const STATES: Readonly<Record<string, CiState>> = {
  created: 'created',
  waiting_for_resource: 'pending',
  waiting_for_callback: 'pending',
  preparing: 'pending',
  pending: 'pending',
  running: 'running',
  canceling: 'running',
  success: 'passed',
  failed: 'failed',
  canceled: 'canceled',
  skipped: 'skipped',
  manual: 'manual',
  scheduled: 'scheduled',
};

export const gitlabState = (status: string | undefined): CiState => STATES[status ?? ''] ?? 'pending';

const project = (ctx: CiContext): string => `/projects/${encodeURIComponent(ctx.repoPath)}`;
const get = (ctx: CiContext, path: string, template: string, query: Readonly<Record<string, string>> = {}): Promise<unknown> =>
  getCached(ctx, `${project(ctx)}${path}`, `/projects/{path}${template}`, query);
const list = (body: unknown): unknown[] => (Array.isArray(body) ? body : []);

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new ForgeHttpError('server', `GitLab answered without ${what}`);
  return value;
}

interface Listed {
  readonly id: number;
  readonly iid: number;
  readonly projectId?: number;
  readonly sha?: string;
  readonly ref?: string;
  readonly state: CiState;
}

function listedOf(body: unknown): Listed | undefined {
  const id = numberField(body, 'id');
  if (id === undefined) return undefined;
  const sha = stringField(body, 'sha');
  const ref = stringField(body, 'ref');
  const projectId = numberField(body, 'project_id');
  return { id, iid: numberField(body, 'iid') ?? id, state: gitlabState(stringField(body, 'status')), ...(projectId !== undefined ? { projectId } : {}), ...(sha !== undefined ? { sha } : {}), ...(ref !== undefined ? { ref } : {}) };
}

const newest = (pipelines: readonly (Listed | undefined)[]): Listed | undefined =>
  pipelines.reduce<Listed | undefined>((best, item) => (item !== undefined && (best === undefined || item.iid > best.iid) ? item : best), undefined);

function jobOf(body: unknown, kind: CiJobView['kind']): CiJobView & { readonly order: number } {
  const id = required(numberField(body, 'id'), 'a job id');
  const state = gitlabState(stringField(body, 'status'));
  const startedAt = isoOf(stringField(body, 'started_at'));
  const finishedAt = isoOf(stringField(body, 'finished_at'));
  const durationSeconds = seconds(numberField(body, 'duration'));
  const runner = stringField(field(body, 'runner'), 'description');
  const own = kind === 'job';
  const allowedFailure = state === 'failed' && field(body, 'allow_failure') === true;
  return {
    id,
    order: id,
    name: cleanLine(stringField(body, 'name') ?? '', 200),
    stage: cleanLine(stringField(body, 'stage') ?? '', 200),
    state,
    kind,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(runner ? { runner: cleanLine(runner, 200) } : {}),
    ...(allowedFailure ? { allowedFailure } : {}),
    canRetry: own && isRetriable(state),
    canCancel: own && isActive(state),
    hasLog: own,
  };
}

/**
 * The latest attempt of each name, placed where its first attempt ran, stages in the order their first job ran: GitLab lists
 * every attempt with include_retried and gives each a higher id.
 */
export function stageOrder(jobs: readonly (CiJobView & { readonly order: number })[]): CiJobView[] {
  const byName = new Map<string, CiJobView & { readonly order: number }>();
  for (const job of jobs) {
    const key = `${job.kind}\u0000${job.name}`;
    const seen = byName.get(key);
    if (!seen) byName.set(key, job);
    else byName.set(key, { ...(seen.id > job.id ? seen : job), order: Math.min(seen.order, job.order) });
  }
  const latest = [...byName.values()].sort((a, b) => a.order - b.order);
  const stageAt = new Map<string, number>();
  for (const job of latest) if (!stageAt.has(job.stage)) stageAt.set(job.stage, job.order);
  return latest
    .sort((a, b) => stageAt.get(a.stage)! - stageAt.get(b.stage)! || a.order - b.order)
    .map(({ order: _order, ...job }) => job);
}

/** External commit statuses of the pipeline: those GitLab attributes to it that are none of its jobs or bridges. */
function externalOf(statuses: readonly unknown[], pipelineId: number, ownIds: ReadonlySet<number>): (CiJobView & { readonly order: number })[] {
  return statuses
    .filter((status) => numberField(status, 'pipeline_id') === pipelineId && !ownIds.has(numberField(status, 'id') ?? -1))
    .map((status) => ({ ...jobOf(status, 'external'), order: Number.MAX_SAFE_INTEGER - 1 }));
}

function pipelineView(listed: Listed, jobs: readonly CiJobView[], truncated: boolean, serverId: string, serverName: string): CiPipelineView {
  const started = jobs.map((job) => job.startedAt).filter((at): at is string => at !== undefined).sort()[0];
  const finished = jobs.map((job) => job.finishedAt).filter((at): at is string => at !== undefined).sort().at(-1);
  const durationSeconds = !isActive(listed.state) && started !== undefined && finished !== undefined ? seconds((Date.parse(finished) - Date.parse(started)) / 1000) : undefined;
  return {
    serverId,
    serverName,
    kind: 'gitlab',
    id: listed.id,
    number: listed.iid,
    state: listed.state,
    ...(listed.ref !== undefined ? { ref: cleanLine(listed.ref, 255) } : {}),
    ...(listed.sha !== undefined ? { sha: cleanLine(listed.sha, 64) } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(started !== undefined ? { startedAt: started } : {}),
    ...jobCounts(jobs),
    canRetry: listed.state === 'failed' || listed.state === 'canceled',
    canCancel: isActive(listed.state),
    jobs,
    ...(truncated ? { truncated: true } : {}),
  };
}

async function pipelineFor(ctx: CiContext, branch: string, sha: string | undefined): Promise<Listed | undefined> {
  // the project's own merge request of the branch: a fork's, from a branch of the same name, targets the project too
  const mrs = list(await get(ctx, '/merge_requests', '/merge_requests', { source_branch: branch, state: 'opened', per_page: CANDIDATES, order_by: 'updated_at' }));
  const mr = mrs.find((each) => numberField(each, 'source_project_id') !== undefined && numberField(each, 'source_project_id') === numberField(each, 'target_project_id'));
  const iid = numberField(mr, 'iid');
  const projectId = numberField(mr, 'target_project_id');
  if (iid !== undefined) {
    const ofProject = list(await get(ctx, `/merge_requests/${iid}/pipelines`, '/merge_requests/{iid}/pipelines', { per_page: CANDIDATES })).map(listedOf).filter((listed) => listed?.projectId === projectId);
    const mrPipeline = newest(ofProject);
    if (mrPipeline) return mrPipeline;
  }
  const query = { per_page: CANDIDATES, order_by: 'id', sort: 'desc' };
  const [byBranch, byCommit] = await Promise.all([
    get(ctx, '/pipelines', '/pipelines', { ...query, ref: branch }),
    // a tag pipeline of the commit
    sha !== undefined ? get(ctx, '/pipelines', '/pipelines', { ...query, sha }) : Promise.resolve([]),
  ]);
  return newest([...list(byBranch), ...list(byCommit)].map(listedOf));
}

export const gitlabCi: CiAdapter = {
  liveLogs: true,

  async pipeline(ctx, { branch, sha }, serverName) {
    const listed = await pipelineFor(ctx, branch, sha);
    if (!listed) return null;
    const pages = (path: string, template: string, query: Readonly<Record<string, string>>): ReturnType<typeof getCachedList> =>
      getCachedList(ctx, `${project(ctx)}${path}`, `/projects/{path}${template}`, { ...query, per_page: PAGE }, list);
    const [jobs, bridges, statuses] = await Promise.all([
      // every attempt, newest first, so the latest of each name keeps its first attempt's place
      pages(`/pipelines/${listed.id}/jobs`, '/pipelines/{id}/jobs', { include_retried: 'true' }),
      pages(`/pipelines/${listed.id}/bridges`, '/pipelines/{id}/bridges', {}),
      listed.sha !== undefined && /^[0-9a-f]{7,64}$/.test(listed.sha)
        ? pages(`/repository/commits/${listed.sha}/statuses`, '/repository/commits/{sha}/statuses', {})
        : Promise.resolve({ items: [], truncated: false }),
    ]);
    const own = [...jobs.items.map((job) => jobOf(job, 'job')), ...bridges.items.map((bridge) => jobOf(bridge, 'bridge'))];
    const ownIds = new Set(own.map((job) => job.id));
    const truncated = jobs.truncated || bridges.truncated || statuses.truncated;
    return pipelineView(listed, stageOrder([...own, ...externalOf(statuses.items, listed.id, ownIds)]), truncated, ctx.server.id, serverName);
  },

  async commitPipeline(ctx, sha) {
    let commit: unknown;
    try {
      commit = await get(ctx, `/repository/commits/${sha}`, '/repository/commits/{sha}');
    } catch (err) {
      // a commit the server does not have (not pushed yet) has no pipeline
      if (err instanceof ForgeHttpError && err.kind === 'notFound') return null;
      throw err;
    }
    const listed = listedOf(field(commit, 'last_pipeline'));
    return listed ? { id: listed.id, number: listed.iid, state: listed.state } : null;
  },

  async job(ctx, jobId) {
    const body = await get(ctx, `/jobs/${jobId}`, '/jobs/{id}');
    const { order: _order, ...job } = jobOf(body, 'job');
    const pipeline = field(body, 'pipeline');
    const id = required(numberField(pipeline, 'id'), 'the job\'s pipeline');
    const ref = stringField(body, 'ref');
    return { job, pipeline: { id, number: numberField(pipeline, 'iid') ?? id, ...(ref !== undefined ? { ref: cleanLine(ref, 255) } : {}) } };
  },

  async log(ctx, jobId, etag) {
    const response = await ctx.http.request({
      server: ctx.server,
      url: `${project(ctx)}/jobs/${jobId}/trace`,
      template: '/projects/{path}/jobs/{id}/trace',
      credential: { bearer: ctx.token },
      as: 'tail',
      maxBytes: MAX_JOB_LOG_BYTES,
      signal: ctx.signal,
      ...(etag !== undefined ? { etag } : {}),
    });
    if (response.notModified) return { notModified: true };
    return { notModified: false, tail: response.body as ForgeTail, ...(response.etag !== undefined ? { etag: response.etag } : {}) };
  },

  async action(ctx, target, action) {
    if ('pipelineId' in target) {
      await gitlabRepoApi.pipelineAction(ctx, target.pipelineId, action);
      return {};
    }
    if (!('jobId' in target)) throw new ForgeHttpError('refused', 'GitLab acts on a pipeline or a job');
    const job = await gitlabRepoApi.jobAction(ctx, target.jobId, action);
    return action === 'retry' && job !== null ? { jobId: job.id } : {};
  },

  webUrl(server, repoPath, target) {
    if ('sha' in target) return `${server.webUrl}/${repoPath}/-/commit/${target.sha}/pipelines`;
    if ('pipelineId' in target) return `${server.webUrl}/${repoPath}/-/pipelines/${target.pipelineId}`;
    if ('runId' in target) return `${server.webUrl}/${repoPath}/-/pipelines/${target.runId}`;
    return `${server.webUrl}/${repoPath}/-/jobs/${target.jobId}`;
  },
};
