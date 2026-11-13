import { MAX_JOB_LOG_BYTES } from '../../../shared/forge/ci';
import type { ForgeHttp, ForgeTail } from '../http';
import { hasHiddenCharacter } from './output';
import type { ForgeServer } from '../types';

// Requests are built from a checked repository path and numbers only, never from a URL a server returned.

export interface RepoContext {
  readonly http: ForgeHttp;
  readonly server: ForgeServer;
  readonly token: string;
  /** Checked by checkedRepoPath: "grp/sub/proj" or "owner/repo". */
  readonly repoPath: string;
  readonly signal: AbortSignal;
}

export interface Pipeline {
  /** GitLab's pipeline id, GitHub's workflow run id: what ForgeJobs takes. */
  readonly id: number;
  readonly status: string;
  readonly ref?: string;
  readonly sha?: string;
  readonly name?: string;
  readonly createdAt?: string;
  readonly webUrl?: string;
}

export interface Job {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly stage?: string;
  readonly pipelineId?: number;
  readonly durationSeconds?: number;
  readonly webUrl?: string;
}

export interface Note {
  readonly author: string;
  readonly createdAt?: string;
  readonly body: string;
}

export interface MergeRequest {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly draft: boolean;
  readonly author: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly description: string;
  readonly webUrl?: string;
  readonly createdAt?: string;
}

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly author: string;
  readonly labels: readonly string[];
  readonly description: string;
  readonly webUrl?: string;
  readonly createdAt?: string;
}

export type ListState = 'open' | 'closed' | 'merged' | 'all';

export interface ForgeRepoApi {
  pipelines(ctx: RepoContext, query: { readonly ref?: string; readonly limit: number }): Promise<Pipeline[]>;
  /** truncated: the server listed more pages than MAX_LIST_PAGES, and jobs holds those read. */
  jobs(ctx: RepoContext, pipelineId: number): Promise<{ readonly jobs: Job[]; readonly truncated: boolean }>;
  job(ctx: RepoContext, jobId: number): Promise<Job>;
  /** The raw log's last MAX_JOB_LOG_BYTES. */
  jobLog(ctx: RepoContext, jobId: number): Promise<JobLog>;
  mergeRequest(ctx: RepoContext, number: number): Promise<MergeRequest>;
  mergeRequestNotes(ctx: RepoContext, number: number, limit: number): Promise<Note[]>;
  mergeRequests(ctx: RepoContext, query: { readonly state: ListState; readonly limit: number }): Promise<MergeRequest[]>;
  issue(ctx: RepoContext, number: number): Promise<Issue>;
  issueNotes(ctx: RepoContext, number: number, limit: number): Promise<Note[]>;
  issues(ctx: RepoContext, query: { readonly state: Exclude<ListState, 'merged'>; readonly limit: number }): Promise<Issue[]>;
  defaultBranch(ctx: RepoContext): Promise<string>;
  /** Retry answers the new job, or null when the server does not list it yet (GitHub); cancel answers the job as it is now. */
  jobAction(ctx: RepoContext, jobId: number, action: 'retry' | 'cancel'): Promise<Job | null>;
  /** Retries a pipeline's failed jobs (GitHub: reruns the run's failed jobs) or cancels it. */
  pipelineAction(ctx: RepoContext, pipelineId: number, action: 'retry' | 'cancel'): Promise<void>;
  /**
   * title is posted as given; GitLab marks a draft only in it, GitHub by the draft flag. sourceRepoPath (checked as
   * repoPath is): the fork on the same server the branch lives in, for a merge request across repositories into ctx's.
   */
  openMergeRequest(ctx: RepoContext, request: { readonly sourceBranch: string; readonly sourceRepoPath?: string; readonly targetBranch: string; readonly title: string; readonly body: string; readonly draft: boolean }): Promise<MergeRequest>;
  /** On GitHub, where issues and pull requests share numbers, throws InputError when number is of the other kind. */
  comment(ctx: RepoContext, on: 'mergeRequest' | 'issue', number: number, body: string): Promise<{ readonly id: number }>;
}

/** An input the tool refuses; its message is the call's answer. */
export class InputError extends Error {}

export { MAX_JOB_LOG_BYTES };

export interface JobLog {
  readonly text: string;
  /** The log was longer than MAX_JOB_LOG_BYTES; text is its tail. */
  readonly truncated: boolean;
}

/** A log's tail as text; a tail that starts inside a UTF-8 sequence starts at the next character. */
export function decodeTail(tail: ForgeTail): JobLog {
  const truncated = tail.totalBytes > tail.bytes.byteLength;
  let start = 0;
  // UTF-8 continuation bytes are 10xxxxxx; a character has at most three of them
  while (truncated && start < 3 && start < tail.bytes.byteLength && (tail.bytes[start]! & 0xc0) === 0x80) start++;
  return { text: new TextDecoder().decode(tail.bytes.subarray(start)), truncated };
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,255}$/;

/**
 * A repository path the tools may put in a request path: segments of letters, digits, '_', '.' and '-' only, never '.' or
 * '..' or empty (an encoded '..' still walks up the API path), owner/repo on GitHub and two or more on GitLab.
 */
export function checkedRepoPath(kind: 'github' | 'gitlab', value: string): string | undefined {
  const segments = value.split('/');
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === '.' || segment === '..')) return undefined;
  if (kind === 'github' ? segments.length !== 2 : segments.length < 2 || segments.length > 20) return undefined;
  return segments.join('/');
}

const LOCK_SUFFIX = '.lock';

/**
 * A git branch name the tools send in a query or a body, by `git check-ref-format --branch`'s rules: no '..', '@{' or '//',
 * no component that starts with '.' or ends in '.lock', no leading or trailing '/', no trailing '.', not '@' or 'HEAD', no
 * leading '-', none of space ~ ^ : ? * [ \ or a control character; and no other whitespace or hidden character, at most
 * 255 characters. Every check reads the name once, forward.
 */
export function checkedBranch(value: string): string | undefined {
  if (value.length === 0 || value.length > 255 || value === '@' || value === 'HEAD' || value.startsWith('-')) return undefined;
  if (hasHiddenCharacter(value) || /[\s~^:?*[\\]/.test(value)) return undefined;
  // the name's start reads as a component's start
  let previous = '/';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '.' && (previous === '.' || previous === '/')) return undefined;
    if (char === '/' && (previous === '/' || value.endsWith(LOCK_SUFFIX, index))) return undefined;
    if (char === '{' && previous === '@') return undefined;
    previous = char;
  }
  return previous === '/' || previous === '.' || value.endsWith(LOCK_SUFFIX) ? undefined : value;
}
