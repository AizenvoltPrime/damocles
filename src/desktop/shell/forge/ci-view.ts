import type { Component } from 'vue';
import { CircleCheck, CircleDashed, CircleMinus, CirclePause, CircleSlash, CircleX, Clock, Hand, LoaderCircle, TriangleAlert } from 'lucide-vue-next';
import type { CiJobView, CiPipelineView, CiState, CiStatusView } from '@shared/forge/ci';

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** A CI state's icon and tone: every state has its own shape, so colour is never the only signal. */
export interface CiLook {
  readonly icon: Component;
  readonly tone: string;
  readonly spin: boolean;
}

const LOOKS: Readonly<Record<CiState, CiLook>> = {
  running: { icon: LoaderCircle, tone: 'text-(--d-accent-text)', spin: true },
  passed: { icon: CircleCheck, tone: 'text-(--d-success-text)', spin: false },
  failed: { icon: CircleX, tone: 'text-(--d-danger-text)', spin: false },
  canceled: { icon: CircleSlash, tone: 'text-(--d-faint-text)', spin: false },
  skipped: { icon: CircleMinus, tone: 'text-(--d-faint-text)', spin: false },
  created: { icon: CirclePause, tone: 'text-(--d-faint-text)', spin: false },
  pending: { icon: CircleDashed, tone: 'text-(--d-faint-text)', spin: false },
  scheduled: { icon: Clock, tone: 'text-(--d-faint-text)', spin: false },
  manual: { icon: Hand, tone: 'text-(--d-faint-text)', spin: false },
};

export const ciLook = (state: CiState): CiLook => LOOKS[state];

const ALLOWED_FAILURE: CiLook = { icon: TriangleAlert, tone: 'text-(--d-warning-text)', spin: false };

/** A job's look: a failure its pipeline allows is a warning. */
export const ciJobLook = (job: Pick<CiJobView, 'state' | 'allowedFailure'>): CiLook => (job.allowedFailure === true ? ALLOWED_FAILURE : LOOKS[job.state]);

/** A job's state in words, an allowed failure said as one. */
export const ciJobStateWord = (job: Pick<CiJobView, 'state' | 'allowedFailure'>, t: (key: string) => string): string =>
  (job.allowedFailure === true ? t('forge.ci.job.allowedFailure') : ciStateWord(job.state, t));

/** What a pipeline is called: GitLab's "Pipeline #n"; on GitHub, the commit's "Checks". */
export const ciPipelineName = (pipeline: Pick<CiPipelineView, 'kind' | 'number'>, t: Translate): string =>
  (pipeline.kind === 'github' ? t('forge.ci.checks.name') : t('forge.ci.pipeline.name', { n: pipeline.number }));

/** A stage's heading: checks of other apps that name no stage show under "Other checks". */
export const ciStageName = (stage: string, t: (key: string) => string): string => (stage === '' ? t('forge.ci.stage.other') : stage);

/** The state in words ("running", "passed"), as the accessible names and the announcements say it. */
export const ciStateWord = (state: CiState, t: (key: string) => string): string => t(`forge.ci.state.${state}`);

/** A job's or pipeline's duration as the design writes it: 38s, 2m 05s, 1h 04m. */
export function ciDuration(seconds: number, t: Translate): string {
  const whole = Math.max(0, Math.round(seconds));
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (whole < 60) return t('forge.ci.duration.seconds', { s: whole });
  if (whole < 3600) return t('forge.ci.duration.minutes', { m: Math.floor(whole / 60), s: pad(whole % 60) });
  return t('forge.ci.duration.hours', { h: Math.floor(whole / 3600), m: pad(Math.floor((whole % 3600) / 60)) });
}

/** The pipeline's commit, short, when it is not HEAD's: HEAD has no pipeline yet, as an unpushed commit has none. */
export function ciOtherCommit(status: Extract<CiStatusView, { status: 'ready' }>): string | undefined {
  const { head, pipeline } = status;
  return head !== undefined && pipeline.sha !== undefined && pipeline.sha !== head ? pipeline.sha.slice(0, 7) : undefined;
}

/**
 * Each job's key by its id: kind, stage and name, which a GitLab retry keeps under its new id; a job whose key another job
 * of the list shares (GitHub allows two jobs of one name) keys by its id.
 */
export function ciJobKeys(jobs: readonly Pick<CiJobView, 'id' | 'kind' | 'stage' | 'name'>[]): Map<number, string> {
  const named = jobs.map((job) => JSON.stringify([job.kind, job.stage, job.name]));
  const seen = new Map<string, number>();
  for (const key of named) seen.set(key, (seen.get(key) ?? 0) + 1);
  return new Map(jobs.map((job, at) => [job.id, seen.get(named[at]!) === 1 ? named[at]! : `id:${job.id}`]));
}

/** Jobs grouped by stage in the order the pipeline lists them (stage order, then job order). */
export function jobsByStage<T extends { readonly stage: string }>(jobs: readonly T[]): { readonly stage: string; readonly jobs: readonly T[] }[] {
  const groups: { stage: string; jobs: T[] }[] = [];
  for (const job of jobs) {
    const last = groups.at(-1);
    if (last?.stage === job.stage) last.jobs.push(job);
    else groups.push({ stage: job.stage, jobs: [job] });
  }
  return groups;
}
