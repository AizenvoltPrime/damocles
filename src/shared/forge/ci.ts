// CI state as the chip, the job list, the job log tab and the commit details show it (docs/invariants.md "GitHub and GitLab
// accounts", CI). Names, refs and log text are server data and are never translated.

export type CiState = 'created' | 'pending' | 'running' | 'passed' | 'failed' | 'canceled' | 'skipped' | 'manual' | 'scheduled';

export const CI_STATES: readonly CiState[] = ['created', 'pending', 'running', 'passed', 'failed', 'canceled', 'skipped', 'manual', 'scheduled'];

/** States a pipeline or job leaves on its own: polling stays at the running cadence while any is shown. */
export const CI_ACTIVE_STATES: ReadonlySet<CiState> = new Set(['created', 'pending', 'running', 'scheduled']);

export interface CiStepView {
  readonly number: number;
  readonly name: string;
  readonly state: CiState;
}

export interface CiJobView {
  /** GitLab's job id, GitHub's job id. */
  readonly id: number;
  readonly name: string;
  /**
   * GitLab's stage; GitHub's workflow name, with the run's event when two runs of one workflow show. Empty for a check or
   * status of another app that names none, which the view words itself.
   */
  readonly stage: string;
  readonly state: CiState;
  readonly kind: 'job' | 'bridge' | 'external';
  /** GitHub: the workflow run of an Actions job, which its group's actions take. */
  readonly runId?: number;
  /** A failed job its pipeline lets fail (GitLab's allow_failure): not counted as failed, shown as a warning. */
  readonly allowedFailure?: boolean;
  readonly durationSeconds?: number;
  /** ISO 8601. */
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** False for a waiting manual job, bridges and external statuses. */
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  /** False for bridges and external statuses. */
  readonly hasLog: boolean;
  /** The runner that ran or runs the job, as the server names it. */
  readonly runner?: string;
  /** GitHub only: the job's steps, which the running state shows while its log is not served. */
  readonly steps?: readonly CiStepView[];
}

/** GitHub: one workflow run among a commit's checks, whose heading carries its actions. */
export interface CiRunView {
  readonly id: number;
  /** The stage its jobs show under. */
  readonly stage: string;
  /** Rerun its failed jobs: the run finished failed or canceled. */
  readonly canRetry: boolean;
  readonly canCancel: boolean;
}

export interface CiPipelineView {
  readonly serverId: string;
  /** The host label of "Open pipeline on <server>" and "Open on <server>". */
  readonly serverName: string;
  /** gitlab: one pipeline; github: every check of the commit at sha, its workflow runs, other apps' checks and statuses. */
  readonly kind: 'github' | 'gitlab';
  /** What pipeline actions take: GitLab's pipeline id; 0 on GitHub, whose actions go per run (runs). */
  readonly id: number;
  /** Shown as "#<n>": GitLab's iid; 0 on GitHub, shown as "Checks". */
  readonly number: number;
  readonly state: CiState;
  readonly ref?: string;
  readonly sha?: string;
  readonly durationSeconds?: number;
  readonly startedAt?: string;
  readonly jobsDone: number;
  readonly jobsTotal: number;
  readonly failedCount: number;
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  /** Stage order, then job order; the latest attempt of each name. */
  readonly jobs: readonly CiJobView[];
  /** GitHub: the workflow runs the jobs belong to, in the order their stages show. */
  readonly runs?: readonly CiRunView[];
  /** The server lists more jobs or checks than Damocles reads (10 pages): jobs holds those it read. */
  readonly truncated?: boolean;
}

/** One repository's CI as the chip and the job list show it; null from the API means no chip. */
export type CiStatusView = CiStatusViewOf<string>;

/** Core sends Message as LocalizedText; main renders it to a string. */
export type CiStatusViewOf<Message> =
  | { readonly status: 'loading' }
  // no pipeline for this branch: no chip
  | { readonly status: 'none' }
  // head: HEAD's commit the pipeline was read for; the views name pipeline.sha when it is another commit
  | { readonly status: 'ready'; readonly pipeline: CiPipelineView; readonly head?: string }
  // message is localized by main or core; the chip shows TriangleAlert
  | { readonly status: 'error'; readonly message: Message };

/** A job log as main sends it to its tab: a ready view may carry a later read's failure, shown above the log the tab keeps. */
export type JobLogView = Exclude<JobLogViewOf<string>, { status: 'ready' }> | (Extract<JobLogViewOf<string>, { status: 'ready' }> & { readonly error?: string });

export type JobLogViewOf<Message> =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly job: CiJobView;
      readonly pipeline: { readonly id: number; readonly number: number; readonly ref?: string };
      readonly serverName: string;
      readonly kind: 'github' | 'gitlab';
      /** True: text replaces everything the tab holds; false: text is appended. */
      readonly reset: boolean;
      /** The raw log text, ANSI, \r and section markers intact. */
      readonly text: string;
      /** The log is longer than MAX_JOB_LOG_BYTES; the tab holds its tail. */
      readonly truncated: boolean;
      /** The job runs and the tab will receive appends. */
      readonly live: boolean;
    }
  // the job's steps are in job.steps; the log opens once the job finishes
  | { readonly status: 'githubRunning'; readonly job: CiJobView; readonly serverName: string }
  | { readonly status: 'error'; readonly message: Message; readonly job?: CiJobView; readonly serverName?: string };

export type CommitStatusView = CommitStatusViewOf<string>;

export type CommitStatusViewOf<Message> =
  | { readonly status: 'loading' }
  // no pipeline for this commit: the row is absent
  | { readonly status: 'none' }
  | { readonly status: 'ready'; readonly pipeline: Pick<CiPipelineView, 'id' | 'number' | 'state' | 'serverName' | 'kind'> }
  | { readonly status: 'error'; readonly message: Message };

/** What an action or "Open on <server>" acts on: runId is a GitHub workflow run; sha, a commit's checks, only opens. */
export type CiTarget = { readonly jobId: number } | { readonly pipelineId: number } | { readonly runId: number } | { readonly sha: string };

export type CiAction = 'retry' | 'cancel';

/** A plain copy of a target, so a renderer object's other fields never reach main. */
export function plainCiTarget(target: CiTarget): CiTarget {
  if ('jobId' in target) return { jobId: target.jobId };
  if ('pipelineId' in target) return { pipelineId: target.pipelineId };
  if ('runId' in target) return { runId: target.runId };
  return { sha: target.sha };
}

/** A job log's bound: a longer log keeps its last this many bytes (docs/invariants.md "GitHub and GitLab accounts"). */
export const MAX_JOB_LOG_BYTES: number = 16 * 1024 * 1024;
