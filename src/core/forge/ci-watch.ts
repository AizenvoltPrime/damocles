import type { RemoteEndpoint } from '../../shared/forge/bindings';
import type { CiAction, CiStatusViewOf, CiTarget, CommitStatusViewOf, JobLogViewOf } from '../../shared/forge/ci';
import type { LocalizedText } from '../../shared/localized-text';
import { l } from '../l10n';
import { EtagCache, isActive, type CiAdapter, type CiContext, type CiJobDetail } from './ci-adapter';
import type { ForgeTail } from './http';
import type { KnownSecrets } from './known-secrets';
import { checkedBranch, type RepoContext } from './tools/api';
import { ForgeHttpError, type ForgeServer } from './types';

// CI watching for the chip, the job list and the job log tab (docs/invariants.md "GitHub and GitLab accounts", CI). Core owns
// the timers, ETags and backoff; main says when a watch is shown (Source Control visible, window focused, tab shown). All
// state is memory only.

/** A running job's log is read this often while its tab is shown. */
export const LOG_POLL_MS = 3_000;
/** A failing log read waits LOG_POLL_MS doubled per failure in a row, at most this long. */
export const LOG_BACKOFF_MAX_MS = 60_000;
/** A finished job whose log the server refuses or lacks this many reads in a row is read no more. */
export const LOG_GONE_FAILURES = 3;
/** A pipeline's status is read this often while it runs, and while it does not. */
export const STATUS_RUNNING_MS = 15_000;
export const STATUS_IDLE_MS = 60_000;
/** A rate-limited answer that names no reset waits this long. */
export const RATE_LIMIT_FALLBACK_MS = 60_000;
const COMMIT_STATUS_TTL_MS = 60_000;
const MAX_COMMIT_STATUSES = 200;
// Node fires a setTimeout delay above this after 1 ms
const MAX_TIMER_MS = 2 ** 31 - 1;
// bytes before the last read's end that the next read must repeat for its new bytes to be appended
const ANCHOR_BYTES = 64;

export interface CiRepo {
  readonly projectKey?: string;
  readonly authorityKey: string;
  readonly project: string;
  readonly pushRemote?: string;
  readonly endpoints: readonly RemoteEndpoint[];
  /** The checked-out branch; none for a detached HEAD. */
  readonly branch?: string;
  /** HEAD's commit. */
  readonly sha?: string;
}

/** The repository's server, path and account, with a live token for each request. */
export interface CiResolvedTarget {
  readonly server: ForgeServer;
  readonly repoPath: string;
  readonly serverName: string;
  /** The account whose token run uses. */
  readonly accountId: string;
  readonly adapter: CiAdapter;
  run<T>(work: (ctx: RepoContext) => Promise<T>, signal: AbortSignal): Promise<T>;
}

/** none: no remote on a known server, no account, or the project uses Git's own credentials there: no chip. */
export type CiResolution = { readonly kind: 'target'; readonly target: CiResolvedTarget } | { readonly kind: 'none' } | { readonly kind: 'error'; readonly message: LocalizedText };

export type CiStatus = CiStatusViewOf<LocalizedText>;
export type CiLog = JobLogViewOf<LocalizedText>;
export type CiCommitStatus = CommitStatusViewOf<LocalizedText>;

export type CiChangedEvent = { readonly id: string; readonly status: CiStatus | null } | { readonly id: string; readonly log: CiLog };

export interface CiWatchDeps {
  readonly resolve: (repo: CiRepo, signal: AbortSignal) => Promise<CiResolution>;
  /** damocles.desktop.forge.ciStatus: off means no chip, no log and no polling. */
  readonly enabled: () => boolean;
  readonly emit: (event: CiChangedEvent) => void;
  /** Masks log text before it leaves core. */
  readonly secrets: Pick<KnownSecrets, 'maskStreamed'>;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export interface CiWatcher {
  /** Defines or updates a status watch with repo; without repo, only shows or hides an existing status or log watch. */
  watch(id: string, repo: CiRepo | undefined, active: boolean): Promise<CiStatus | null>;
  unwatch(id: string): void;
  /** The watch read now (the job list opened, Try again); a log watch's read goes to its tab as its polls do, and this answers null. */
  jobs(id: string): Promise<CiStatus | null>;
  /** Starts (or restarts, for another job) log watch id, shown, and answers its whole log so far. */
  jobLog(id: string, repo: CiRepo, jobId: number): Promise<CiLog>;
  /** retry may answer the job that replaced jobId. */
  jobAction(repo: CiRepo, target: CiTarget, action: CiAction): Promise<{ readonly ok: boolean; readonly jobId?: number }>;
  commitStatus(repo: CiRepo, sha: string, retry: boolean): Promise<CiCommitStatus | null>;
  /** The server's page for the target; null when the repository has no target or CI status is off. */
  webUrl(repo: CiRepo, target: CiTarget): Promise<{ readonly url: string; readonly serverName: string } | null>;
  /** Accounts, bindings or the setting changed: every watch resolves and reads again. */
  refresh(): void;
  dispose(): void;
}

interface Watch {
  readonly id: string;
  repo: CiRepo;
  active: boolean;
  gen: number;
  abort: AbortController;
  resolution: Promise<CiResolution> | undefined;
  readonly etags: EtagCache;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastPoll: number | undefined;
  retryAt: number | undefined;
  running: Promise<void> | undefined;
  // a read was asked while one ran: another goes once it settles
  again: boolean;
}

interface StatusWatch extends Watch {
  readonly kind: 'status';
  view: CiStatus | null | undefined;
}

type ReadyLog = Extract<CiLog, { status: 'ready' }>;

/** What jobLog's first read and the reads it ran into produced, answered as one view instead of emitted. */
interface Collected {
  ready?: ReadyLog;
  last?: CiLog;
}

/** A log watch's read position, which a reset view starts again. */
interface LogPosition {
  logEtag: string | undefined;
  // a read has set the position, so the next one may append to it
  read: boolean;
  sentBytes: number;
  anchor: Uint8Array;
  decoder: InstanceType<typeof TextDecoder>;
  truncated: boolean;
  // decoded text held back until the next read or the job's end, so a secret split between reads is masked whole
  held: string;
}

interface LogWatch extends Watch, LogPosition {
  readonly kind: 'log';
  // a rerun's newer attempt replaces it
  jobId: number;
  detail: CiJobDetail | undefined;
  // a read of the job has succeeded since the watch started or followed a rerun
  started: boolean;
  finished: boolean;
  // the last ready view said live: false, after which the tab takes only a whole log (reset)
  ended: boolean;
  // failed reads in a row, which lengthen the wait before the next
  failures: number;
  // the last error view's message, which is not sent again
  errorText: string | undefined;
  // CI status is off: the watch answered so and reads nothing
  off: boolean;
  collected: Collected | undefined;
}

/** What a failed read tells the user; rateLimited's retryAt drives the backoff. */
export function ciErrorText(err: unknown, serverName: string): LocalizedText {
  if (err instanceof ForgeHttpError) {
    const host = err.foreignHost ?? serverName;
    switch (err.kind) {
      case 'rateLimited': return l('{0} is limiting requests. Damocles reads CI again once the limit resets.', host);
      case 'network': return err.privateAddress
        ? l('{0} is a private address, which Damocles reaches only as a Git hosting server\'s own address.', host)
        : l('Could not reach {0}. Check the connection and try again.', host);
      case 'tls': return l('{0} presented a certificate this computer does not trust.', host);
      default: break;
    }
    // a host that is not the server's gets no credential, so its refusals say nothing about the account
    if (err.foreignHost === undefined) {
      switch (err.kind) {
        case 'unauthorized': return l('{0} refused the account\'s sign-in. Sign in again in Settings › Models & accounts › Git hosting.', serverName);
        case 'notFound': return l('{0} has no such pipeline or job, or the account cannot see it.', serverName);
        case 'forbidden':
        case 'ssoRequired':
        case 'appNotApproved':
          return l('{0} refused the request: the account lacks the permission it needs.', serverName);
        default: break;
      }
    }
    return err.status !== undefined ? l('{0} could not answer (HTTP {1}).', host, err.status) : l('{0} could not answer.', host);
  }
  return l('{0} could not answer.', serverName);
}

const CI_OFF = (): LocalizedText => l('CI status is off in Settings.');

/** A log the server lacks or refuses, or has removed (410): lasting when it keeps answering so for a finished job. */
const isGone = (err: unknown): boolean => err instanceof ForgeHttpError && (err.kind === 'notFound' || err.kind === 'forbidden' || err.status === 410);

const sameRepo = (a: CiRepo, b: CiRepo): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The text a log read adds to what the tab holds: an append when the read repeats the last read's final bytes, else the whole
 * tail again (reset). Bytes are decoded by one streaming decoder per log, so a character split between reads decodes whole.
 */
export function logDelta(state: Pick<LogPosition, 'read' | 'sentBytes' | 'anchor' | 'decoder' | 'truncated'>, tail: ForgeTail): { readonly text: string; readonly reset: boolean; readonly truncated: boolean } {
  const total = tail.totalBytes;
  const start = total - tail.bytes.byteLength;
  const anchorAt = state.sentBytes - state.anchor.byteLength - start;
  const continues = state.read && total >= state.sentBytes && anchorAt >= 0 && state.anchor.every((byte, at) => tail.bytes[anchorAt + at] === byte);
  let text: string;
  if (continues) {
    text = state.decoder.decode(tail.bytes.subarray(state.sentBytes - start), { stream: true });
  } else {
    state.decoder = new TextDecoder();
    let skip = 0;
    // a tail that starts inside a UTF-8 sequence starts at the next character
    while (start > 0 && skip < 3 && skip < tail.bytes.byteLength && (tail.bytes[skip]! & 0xc0) === 0x80) skip++;
    text = state.decoder.decode(tail.bytes.subarray(skip), { stream: true });
    state.truncated = start > 0;
  }
  state.read = true;
  state.sentBytes = total;
  state.anchor = tail.bytes.slice(Math.max(0, tail.bytes.byteLength - ANCHOR_BYTES));
  return { text, reset: !continues, truncated: state.truncated };
}

const freshPosition = (): LogPosition => ({ logEtag: undefined, read: false, sentBytes: 0, anchor: new Uint8Array(0), decoder: new TextDecoder(), truncated: false, held: '' });

/** Adds a view a read produced to what jobLog answers: appends join the ready text before them. */
function collect(collected: Collected, view: CiLog): void {
  if (view.status === 'ready') collected.ready = collected.ready && !view.reset ? { ...view, reset: collected.ready.reset, text: collected.ready.text + view.text } : view;
  collected.last = view;
}

export function createCiWatcher(deps: CiWatchDeps): CiWatcher {
  const now = deps.now ?? Date.now;
  const watches = new Map<string, StatusWatch | LogWatch>();
  const commitStatuses = new Map<string, { readonly at: number; readonly view: CiCommitStatus }>();
  let disposed = false;

  function resolveOf(watch: Watch): Promise<CiResolution> {
    if (!watch.resolution) {
      const held = deps.resolve(watch.repo, watch.abort.signal);
      watch.resolution = held;
      // a failed or undecided resolution is not kept: the next read resolves again
      const forget = (): void => {
        if (watch.resolution === held) watch.resolution = undefined;
      };
      held.then((resolution) => {
        if (resolution.kind === 'error') forget();
      }, forget);
    }
    return watch.resolution;
  }

  function ctxOf(watch: Watch, ctx: RepoContext): CiContext {
    return { ...ctx, etags: watch.etags };
  }

  function clearTimer(watch: Watch): void {
    if (watch.timer !== undefined) clearTimeout(watch.timer);
    watch.timer = undefined;
  }

  function cadence(watch: StatusWatch | LogWatch): number | undefined {
    if (watch.kind === 'log') return watch.finished ? undefined : Math.min(LOG_POLL_MS * 2 ** watch.failures, LOG_BACKOFF_MAX_MS);
    const view = watch.view;
    if (view?.status === 'ready' && (isActive(view.pipeline.state) || view.pipeline.jobs.some((job) => isActive(job.state)))) return STATUS_RUNNING_MS;
    return view === null ? undefined : STATUS_IDLE_MS;
  }

  function schedule(watch: StatusWatch | LogWatch): void {
    clearTimer(watch);
    if (disposed || !watch.active || !deps.enabled() || watches.get(watch.id) !== watch) return;
    const every = cadence(watch);
    if (every === undefined) return;
    // a watch with no read for its current repository and resolution reads at once
    let due = watch.lastPoll === undefined ? now() : watch.lastPoll + every;
    if (watch.retryAt !== undefined && watch.retryAt > due) due = watch.retryAt;
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      void tick(watch);
    }, Math.min(Math.max(0, due - now()), MAX_TIMER_MS));
  }

  /** A log view to the tab, or to jobLog's answer while its first read runs. */
  function deliver(watch: LogWatch, view: CiLog): void {
    if (watch.collected) collect(watch.collected, view);
    else deps.emit({ id: watch.id, log: view });
  }

  /**
   * One read of the watch. A read asked while one runs goes again once it settles, and so does one whose repository or
   * resolution changed meanwhile, since its answer was dropped; the promise settles after that read too.
   */
  function tick(watch: StatusWatch | LogWatch): Promise<void> {
    if (watch.running) {
      watch.again = true;
      return watch.running;
    }
    const gen = watch.gen;
    const signal = watch.abort.signal;
    const run = (watch.kind === 'status' ? pollStatus(watch) : pollLog(watch).then((view) => {
      if (view && watches.get(watch.id) === watch) deliver(watch, view);
    })).catch((err: unknown) => {
      // a read a repository change, unwatch or dispose dropped ends with its abort, which is no failure
      if (signal.aborted) return;
      deps.log(`[forge] reading CI for ${watch.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    const running = run.finally(() => {
      watch.running = undefined;
      const again = watch.again || gen !== watch.gen;
      watch.again = false;
      if (again && !disposed && watches.get(watch.id) === watch) return tick(watch);
      schedule(watch);
      return undefined;
    });
    watch.running = running;
    return running;
  }

  function noteFailure(watch: Watch, err: unknown): void {
    watch.retryAt = err instanceof ForgeHttpError && err.kind === 'rateLimited' ? err.retryAt ?? now() + RATE_LIMIT_FALLBACK_MS : undefined;
  }

  async function pollStatus(watch: StatusWatch): Promise<void> {
    const gen = watch.gen;
    const view = await readStatus(watch);
    if (gen !== watch.gen || watches.get(watch.id) !== watch) return;
    watch.lastPoll = now();
    const changed = JSON.stringify(view) !== JSON.stringify(watch.view);
    watch.view = view;
    if (changed) deps.emit({ id: watch.id, status: view });
  }

  async function readStatus(watch: StatusWatch): Promise<CiStatus | null> {
    if (!deps.enabled()) return null;
    const signal = watch.abort.signal;
    const resolution = await resolveOf(watch);
    if (resolution.kind === 'none') return null;
    if (resolution.kind === 'error') return { status: 'error', message: resolution.message };
    const { target } = resolution;
    // a branch name git accepts but a query should not carry shows no chip
    const branch = watch.repo.branch !== undefined ? checkedBranch(watch.repo.branch) : undefined;
    if (branch === undefined) return { status: 'none' };
    try {
      const sha = watch.repo.sha;
      const pipeline = await target.run((ctx) => target.adapter.pipeline(ctxOf(watch, ctx), { branch, ...(sha !== undefined ? { sha } : {}) }, target.serverName), signal);
      watch.retryAt = undefined;
      return pipeline ? { status: 'ready', pipeline, ...(sha !== undefined ? { head: sha } : {}) } : { status: 'none' };
    } catch (err) {
      if (signal.aborted) throw err;
      noteFailure(watch, err);
      deps.log(`[forge] CI status of ${target.server.id} failed: ${err instanceof ForgeHttpError ? err.kind : err instanceof Error ? err.name : typeof err}`);
      return { status: 'error', message: ciErrorText(err, target.serverName) };
    }
  }

  /** An error view of the log, or undefined when the last one said the same. */
  function logError(watch: LogWatch, message: LocalizedText, serverName: string | undefined): CiLog | undefined {
    const text = JSON.stringify(message);
    if (text === watch.errorText) return undefined;
    watch.errorText = text;
    return { status: 'error', message, ...(watch.detail ? { job: watch.detail.job } : {}), ...(serverName !== undefined ? { serverName } : {}) };
  }

  function offView(watch: LogWatch): CiLog | undefined {
    watch.off = true;
    return logError(watch, CI_OFF(), undefined);
  }

  /** The log's text from the last held characters on, masked, keeping back what may start a secret unless the job ended. */
  function masked(watch: LogWatch, text: string, reset: boolean, final: boolean): string {
    if (reset) watch.held = '';
    const out = deps.secrets.maskStreamed(watch.held + text, final);
    watch.held = out.held;
    return out.text;
  }

  /** The watch reads jobId, a newer attempt of its job, from its start. */
  function follow(watch: LogWatch, jobId: number): void {
    Object.assign(watch, freshPosition());
    watch.jobId = jobId;
    watch.detail = undefined;
    watch.started = false;
    watch.ended = false;
    watch.errorText = undefined;
  }

  /** One read of a log watch; undefined when nothing changed. */
  async function pollLog(watch: LogWatch): Promise<CiLog | undefined> {
    if (!deps.enabled()) return offView(watch);
    if (watch.off) {
      // the tab said CI status is off, so the log comes whole again
      Object.assign(watch, freshPosition());
      watch.off = false;
      watch.ended = false;
      watch.errorText = undefined;
    }
    const gen = watch.gen;
    const signal = watch.abort.signal;
    const resolution = await resolveOf(watch);
    if (gen !== watch.gen) return undefined;
    if (resolution.kind !== 'target') {
      watch.finished = true;
      return logError(watch, resolution.kind === 'error' ? resolution.message : l('Damocles has no account that can read this log.'), undefined);
    }
    const { target } = resolution;
    const { adapter, serverName } = target;
    const readJob = (): Promise<CiJobDetail> => target.run((ctx) => adapter.job(ctxOf(watch, ctx), watch.jobId), signal);
    try {
      let detail = await readJob();
      if (gen !== watch.gen) return undefined;
      // a finished job whose run runs again may have been rerun as a newer attempt, which the tab follows
      if (adapter.attemptAfter && detail.runActive === true && !isActive(detail.job.state)) {
        const known = detail;
        const newer = await target.run((ctx) => adapter.attemptAfter!(ctxOf(watch, ctx), known), signal);
        if (gen !== watch.gen) return undefined;
        if (newer !== undefined && newer !== watch.jobId) {
          follow(watch, newer);
          detail = await readJob();
          if (gen !== watch.gen) return undefined;
        }
      }
      const live = isActive(detail.job.state);
      const before = watch.detail;
      const sameJob = JSON.stringify(before?.job) === JSON.stringify(detail.job);
      // the job's run still runs: it may yet be rerun, so the watch keeps reading
      const awaitsRerun = adapter.attemptAfter !== undefined && detail.runActive === true;
      // the tab shows the last error until a view replaces it, so a read after one sends a view even when nothing changed
      const afterError = watch.errorText !== undefined;
      watch.detail = detail;
      watch.started = true;
      watch.lastPoll = now();
      const succeeded = (): void => {
        watch.retryAt = undefined;
        watch.failures = 0;
        watch.errorText = undefined;
      };
      if (!adapter.liveLogs && live) {
        succeeded();
        watch.finished = false;
        return !afterError && JSON.stringify(before) === JSON.stringify(detail) ? undefined : { status: 'githubRunning', job: detail.job, serverName };
      }
      // a finished log the tab holds whole is not read again
      if (watch.ended && !live && sameJob) {
        succeeded();
        watch.finished = !awaitsRerun;
        return afterError ? { status: 'ready', job: detail.job, pipeline: detail.pipeline, serverName, kind: target.server.kind, live, reset: false, text: '', truncated: watch.truncated } : undefined;
      }
      if (watch.ended) Object.assign(watch, freshPosition());
      const read = await target.run((ctx) => adapter.log(ctxOf(watch, ctx), watch.jobId, watch.logEtag), signal);
      if (gen !== watch.gen) return undefined;
      succeeded();
      watch.finished = !live && !awaitsRerun;
      watch.ended = !live;
      const base = { status: 'ready' as const, job: detail.job, pipeline: detail.pipeline, serverName, kind: target.server.kind, live };
      if (read.notModified) {
        // nothing new, but the job's end lets out what was held back
        const text = masked(watch, '', false, !live);
        return text === '' && sameJob && !afterError ? undefined : { ...base, reset: false, text, truncated: watch.truncated };
      }
      if (read.etag !== undefined) watch.logEtag = read.etag;
      const delta = logDelta(watch, read.tail);
      const text = masked(watch, delta.text, delta.reset, !live);
      if (!delta.reset && text === '' && sameJob && !afterError) return undefined;
      return { ...base, reset: delta.reset, text, truncated: delta.truncated };
    } catch (err) {
      if (signal.aborted) throw err;
      noteFailure(watch, err);
      watch.lastPoll = now();
      watch.failures++;
      deps.log(`[forge] reading job ${watch.jobId} on ${target.server.id} failed: ${err instanceof ForgeHttpError ? err.kind : err instanceof Error ? err.name : typeof err}`);
      // a failed first read ends the watch, and so does a finished job's log the server keeps refusing or lacking; any other
      // failure keeps the log and backs off
      const job = watch.detail?.job;
      if (!watch.started || (job !== undefined && !isActive(job.state) && isGone(err) && watch.failures >= LOG_GONE_FAILURES)) watch.finished = true;
      return logError(watch, ciErrorText(err, serverName), serverName);
    }
  }

  function newWatch(id: string, repo: CiRepo, active: boolean): Watch {
    return { id, repo, active, gen: 0, abort: new AbortController(), etags: new EtagCache(), resolution: undefined, timer: undefined, lastPoll: undefined, retryAt: undefined, running: undefined, again: false };
  }

  function drop(watch: Watch): void {
    clearTimer(watch);
    watch.gen++;
    watch.abort.abort();
  }

  function unwatch(id: string): void {
    const watch = watches.get(id);
    if (!watch) return;
    watches.delete(id);
    drop(watch);
  }

  function keyOf(target: CiResolvedTarget): string {
    return `${target.server.id}|${target.repoPath}`;
  }

  /** Reads again, now, every watch on the repository of target: an action changed what they show. */
  async function refreshRepository(target: CiResolvedTarget, jobId?: number): Promise<void> {
    const key = keyOf(target);
    const affected: (StatusWatch | LogWatch)[] = [];
    for (const watch of watches.values()) {
      const resolution = watch.resolution ? await watch.resolution.catch(() => undefined) : undefined;
      if (resolution?.kind !== 'target' || keyOf(resolution.target) !== key) continue;
      if (watch.kind === 'status' || jobId === undefined || watch.jobId === jobId) affected.push(watch);
    }
    for (const watch of affected) {
      if (watch.kind === 'log') watch.finished = false;
      clearTimer(watch);
      void tick(watch);
    }
  }

  return {
    async watch(id, repo, active) {
      let watch = watches.get(id);
      if (repo === undefined) {
        if (!watch) return null;
      } else if (!watch || watch.kind !== 'status') {
        if (watch) unwatch(id);
        watch = { ...newWatch(id, repo, active), kind: 'status', view: undefined };
        watches.set(id, watch);
      } else if (!sameRepo(watch.repo, repo)) {
        drop(watch);
        watch.abort = new AbortController();
        watch.repo = repo;
        watch.resolution = undefined;
        watch.lastPoll = undefined;
        // the previous repository's view is no answer for this one; its ETags still answer the same URLs
        watch.view = undefined;
      }
      const wasActive = watch.active;
      watch.active = active;
      if (!active) clearTimer(watch);
      if (watch.kind === 'log') {
        if (active && !wasActive) schedule(watch);
        return null;
      }
      // the first read goes whether shown or not, so the chip has a state; the next ones only while shown. A first read
      // already running answers this call too.
      if (watch.lastPoll === undefined) await (watch.running ?? tick(watch));
      else if (active && !wasActive && !watch.running) schedule(watch);
      return watch.view === undefined ? { status: 'loading' } : watch.view;
    },

    unwatch,

    async jobs(id) {
      const watch = watches.get(id);
      if (!watch) return null;
      clearTimer(watch);
      await tick(watch);
      if (watch.kind === 'log') return null;
      return watch.view === undefined ? { status: 'loading' } : watch.view;
    },

    async jobLog(id, repo, jobId) {
      unwatch(id);
      const watch: LogWatch = {
        ...newWatch(id, repo, true),
        ...freshPosition(),
        kind: 'log',
        jobId,
        detail: undefined,
        started: false,
        finished: false,
        ended: false,
        failures: 0,
        errorText: undefined,
        off: false,
        collected: undefined,
      };
      watches.set(id, watch);
      // kept while off, so refresh reads it once CI status is on again
      if (!deps.enabled()) return offView(watch)!;
      const collected: Collected = {};
      watch.collected = collected;
      await tick(watch);
      watch.collected = undefined;
      const answer = collected.last?.status === 'ready' ? collected.ready : collected.last;
      // the tab holds only this answer, so after a ready view the next one sends the whole log again
      if (answer?.status !== 'ready' && collected.ready) Object.assign(watch, freshPosition());
      return answer ?? { status: 'loading' };
    },

    async jobAction(repo, target, action) {
      if (!deps.enabled()) return { ok: false };
      const abort = new AbortController();
      const resolution = await deps.resolve(repo, abort.signal);
      if (resolution.kind !== 'target') return { ok: false };
      const { target: resolved } = resolution;
      try {
        const answer = await resolved.run((ctx) => resolved.adapter.action({ ...ctx, etags: new EtagCache() }, target, action), abort.signal);
        void refreshRepository(resolved, 'jobId' in target ? target.jobId : undefined);
        return { ok: true, ...(answer.jobId !== undefined ? { jobId: answer.jobId } : {}) };
      } catch (err) {
        deps.log(`[forge] CI ${action} on ${resolved.server.id} failed: ${err instanceof ForgeHttpError ? err.kind : err instanceof Error ? err.name : typeof err}`);
        return { ok: false };
      }
    },

    async commitStatus(repo, sha, retry) {
      if (!deps.enabled() || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) return null;
      const abort = new AbortController();
      const resolution = await deps.resolve(repo, abort.signal);
      if (resolution.kind === 'none') return null;
      if (resolution.kind === 'error') return { status: 'error', message: resolution.message };
      const { target } = resolution;
      const key = `${keyOf(target)}|${sha}`;
      const held = commitStatuses.get(key);
      const ttl = held?.view.status === 'ready' && isActive(held.view.pipeline.state) ? STATUS_RUNNING_MS : COMMIT_STATUS_TTL_MS;
      if (!retry && held && now() - held.at < ttl) return held.view;
      let view: CiCommitStatus;
      try {
        const pipeline = await target.run((ctx) => target.adapter.commitPipeline({ ...ctx, etags: new EtagCache() }, sha), abort.signal);
        view = pipeline ? { status: 'ready', pipeline: { ...pipeline, serverName: target.serverName, kind: target.server.kind } } : { status: 'none' };
      } catch (err) {
        deps.log(`[forge] CI status of a commit on ${target.server.id} failed: ${err instanceof ForgeHttpError ? err.kind : err instanceof Error ? err.name : typeof err}`);
        return { status: 'error', message: ciErrorText(err, target.serverName) };
      }
      commitStatuses.delete(key);
      commitStatuses.set(key, { at: now(), view });
      while (commitStatuses.size > MAX_COMMIT_STATUSES) commitStatuses.delete(commitStatuses.keys().next().value!);
      return view;
    },

    async webUrl(repo, target) {
      if (!deps.enabled()) return null;
      const abort = new AbortController();
      const resolution = await deps.resolve(repo, abort.signal);
      if (resolution.kind !== 'target') return null;
      const { target: resolved } = resolution;
      const { adapter, server, repoPath, serverName } = resolved;
      let pipelineIdOfJob: number | undefined;
      if ('jobId' in target && server.kind === 'github') {
        pipelineIdOfJob = (await resolved.run((ctx) => adapter.job({ ...ctx, etags: new EtagCache() }, target.jobId), abort.signal)).pipeline.id;
      }
      return { url: adapter.webUrl(server, repoPath, { ...target, ...(pipelineIdOfJob !== undefined ? { pipelineIdOfJob } : {}) }), serverName };
    },

    refresh() {
      const enabled = deps.enabled();
      for (const watch of watches.values()) {
        watch.resolution = undefined;
        // a read in flight resolved the old way: its answer is dropped and the watch reads again
        watch.gen++;
        clearTimer(watch);
        if (watch.kind === 'log') {
          if (!enabled) {
            const view = watch.running ? undefined : offView(watch);
            if (view) deps.emit({ id: watch.id, log: view });
            continue;
          }
          watch.finished = false;
          if (watch.off) watch.lastPoll = undefined;
          if (!watch.running) schedule(watch);
          continue;
        }
        watch.lastPoll = undefined;
        // a hidden or blurred watch reads when it is shown again
        if (watch.active || watch.running) void tick(watch);
      }
      commitStatuses.clear();
    },

    dispose() {
      disposed = true;
      for (const watch of watches.values()) drop(watch);
      watches.clear();
      commitStatuses.clear();
    },
  };
}
