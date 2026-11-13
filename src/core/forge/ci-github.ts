import { MAX_JOB_LOG_BYTES, type CiJobView, type CiPipelineView, type CiRunView, type CiState, type CiStepView } from '../../shared/forge/ci';
import { getCached, getCachedList, isActive, isoOf, isRetriable, jobCounts, seconds, type CiAdapter, type CiContext } from './ci-adapter';
import { field, numberField, stringField, type ForgeTail } from './http';
import { githubRepoApi, newerAttempt } from './tools/github';
import { cleanLine } from './tools/output';
import { ForgeHttpError } from './types';

// GitHub for the chip, the job list and the job log tab: the pipeline is every check of the head commit, its workflow runs
// grouped by workflow, other apps' check runs and its commit statuses. GitHub serves a job's log only once the job completes,
// so a running job shows its steps instead (docs/git-hosting.md, CI).

const CONCLUSIONS: Readonly<Record<string, CiState>> = {
  success: 'passed',
  failure: 'failed',
  timed_out: 'failed',
  startup_failure: 'failed',
  cancelled: 'canceled',
  stale: 'canceled',
  skipped: 'skipped',
  neutral: 'skipped',
  action_required: 'manual',
};

const STATUSES: Readonly<Record<string, CiState>> = {
  queued: 'pending',
  requested: 'pending',
  waiting: 'pending',
  pending: 'pending',
  in_progress: 'running',
};

// a commit status's state (GET /repos/{owner}/{repo}/commits/{ref}/status)
const STATUS_STATES: Readonly<Record<string, CiState>> = {
  success: 'passed',
  failure: 'failed',
  error: 'failed',
  pending: 'pending',
};

// the app whose check runs are Actions jobs
const ACTIONS_APP = 'github-actions';
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A run's, job's, check run's or step's state: its conclusion once completed, else its status. */
export function githubState(body: unknown): CiState {
  const status = stringField(body, 'status');
  if (status === 'completed') return CONCLUSIONS[stringField(body, 'conclusion') ?? ''] ?? 'failed';
  return STATUSES[status ?? ''] ?? 'pending';
}

/** Many checks as one: any active runs, else any failed fails, else any canceled cancels; only skipped ones skip; else passed. */
function combinedState(states: readonly CiState[]): CiState | undefined {
  if (states.length === 0) return undefined;
  if (states.some(isActive)) return 'running';
  if (states.includes('failed')) return 'failed';
  if (states.includes('canceled')) return 'canceled';
  return states.every((state) => state === 'skipped') ? 'skipped' : 'passed';
}

const repo = (ctx: CiContext): string => {
  const [owner, name] = ctx.repoPath.split('/');
  return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
};
const get = (ctx: CiContext, path: string, template: string, query: Readonly<Record<string, string>> = {}): Promise<unknown> =>
  getCached(ctx, `${repo(ctx)}${path}`, `/repos/{owner}/{repo}${template}`, query);
const list = (body: unknown): unknown[] => (Array.isArray(body) ? body : []);
const timeOf = (value: string | undefined): number => Date.parse(value ?? '') || 0;

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new ForgeHttpError('server', `GitHub answered without ${what}`);
  return value;
}

interface Run {
  readonly id: number;
  readonly workflowId: number | undefined;
  readonly event: string;
  readonly name: string;
  readonly suiteId: number | undefined;
  readonly headSha: string | undefined;
  readonly created: number;
  readonly started: number;
  readonly state: CiState;
}

function runOf(body: unknown): Run | undefined {
  const id = numberField(body, 'id');
  if (id === undefined) return undefined;
  return {
    id,
    workflowId: numberField(body, 'workflow_id'),
    event: cleanLine(stringField(body, 'event') ?? '', 60),
    name: cleanLine(stringField(body, 'name') ?? '', 200),
    suiteId: numberField(body, 'check_suite_id'),
    headSha: stringField(body, 'head_sha'),
    created: timeOf(stringField(body, 'created_at')),
    started: timeOf(stringField(body, 'run_started_at')),
    state: githubState(body),
  };
}

const sameName = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * The workflow runs a commit's checks show: those of the repository's own branches (a fork's pull request run of a branch of
 * the same name is not the repository's), the newest of each workflow and event.
 */
function shownRuns(bodies: readonly unknown[]): { readonly shown: Run[]; readonly suites: ReadonlySet<number> } {
  const suites = new Set<number>();
  const newest = new Map<string, Run>();
  for (const body of bodies) {
    const run = runOf(body);
    if (!run) continue;
    if (run.suiteId !== undefined) suites.add(run.suiteId);
    if (!sameName(stringField(field(body, 'head_repository'), 'full_name'), stringField(field(body, 'repository'), 'full_name'))) continue;
    const key = `${run.workflowId ?? run.name}\u0000${run.event}`;
    const held = newest.get(key);
    if (!held || run.created > held.created || (run.created === held.created && run.id > held.id)) newest.set(key, run);
  }
  const shown = [...newest.values()].sort((a, b) => a.created - b.created || a.started - b.started || a.id - b.id);
  return { shown, suites };
}

function stepsOf(body: unknown): CiStepView[] {
  return list(field(body, 'steps')).slice(0, 200).flatMap((step) => {
    const number = numberField(step, 'number');
    return number === undefined ? [] : [{ number, name: cleanLine(stringField(step, 'name') ?? '', 200), state: githubState(step) }];
  });
}

/** Started, finished and duration of a job, check run or status, from its two stamps. */
function times(started: string | undefined, finished: string | undefined): Pick<CiJobView, 'startedAt' | 'finishedAt' | 'durationSeconds'> {
  const startedAt = isoOf(started);
  const finishedAt = isoOf(finished);
  const durationSeconds = startedAt !== undefined && finishedAt !== undefined ? seconds((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000) : undefined;
  return { ...(startedAt !== undefined ? { startedAt } : {}), ...(finishedAt !== undefined ? { finishedAt } : {}), ...(durationSeconds !== undefined ? { durationSeconds } : {}) };
}

/** A job (GET /actions/jobs/{id}) or an Actions check run, whose id is its job's. */
function jobOf(body: unknown, stage: string, runId: number, runFinished: boolean): CiJobView {
  const state = githubState(body);
  const runner = stringField(body, 'runner_name');
  const steps = field(body, 'steps') !== undefined ? stepsOf(body) : undefined;
  return {
    id: required(numberField(body, 'id'), 'a job id'),
    name: cleanLine(stringField(body, 'name') ?? '', 200),
    stage,
    state,
    kind: 'job',
    runId,
    ...times(stringField(body, 'started_at'), stringField(body, 'completed_at')),
    ...(runner ? { runner: cleanLine(runner, 200) } : {}),
    // GitHub reruns a job only once its whole run completed; Cancel acts on the run, from its heading
    canRetry: runFinished && isRetriable(state),
    canCancel: false,
    hasLog: true,
    ...(steps !== undefined ? { steps } : {}),
  };
}

function externalCheck(body: unknown): CiJobView | undefined {
  const id = numberField(body, 'id');
  if (id === undefined) return undefined;
  return { id, name: cleanLine(stringField(body, 'name') ?? '', 200), stage: '', state: githubState(body), kind: 'external', ...times(stringField(body, 'started_at'), stringField(body, 'completed_at')), canRetry: false, canCancel: false, hasLog: false };
}

function externalStatus(body: unknown): CiJobView | undefined {
  const id = numberField(body, 'id');
  if (id === undefined) return undefined;
  const state = STATUS_STATES[stringField(body, 'state') ?? ''] ?? 'pending';
  return { id, name: cleanLine(stringField(body, 'context') ?? '', 200), stage: '', state, kind: 'external', ...times(stringField(body, 'created_at'), isActive(state) ? undefined : stringField(body, 'updated_at')), canRetry: false, canCancel: false, hasLog: false };
}

const startOf = (job: CiJobView): number => (job.startedAt !== undefined ? Date.parse(job.startedAt) : Number.MAX_SAFE_INTEGER);

interface Checks {
  readonly runs: readonly unknown[];
  readonly checkRuns: readonly unknown[];
  readonly statuses: readonly unknown[];
  readonly truncated: boolean;
}

/** Every check of a commit, each list read conditionally. */
async function checksAt(ctx: CiContext, sha: string): Promise<Checks> {
  const at = `${repo(ctx)}/commits/${sha}`;
  const [runs, checkRuns, statuses] = await Promise.all([
    get(ctx, '/actions/runs', '/actions/runs', { head_sha: sha, per_page: '100' }),
    getCachedList(ctx, `${at}/check-runs`, '/repos/{owner}/{repo}/commits/{sha}/check-runs', { filter: 'latest', per_page: '100' }, (body) => list(field(body, 'check_runs'))),
    getCachedList(ctx, `${at}/status`, '/repos/{owner}/{repo}/commits/{sha}/status', { per_page: '100' }, (body) => list(field(body, 'statuses'))),
  ]);
  return { runs: list(field(runs, 'workflow_runs')), checkRuns: checkRuns.items, statuses: statuses.items, truncated: checkRuns.truncated || statuses.truncated };
}

const isEmpty = (checks: Checks): boolean => checks.runs.length === 0 && checks.checkRuns.length === 0 && checks.statuses.length === 0;

function checksView(checks: Checks, ref: { readonly branch: string; readonly sha: string }, serverId: string, serverName: string): CiPipelineView | null {
  const { shown, suites } = shownRuns(checks.runs);
  const bySuite = new Map(shown.flatMap((run) => (run.suiteId !== undefined ? [[run.suiteId, run] as const] : [])));
  const workflowOf = (run: Run): string => String(run.workflowId ?? run.name);
  const runsOf = new Map<string, number>();
  for (const run of shown) runsOf.set(workflowOf(run), (runsOf.get(workflowOf(run)) ?? 0) + 1);
  const stageOf = (run: Run): string => (runsOf.get(workflowOf(run))! > 1 ? `${run.name} (${run.event})` : run.name);
  const jobsOf = new Map<number, CiJobView[]>(shown.map((run) => [run.id, []]));
  const external: CiJobView[] = [];
  for (const check of checks.checkRuns) {
    const suite = numberField(field(check, 'check_suite'), 'id');
    const run = suite !== undefined ? bySuite.get(suite) : undefined;
    if (run) jobsOf.get(run.id)!.push(jobOf(check, stageOf(run), run.id, !isActive(run.state)));
    // an Actions check run of a run not shown (an older run of its workflow, a fork's run) is left out
    else if ((suite === undefined || !suites.has(suite)) && stringField(field(check, 'app'), 'slug') !== ACTIONS_APP) {
      const row = externalCheck(check);
      if (row) external.push(row);
    }
  }
  for (const status of checks.statuses) {
    const row = externalStatus(status);
    if (row) external.push(row);
  }
  if (shown.length === 0 && external.length === 0) return null;
  const jobs = [
    ...shown.flatMap((run) => jobsOf.get(run.id)!.sort((a, b) => startOf(a) - startOf(b) || a.id - b.id)),
    ...external.sort((a, b) => startOf(a) - startOf(b) || a.id - b.id),
  ];
  const runs: CiRunView[] = shown.map((run) => ({ id: run.id, stage: stageOf(run), canRetry: run.state === 'failed' || run.state === 'canceled', canCancel: isActive(run.state) }));
  const state = combinedState([...shown.map((run) => run.state), ...external.map((row) => row.state)])!;
  const started = jobs.map((job) => job.startedAt).filter((at): at is string => at !== undefined).sort()[0];
  const finished = jobs.map((job) => job.finishedAt).filter((at): at is string => at !== undefined).sort().at(-1);
  const durationSeconds = !isActive(state) && started !== undefined && finished !== undefined ? seconds((Date.parse(finished) - Date.parse(started)) / 1000) : undefined;
  return {
    serverId,
    serverName,
    kind: 'github',
    id: 0,
    number: 0,
    state,
    ref: cleanLine(ref.branch, 255),
    sha: ref.sha,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(started !== undefined ? { startedAt: started } : {}),
    ...jobCounts(jobs),
    canRetry: false,
    canCancel: false,
    jobs,
    runs,
    ...(checks.truncated ? { truncated: true } : {}),
  };
}

/** The commit the chip shows: HEAD when it has checks, else the newest run's commit of the branch in the repository itself. */
async function checksFor(ctx: CiContext, branch: string, sha: string | undefined): Promise<{ readonly checks: Checks; readonly sha: string } | undefined> {
  const atHead = sha !== undefined ? await checksAt(ctx, sha) : undefined;
  if (atHead && !isEmpty(atHead)) return { checks: atHead, sha: sha! };
  const ofBranch = shownRuns(list(field(await get(ctx, '/actions/runs', '/actions/runs', { branch, per_page: '20' }), 'workflow_runs')));
  const headSha = ofBranch.shown.at(-1)?.headSha;
  if (headSha === undefined || !SHA.test(headSha) || headSha === sha) return undefined;
  return { checks: await checksAt(ctx, headSha), sha: headSha };
}

export const githubCi: CiAdapter = {
  liveLogs: false,

  async pipeline(ctx, { branch, sha }, serverName) {
    const found = await checksFor(ctx, branch, sha);
    return found ? checksView(found.checks, { branch, sha: found.sha }, ctx.server.id, serverName) : null;
  },

  async commitPipeline(ctx, sha) {
    const [runs, status] = await Promise.all([
      get(ctx, '/actions/runs', '/actions/runs', { head_sha: sha, per_page: '100' }),
      get(ctx, `/commits/${sha}/status`, '/commits/{sha}/status', { per_page: '1' }),
    ]);
    const states = shownRuns(list(field(runs, 'workflow_runs'))).shown.map((run) => run.state);
    // a commit with no status still answers state "pending"
    const combined = (numberField(status, 'total_count') ?? 0) > 0 ? STATUS_STATES[stringField(status, 'state') ?? ''] : undefined;
    const state = combinedState(combined !== undefined ? [...states, combined] : states);
    return state === undefined ? null : { id: 0, number: 0, state };
  },

  async job(ctx, jobId) {
    const body = await get(ctx, `/actions/jobs/${jobId}`, '/actions/jobs/{id}');
    const runId = required(numberField(body, 'run_id'), 'the job\'s run');
    const run = await get(ctx, `/actions/runs/${runId}`, '/actions/runs/{id}');
    const runActive = isActive(githubState(run));
    const job = jobOf(body, cleanLine(stringField(body, 'workflow_name') ?? stringField(run, 'name') ?? '', 200), runId, !runActive);
    const ref = stringField(body, 'head_branch');
    const attempt = numberField(body, 'run_attempt');
    return {
      job,
      pipeline: { id: runId, number: numberField(run, 'run_number') ?? runId, ...(ref !== undefined ? { ref: cleanLine(ref, 255) } : {}) },
      runActive,
      ...(attempt !== undefined ? { attempt } : {}),
    };
  },

  async attemptAfter(ctx, detail) {
    const body = await get(ctx, `/actions/jobs/${detail.job.id}`, '/actions/jobs/{id}');
    const jobs = await getCachedList(ctx, `${repo(ctx)}/actions/runs/${detail.pipeline.id}/jobs`, '/repos/{owner}/{repo}/actions/runs/{id}/jobs', { filter: 'all', per_page: '100' }, (page) => list(field(page, 'jobs')));
    return numberField(newerAttempt(body, jobs.items), 'id');
  },

  async log(ctx, jobId) {
    // a redirect to GitHub's log storage, which http.ts follows without the token
    const response = await ctx.http.request({
      server: ctx.server,
      url: `${repo(ctx)}/actions/jobs/${jobId}/logs`,
      template: '/repos/{owner}/{repo}/actions/jobs/{id}/logs',
      credential: { bearer: ctx.token },
      as: 'tail',
      maxBytes: MAX_JOB_LOG_BYTES,
      signal: ctx.signal,
    });
    return { notModified: false, tail: response.body as ForgeTail };
  },

  async action(ctx, target, action) {
    if ('runId' in target) {
      await githubRepoApi.pipelineAction(ctx, target.runId, action);
      return {};
    }
    if (!('jobId' in target)) throw new ForgeHttpError('refused', 'GitHub acts on a workflow run or a job');
    const job = await githubRepoApi.jobAction(ctx, target.jobId, action);
    return action === 'retry' && job !== null && job.id !== target.jobId ? { jobId: job.id } : {};
  },

  webUrl(server, repoPath, target) {
    if ('sha' in target) return `${server.webUrl}/${repoPath}/commit/${target.sha}/checks`;
    if ('runId' in target) return `${server.webUrl}/${repoPath}/actions/runs/${target.runId}`;
    if ('pipelineId' in target) return `${server.webUrl}/${repoPath}/actions/runs/${target.pipelineId}`;
    return target.pipelineIdOfJob !== undefined ? `${server.webUrl}/${repoPath}/actions/runs/${target.pipelineIdOfJob}/job/${target.jobId}` : `${server.webUrl}/${repoPath}/actions`;
  },
};
