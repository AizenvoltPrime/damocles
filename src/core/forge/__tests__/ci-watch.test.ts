import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiJobView, CiPipelineView, CiState } from '../../../shared/forge/ci';
import type { CiAdapter, CiLogRead } from '../ci-adapter';
import { ciErrorText, createCiWatcher, LOG_BACKOFF_MAX_MS, LOG_POLL_MS, logDelta, STATUS_IDLE_MS, STATUS_RUNNING_MS, type CiChangedEvent, type CiRepo, type CiResolution, type CiWatcher } from '../ci-watch';
import { createKnownSecrets, type KnownSecrets } from '../known-secrets';
import type { RepoContext } from '../tools/api';
import { ForgeHttpError, type ForgeServer } from '../types';

// CI polling with fake timers (docs/invariants.md "GitHub and GitLab accounts", CI): the log every 3 s while its job runs and
// its tab shows, backing off while its reads fail, the status every 15 s while running and 60 s idle, nothing while hidden,
// blurred or off, nothing new on a 304, no read before a rate limit resets, and log text masked before it leaves core.

const REPO: CiRepo = { authorityKey: 'local', project: 'damocles', endpoints: [], branch: 'feature/forge-accounts', sha: 'a'.repeat(40) };
const SERVER = { id: 'gitlab.com', kind: 'gitlab', webUrl: 'https://gitlab.com' } as ForgeServer;

const job = (state: CiState, id = 9203): CiJobView => ({ id, name: 'unit', stage: 'test', state, kind: 'job', canRetry: false, canCancel: state === 'running', hasLog: true });

interface WorldState {
  pipeline: CiState;
  job: CiState;
  log: string;
  failure?: Error;
  logFailure?: Error;
  gate?: Promise<void>;
  // a log read takes its text, then waits for this
  logGate?: Promise<void>;
  // the server sends no ETag with a log
  noEtag?: boolean;
  // GitHub: the job's run runs, the newer attempt its run lists, and that attempt's state
  runActive?: boolean;
  newer?: number;
  newerState?: CiState;
}

function world(options: { readonly liveLogs?: boolean; readonly attempts?: boolean; readonly enabled?: () => boolean; readonly resolutions?: CiResolution[]; readonly secrets?: KnownSecrets } = {}) {
  const calls = { pipeline: 0, job: 0, log: 0, action: 0, attempts: 0 };
  const state: WorldState = { pipeline: 'running', job: 'running', log: 'line 1\n' };
  const logs: string[] = [];
  // the ETag caches the reads were given
  const caches = new Set<unknown>();
  let etag = 0;
  let served = '';
  const adapter: CiAdapter = {
    liveLogs: options.liveLogs ?? true,
    async pipeline(ctx, ref, serverName) {
      calls.pipeline++;
      caches.add(ctx.etags);
      if (state.gate) await state.gate;
      if (state.failure) throw state.failure;
      const pipeline: CiPipelineView = { serverId: SERVER.id, serverName, kind: 'gitlab', id: 54312, number: 4312, state: state.pipeline, ref: ref.branch, jobsDone: 0, jobsTotal: 1, failedCount: 0, canRetry: false, canCancel: true, jobs: [job(state.job)] };
      return pipeline;
    },
    async commitPipeline() {
      return null;
    },
    async job(_ctx, jobId) {
      calls.job++;
      const jobState = jobId === state.newer && state.newerState !== undefined ? state.newerState : state.job;
      return { job: job(jobState, jobId), pipeline: { id: 54312, number: 4312 }, ...(state.runActive !== undefined ? { runActive: state.runActive } : {}) };
    },
    async log(_ctx, _jobId, sent): Promise<CiLogRead> {
      calls.log++;
      if (state.failure) throw state.failure;
      if (state.logFailure) throw state.logFailure;
      if (sent !== undefined && served === state.log) return { notModified: true };
      served = state.log;
      etag++;
      const bytes = new TextEncoder().encode(state.log);
      if (state.logGate) await state.logGate;
      return { notModified: false, tail: { bytes, totalBytes: bytes.byteLength }, ...(state.noEtag ? {} : { etag: `W/"${etag}"` }) };
    },
    async action() {
      calls.action++;
      state.pipeline = 'canceled';
      return {};
    },
    webUrl: () => 'https://gitlab.com/grp/proj/-/pipelines/54312',
    ...(options.attempts
      ? {
          async attemptAfter() {
            calls.attempts++;
            return state.newer;
          },
        }
      : {}),
  };
  const events: CiChangedEvent[] = [];
  const resolution: CiResolution = {
    kind: 'target',
    target: {
      server: SERVER,
      repoPath: 'alexios-s/damocles',
      serverName: 'gitlab.com',
      accountId: 'gitlab.com|2001',
      adapter,
      // as the forge client does, an aborted request rejects at once
      run: (work, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
        work({ signal } as RepoContext).then(resolve, reject);
      }),
    },
  };
  const watcher: CiWatcher = createCiWatcher({
    resolve: async () => options.resolutions?.shift() ?? resolution,
    enabled: options.enabled ?? (() => true),
    emit: (event) => events.push(event),
    secrets: options.secrets ?? createKnownSecrets(),
    log: (line) => logs.push(line),
  });
  return { watcher, calls, state, events, logs, caches };
}

const logViews = (events: readonly CiChangedEvent[]) => events.flatMap((event) => ('log' in event ? [event.log] : []));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('status polling', () => {
  it('reads every 15 s while the pipeline runs and every 60 s once it is idle', async () => {
    const w = world();
    const first = await w.watcher.watch('s', REPO, true);
    // with the HEAD it was read for, which the views compare with the pipeline's commit
    expect(first).toMatchObject({ status: 'ready', pipeline: { number: 4312, state: 'running' }, head: REPO.sha });
    expect(w.calls.pipeline).toBe(1);
    await vi.advanceTimersByTimeAsync(STATUS_RUNNING_MS - 1);
    expect(w.calls.pipeline).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.calls.pipeline).toBe(2);
    w.state.pipeline = 'passed';
    w.state.job = 'passed';
    await vi.advanceTimersByTimeAsync(STATUS_RUNNING_MS);
    expect(w.calls.pipeline).toBe(3);
    expect(w.events.at(-1)).toMatchObject({ id: 's', status: { status: 'ready', pipeline: { state: 'passed' } } });
    await vi.advanceTimersByTimeAsync(STATUS_IDLE_MS - 1);
    expect(w.calls.pipeline).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.calls.pipeline).toBe(4);
    w.watcher.dispose();
  });

  it('reads once while hidden or blurred, nothing more until shown again, then when the next read is due', async () => {
    const w = world();
    await w.watcher.watch('s', REPO, false);
    expect(w.calls.pipeline).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * STATUS_IDLE_MS);
    expect(w.calls.pipeline).toBe(1);
    // shown, overdue: it reads at once
    await w.watcher.watch('s', undefined, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls.pipeline).toBe(2);
    // blurred mid-way: the due read does not go
    await vi.advanceTimersByTimeAsync(5_000);
    await w.watcher.watch('s', undefined, false);
    await vi.advanceTimersByTimeAsync(10 * STATUS_RUNNING_MS);
    expect(w.calls.pipeline).toBe(2);
    // focused again: the read goes when it falls due
    await w.watcher.watch('s', undefined, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls.pipeline).toBe(3);
    w.watcher.dispose();
  });

  it('emits only changes, and reads at once after an action', async () => {
    const w = world();
    await w.watcher.watch('s', REPO, true);
    const emitted = w.events.length;
    await vi.advanceTimersByTimeAsync(STATUS_RUNNING_MS);
    expect(w.calls.pipeline).toBe(2);
    expect(w.events.length).toBe(emitted);
    expect(await w.watcher.jobAction(REPO, { pipelineId: 54312 }, 'cancel')).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls.pipeline).toBe(3);
    expect(w.events.at(-1)).toMatchObject({ status: { pipeline: { state: 'canceled' } } });
    w.watcher.dispose();
  });

  it('backs off until a rate limit resets, and says why', async () => {
    const w = world();
    await w.watcher.watch('s', REPO, true);
    w.state.failure = new ForgeHttpError('rateLimited', 'limited', { status: 429, retryAt: Date.now() + STATUS_RUNNING_MS + 5 * 60_000 });
    await vi.advanceTimersByTimeAsync(STATUS_RUNNING_MS);
    expect(w.calls.pipeline).toBe(2);
    expect(w.events.at(-1)).toMatchObject({ status: { status: 'error', message: { message: '{0} is limiting requests. Damocles reads CI again once the limit resets.', args: ['gitlab.com'] } } });
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(w.calls.pipeline).toBe(2);
    delete w.state.failure;
    await vi.advanceTimersByTimeAsync(1);
    expect(w.calls.pipeline).toBe(3);
    expect(w.events.at(-1)).toMatchObject({ status: { status: 'ready' } });
    w.watcher.dispose();
  });

  it('waits out a retry time past what a timer can hold, without reading again at once', async () => {
    const w = world();
    await w.watcher.watch('s', REPO, true);
    w.state.failure = new ForgeHttpError('rateLimited', 'limited', { status: 403, retryAt: Date.now() + 1e14 });
    await vi.advanceTimersByTimeAsync(STATUS_RUNNING_MS);
    expect(w.calls.pipeline).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * STATUS_IDLE_MS);
    expect(w.calls.pipeline).toBe(2);
    w.watcher.dispose();
  });

  it('reads a changed repository at once while a read of the old one runs, and never answers with the old one\'s pipeline', async () => {
    const w = world();
    let release = (): void => undefined;
    w.state.gate = new Promise((resolve) => (release = resolve));
    const first = w.watcher.watch('s', REPO, true);
    await vi.advanceTimersByTimeAsync(0);
    const second = w.watcher.watch('s', { ...REPO, branch: 'other' }, true);
    delete w.state.gate;
    release();
    expect(await second).toMatchObject({ status: 'ready', pipeline: { ref: 'other' } });
    expect(await first).toMatchObject({ status: 'ready', pipeline: { ref: 'other' } });
    expect(w.calls.pipeline).toBe(2);
    expect(w.events.flatMap((event) => ('status' in event && event.status?.status === 'ready' ? [event.status.pipeline.ref] : []))).toEqual(['other']);
    // the dropped read's abort is no failure, and the ETags still answer the same URLs
    expect(w.logs).toEqual([]);
    expect(w.caches.size).toBe(1);
    // the next read is a full cadence after the new repository's read
    await vi.advanceTimersByTimeAsync(STATUS_RUNNING_MS - 1);
    expect(w.calls.pipeline).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.calls.pipeline).toBe(3);
    w.watcher.dispose();
  });

  it('answers a second definition of a watch from the first read still running, without reading twice', async () => {
    const w = world();
    let release = (): void => undefined;
    w.state.gate = new Promise((resolve) => (release = resolve));
    const first = w.watcher.watch('s', REPO, false);
    const second = w.watcher.watch('s', REPO, true);
    delete w.state.gate;
    release();
    expect(await first).toMatchObject({ status: 'ready' });
    expect(await second).toMatchObject({ status: 'ready' });
    expect(w.calls.pipeline).toBe(1);
    // shown by the second: the next read goes at the running cadence
    await vi.advanceTimersByTimeAsync(STATUS_RUNNING_MS);
    expect(w.calls.pipeline).toBe(2);
    w.watcher.dispose();
  });

  it('reads again after a refresh that came while a read ran, and leaves hidden watches until they show', async () => {
    const w = world();
    await w.watcher.watch('shown', REPO, true);
    await w.watcher.watch('hidden', { ...REPO, branch: 'hidden' }, false);
    expect(w.calls.pipeline).toBe(2);
    let release = (): void => undefined;
    w.state.gate = new Promise((resolve) => (release = resolve));
    void w.watcher.jobs('shown');
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls.pipeline).toBe(3);
    w.watcher.refresh();
    delete w.state.gate;
    release();
    await vi.advanceTimersByTimeAsync(0);
    // the read in flight resolved the old way and is followed by one more; the hidden watch is not read
    expect(w.calls.pipeline).toBe(4);
    await w.watcher.watch('hidden', undefined, true);
    expect(w.calls.pipeline).toBe(5);
    w.watcher.dispose();
  });

  it('shows why a repository could not be resolved, and resolves it again on the next read', async () => {
    const unreachable: CiResolution = { kind: 'error', message: { message: 'Could not reach {0}. Check the connection and try again.', args: ['gitlab.com'] } };
    const w = world({ resolutions: [unreachable] });
    expect(await w.watcher.watch('s', REPO, true)).toEqual({ status: 'error', message: unreachable.message });
    expect(w.calls.pipeline).toBe(0);
    await vi.advanceTimersByTimeAsync(STATUS_IDLE_MS);
    expect(w.calls.pipeline).toBe(1);
    expect(w.events.at(-1)).toMatchObject({ status: { status: 'ready', pipeline: { number: 4312 } } });
    w.watcher.dispose();
  });

  it('watches nothing and polls nothing with ciStatus off', async () => {
    const w = world({ enabled: () => false });
    expect(await w.watcher.watch('s', REPO, true)).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * STATUS_IDLE_MS);
    expect(w.calls.pipeline).toBe(0);
    expect(await w.watcher.commitStatus(REPO, 'a'.repeat(40), true)).toBeNull();
  });

  it('answers no chip for a detached HEAD or a branch name a query should not carry', async () => {
    const w = world();
    const { branch: _branch, ...detached } = REPO;
    expect(await w.watcher.watch('s', detached, true)).toEqual({ status: 'none' });
    expect(await w.watcher.watch('t', { ...REPO, branch: 'bad name' }, true)).toEqual({ status: 'none' });
    expect(w.calls.pipeline).toBe(0);
    w.watcher.dispose();
  });
});

describe('log polling', () => {
  it('reads the log every 3 s while the job runs and the tab shows; an unchanged log adds nothing; it stops when the job ends', async () => {
    const w = world();
    const first = await w.watcher.jobLog('l', REPO, 9203);
    expect(first).toMatchObject({ status: 'ready', reset: true, text: 'line 1\n', live: true });
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(w.calls.log).toBe(2);
    expect(w.events).toEqual([]);
    w.state.log = 'line 1\nline 2\n';
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(w.events).toEqual([{ id: 'l', log: expect.objectContaining({ status: 'ready', reset: false, text: 'line 2\n', live: true }) }]);
    // the tab is hidden
    await w.watcher.watch('l', undefined, false);
    await vi.advanceTimersByTimeAsync(10 * LOG_POLL_MS);
    expect(w.calls.log).toBe(3);
    await w.watcher.watch('l', undefined, true);
    w.state.job = 'passed';
    w.state.log = 'line 1\nline 2\nJob succeeded\n';
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(w.events.at(-1)).toEqual({ id: 'l', log: expect.objectContaining({ reset: false, text: 'Job succeeded\n', live: false, job: expect.objectContaining({ state: 'passed' }) }) });
    const reads = w.calls.log;
    await vi.advanceTimersByTimeAsync(10 * LOG_POLL_MS);
    expect(w.calls.log).toBe(reads);
    w.watcher.dispose();
  });

  it('sends a finished log only whole again when an action reads it once more', async () => {
    const w = world();
    w.state.job = 'failed';
    expect(await w.watcher.jobLog('l', REPO, 9203)).toMatchObject({ status: 'ready', reset: true, live: false });
    w.state.job = 'running';
    w.state.log = 'line 1\nretry\n';
    expect(await w.watcher.jobAction(REPO, { jobId: 9203 }, 'retry')).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.events.at(-1)).toEqual({ id: 'l', log: expect.objectContaining({ status: 'ready', reset: true, text: 'line 1\nretry\n', live: true }) });
    w.state.log = 'line 1\nretry\nmore\n';
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(w.events.at(-1)).toEqual({ id: 'l', log: expect.objectContaining({ reset: false, text: 'more\n' }) });
    w.watcher.dispose();
  });

  it('shows a running GitHub job\'s steps, and its log once it finishes', async () => {
    const w = world({ liveLogs: false });
    expect(await w.watcher.jobLog('l', REPO, 9203)).toMatchObject({ status: 'githubRunning', job: { state: 'running' }, serverName: 'gitlab.com' });
    expect(w.calls.log).toBe(0);
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(w.events).toEqual([]);
    w.state.job = 'passed';
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(w.events.at(-1)).toEqual({ id: 'l', log: expect.objectContaining({ status: 'ready', reset: true, text: 'line 1\n', live: false }) });
    w.watcher.dispose();
  });

  it('backs off a rate-limited log read and keeps the log', async () => {
    const w = world();
    await w.watcher.jobLog('l', REPO, 9203);
    w.state.failure = new ForgeHttpError('rateLimited', 'limited', { status: 403, retryAt: Date.now() + 60_000 });
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(w.events.at(-1)).toMatchObject({ log: { status: 'error', job: { id: 9203 } } });
    const reads = w.calls.log;
    await vi.advanceTimersByTimeAsync(60_000 - LOG_POLL_MS - 1);
    expect(w.calls.log).toBe(reads);
    delete w.state.failure;
    await vi.advanceTimersByTimeAsync(1);
    expect(w.calls.log).toBe(reads + 1);
    w.watcher.dispose();
  });

  it('waits twice as long after each failed read, at most a minute, and says the same failure once', async () => {
    const w = world();
    await w.watcher.jobLog('l', REPO, 9203);
    w.state.logFailure = new ForgeHttpError('server', 'down', { status: 502 });
    const readsAfter = async (ms: number): Promise<number> => {
      await vi.advanceTimersByTimeAsync(ms);
      return w.calls.log;
    };
    const start = w.calls.log;
    expect(await readsAfter(LOG_POLL_MS)).toBe(start + 1);
    // 6 s, 12 s, 24 s, 48 s, then a minute
    for (const [index, wait] of [2 * LOG_POLL_MS, 4 * LOG_POLL_MS, 8 * LOG_POLL_MS, 16 * LOG_POLL_MS, LOG_BACKOFF_MAX_MS, LOG_BACKOFF_MAX_MS].entries()) {
      expect(await readsAfter(wait - 1)).toBe(start + 1 + index);
      expect(await readsAfter(1)).toBe(start + 2 + index);
    }
    expect(logViews(w.events)).toEqual([expect.objectContaining({ status: 'error', message: expect.objectContaining({ message: '{0} could not answer (HTTP {1}).' }) })]);
    // a running job's log goes on being read
    delete w.state.logFailure;
    w.state.log = 'line 1\nline 2\n';
    await vi.advanceTimersByTimeAsync(LOG_BACKOFF_MAX_MS);
    expect(logViews(w.events).at(-1)).toMatchObject({ status: 'ready', reset: false, text: 'line 2\n' });
    const back = w.calls.log;
    expect(await readsAfter(LOG_POLL_MS)).toBe(back + 1);
    w.watcher.dispose();
  });

  it('reads a log watch at once when asked, and after a failed read sends the unchanged log, which ends the failure', async () => {
    const w = world();
    await w.watcher.jobLog('l', REPO, 9203);
    w.state.logFailure = new ForgeHttpError('server', 'down', { status: 502 });
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(logViews(w.events)).toEqual([expect.objectContaining({ status: 'error' })]);
    delete w.state.logFailure;
    const reads = w.calls.log;
    // Try again: a read now, before the backed-off one falls due
    expect(await w.watcher.jobs('l')).toBeNull();
    expect(w.calls.log).toBe(reads + 1);
    expect(logViews(w.events).at(-1)).toMatchObject({ status: 'ready', reset: false, text: '', live: true });
    // and from then on an unchanged log sends nothing
    const sent = w.events.length;
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(w.calls.log).toBe(reads + 2);
    expect(w.events).toHaveLength(sent);
    w.watcher.dispose();
  });

  it('stops reading a finished job\'s log the server keeps refusing after three reads, and a running job\'s never', async () => {
    const finished = world({ liveLogs: false });
    await finished.watcher.jobLog('l', REPO, 9203);
    finished.state.job = 'passed';
    finished.state.logFailure = new ForgeHttpError('notFound', 'gone', { status: 404 });
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS + 2 * LOG_POLL_MS + 4 * LOG_POLL_MS);
    expect(finished.calls.log).toBe(3);
    await vi.advanceTimersByTimeAsync(10 * LOG_BACKOFF_MAX_MS);
    expect(finished.calls.log).toBe(3);
    finished.watcher.dispose();

    const running = world();
    await running.watcher.jobLog('l', REPO, 9203);
    running.state.logFailure = new ForgeHttpError('notFound', 'gone', { status: 404 });
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS + 2 * LOG_POLL_MS + 4 * LOG_POLL_MS + 8 * LOG_POLL_MS);
    expect(running.calls.log).toBe(1 + 4);
    running.watcher.dispose();
  });

  it('sends nothing for an empty log the server serves without an ETag', async () => {
    const w = world();
    w.state.log = '';
    w.state.noEtag = true;
    expect(await w.watcher.jobLog('l', REPO, 9203)).toMatchObject({ status: 'ready', reset: true, text: '' });
    await vi.advanceTimersByTimeAsync(3 * LOG_POLL_MS);
    expect(w.calls.log).toBe(4);
    expect(w.events).toEqual([]);
    w.watcher.dispose();
  });

  it('answers that CI status is off and reads nothing while it is, then reads the whole log again once it is on', async () => {
    let enabled = false;
    const w = world({ enabled: () => enabled });
    expect(await w.watcher.jobLog('l', REPO, 9203)).toEqual({ status: 'error', message: { message: 'CI status is off in Settings.' } });
    expect(await w.watcher.jobAction(REPO, { jobId: 9203 }, 'retry')).toEqual({ ok: false });
    expect(await w.watcher.webUrl(REPO, { jobId: 9203 })).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * LOG_POLL_MS);
    expect(w.calls.job + w.calls.log + w.calls.action).toBe(0);
    enabled = true;
    w.watcher.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(logViews(w.events)).toEqual([expect.objectContaining({ status: 'ready', reset: true, text: 'line 1\n' })]);
    // off again: the tab says so once, and the timer reads nothing
    enabled = false;
    w.watcher.refresh();
    const reads = w.calls.log;
    await vi.advanceTimersByTimeAsync(10 * LOG_POLL_MS);
    expect(w.calls.log).toBe(reads);
    expect(logViews(w.events).slice(1)).toEqual([{ status: 'error', message: { message: 'CI status is off in Settings.' }, job: expect.objectContaining({ id: 9203 }) }]);
    w.watcher.dispose();
  });

  it('answers the first read with what an action read while it ran, and emits none of it', async () => {
    const w = world();
    let release = (): void => undefined;
    w.state.logGate = new Promise((resolve) => (release = resolve));
    const first = w.watcher.jobLog('l', REPO, 9203);
    await vi.advanceTimersByTimeAsync(0);
    expect(await w.watcher.jobAction(REPO, { jobId: 9203 }, 'retry')).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    w.state.log = 'line 1\nline 2\n';
    delete w.state.logGate;
    release();
    expect(await first).toMatchObject({ status: 'ready', reset: true, text: 'line 1\nline 2\n' });
    expect(w.calls.log).toBe(2);
    expect(w.events.filter((event) => 'log' in event)).toEqual([]);
    w.watcher.dispose();
  });

  it('follows a GitHub rerun to its newer attempt once the run lists it, reading meanwhile only while the run runs', async () => {
    const w = world({ liveLogs: false, attempts: true });
    w.state.job = 'failed';
    w.state.runActive = false;
    expect(await w.watcher.jobLog('l', REPO, 9203)).toMatchObject({ status: 'ready', live: false });
    // the rerun runs the run again; GitHub has not listed the new attempt yet
    w.state.runActive = true;
    expect(await w.watcher.jobAction(REPO, { jobId: 9203 }, 'retry')).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls.attempts).toBe(1);
    const logReads = w.calls.log;
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(w.calls.attempts).toBe(2);
    // the finished log the tab holds is not read again
    expect(w.calls.log).toBe(logReads);
    w.state.newer = 9310;
    w.state.newerState = 'pending';
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(logViews(w.events)).toEqual([expect.objectContaining({ status: 'githubRunning', job: expect.objectContaining({ id: 9310, state: 'pending' }) })]);
    w.state.newerState = 'passed';
    w.state.runActive = false;
    w.state.log = 'attempt 2\n';
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    expect(logViews(w.events).at(-1)).toMatchObject({ status: 'ready', reset: true, text: 'attempt 2\n', live: false, job: { id: 9310 } });
    w.watcher.dispose();
  });

  it('masks a known token in the log, one split between two reads included, holding back a tail until the job ends', async () => {
    const token = 'glpat-plantedSplitToken000001';
    const secrets = createKnownSecrets();
    secrets.setLive('gitlab.com|2001', [token]);
    const w = world({ secrets });
    w.state.log = `line 1\n$ export T=${token.slice(0, 12)}`;
    const first = await w.watcher.jobLog('l', REPO, 9203);
    if (first.status !== 'ready') throw new Error('expected a ready log');
    w.state.log = `line 1\n$ export T=${token}\nmore\n`;
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    w.state.job = 'passed';
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    const pieces = [first.text, ...logViews(w.events).map((view) => (view.status === 'ready' ? view.text : ''))];
    expect(pieces.join('')).toBe('line 1\n$ export T=***\nmore\n');
    expect(pieces.some((piece) => piece.includes('glpat-') || piece.includes('Split'))).toBe(false);
    w.watcher.dispose();
  });
});

describe('logDelta', () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  const fresh = () => ({ read: false, sentBytes: 0, anchor: new Uint8Array(0), decoder: new TextDecoder(), truncated: false });

  it('continues an empty log with nothing rather than starting it again', () => {
    const state = fresh();
    expect(logDelta(state, { bytes: new Uint8Array(0), totalBytes: 0 })).toEqual({ text: '', reset: true, truncated: false });
    expect(logDelta(state, { bytes: new Uint8Array(0), totalBytes: 0 })).toEqual({ text: '', reset: false, truncated: false });
  });

  it('appends what a read adds, decoding a character split between reads whole', () => {
    const state = fresh();
    const text = 'αβ\n✓ ok\n';
    const bytes = encode(text);
    // the first read ends inside the 3-byte ✓
    expect(logDelta(state, { bytes: bytes.subarray(0, 6), totalBytes: 6 })).toEqual({ text: 'αβ\n', reset: true, truncated: false });
    expect(logDelta(state, { bytes, totalBytes: bytes.byteLength })).toEqual({ text: '✓ ok\n', reset: false, truncated: false });
  });

  it('sends the whole tail again when the log no longer continues what was sent', () => {
    const state = fresh();
    logDelta(state, { bytes: encode('one\ntwo\n'), totalBytes: 8 });
    expect(logDelta(state, { bytes: encode('ONE\ntwo\nthree\n'), totalBytes: 14 })).toEqual({ text: 'ONE\ntwo\nthree\n', reset: true, truncated: false });
  });

  it('keeps the tail of a log longer than the bound, starting at a whole character, and marks it truncated', () => {
    const state = fresh();
    const tail = encode('✓ tail\n').subarray(1);
    expect(logDelta(state, { bytes: tail, totalBytes: 20_000_000 })).toEqual({ text: ' tail\n', reset: true, truncated: true });
    // the bounded window moves on: its front drops, the bytes last sent stay inside it
    const window = encode('a'.repeat(100));
    expect(logDelta(state, { bytes: window, totalBytes: 30_000_000 }).reset).toBe(true);
    const moved = new Uint8Array([...window.subarray(5), ...encode('next\n')]);
    expect(logDelta(state, { bytes: moved, totalBytes: 30_000_005 })).toEqual({ text: 'next\n', reset: false, truncated: true });
  });
});

describe('ciErrorText', () => {
  it('names the host that failed when it is not the server, such as the log storage a log read was redirected to', () => {
    const unreachable = 'Could not reach {0}. Check the connection and try again.';
    expect(ciErrorText(new ForgeHttpError('network', 'down', { foreignHost: 'results.blob.example.net' }), 'github.com')).toEqual({ message: unreachable, args: ['results.blob.example.net'] });
    expect(ciErrorText(new ForgeHttpError('network', 'down'), 'github.com')).toEqual({ message: unreachable, args: ['github.com'] });
    expect(ciErrorText(new ForgeHttpError('tls', 'refused', { foreignHost: 'results.blob.example.net' }), 'github.com')).toEqual({ message: '{0} presented a certificate this computer does not trust.', args: ['results.blob.example.net'] });
  });

  it('calls a foreign host the SSRF guard refused a private address', () => {
    expect(ciErrorText(new ForgeHttpError('network', 'refused', { foreignHost: 'minio.corp.example:9000', privateAddress: true }), 'ghes.corp.example')).toEqual({ message: '{0} is a private address, which Damocles reaches only as a Git hosting server\'s own address.', args: ['minio.corp.example:9000'] });
  });

  it('names a foreign host for its error statuses and broken answers, never blaming the account', () => {
    const storage = { foreignHost: 'results.blob.example.net' };
    expect(ciErrorText(new ForgeHttpError('notFound', 'gone', { status: 404, ...storage }), 'github.com')).toEqual({ message: '{0} could not answer (HTTP {1}).', args: ['results.blob.example.net', 404] });
    expect(ciErrorText(new ForgeHttpError('forbidden', 'expired', { status: 403, ...storage }), 'github.com')).toEqual({ message: '{0} could not answer (HTTP {1}).', args: ['results.blob.example.net', 403] });
    expect(ciErrorText(new ForgeHttpError('unauthorized', 'no', { status: 401, ...storage }), 'github.com')).toEqual({ message: '{0} could not answer (HTTP {1}).', args: ['results.blob.example.net', 401] });
    expect(ciErrorText(new ForgeHttpError('rateLimited', 'slow', { status: 429, ...storage }), 'github.com')).toEqual({ message: '{0} is limiting requests. Damocles reads CI again once the limit resets.', args: ['results.blob.example.net'] });
    expect(ciErrorText(new ForgeHttpError('notFound', 'gone', { status: 404 }), 'github.com')).toEqual({ message: '{0} has no such pipeline or job, or the account cannot see it.', args: ['github.com'] });
  });
});
