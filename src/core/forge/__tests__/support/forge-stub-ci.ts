import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// The stub's CI, merge request and issue endpoints (forge-stub.ts calls these), in GitLab's and GitHub's REST shapes. Every
// repository the stub knows has the same sample data: pipeline 4312 on main with jobs unit and e2e (e2e retried once), merge
// request !45 "Refresh tokens one at a time" and issue #12, which the agent tools read; and the CI chip's pipeline #4312 on
// feature/forge-accounts (CiUi), running, whose unit log grows every LOG_TICK_MS, on GitHub the checks of its commit. GET
// answers carry an ETag and answer 304 to a matching If-None-Match; lists page as each server does. GitHub serves job logs
// from a second origin (the log storage), which must see no credential.

/** A token-shaped string planted in the e2e job's log; it never authenticates anything. */
export const PLANTED_LOG_TOKEN = 'glpat-plantedStubLogToken0001';

export const CI_FIXTURES = {
  branch: 'main',
  pipeline: { id: 4312, previous: 4311 },
  jobs: { unit: 9101, e2eRetried: 9100, e2e: 9102 },
  mergeRequest: { number: 45, title: 'Refresh tokens one at a time', sourceBranch: 'fix/token-refresh', targetBranch: 'main' },
  issue: { number: 12, title: 'Token refresh races on two windows' },
  /** GitHub only: a pull request number the REST issue list also returns, which ForgeIssues leaves out. */
  pullInIssues: 45,
  /** GitHub only: pull requests that GraphQL lists by state, which a REST page of the newest pull requests leaves out. */
  mergedPull: { number: 44, title: 'Persist the rotated token first' },
  closedPull: { number: 43, title: 'Try a refresh lock file' },
} as const;

/** The CI chip's pipeline, which the job log tab and the commit status row show too: its id, its number #4312, its branch and its jobs' first ids. */
export const CI_UI_FIXTURES = {
  branch: 'feature/forge-accounts',
  sha: '7c2d9e4f1a3b5c6d8e9f0a1b2c3d4e5f6a7b8c9d',
  pipeline: { id: 54312, number: 4312 },
  gitlabJobs: { compile: 9201, lint: 9202, unit: 9203, e2e: 9204, reviewApp: 9205 },
  githubRun: { id: 64312, number: 4312 },
  githubJobs: { unit: 9401, e2e: 9402 },
  runner: 'shared-03',
} as const;

/** The running unit log gains a line this often. */
export const LOG_TICK_MS = 3_000;
const MAX_GROWN_LINES = 400;

/** A write the stub received, for the tests' assertions; body as JSON. */
export interface StubWrite {
  readonly method: string;
  readonly path: string;
  readonly login: string;
  readonly body: unknown;
}

type StubJobStatus = 'created' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual';

interface UiJob {
  readonly id: number;
  readonly name: string;
  readonly stage: string;
  status: StubJobStatus;
  readonly startedAt: string;
  finishedAt?: string;
  allowFailure?: boolean;
}

/** GitHub: a rerun of a job of the chip's run, a new attempt with a new id. */
interface GithubAttempt {
  readonly id: number;
  readonly name: string;
  readonly attempt: number;
  status: 'queued' | 'completed';
  conclusion: string | null;
}

/** The CI chip's pipeline on one stub server, which a test may steer. */
export class CiUi {
  branch: string = CI_UI_FIXTURES.branch;
  /** The commit whose status is the pipeline's; a spec sets it to its repository's commit. */
  sha: string = CI_UI_FIXTURES.sha;
  /** The pipeline's state; undefined: derived from its jobs. */
  pipelineState: StubJobStatus | undefined;
  /** The next commit status request answers 500 (the commit status row's error and Try again). */
  failNextCommitStatus = false;
  /** 304 answers given, for the polling assertions. */
  notModified = 0;
  readonly jobs: UiJob[] = [];
  /**
   * GitHub, at the chip's commit: a second workflow (Lint, created after CI, passed), a fork's pull request run of CI (failed),
   * another app's check run and a commit status.
   */
  githubOtherChecks = false;
  /** GitHub: this many more check runs of another app at the chip's commit. */
  thirdPartyChecks = 0;
  /** GitHub: a pull request run of CI at the chip's commit, from the repository's own branch, passed. */
  githubPullRequestRun = false;
  /** GitHub: reruns of the chip's run's jobs. */
  readonly githubAttempts: GithubAttempt[] = [];
  /** GitHub lists a rerun's new attempt only once this is true. */
  githubAttemptsListed = true;
  /** GitLab: an open merge request of the chip's branch from a fork, whose pipeline ran in the fork. */
  forkMergeRequest = false;
  private nextId = 9300;
  private nextGithubId = 0;
  private logStart = Date.now();
  // while set, the unit log keeps this many grown lines
  private frozenAt: number | undefined;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.reset();
  }

  /** Back to the fixture: unit running and its log growing from now. */
  reset(): void {
    const at = '2026-05-04T09:12:00Z';
    const { compile, lint, unit, e2e, reviewApp } = CI_UI_FIXTURES.gitlabJobs;
    this.jobs.length = 0;
    this.jobs.push(
      { id: compile, name: 'compile', stage: 'build', status: 'success', startedAt: at, finishedAt: '2026-05-04T09:12:40Z' },
      { id: lint, name: 'lint', stage: 'build', status: 'success', startedAt: at, finishedAt: '2026-05-04T09:12:31Z' },
      { id: unit, name: 'unit', stage: 'test', status: 'running', startedAt: '2026-05-04T09:12:41Z' },
      { id: e2e, name: 'e2e', stage: 'test', status: 'success', startedAt: '2026-05-04T09:12:41Z', finishedAt: '2026-05-04T09:15:11Z' },
      { id: reviewApp, name: 'review-app', stage: 'deploy', status: 'manual', startedAt: at },
    );
    this.pipelineState = undefined;
    this.failNextCommitStatus = false;
    this.notModified = 0;
    this.githubOtherChecks = false;
    this.thirdPartyChecks = 0;
    this.githubPullRequestRun = false;
    this.githubAttempts.length = 0;
    this.nextGithubId = 9410;
    this.githubAttemptsListed = true;
    this.forkMergeRequest = false;
    this.logStart = this.now();
    this.frozenAt = undefined;
  }

  /** Stops (or restarts) the unit log's growth, so its ETag stays the same. */
  freezeLog(frozen: boolean): void {
    if (frozen && this.frozenAt === undefined) this.frozenAt = this.grownLines();
    if (!frozen && this.frozenAt !== undefined) {
      this.logStart = this.now() - this.frozenAt * LOG_TICK_MS;
      this.frozenAt = undefined;
    }
  }

  /** The unit job ends with status; its log then ends too. */
  finishUnit(status: 'success' | 'failed'): void {
    const unit = this.latest('unit');
    if (!unit) return;
    this.freezeLog(true);
    unit.status = status;
    unit.finishedAt = '2026-05-04T09:14:51Z';
  }

  grownLines(): number {
    return this.frozenAt ?? Math.min(MAX_GROWN_LINES, Math.floor((this.now() - this.logStart) / LOG_TICK_MS));
  }

  latest(name: string): UiJob | undefined {
    return this.jobs.filter((job) => job.name === name).sort((a, b) => b.id - a.id)[0];
  }

  byId(id: number): UiJob | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  state(): StubJobStatus {
    if (this.pipelineState !== undefined) return this.pipelineState;
    const latest = [...new Set(this.jobs.map((job) => job.name))].map((name) => this.latest(name)!).filter((job) => job.status !== 'manual');
    if (latest.some((job) => job.status === 'running' || job.status === 'pending' || job.status === 'created')) return 'running';
    if (latest.some((job) => job.status === 'failed')) return 'failed';
    if (latest.some((job) => job.status === 'canceled')) return 'canceled';
    return 'success';
  }

  /** Retry: a new attempt of the job, running; cancel: the job canceled. Answers the job as it is now. */
  jobAction(id: number, action: 'retry' | 'cancel'): UiJob | undefined {
    const job = this.byId(id);
    if (!job) return undefined;
    if (action === 'cancel') {
      job.status = 'canceled';
      job.finishedAt = '2026-05-04T09:16:00Z';
      return job;
    }
    const attempt: UiJob = { id: this.nextId++, name: job.name, stage: job.stage, status: 'running', startedAt: '2026-05-04T09:16:00Z' };
    this.jobs.push(attempt);
    this.pipelineState = undefined;
    return attempt;
  }

  /** GitHub: a rerun of the named job of the chip's run, queued as its next attempt. */
  githubRerun(name: string): void {
    const attempt = Math.max(1, ...this.githubAttempts.filter((each) => each.name === name).map((each) => each.attempt)) + 1;
    this.githubAttempts.push({ id: this.nextGithubId++, name, attempt, status: 'queued', conclusion: null });
  }

  pipelineAction(action: 'retry' | 'cancel'): void {
    this.pipelineState = undefined;
    for (const name of new Set(this.jobs.map((job) => job.name))) {
      const job = this.latest(name)!;
      if (action === 'cancel' && (job.status === 'running' || job.status === 'pending' || job.status === 'created')) this.jobAction(job.id, 'cancel');
      if (action === 'retry' && (job.status === 'failed' || job.status === 'canceled')) this.jobAction(job.id, 'retry');
    }
  }

  /** The job's log as GitLab's trace serves it. */
  log(job: UiJob): string {
    if (job.name !== 'unit') return [`Running with gitlab-runner 17.9.0 (${CI_UI_FIXTURES.runner})`, `$ npm run ${job.name}`, job.status === 'success' ? '\u001b[32mJob succeeded\u001b[0;m' : `${job.name} ${job.status}`, ''].join('\n');
    const grown = Array.from({ length: this.grownLines() }, (_, at) => `\u001b[32m✓\u001b[0m src/core/forge/__tests__/suite-${at + 1}.test.ts (${(at % 9) + 1} tests)`);
    const done = job.status === 'running' ? [] : ['section_end:1746349990:step_script\r\u001b[0K', job.status === 'success' ? '\u001b[32;1mJob succeeded\u001b[0;m' : '\u001b[31;1mERROR: Job failed: exit code 1\u001b[0;m'];
    return [...UNIT_LOG_LINES, ...grown, ...done, ''].join('\n');
  }
}

/** The unit job's log before it grows. */
export const UNIT_LOG_LINES: readonly string[] = [
  `\u001b[0KRunning with gitlab-runner 17.9.0 (${CI_UI_FIXTURES.runner})`,
  '\u001b[0Ksection_start:1746349920:prepare_executor[collapsed=true]\r\u001b[0K\u001b[0K\u001b[36;1mPreparing the "docker" executor\u001b[0;m',
  'Using Docker executor with image node:22 ...',
  'Pulling docker image node:22 ...',
  '\u001b[0Ksection_end:1746349925:prepare_executor\r\u001b[0K',
  '\u001b[0Ksection_start:1746349925:get_sources[collapsed=true]\r\u001b[0K\u001b[0K\u001b[36;1mGetting source from Git repository\u001b[0;m',
  'Fetching changes with git depth set to 20...',
  `Checking out 7c2d9e4f as detached HEAD (ref is ${CI_UI_FIXTURES.branch})...`,
  '\u001b[0Ksection_end:1746349929:get_sources\r\u001b[0K',
  '\u001b[0Ksection_start:1746349929:step_script\r\u001b[0K\u001b[0K\u001b[36;1mExecuting "step_script" stage of the job script\u001b[0;m',
  '$ npm ci',
  'added 812 packages in 21s',
  '$ npm run test:unit',
  '\u001b[38;5;208m warn\u001b[0m deprecated option --reporter=dot',
  '\u001b[38;2;120;180;255m RUN  v4.1.1\u001b[0m',
];

const SHA = '4e1a9c2b7d0f5e6a8c9b1d2e3f4a5b6c7d8e9f00';
// GitLab: a fork of the project and its merge request from a branch named as the chip's
const FORK_PROJECT = 99;
const FORK_MR = 46;
const CREATED = '2026-05-04T09:12:00Z';

export const E2E_LOG_LINES: readonly string[] = [
  '\u001b[0KRunning with gitlab-runner 17.9.0',
  'section_start:1746349920:prepare_script\r\u001b[0K\u001b[36;1mPreparing environment\u001b[0;m',
  'Running on runner-abc via stub...',
  'section_end:1746349921:prepare_script\r\u001b[0K',
  'section_start:1746349922:step_script\r\u001b[0K\u001b[36;1mExecuting "step_script" stage of the job script\u001b[0;m',
  '$ npm ci',
  'added 812 packages in 21s',
  `$ export GITLAB_TOKEN=${PLANTED_LOG_TOKEN}`,
  '$ npm run test:e2e',
  '\u001b[31m✗ refresh › rotates once per account (2.1 s)\u001b[0m',
  '  Expected 1 refresh, received 2',
  'Progress: 10%\rProgress: 100%',
  'section_end:1746349990:step_script\r\u001b[0K',
  '\u001b[31;1mERROR: Job failed: exit code 1\u001b[0;m',
];

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

/** A GET's answer with its ETag, or 304 when the request already holds it. */
function reply(ctx: CiContext, body: string, contentType: string, headers: Record<string, string> = {}): void {
  const etag = `W/"${createHash('sha1').update(body).digest('hex')}"`;
  if (ctx.ifNoneMatch === etag) {
    ctx.ui.notModified += 1;
    ctx.response.writeHead(304, { etag });
    ctx.response.end();
    return;
  }
  ctx.response.writeHead(200, { 'content-type': contentType, etag, ...headers });
  ctx.response.end(body);
}

const getJson = (ctx: CiContext, body: unknown, headers: Record<string, string> = {}): void => reply(ctx, JSON.stringify(body), 'application/json', headers);

/**
 * One page of a list, by the request's page and per_page, naming the next page as the server does: GitLab's x-next-page
 * (empty on the last page), GitHub's Link header with rel="next".
 */
function page<T>(ctx: CiContext, items: readonly T[]): { readonly items: T[]; readonly headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(ctx.url.searchParams.get('per_page') ?? '30') || 30));
  const number = Math.max(1, Number(ctx.url.searchParams.get('page') ?? '1') || 1);
  const shown = items.slice((number - 1) * perPage, number * perPage);
  const more = number * perPage < items.length;
  if (ctx.kind === 'gitlab') return { items: shown, headers: { 'x-next-page': more ? String(number + 1) : '' } };
  if (!more) return { items: shown, headers: {} };
  const next = new URL(ctx.url.href);
  next.searchParams.set('page', String(number + 1));
  return { items: shown, headers: { link: `<${next.href}>; rel="next"` } };
}

function gitlabJob(webUrl: string, path: string, id: number, name: string, status: string): Record<string, unknown> {
  return { id, name, stage: 'test', status, duration: name === 'unit' ? 42.4 : 71.8, pipeline: { id: CI_FIXTURES.pipeline.id, iid: 312, project_id: 42 }, ref: CI_FIXTURES.branch, web_url: `${webUrl}/${path}/-/jobs/${id}` };
}

function githubJob(webUrl: string, path: string, id: number, name: string, conclusion: string): Record<string, unknown> {
  return { id, run_id: CI_FIXTURES.pipeline.id, run_attempt: 1, name, status: 'completed', conclusion, head_branch: CI_FIXTURES.branch, started_at: '2026-05-04T09:12:10Z', completed_at: name === 'unit' ? '2026-05-04T09:12:52Z' : '2026-05-04T09:13:22Z', html_url: `${webUrl}/${path}/actions/runs/${CI_FIXTURES.pipeline.id}/job/${id}`, steps: [] };
}

const JOB_NAMES: Readonly<Record<number, string>> = { [CI_FIXTURES.jobs.unit]: 'unit', [CI_FIXTURES.jobs.e2eRetried]: 'e2e', [CI_FIXTURES.jobs.e2e]: 'e2e' };
const JOB_STATUS: Readonly<Record<number, string>> = { [CI_FIXTURES.jobs.unit]: 'success', [CI_FIXTURES.jobs.e2eRetried]: 'failed', [CI_FIXTURES.jobs.e2e]: 'failed' };

export interface CiContext {
  readonly kind: 'github' | 'gitlab';
  readonly webUrl: string;
  readonly method: string;
  /** The API path after /api/v4 or /api/v3, still URL-encoded. */
  readonly path: string;
  readonly url: URL;
  readonly login: string;
  readonly body: string;
  readonly ifNoneMatch?: string;
  readonly response: ServerResponse;
  /** The login's access level to a repository path, or undefined when it has none (404). */
  readonly level: (repoPath: string) => number | undefined;
  /** GitHub: answers 403 with X-GitHub-SSO when the owner needs SSO the login has not authorized; true when it answered. */
  readonly ssoBlocked: (owner: string) => boolean;
  readonly writes: StubWrite[];
  readonly ui: CiUi;
  /** GitHub: the log storage's origin, where job logs are redirected. */
  readonly logStorage: string;
}

/** Answers a CI, merge request or issue request; false when the path is none of them. */
export function answerCi(ctx: CiContext): boolean {
  return ctx.kind === 'gitlab' ? gitlab(ctx) : github(ctx);
}

function record(ctx: CiContext): void {
  ctx.writes.push({ method: ctx.method, path: decodeURIComponent(ctx.path), login: ctx.login, body: ctx.body === '' ? undefined : JSON.parse(ctx.body) as unknown });
}

function uiGitlabPipeline(ctx: CiContext, repoPath: string): Record<string, unknown> {
  const { pipeline } = CI_UI_FIXTURES;
  return { id: pipeline.id, iid: pipeline.number, project_id: 42, status: ctx.ui.state(), ref: ctx.ui.branch, sha: ctx.ui.sha, created_at: CREATED, web_url: `${ctx.webUrl}/${repoPath}/-/pipelines/${pipeline.id}` };
}

function uiGitlabJob(ctx: CiContext, repoPath: string, job: UiJob): Record<string, unknown> {
  const duration = job.finishedAt !== undefined ? (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000 : undefined;
  return {
    id: job.id,
    name: job.name,
    stage: job.stage,
    status: job.status,
    ref: ctx.ui.branch,
    ...(job.status !== 'manual' ? { started_at: job.startedAt } : {}),
    ...(job.finishedAt !== undefined ? { finished_at: job.finishedAt } : {}),
    ...(duration !== undefined ? { duration } : {}),
    allow_failure: job.allowFailure === true,
    pipeline: { id: CI_UI_FIXTURES.pipeline.id, iid: CI_UI_FIXTURES.pipeline.number, project_id: 42 },
    runner: { id: 3, description: CI_UI_FIXTURES.runner },
    web_url: `${ctx.webUrl}/${repoPath}/-/jobs/${job.id}`,
  };
}

function gitlab(ctx: CiContext): boolean {
  const match = /^\/projects\/([^/]+)(\/.+)$/.exec(ctx.path);
  if (!match) return false;
  const repoPath = decodeURIComponent(match[1]!);
  const rest = match[2]!;
  const { response, webUrl, method, ui } = ctx;
  const level = ctx.level(repoPath);
  if (level === undefined) {
    json(response, 404, { message: '404 Project Not Found' });
    return true;
  }
  const { pipeline, jobs, mergeRequest, issue } = CI_FIXTURES;
  const job = (id: number) => gitlabJob(webUrl, repoPath, id, JOB_NAMES[id]!, JOB_STATUS[id]!);
  const mr = (number: number, title: string, source: string) => ({ id: 700 + number, iid: number, project_id: 42, title, state: 'opened', draft: false, author: { username: 'alexios-s' }, source_branch: source, target_branch: mergeRequest.targetBranch, description: 'Refresh now runs once per account and persists the rotated token before first use.', web_url: `${webUrl}/${repoPath}/-/merge_requests/${number}`, created_at: CREATED });
  const issueBody = { id: 812, iid: issue.number, title: issue.title, state: 'opened', author: { username: 'work-alexios' }, labels: ['bug', 'auth'], description: 'Two windows refresh the same token at once and one of them loses.', web_url: `${webUrl}/${repoPath}/-/issues/${issue.number}`, created_at: CREATED };
  const notes = [
    { id: 1, body: 'added 1 commit', system: true, author: { username: 'alexios-s' }, created_at: CREATED },
    { id: 2, body: 'Looks good once the e2e job passes.', system: false, author: { username: 'work-alexios' }, created_at: CREATED },
  ];
  const writable = level >= 30;
  if (method === 'GET') {
    if (rest === '/pipelines') {
      const ref = ctx.url.searchParams.get('ref');
      const sha = ctx.url.searchParams.get('sha');
      const all = [
        uiGitlabPipeline(ctx, repoPath),
        { id: pipeline.id, iid: 312, project_id: 42, status: 'failed', ref: CI_FIXTURES.branch, sha: SHA, name: 'Refresh tokens one at a time', created_at: CREATED, web_url: `${webUrl}/${repoPath}/-/pipelines/${pipeline.id}` },
        { id: pipeline.previous, iid: 311, project_id: 42, status: 'success', ref: CI_FIXTURES.branch, sha: SHA, created_at: CREATED, web_url: `${webUrl}/${repoPath}/-/pipelines/${pipeline.previous}` },
      ];
      getJson(ctx, all.filter((item) => (ref === null || item['ref'] === ref) && (sha === null || item['sha'] === sha)));
      return true;
    }
    if (rest === `/pipelines/${pipeline.id}/jobs`) {
      getJson(ctx, [jobs.unit, jobs.e2eRetried, jobs.e2e].map(job));
      return true;
    }
    if (rest === `/pipelines/${CI_UI_FIXTURES.pipeline.id}/jobs`) {
      // GitLab lists the newest job first
      const listed = page(ctx, [...ui.jobs].sort((a, b) => b.id - a.id).map((item) => uiGitlabJob(ctx, repoPath, item)));
      getJson(ctx, listed.items, listed.headers);
      return true;
    }
    if (/^\/pipelines\/\d+\/bridges$/.test(rest)) {
      getJson(ctx, []);
      return true;
    }
    if (/^\/repository\/commits\/[0-9a-f]+\/statuses$/.test(rest)) {
      getJson(ctx, []);
      return true;
    }
    const commit = /^\/repository\/commits\/([0-9a-f]{7,64})$/.exec(rest);
    if (commit) {
      if (ui.failNextCommitStatus) {
        ui.failNextCommitStatus = false;
        json(response, 500, { message: '500 Internal Server Error' });
        return true;
      }
      // the chip's pipeline's commit, else a commit the server does not have
      if (commit[1] === ui.sha) getJson(ctx, { id: ui.sha, short_id: ui.sha.slice(0, 8), last_pipeline: uiGitlabPipeline(ctx, repoPath) });
      else json(response, 404, { message: '404 Commit Not Found' });
      return true;
    }
    const oneJob = /^\/jobs\/(\d+)$/.exec(rest);
    const uiJob = oneJob ? ui.byId(Number(oneJob[1])) : undefined;
    if (uiJob) {
      getJson(ctx, uiGitlabJob(ctx, repoPath, uiJob));
      return true;
    }
    if (oneJob && JOB_NAMES[Number(oneJob[1])] !== undefined) {
      getJson(ctx, job(Number(oneJob[1])));
      return true;
    }
    const trace = /^\/jobs\/(\d+)\/trace$/.exec(rest);
    const uiTrace = trace ? ui.byId(Number(trace[1])) : undefined;
    if (uiTrace) {
      reply(ctx, ui.log(uiTrace), 'text/plain');
      return true;
    }
    if (trace && JOB_NAMES[Number(trace[1])] !== undefined) {
      reply(ctx, JOB_NAMES[Number(trace[1])] === 'e2e' ? E2E_LOG_LINES.join('\n') : 'unit ok\n', 'text/plain');
      return true;
    }
    if (rest === `/merge_requests/${mergeRequest.number}`) {
      getJson(ctx, mr(mergeRequest.number, mergeRequest.title, mergeRequest.sourceBranch));
      return true;
    }
    if (rest === `/merge_requests/${mergeRequest.number}/pipelines`) {
      getJson(ctx, []);
      return true;
    }
    if (rest === `/merge_requests/${FORK_MR}/pipelines`) {
      getJson(ctx, [{ id: 77_777, iid: 9, project_id: FORK_PROJECT, status: 'failed', ref: ui.branch, sha: ui.sha, created_at: CREATED }]);
      return true;
    }
    if (rest === `/merge_requests/${mergeRequest.number}/notes` || rest === `/issues/${issue.number}/notes`) {
      getJson(ctx, notes);
      return true;
    }
    if (rest === '/merge_requests') {
      const source = ctx.url.searchParams.get('source_branch');
      const fork = { ...mr(FORK_MR, 'Same branch name from a fork', ui.branch), source_project_id: FORK_PROJECT, target_project_id: 42 };
      const own = { ...mr(mergeRequest.number, mergeRequest.title, mergeRequest.sourceBranch), source_project_id: 42, target_project_id: 42 };
      getJson(ctx, [
        ...(source === null || source === mergeRequest.sourceBranch ? [own] : []),
        ...(ui.forkMergeRequest && (source === null || source === ui.branch) ? [fork] : []),
      ]);
      return true;
    }
    if (rest === `/issues/${issue.number}`) {
      getJson(ctx, issueBody);
      return true;
    }
    if (rest === '/issues') {
      getJson(ctx, [issueBody]);
      return true;
    }
    return false;
  }
  if (method !== 'POST') return false;
  if (!writable) {
    json(response, 403, { message: '403 Forbidden' });
    return true;
  }
  const action = /^\/jobs\/(\d+)\/(retry|cancel)$/.exec(rest);
  const uiTarget = action ? ui.byId(Number(action[1])) : undefined;
  if (action && uiTarget) {
    record(ctx);
    json(response, 201, uiGitlabJob(ctx, repoPath, ui.jobAction(uiTarget.id, action[2] as 'retry' | 'cancel')!));
    return true;
  }
  if (action && JOB_NAMES[Number(action[1])] !== undefined) {
    record(ctx);
    const id = action[2] === 'retry' ? 9103 : Number(action[1]);
    json(response, 201, { ...job(Number(action[1])), id, status: action[2] === 'retry' ? 'pending' : 'canceled' });
    return true;
  }
  const pipelineAction = /^\/pipelines\/(\d+)\/(retry|cancel)$/.exec(rest);
  if (pipelineAction && Number(pipelineAction[1]) === CI_UI_FIXTURES.pipeline.id) {
    record(ctx);
    ui.pipelineAction(pipelineAction[2] as 'retry' | 'cancel');
    json(response, 201, uiGitlabPipeline(ctx, repoPath));
    return true;
  }
  if (rest === `/merge_requests/${mergeRequest.number}/notes` || rest === `/issues/${issue.number}/notes`) {
    record(ctx);
    json(response, 201, { id: 900 + ctx.writes.length, body: (JSON.parse(ctx.body) as { body?: unknown }).body, author: { username: ctx.login } });
    return true;
  }
  if (rest === '/merge_requests') {
    record(ctx);
    const sent = JSON.parse(ctx.body) as { title?: string; source_branch?: string };
    json(response, 201, mr(46, sent.title ?? '', sent.source_branch ?? ''));
    return true;
  }
  return false;
}

// GitHub: the workflows of the chip's commit, each run's check suite, and the fork's run of CI
const WORKFLOWS = { ci: 1, lint: 2 } as const;
const SUITES = { ci: 7001, lint: 7002, fork: 7003, pullRequest: 7004 } as const;
const GITHUB_OTHER = { lintRun: 64_313, lintJob: 9451, forkRun: 64_314, forkJob: 9461, pullRequestRun: 64_315, pullRequestJob: 9471, check: 9501, status: 9601 } as const;

/** The run fields GitHub's run list and run read answer, of a run of the repository itself unless fork names its owner. */
function githubRunFields(repoPath: string, workflow: number, event: string, suite: number, fork?: string): Record<string, unknown> {
  return { workflow_id: workflow, event, check_suite_id: suite, repository: { full_name: repoPath }, head_repository: { full_name: fork !== undefined ? `${fork}/${repoPath.split('/')[1]!}` : repoPath } };
}

/** GitHub's side of the CI chip's pipeline: run #4312 of CI, unit running (steps only) and e2e passed; queued while a rerun waits. */
function uiGithubRun(ctx: CiContext, repoPath: string): Record<string, unknown> {
  const unit = ctx.ui.latest('unit');
  const rerun = ctx.ui.githubAttempts.some((attempt) => attempt.status === 'queued');
  const running = unit?.status === 'running' || rerun;
  const { githubRun } = CI_UI_FIXTURES;
  return {
    id: githubRun.id,
    run_number: githubRun.number,
    run_attempt: 1 + Math.max(0, ...ctx.ui.githubAttempts.map((attempt) => attempt.attempt - 1)),
    name: 'CI',
    display_title: 'Sign in to GitHub and GitLab',
    status: running ? 'in_progress' : 'completed',
    conclusion: running ? null : unit?.status === 'success' ? 'success' : 'failure',
    head_branch: ctx.ui.branch,
    head_sha: ctx.ui.sha,
    created_at: CREATED,
    run_started_at: '2026-05-04T09:12:05Z',
    updated_at: '2026-05-04T09:15:11Z',
    html_url: `${ctx.webUrl}/${repoPath}/actions/runs/${githubRun.id}`,
    ...githubRunFields(repoPath, WORKFLOWS.ci, 'push', SUITES.ci),
  };
}

/** The chip commit's other runs: Lint, newer and passed, and a fork's pull request run of CI, failed. */
function otherGithubRuns(ctx: CiContext, repoPath: string): Record<string, unknown>[] {
  const run = (id: number, name: string, conclusion: string, created: string) => ({ id, run_number: 4313, run_attempt: 1, name, status: 'completed', conclusion, head_branch: ctx.ui.branch, head_sha: ctx.ui.sha, created_at: created, run_started_at: created, updated_at: '2026-05-04T09:13:00Z' });
  const pullRequest = ctx.ui.githubPullRequestRun ? [{ ...run(GITHUB_OTHER.pullRequestRun, 'CI', 'success', '2026-05-04T09:12:50Z'), ...githubRunFields(repoPath, WORKFLOWS.ci, 'pull_request', SUITES.pullRequest) }] : [];
  if (!ctx.ui.githubOtherChecks) return pullRequest;
  return [
    ...pullRequest,
    { ...run(GITHUB_OTHER.lintRun, 'Lint', 'success', '2026-05-04T09:12:30Z'), ...githubRunFields(repoPath, WORKFLOWS.lint, 'push', SUITES.lint) },
    { ...run(GITHUB_OTHER.forkRun, 'CI', 'failure', '2026-05-04T09:12:40Z'), ...githubRunFields(repoPath, WORKFLOWS.ci, 'pull_request', SUITES.fork, 'fork-owner') },
  ];
}

/** The chip run's jobs of every attempt (filter=all), or the newest attempt of each (filter=latest). */
function uiGithubJobs(ctx: CiContext, repoPath: string, filter: 'latest' | 'all' = 'latest'): Record<string, unknown>[] {
  const unit = ctx.ui.latest('unit');
  const running = unit?.status === 'running';
  const { githubRun, githubJobs } = CI_UI_FIXTURES;
  const step = (number: number, name: string, status: string, conclusion: string | null) => ({ number, name, status, conclusion });
  const common = (id: number, name: string) => ({ id, run_id: githubRun.id, workflow_name: 'CI', head_branch: ctx.ui.branch, name, runner_name: CI_UI_FIXTURES.runner, html_url: `${ctx.webUrl}/${repoPath}/actions/runs/${githubRun.id}/job/${id}` });
  const first: Record<string, unknown>[] = [
    {
      ...common(githubJobs.unit, 'unit'),
      run_attempt: 1,
      status: running ? 'in_progress' : 'completed',
      conclusion: running ? null : unit?.status === 'success' ? 'success' : 'failure',
      started_at: '2026-05-04T09:12:41Z',
      ...(running ? {} : { completed_at: '2026-05-04T09:14:51Z' }),
      steps: [
        step(1, 'Set up job', 'completed', 'success'),
        step(2, 'Run npm ci', 'completed', 'success'),
        step(3, 'Run npm run test:unit', running ? 'in_progress' : 'completed', running ? null : 'success'),
        step(4, 'Complete job', running ? 'queued' : 'completed', running ? null : 'success'),
      ],
    },
    {
      ...common(githubJobs.e2e, 'e2e'),
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-05-04T09:12:41Z',
      completed_at: '2026-05-04T09:15:11Z',
      steps: [step(1, 'Set up job', 'completed', 'success'), step(2, 'Run npm run test:e2e', 'completed', 'success')],
    },
  ];
  const later = ctx.ui.githubAttemptsListed ? ctx.ui.githubAttempts.map((attempt) => ({ ...common(attempt.id, attempt.name), run_attempt: attempt.attempt, status: attempt.status, conclusion: attempt.conclusion, steps: [] })) : [];
  const all = [...first, ...later];
  if (filter === 'all') return all;
  const newest = (name: unknown): number => Math.max(...all.filter((job) => job['name'] === name).map((job) => job['run_attempt'] as number));
  return all.filter((job) => job['run_attempt'] === newest(job['name']));
}

/** The chip commit's check runs: its runs' jobs as GitHub Actions lists them (a job's check run has its id), and other apps'. */
function githubCheckRuns(ctx: CiContext, repoPath: string): Record<string, unknown>[] {
  const actions = { slug: 'github-actions', name: 'GitHub Actions' };
  const check = (id: number, name: string, conclusion: string, suite: number, app: Record<string, string>) => ({ id, name, status: 'completed', conclusion, started_at: '2026-05-04T09:12:31Z', completed_at: '2026-05-04T09:12:58Z', check_suite: { id: suite }, app });
  const ofRun = uiGithubJobs(ctx, repoPath).map((job) => ({ id: job['id'], name: job['name'], status: job['status'], conclusion: job['conclusion'], started_at: job['started_at'] ?? null, completed_at: job['completed_at'] ?? null, check_suite: { id: SUITES.ci }, app: actions }));
  const pullRequest = ctx.ui.githubPullRequestRun ? [check(GITHUB_OTHER.pullRequestJob, 'unit', 'success', SUITES.pullRequest, actions)] : [];
  const other = ctx.ui.githubOtherChecks
    ? [
        check(GITHUB_OTHER.lintJob, 'eslint', 'success', SUITES.lint, actions),
        check(GITHUB_OTHER.forkJob, 'unit', 'failure', SUITES.fork, actions),
        check(GITHUB_OTHER.check, 'ci/circleci: build', 'success', 7100, { slug: 'circleci-checks', name: 'CircleCI Checks' }),
      ]
    : [];
  const more = Array.from({ length: ctx.ui.thirdPartyChecks }, (_, at) => check(20_000 + at, `external ${at + 1}`, 'success', 7200, { slug: 'stub-checks', name: 'Stub Checks' }));
  return [...ofRun, ...pullRequest, ...other, ...more];
}

function github(ctx: CiContext): boolean {
  const match = /^\/repos\/([^/]+)\/([^/]+)(\/.+)$/.exec(ctx.path);
  if (!match) return false;
  const [owner, repo, rest] = [match[1]!, match[2]!, match[3]!];
  const repoPath = `${owner}/${repo}`;
  const { response, webUrl, method, ui } = ctx;
  if (ctx.ssoBlocked(owner)) return true;
  const level = ctx.level(repoPath);
  if (level === undefined) {
    json(response, 404, { message: 'Not Found' });
    return true;
  }
  const { pipeline, jobs, mergeRequest, issue } = CI_FIXTURES;
  const { githubRun, githubJobs } = CI_UI_FIXTURES;
  const job = (id: number) => githubJob(webUrl, repoPath, id, JOB_NAMES[id]!, JOB_STATUS[id]!);
  const pull = (number: number, title: string, head: string) => ({ id: 7000 + number, number, title, state: 'open', draft: false, user: { login: 'astefanopoulos' }, head: { ref: head }, base: { ref: mergeRequest.targetBranch }, body: 'Refresh now runs once per account and persists the rotated token before first use.', html_url: `${webUrl}/${repoPath}/pull/${number}`, created_at: CREATED, merged_at: null });
  const issueBody = { id: 8120, number: issue.number, title: issue.title, state: 'open', user: { login: 'astef-admin' }, labels: [{ name: 'bug' }, { name: 'auth' }], body: 'Two windows refresh the same token at once and one of them loses.', html_url: `${webUrl}/${repoPath}/issues/${issue.number}`, created_at: CREATED };
  const comments = [{ id: 2, body: 'Looks good once the e2e job passes.', user: { login: 'astef-admin' }, created_at: CREATED }];
  const toolRuns: Record<string, unknown>[] = [
    { id: pipeline.id, run_number: 312, run_attempt: 1, name: 'CI', display_title: 'Refresh tokens one at a time', status: 'completed', conclusion: 'failure', head_branch: CI_FIXTURES.branch, head_sha: SHA, created_at: CREATED, html_url: `${webUrl}/${repoPath}/actions/runs/${pipeline.id}`, ...githubRunFields(repoPath, WORKFLOWS.ci, 'push', 7312) },
    { id: pipeline.previous, run_number: 311, run_attempt: 1, name: 'CI', status: 'completed', conclusion: 'success', head_branch: CI_FIXTURES.branch, head_sha: SHA, created_at: CREATED, html_url: `${webUrl}/${repoPath}/actions/runs/${pipeline.previous}`, ...githubRunFields(repoPath, WORKFLOWS.ci, 'push', 7311) },
  ];
  const allRuns = (): Record<string, unknown>[] => [uiGithubRun(ctx, repoPath), ...otherGithubRuns(ctx, repoPath), ...toolRuns];
  const listJobs = (items: readonly Record<string, unknown>[]): void => {
    const listed = page(ctx, items);
    getJson(ctx, { total_count: items.length, jobs: listed.items }, listed.headers);
  };
  if (method === 'GET') {
    if (rest === '/actions/runs') {
      const branch = ctx.url.searchParams.get('branch');
      const sha = ctx.url.searchParams.get('head_sha');
      const runs = allRuns().filter((run) => (branch === null || run['head_branch'] === branch) && (sha === null || run['head_sha'] === sha));
      getJson(ctx, { total_count: runs.length, workflow_runs: runs });
      return true;
    }
    const oneRun = /^\/actions\/runs\/(\d+)$/.exec(rest);
    if (oneRun) {
      const run = allRuns().find((item) => item['id'] === Number(oneRun[1]));
      if (run) getJson(ctx, run);
      else json(response, 404, { message: 'Not Found' });
      return true;
    }
    if (rest === `/actions/runs/${pipeline.id}/jobs`) {
      listJobs([jobs.unit, jobs.e2e].map(job));
      return true;
    }
    if (rest === `/actions/runs/${githubRun.id}/jobs`) {
      listJobs(uiGithubJobs(ctx, repoPath, ctx.url.searchParams.get('filter') === 'all' ? 'all' : 'latest'));
      return true;
    }
    const checkRuns = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(rest);
    if (checkRuns) {
      const items = checkRuns[1] === ui.sha ? githubCheckRuns(ctx, repoPath) : [];
      const listed = page(ctx, items);
      getJson(ctx, { total_count: items.length, check_runs: listed.items }, listed.headers);
      return true;
    }
    const combined = /^\/commits\/([0-9a-f]{40})\/status$/.exec(rest);
    if (combined) {
      const statuses = combined[1] === ui.sha && ui.githubOtherChecks ? [{ id: GITHUB_OTHER.status, context: 'deploy/netlify', state: 'success', description: 'Deploy preview ready', created_at: '2026-05-04T09:12:20Z', updated_at: '2026-05-04T09:13:40Z' }] : [];
      const listed = page(ctx, statuses);
      getJson(ctx, { state: statuses.length > 0 ? 'success' : 'pending', sha: combined[1], total_count: statuses.length, statuses: listed.items }, listed.headers);
      return true;
    }
    const oneJob = /^\/actions\/jobs\/(\d+)$/.exec(rest);
    const uiJob = oneJob ? uiGithubJobs(ctx, repoPath, 'all').find((item) => item['id'] === Number(oneJob[1])) : undefined;
    if (uiJob) {
      getJson(ctx, uiJob);
      return true;
    }
    if (oneJob && JOB_NAMES[Number(oneJob[1])] !== undefined) {
      getJson(ctx, job(Number(oneJob[1])));
      return true;
    }
    const logs = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest);
    if (logs && Number(logs[1]) === githubJobs.unit && ui.latest('unit')?.status === 'running') {
      // GitHub publishes a job's log only once the job completes
      json(response, 404, { message: 'Not Found' });
      return true;
    }
    if (logs && (JOB_NAMES[Number(logs[1])] !== undefined || Number(logs[1]) === githubJobs.unit || Number(logs[1]) === githubJobs.e2e)) {
      // GitHub redirects to its log storage, another origin, with a short-lived signed URL
      response.writeHead(302, { location: `${ctx.logStorage}/_logs/${logs[1]}.txt?sig=stub` });
      response.end();
      return true;
    }
    if (rest === `/pulls/${mergeRequest.number}`) {
      getJson(ctx, pull(mergeRequest.number, mergeRequest.title, mergeRequest.sourceBranch));
      return true;
    }
    if (rest === `/issues/${mergeRequest.number}/comments` || rest === `/issues/${issue.number}/comments`) {
      getJson(ctx, comments);
      return true;
    }
    if (rest === '/pulls') {
      getJson(ctx, [pull(mergeRequest.number, mergeRequest.title, mergeRequest.sourceBranch)]);
      return true;
    }
    if (rest === `/issues/${issue.number}`) {
      getJson(ctx, issueBody);
      return true;
    }
    if (rest === `/issues/${CI_FIXTURES.pullInIssues}`) {
      getJson(ctx, { ...issueBody, number: CI_FIXTURES.pullInIssues, pull_request: { url: 'stub' } });
      return true;
    }
    if (rest === '/issues') {
      // as on a busy repository, the newest page holds pull requests only
      const perPage = Number(ctx.url.searchParams.get('per_page') ?? '30');
      getJson(ctx, Array.from({ length: perPage }, (_, index) => ({ ...issueBody, number: 1000 + index, title: mergeRequest.title, pull_request: { url: 'stub' } })));
      return true;
    }
    return false;
  }
  if (method !== 'POST') return false;
  if (level < 30) {
    json(response, 403, { message: 'Must have admin rights to Repository.' });
    return true;
  }
  const rerun = /^\/actions\/jobs\/(\d+)\/rerun$/.exec(rest);
  const rerunOfChip = rerun ? uiGithubJobs(ctx, repoPath, 'all').find((item) => item['id'] === Number(rerun[1])) : undefined;
  if (rerun && (JOB_NAMES[Number(rerun[1])] !== undefined || rerunOfChip)) {
    record(ctx);
    // a rerun of the chip's run is its job's next attempt, which runs the run again
    if (rerunOfChip) ui.githubRerun(rerunOfChip['name'] as string);
    response.writeHead(201);
    response.end();
    return true;
  }
  const runAction = /^\/actions\/runs\/(\d+)\/(cancel|rerun-failed-jobs)$/.exec(rest);
  if (runAction && (Number(runAction[1]) === pipeline.id || Number(runAction[1]) === githubRun.id || (ui.githubOtherChecks && Number(runAction[1]) === GITHUB_OTHER.lintRun))) {
    record(ctx);
    if (runAction[2] === 'rerun-failed-jobs' && Number(runAction[1]) === githubRun.id) {
      for (const failed of uiGithubJobs(ctx, repoPath).filter((item) => item['conclusion'] === 'failure')) ui.githubRerun(failed['name'] as string);
    }
    json(response, runAction[2] === 'cancel' ? 202 : 201, {});
    return true;
  }
  const comment = /^\/issues\/(\d+)\/comments$/.exec(rest);
  if (comment && (Number(comment[1]) === mergeRequest.number || Number(comment[1]) === issue.number)) {
    record(ctx);
    json(response, 201, { id: 900 + ctx.writes.length, body: (JSON.parse(ctx.body) as { body?: unknown }).body, user: { login: ctx.login } });
    return true;
  }
  if (rest === '/pulls') {
    const sent = JSON.parse(ctx.body) as { title?: string; head?: string };
    if (sent.head === mergeRequest.sourceBranch) {
      json(response, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${owner}:${sent.head}.` }], documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request' });
      return true;
    }
    record(ctx);
    json(response, 201, pull(46, sent.title ?? '', sent.head ?? ''));
    return true;
  }
  return false;
}

/**
 * GitHub GraphQL's lists the agent tools read: a repository's issues and its pull requests, by the states asked for, newest
 * first; undefined for any other query.
 */
export function answerGithubToolsGraphql(query: string, variables: Record<string, unknown>, webUrl: string): unknown {
  const repoPath = `${String(variables['owner'])}/${String(variables['repo'])}`;
  const states = Array.isArray(variables['states']) ? (variables['states'] as unknown[]) : null;
  const first = typeof variables['first'] === 'number' ? variables['first'] : 0;
  const picked = <T extends { readonly state: string }>(nodes: readonly T[]): T[] => nodes.filter((node) => states === null || states.includes(node.state)).slice(0, first);
  const { issue, mergeRequest, mergedPull, closedPull } = CI_FIXTURES;
  if (query.includes('issues(states:')) {
    const nodes = [{ number: issue.number, title: issue.title, state: 'OPEN', url: `${webUrl}/${repoPath}/issues/${issue.number}`, createdAt: CREATED, author: { login: 'astef-admin' }, labels: { nodes: [{ name: 'bug' }, { name: 'auth' }] } }];
    return { data: { repository: { issues: { nodes: picked(nodes) } } } };
  }
  if (query.includes('pullRequests(states:')) {
    const pull = (number: number, title: string, state: string, head: string) => ({ number, title, state, isDraft: false, url: `${webUrl}/${repoPath}/pull/${number}`, createdAt: CREATED, headRefName: head, baseRefName: mergeRequest.targetBranch, author: { login: 'astefanopoulos' } });
    const nodes = [pull(mergeRequest.number, mergeRequest.title, 'OPEN', mergeRequest.sourceBranch), pull(mergedPull.number, mergedPull.title, 'MERGED', 'fix/persist-first'), pull(closedPull.number, closedPull.title, 'CLOSED', 'fix/lock-file')];
    return { data: { repository: { pullRequests: { nodes: picked(nodes) } } } };
  }
  return undefined;
}

/** GitHub's log storage stand-in, its own origin: /_logs/<job id>.txt, answered without a credential. */
export function answerGithubLog(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
  const match = /^\/_logs\/(\d+)\.txt$/.exec(url.pathname);
  const id = match ? Number(match[1]) : undefined;
  const known = id !== undefined && (JOB_NAMES[id] !== undefined || id === CI_UI_FIXTURES.githubJobs.unit || id === CI_UI_FIXTURES.githubJobs.e2e);
  if (request.method !== 'GET' || !known) return false;
  response.writeHead(200, { 'content-type': 'text/plain' });
  const timestamped = (line: string): string => `2026-05-04T09:12:30.0000000Z ${line}`;
  const lines = JOB_NAMES[id] === 'e2e'
    ? ['##[group]Run npm run test:e2e', `export GITHUB_TOKEN=${PLANTED_LOG_TOKEN}`, 'npm run test:e2e', '##[endgroup]', '\u001b[31m✗ refresh › rotates once per account\u001b[0m', '##[error]Process completed with exit code 1.']
    : id === CI_UI_FIXTURES.githubJobs.e2e
      ? ['##[group]Run npm run test:e2e', 'npm run test:e2e', '##[endgroup]', '\u001b[32m✓ 42 passed\u001b[0m']
      : ['unit ok'];
  response.end(lines.map(timestamped).join('\n'));
  return true;
}
