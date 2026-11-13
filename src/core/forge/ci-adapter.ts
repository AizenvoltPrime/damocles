import { CI_ACTIVE_STATES, type CiAction, type CiJobView, type CiPipelineView, type CiState, type CiTarget } from '../../shared/forge/ci';
import type { ForgeTail } from './http';
import { hasNextPage, readPages } from './paging';
import type { RepoContext } from './tools/api';
import type { ForgeServer } from './types';

// What CI watching (ci-watch.ts) asks of a server kind: ci-gitlab.ts and ci-github.ts. Requests are built from a checked
// repository path and numbers only; ETags and their bodies are memory only.

const MAX_ETAGS = 64;

interface CachedAnswer {
  readonly etag: string;
  readonly body: unknown;
  // the answer named a next page, which a 304 may not repeat
  readonly next: boolean;
}

/** One watch's ETags and the bodies they answered for, so a 304 reuses the body; the oldest entry goes first. */
export class EtagCache {
  private readonly entries = new Map<string, CachedAnswer>();

  get(url: string): CachedAnswer | undefined {
    const entry = this.entries.get(url);
    if (entry) {
      this.entries.delete(url);
      this.entries.set(url, entry);
    }
    return entry;
  }

  set(url: string, etag: string, body: unknown, next: boolean): void {
    this.entries.delete(url);
    this.entries.set(url, { etag, body, next });
    while (this.entries.size > MAX_ETAGS) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface CiContext extends RepoContext {
  readonly etags: EtagCache;
}

/** A GET of JSON with If-None-Match from the cache: a 304 answers the cached body and whether it named a next page. */
async function getCachedPage(ctx: CiContext, path: string, template: string, query: Readonly<Record<string, string>>): Promise<{ readonly body: unknown; readonly next: boolean }> {
  const search = new URLSearchParams(query).toString();
  const url = `${path}${search ? `?${search}` : ''}`;
  const held = ctx.etags.get(url);
  const response = await ctx.http.request({ server: ctx.server, url, template, credential: { bearer: ctx.token }, signal: ctx.signal, ...(held ? { etag: held.etag } : {}) });
  if (response.notModified && held) return { body: held.body, next: held.next };
  const next = hasNextPage(response.headers);
  if (response.etag !== undefined) ctx.etags.set(url, response.etag, response.body, next);
  return { body: response.body, next };
}

export async function getCached(ctx: CiContext, path: string, template: string, query: Readonly<Record<string, string>> = {}): Promise<unknown> {
  return (await getCachedPage(ctx, path, template, query)).body;
}

/** Every page of a list, each read as getCached reads, up to MAX_LIST_PAGES; items picks a page's entries from its body. */
export function getCachedList(ctx: CiContext, path: string, template: string, query: Readonly<Record<string, string>>, items: (body: unknown) => readonly unknown[]): Promise<{ readonly items: unknown[]; readonly truncated: boolean }> {
  return readPages(async (page) => {
    const answer = await getCachedPage(ctx, path, template, { ...query, page: String(page) });
    return { items: items(answer.body), next: answer.next };
  });
}

export type CiLogRead =
  | { readonly notModified: true }
  | { readonly notModified: false; readonly tail: ForgeTail; readonly etag?: string };

export interface CiJobDetail {
  readonly job: CiJobView;
  readonly pipeline: { readonly id: number; readonly number: number; readonly ref?: string };
  /** GitHub: the job's attempt (run_attempt), and whether its workflow run is running, which a rerun makes it. */
  readonly attempt?: number;
  readonly runActive?: boolean;
}

export interface CiAdapter {
  /** The pipeline CI shows for a branch at a commit, with its jobs; null: none. */
  pipeline(ctx: CiContext, ref: { readonly branch: string; readonly sha?: string }, serverName: string): Promise<CiPipelineView | null>;
  /** The newest pipeline of a commit, without its jobs; null: none. */
  commitPipeline(ctx: CiContext, sha: string): Promise<{ readonly id: number; readonly number: number; readonly state: CiState } | null>;
  job(ctx: CiContext, jobId: number): Promise<CiJobDetail>;
  /** The log's last MAX_JOB_LOG_BYTES; with etag, a 304 when it has not changed. */
  log(ctx: CiContext, jobId: number, etag: string | undefined): Promise<CiLogRead>;
  /** retry answers the job that replaced jobId when the server lists it (a retried job gets a new id). */
  action(ctx: CiContext, target: CiTarget, action: CiAction): Promise<{ readonly jobId?: number }>;
  /** The server's page for the target, from its web URL, the checked repository path and the id or commit. */
  webUrl(server: ForgeServer, repoPath: string, target: CiTarget & { readonly pipelineIdOfJob?: number }): string;
  /** Whether the server serves a log while the job runs (GitHub does not). */
  readonly liveLogs: boolean;
  /** GitHub: the id of a newer attempt of the job (a rerun), once its run lists one. */
  attemptAfter?(ctx: CiContext, detail: CiJobDetail): Promise<number | undefined>;
}

export const isActive = (state: CiState): boolean => CI_ACTIVE_STATES.has(state);

const FINISHED: ReadonlySet<CiState> = new Set(['passed', 'failed', 'canceled', 'skipped']);
export const isFinished = (state: CiState): boolean => FINISHED.has(state);

/** A finite, non-negative number of seconds, rounded. */
export function seconds(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** An ISO stamp of the server's, kept only when it parses. */
export function isoOf(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** Done, total and failed counts of the jobs a pipeline shows: a waiting manual job is not done, an allowed failure not failed. */
export function jobCounts(jobs: readonly CiJobView[]): { readonly jobsDone: number; readonly jobsTotal: number; readonly failedCount: number } {
  return {
    jobsDone: jobs.filter((job) => isFinished(job.state)).length,
    jobsTotal: jobs.length,
    failedCount: jobs.filter((job) => job.state === 'failed' && job.allowedFailure !== true).length,
  };
}

/** A job of a finished state the server reruns: a skipped job never ran and cannot be retried. */
export const isRetriable = (state: CiState): boolean => isFinished(state) && state !== 'skipped';
