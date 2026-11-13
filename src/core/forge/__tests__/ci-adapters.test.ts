import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeService } from '..';
import type { RemoteEndpoint } from '../../../shared/forge/bindings';
import type { CiPipelineView } from '../../../shared/forge/ci';
import { CiLogParser } from '../../../shared/forge/ci-log';
import { LOG_POLL_MS, type CiChangedEvent, type CiLog, type CiRepo, type CiStatus } from '../ci-watch';
import { FORGE_CI_STATUS_SETTING } from '../types';
import { createHarness, type Harness } from './support/harness';
import { CI_UI_FIXTURES } from './support/forge-stub-ci';
import type { StubServer } from './support/forge-stub';

// CI against the stub through the forge service (docs/invariants.md "GitHub and GitLab accounts", CI): the pipeline a branch
// shows, its jobs in stage order, actions, ETag polling, the log's appends, GitHub's checks of a commit, its running jobs and
// its log storage on another origin, which never gets the token. The stub's log grows by the test's clock, and the watch's
// timers are fake, so nothing waits on the wall clock.

let harness: Harness;
let service: ForgeService;
const events: CiChangedEvent[] = [];
const clock = { now: Date.now() };

function endpoint(server: StubServer, repoPath: string): RemoteEndpoint {
  const url = new URL(server.webUrl);
  return { remote: 'origin', fetch: { protocol: 'https', host: url.hostname, port: Number(url.port), path: `${repoPath}.git`, aliasResolved: false } };
}

const repo = (server: StubServer, repoPath: string, extra: Partial<CiRepo> = {}): CiRepo => ({
  authorityKey: 'local',
  projectKey: 'c:/src/damocles',
  project: 'damocles',
  endpoints: [endpoint(server, repoPath)],
  branch: CI_UI_FIXTURES.branch,
  ...extra,
});
const gitlab = (extra: Partial<CiRepo> = {}): CiRepo => repo(harness.stub.gitlab, 'alexios-s/damocles', extra);
const github = (extra: Partial<CiRepo> = {}): CiRepo => repo(harness.stub.github, 'astefanopoulos/damocles', extra);

const ready = (log: CiLog): Extract<CiLog, { status: 'ready' }> => {
  if (log.status !== 'ready') throw new Error(`expected a ready log, got ${log.status}`);
  return log;
};
const pipelineOf = (view: CiStatus | null): CiPipelineView => {
  if (view?.status !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(view)}`);
  return view.pipeline;
};
const logsOf = (id: string): CiLog[] => events.flatMap((event) => ('log' in event && event.id === id ? [event.log] : []));

// vi.waitFor moves the fake timers by its interval on each check: a short one stays far below the watch's next read
const WAIT = { timeout: 5_000, interval: 5 };

/** The watch's next log read, LOG_POLL_MS on by the clock and its timer. */
async function poll(): Promise<void> {
  clock.now += LOG_POLL_MS;
  await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
}

beforeAll(async () => {
  harness = await createHarness({ now: () => clock.now });
  service = harness.service();
  service.onCiChanged((event) => events.push(event));
  await service.load();
  await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubAlexiosSApi000000008', agentShells: false });
  await service.signIn({ serverId: 'github.com', route: 'token', token: 'ghp_stubAstefanopoulosRepo0000000001', agentShells: false });
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  // the watch's timers only: the stub and the client keep the real event loop
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  harness.stub.gitlab.ci.reset();
  harness.stub.github.ci.reset();
  harness.settings = {};
  events.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GitLab CI', () => {
  it('shows the branch\'s pipeline #4312 with its jobs in stage order, a waiting manual job with no actions', async () => {
    const pipeline = pipelineOf(await service.ci.watch('w-gitlab', gitlab(), false));
    service.ci.unwatch('w-gitlab');
    expect(pipeline).toMatchObject({ kind: 'gitlab', id: CI_UI_FIXTURES.pipeline.id, number: 4312, state: 'running', ref: CI_UI_FIXTURES.branch, jobsDone: 3, jobsTotal: 5, failedCount: 0, canCancel: true, canRetry: false, serverName: 'gitlab.com' });
    expect(pipeline.truncated).toBeUndefined();
    expect(pipeline.jobs.map((job) => [job.stage, job.name, job.state])).toEqual([
      ['build', 'compile', 'passed'],
      ['build', 'lint', 'passed'],
      ['test', 'unit', 'running'],
      ['test', 'e2e', 'passed'],
      ['deploy', 'review-app', 'manual'],
    ]);
    const reviewApp = pipeline.jobs.find((job) => job.name === 'review-app')!;
    expect([reviewApp.canRetry, reviewApp.canCancel]).toEqual([false, false]);
    expect(pipeline.jobs.find((job) => job.name === 'e2e')).toMatchObject({ canRetry: true, canCancel: false, hasLog: true, runner: 'shared-03' });
  });

  it('answers no chip for a branch without a pipeline, and nothing at all with ciStatus off', async () => {
    expect(await service.ci.watch('w-none', gitlab({ branch: 'no-ci-here' }), false)).toEqual({ status: 'none' });
    service.ci.unwatch('w-none');
    harness.settings = { [FORGE_CI_STATUS_SETTING]: false };
    const before = harness.stub.gitlab.requests.length;
    expect(await service.ci.watch('w-off', gitlab(), true)).toBeNull();
    service.ci.unwatch('w-off');
    expect(harness.stub.gitlab.requests.length).toBe(before);
  });

  it('shows the branch\'s pipeline, not the pipeline of a fork\'s merge request from a branch of the same name', async () => {
    harness.stub.gitlab.ci.forkMergeRequest = true;
    const pipeline = pipelineOf(await service.ci.watch('w-fork', gitlab(), false));
    service.ci.unwatch('w-fork');
    expect(pipeline.id).toBe(CI_UI_FIXTURES.pipeline.id);
  });

  it('reads every page of a long job list, and says when it holds only the newest ten pages', async () => {
    const ui = harness.stub.gitlab.ci;
    const add = (count: number): void => {
      const from = ui.jobs.length;
      ui.jobs.push(...Array.from({ length: count }, (_, at) => ({ id: 20_000 + from + at, name: `matrix ${from + at}`, stage: 'matrix', status: 'success' as const, startedAt: '2026-05-04T09:13:00Z', finishedAt: '2026-05-04T09:13:30Z' })));
    };
    add(245);
    const paged = pipelineOf(await service.ci.watch('w-pages', gitlab(), false));
    service.ci.unwatch('w-pages');
    expect(paged.jobsTotal).toBe(250);
    expect(paged.truncated).toBeUndefined();
    expect(paged.jobs[0]!.name).toBe('compile');
    add(800);
    const cut = pipelineOf(await service.ci.watch('w-cut', gitlab(), false));
    service.ci.unwatch('w-cut');
    expect(cut.jobsTotal).toBe(1000);
    expect(cut.truncated).toBe(true);
    // GitLab lists the newest first, so the earliest stage is the one left out
    expect(cut.jobs.some((job) => job.stage === 'build')).toBe(false);
  });

  it('counts a failure its pipeline allows as no failure, and offers no retry of a skipped job', async () => {
    const ui = harness.stub.gitlab.ci;
    const lint = ui.latest('lint')!;
    lint.status = 'failed';
    lint.allowFailure = true;
    ui.latest('review-app')!.status = 'skipped';
    const pipeline = pipelineOf(await service.ci.watch('w-allowed', gitlab(), false));
    service.ci.unwatch('w-allowed');
    expect(pipeline.failedCount).toBe(0);
    expect(pipeline.jobs.find((job) => job.name === 'lint')).toMatchObject({ state: 'failed', allowedFailure: true, canRetry: true });
    expect(pipeline.jobs.find((job) => job.name === 'review-app')).toMatchObject({ state: 'skipped', canRetry: false });
  });

  it('retries a job as a new one, then cancels it, and the watch shows each at once', async () => {
    await service.ci.watch('w-actions', gitlab(), false);
    const retried = await service.ci.jobAction(gitlab(), { jobId: CI_UI_FIXTURES.gitlabJobs.e2e }, 'retry');
    expect(retried.ok).toBe(true);
    expect(retried.jobId).toBeGreaterThan(CI_UI_FIXTURES.gitlabJobs.e2e);
    let pipeline = pipelineOf(await service.ci.jobs('w-actions'));
    expect(pipeline.jobs.find((job) => job.name === 'e2e')).toMatchObject({ id: retried.jobId, state: 'running', canCancel: true, canRetry: false });
    expect((await service.ci.jobAction(gitlab(), { jobId: retried.jobId! }, 'cancel')).ok).toBe(true);
    pipeline = pipelineOf(await service.ci.jobs('w-actions'));
    expect(pipeline.jobs.find((job) => job.name === 'e2e')).toMatchObject({ state: 'canceled', canRetry: true, canCancel: false });
    expect(events.some((event) => 'status' in event && event.id === 'w-actions')).toBe(true);
    expect((await service.ci.jobAction(gitlab(), { pipelineId: CI_UI_FIXTURES.pipeline.id }, 'cancel')).ok).toBe(true);
    expect(harness.stub.gitlab.forgeWrites.at(-1)).toMatchObject({ path: `/projects/alexios-s/damocles/pipelines/${CI_UI_FIXTURES.pipeline.id}/cancel` });
    service.ci.unwatch('w-actions');
  });

  it('reads a running log whole, appends what it gained every 3 s, and an unchanged log answers 304 with no update', async () => {
    const ui = harness.stub.gitlab.ci;
    const first = ready(await service.ci.jobLog('log-unit', gitlab(), CI_UI_FIXTURES.gitlabJobs.unit));
    expect(first).toMatchObject({ reset: true, live: true, truncated: false, pipeline: { number: 4312, ref: CI_UI_FIXTURES.branch } });
    expect(first.text).toContain('Executing "step_script" stage of the job script');
    const parser = new CiLogParser('gitlab');
    parser.push(first.text);
    expect(parser.sections.find((section) => section.title === 'Preparing the "docker" executor')?.collapsed).toBe(true);
    // the stub's log gains a line every LOG_TICK_MS of the clock; the last characters wait for the next read, in case a
    // token is cut there. Each read is awaited before the clock moves on, so the next one is the watch's own timer's.
    const appended = (): string => logsOf('log-unit').map((view) => ready(view).text).join('');
    for (const reads of [1, 2]) {
      await poll();
      await vi.waitFor(() => expect(logsOf('log-unit')).toHaveLength(reads), WAIT);
    }
    expect(appended()).toContain('suite-1.test.ts');
    expect(logsOf('log-unit').every((view) => !ready(view).reset)).toBe(true);
    expect(appended()).not.toContain('Preparing the "docker" executor');
    ui.freezeLog(true);
    let notModified = ui.notModified;
    await poll();
    await vi.waitFor(() => expect(ui.notModified).toBeGreaterThan(notModified), WAIT);
    // the next read goes only once the unchanged one was handled
    const eventsBefore = events.length;
    notModified = ui.notModified;
    await poll();
    await vi.waitFor(() => expect(ui.notModified).toBeGreaterThan(notModified), WAIT);
    service.ci.unwatch('log-unit');
    expect(events.length).toBe(eventsBefore);
  });

  it('answers a commit\'s pipeline, none for a commit the server lacks, and an error once when the server fails', async () => {
    const ui = harness.stub.gitlab.ci;
    ui.pipelineState = 'success';
    expect(await service.ci.commitStatus(gitlab(), CI_UI_FIXTURES.sha, true)).toEqual({ status: 'ready', pipeline: { id: CI_UI_FIXTURES.pipeline.id, number: 4312, state: 'passed', serverName: 'gitlab.com', kind: 'gitlab' } });
    expect(await service.ci.commitStatus(gitlab(), 'a'.repeat(40), true)).toEqual({ status: 'none' });
    ui.failNextCommitStatus = true;
    expect(await service.ci.commitStatus(gitlab(), CI_UI_FIXTURES.sha, true)).toMatchObject({ status: 'error', message: { message: '{0} could not answer (HTTP {1}).' } });
    expect(await service.ci.commitStatus(gitlab(), 'not-a-sha', true)).toBeNull();
  });

  it('builds the server page of a pipeline or job from its web URL, the repository path and the id', async () => {
    expect(await service.ci.webUrl(gitlab(), { pipelineId: 54312 })).toEqual({ url: `${harness.stub.gitlab.webUrl}/alexios-s/damocles/-/pipelines/54312`, serverName: 'gitlab.com' });
    expect(await service.ci.webUrl(gitlab(), { jobId: 9203 })).toEqual({ url: `${harness.stub.gitlab.webUrl}/alexios-s/damocles/-/jobs/9203`, serverName: 'gitlab.com' });
  });
});

describe('GitHub checks', () => {
  it('shows the checks of the branch\'s newest commit, grouped by workflow, and a running job\'s steps instead of its log', async () => {
    const pipeline = pipelineOf(await service.ci.watch('w-github', github(), false));
    service.ci.unwatch('w-github');
    expect(pipeline).toMatchObject({ kind: 'github', id: 0, number: 0, state: 'running', sha: CI_UI_FIXTURES.sha, jobsDone: 1, jobsTotal: 2, canRetry: false, canCancel: false });
    expect(pipeline.runs).toEqual([{ id: CI_UI_FIXTURES.githubRun.id, stage: 'CI', canRetry: false, canCancel: true }]);
    expect(pipeline.jobs.map((job) => [job.stage, job.name, job.runId, job.canCancel])).toEqual([['CI', 'unit', CI_UI_FIXTURES.githubRun.id, false], ['CI', 'e2e', CI_UI_FIXTURES.githubRun.id, false]]);
    const running = await service.ci.jobLog('log-gh-unit', github(), CI_UI_FIXTURES.githubJobs.unit);
    service.ci.unwatch('log-gh-unit');
    expect(running.status).toBe('githubRunning');
    if (running.status !== 'githubRunning') return;
    expect(running.job.steps?.map((step) => [step.name, step.state])).toEqual([['Set up job', 'passed'], ['Run npm ci', 'passed'], ['Run npm run test:unit', 'running'], ['Complete job', 'pending']]);
  });

  it('fails when the older of two workflows failed, groups its jobs, and lists other apps\' checks and statuses with no actions', async () => {
    const ui = harness.stub.github.ci;
    ui.githubOtherChecks = true;
    ui.finishUnit('failed');
    const pipeline = pipelineOf(await service.ci.watch('w-checks', github({ sha: CI_UI_FIXTURES.sha }), false));
    service.ci.unwatch('w-checks');
    expect(pipeline).toMatchObject({ state: 'failed', failedCount: 1, jobsTotal: 5 });
    // a fork's pull request run of CI at the same commit is not the repository's
    expect(pipeline.jobs.map((job) => [job.stage, job.name, job.kind, job.state])).toEqual([
      ['CI', 'unit', 'job', 'failed'],
      ['CI', 'e2e', 'job', 'passed'],
      ['Lint', 'eslint', 'job', 'passed'],
      ['', 'deploy/netlify', 'external', 'passed'],
      ['', 'ci/circleci: build', 'external', 'passed'],
    ]);
    expect(pipeline.runs).toEqual([
      { id: CI_UI_FIXTURES.githubRun.id, stage: 'CI', canRetry: true, canCancel: false },
      { id: 64_313, stage: 'Lint', canRetry: false, canCancel: false },
    ]);
    expect(pipeline.jobs.filter((job) => job.kind === 'external').every((job) => !job.hasLog && !job.canRetry && !job.canCancel && job.runId === undefined)).toBe(true);
    expect(pipeline.jobs.find((job) => job.name === 'unit')).toMatchObject({ canRetry: true });
    expect(await service.ci.commitStatus(github(), CI_UI_FIXTURES.sha, true)).toEqual({ status: 'ready', pipeline: { id: 0, number: 0, state: 'failed', serverName: 'github.com', kind: 'github' } });
    expect(await service.ci.webUrl(github(), { sha: CI_UI_FIXTURES.sha })).toEqual({ url: `${harness.stub.github.webUrl}/astefanopoulos/damocles/commit/${CI_UI_FIXTURES.sha}/checks`, serverName: 'github.com' });
  });

  it('names two runs of one workflow at the commit by their events', async () => {
    harness.stub.github.ci.githubPullRequestRun = true;
    const pipeline = pipelineOf(await service.ci.watch('w-events', github({ sha: CI_UI_FIXTURES.sha }), false));
    service.ci.unwatch('w-events');
    expect(pipeline.runs?.map((run) => run.stage)).toEqual(['CI (push)', 'CI (pull_request)']);
    expect(pipeline.jobs.map((job) => [job.stage, job.name])).toEqual([['CI (push)', 'unit'], ['CI (push)', 'e2e'], ['CI (pull_request)', 'unit']]);
  });

  it('reads every page of a commit\'s check runs, and says when it holds only the first ten pages', async () => {
    const ui = harness.stub.github.ci;
    ui.thirdPartyChecks = 150;
    const paged = pipelineOf(await service.ci.watch('w-gh-pages', github({ sha: CI_UI_FIXTURES.sha }), false));
    service.ci.unwatch('w-gh-pages');
    expect(paged.jobsTotal).toBe(152);
    expect(paged.truncated).toBeUndefined();
    ui.thirdPartyChecks = 1000;
    const cut = pipelineOf(await service.ci.watch('w-gh-cut', github({ sha: CI_UI_FIXTURES.sha }), false));
    service.ci.unwatch('w-gh-cut');
    expect(cut.jobsTotal).toBe(1000);
    expect(cut.truncated).toBe(true);
  });

  it('reruns a workflow run\'s failed jobs and cancels a run from its heading', async () => {
    const ui = harness.stub.github.ci;
    ui.finishUnit('failed');
    expect(await service.ci.jobAction(github(), { runId: CI_UI_FIXTURES.githubRun.id }, 'retry')).toEqual({ ok: true });
    expect(harness.stub.github.forgeWrites.at(-1)).toMatchObject({ path: `/repos/astefanopoulos/damocles/actions/runs/${CI_UI_FIXTURES.githubRun.id}/rerun-failed-jobs` });
    expect(await service.ci.jobAction(github(), { runId: CI_UI_FIXTURES.githubRun.id }, 'cancel')).toEqual({ ok: true });
    expect(harness.stub.github.forgeWrites.at(-1)).toMatchObject({ path: `/repos/astefanopoulos/damocles/actions/runs/${CI_UI_FIXTURES.githubRun.id}/cancel` });
    // the checks have no pipeline-wide action
    expect(await service.ci.jobAction(github(), { pipelineId: CI_UI_FIXTURES.githubRun.id }, 'retry')).toEqual({ ok: false });
  });

  it('answers a job\'s rerun with its new attempt once GitHub lists it, and a log watch of the old job follows it', async () => {
    const ui = harness.stub.github.ci;
    const { e2e } = CI_UI_FIXTURES.githubJobs;
    ui.githubAttemptsListed = false;
    expect(await service.ci.jobAction(github(), { jobId: e2e }, 'retry')).toEqual({ ok: true });
    ui.githubAttemptsListed = true;
    const followed = await service.ci.jobLog('log-gh-rerun', github(), e2e);
    service.ci.unwatch('log-gh-rerun');
    expect(followed).toMatchObject({ status: 'githubRunning', job: { id: 9410, state: 'pending', runId: CI_UI_FIXTURES.githubRun.id } });
    ui.reset();
    expect(await service.ci.jobAction(github(), { jobId: e2e }, 'retry')).toEqual({ ok: true, jobId: 9410 });
  });

  it('reads a finished job\'s log from the log storage on another origin, which never sees the token', async () => {
    const before = harness.stub.logStorage.requests.length;
    const log = ready(await service.ci.jobLog('log-gh-e2e', github(), CI_UI_FIXTURES.githubJobs.e2e));
    service.ci.unwatch('log-gh-e2e');
    expect(log).toMatchObject({ reset: true, live: false, kind: 'github' });
    expect(log.text).toContain('42 passed');
    expect(harness.stub.logStorage.requests.slice(before)).toEqual([{ path: `/_logs/${CI_UI_FIXTURES.githubJobs.e2e}.txt`, authorized: false }]);
    expect(new URL(harness.stub.logStorage.url).origin).not.toBe(new URL(harness.stub.github.webUrl).origin);
  });

  it('builds a job\'s page under its run', async () => {
    expect(await service.ci.webUrl(github(), { jobId: CI_UI_FIXTURES.githubJobs.e2e })).toEqual({ url: `${harness.stub.github.webUrl}/astefanopoulos/damocles/actions/runs/${CI_UI_FIXTURES.githubRun.id}/job/${CI_UI_FIXTURES.githubJobs.e2e}`, serverName: 'github.com' });
  });
});
