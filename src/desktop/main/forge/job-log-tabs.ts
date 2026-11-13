// A CI job's log in a read-only `jobLog` editor tab (docs/invariants.md "Desktop host", job log tabs): one tab per (repoId, jobId),
// never persisted or restored, closed with its repository. Core reads the log while the tab is shown and the window focused;
// main pushes what it adds as appends and keeps the tab's last MAX_JOB_LOG_BYTES characters, so a remounted tab gets the whole
// text again, and keeps a later read's failure apart from that text, so the tab shows the failure above the log it has.
import type { Disposable } from '../../../platform/disposable';
import type { CiLog, CiRepo } from '../../../core/forge/ci-watch';
import { MAX_JOB_LOG_BYTES, type JobLogView } from '../../../shared/forge/ci';
import type { LocalizedText } from '../../../shared/localized-text';
import type { JobLogUpdate } from '../../preload/forge-channels';
import type { ShellJobLogTab } from '../../preload/shell-channels';
import type { CoreClient } from '../core-client';
import { renderJobLog, type CiJobName } from './forge-host';

const LOG_WATCH = 'log:';
// held text may pass the bound by this much before it is cut, so a cut is not paid on every append
const TRIM_SLACK = 1024 * 1024;

export interface JobLogTabsDeps {
  /** This computer's core, waited for through a restart. */
  readonly core: <T>(label: string, work: (client: CoreClient) => Promise<T>) => Promise<T>;
  /** This computer's core runs and is ready; a core that is not holds no log watch. */
  readonly coreRunning: () => boolean;
  readonly forge: {
    ciRepo(repoId: string): Promise<CiRepo | undefined>;
    ciJob(repoId: string, jobId: number): CiJobName | undefined;
    isWindowFocused(): boolean;
  };
  readonly pane: {
    showJobLog(jobLog: ShellJobLogTab, opts: { readonly focus: boolean }): string;
    jobLogTab(tabId: string): ShellJobLogTab | undefined;
    updateJobLog(tabId: string, jobLog: ShellJobLogTab): void;
    whenClosed(tabId: string): Promise<void>;
  };
  readonly render: (text: LocalizedText) => string;
  /** main's own text in its language */
  readonly t: (message: string, ...args: Array<string | number>) => string;
  /** To the shell page. */
  readonly send: (update: JobLogUpdate) => void;
  readonly log: (line: string) => void;
}

type ShownView = Exclude<JobLogView, { status: 'error' }>;
type ErrorView = Extract<JobLogView, { status: 'error' }>;

interface TabState {
  readonly tabId: string;
  readonly repoId: string;
  jobId: number;
  visible: boolean;
  chunks: string[];
  length: number;
  truncated: boolean;
  // the newest view that is no error, a ready one without its text
  shown: ShownView;
  // the failure of the newest read, when it failed; a ready view keeps its log under it
  error: ErrorView | undefined;
  first: Promise<void>;
  // bumped when the tab follows a retried job, so a late answer for the old one is dropped
  gen: number;
}

export class JobLogTabs implements Disposable {
  private readonly deps: JobLogTabsDeps;
  private readonly tabs = new Map<string, TabState>();

  constructor(deps: JobLogTabsDeps) {
    this.deps = deps;
  }

  /** Opens or focuses the job's log tab. */
  async open(repoId: string, jobId: number, opts: { readonly focus: boolean }): Promise<void> {
    const known = this.deps.forge.ciJob(repoId, jobId);
    const tabId = this.deps.pane.showJobLog({
      repoId,
      jobId,
      jobName: known?.name ?? `#${jobId}`,
      state: known?.state ?? 'pending',
      ...(known?.pipelineNumber !== undefined ? { pipelineNumber: known.pipelineNumber } : {}),
      ...(known?.workflow !== undefined ? { workflow: known.workflow } : {}),
    }, opts);
    if (this.tabs.has(tabId)) return;
    const state: TabState = { tabId, repoId, jobId, visible: true, chunks: [], length: 0, truncated: false, shown: { status: 'loading' }, error: undefined, first: Promise.resolve(), gen: 0 };
    this.tabs.set(tabId, state);
    void this.deps.pane.whenClosed(tabId).then(() => this.closed(tabId, true));
    state.first = this.start(state);
    await state.first;
  }

  /**
   * The tab's whole log so far, as one reset view with any later read's failure; after a failed read with no log to keep (the
   * error state's Try again) it reads again.
   */
  async jobLog(tabId: string): Promise<JobLogView> {
    const state = this.stateOf(tabId);
    await state.first;
    if (state.error && state.shown.status !== 'ready') {
      this.restart(state, false);
      await state.first;
    }
    return this.whole(state);
  }

  /** Try again over a kept log: core reads the tab's watch now, and what the read brings comes as an update. */
  async readNow(tabId: string): Promise<void> {
    const state = this.stateOf(tabId);
    await state.first;
    await this.deps.core('forge ci read', (client) => client.forgeCiJobs(LOG_WATCH + tabId));
  }

  /** A new core holds no log watch: each tab's starts again and the tab gets its whole log. */
  coreAttached(): void {
    for (const state of this.tabs.values()) this.restart(state, true);
  }

  /** The tab was shown or hidden: a hidden tab's log is not read. */
  setVisible(tabId: string, visible: boolean): void {
    const state = this.tabs.get(tabId);
    if (!state || state.visible === visible) return;
    state.visible = visible;
    this.sendActive(state);
  }

  setWindowFocused(): void {
    for (const state of this.tabs.values()) if (state.visible) this.sendActive(state);
  }

  /** Core's update of a log watch. */
  coreLog(id: string, view: CiLog): void {
    if (!id.startsWith(LOG_WATCH)) return;
    const state = this.tabs.get(id.slice(LOG_WATCH.length));
    if (!state) return;
    const rendered = renderJobLog(view, this.deps.render);
    if (rendered.status !== 'loading' && rendered.job && rendered.job.id < state.jobId) return;
    // past the bound the tab parses the kept tail again, so the renderer holds no more than main
    const cut = this.take(state, rendered);
    this.deps.send({ tabId: state.tabId, view: cut ? this.whole(state) : this.update(state, rendered) });
  }

  /** A retry replaced jobId with newJobId: the tab follows the new job from its start. */
  retarget(repoId: string, jobId: number, newJobId: number): void {
    for (const state of this.tabs.values()) {
      if (state.repoId !== repoId || state.jobId !== jobId) continue;
      state.jobId = newJobId;
      const descriptor = this.deps.pane.jobLogTab(state.tabId);
      if (descriptor) this.deps.pane.updateJobLog(state.tabId, { ...descriptor, jobId: newJobId, state: 'pending' });
      this.restart(state, true);
    }
  }

  /** Reads the tab's log from its start again; push sends the result to the shell as a reset. */
  private restart(state: TabState, push: boolean): void {
    state.gen++;
    state.chunks = [];
    state.length = 0;
    state.truncated = false;
    state.shown = { status: 'loading' };
    state.error = undefined;
    state.first = this.start(state).then(() => {
      if (push && this.tabs.get(state.tabId) === state) this.deps.send({ tabId: state.tabId, view: this.whole(state) });
    });
  }

  dispose(): void {
    const ending = this.deps.coreRunning();
    for (const tabId of [...this.tabs.keys()]) this.closed(tabId, ending);
  }

  private stateOf(tabId: string): TabState {
    const state = this.tabs.get(tabId);
    if (!state) throw new Error('No such job log tab');
    return state;
  }

  private async start(state: TabState): Promise<void> {
    const gen = state.gen;
    let view: JobLogView;
    try {
      const repo = await this.deps.forge.ciRepo(state.repoId);
      view = repo
        ? renderJobLog(await this.deps.core('forge ci jobLog', (client) => client.forgeCiJobLog({ id: LOG_WATCH + state.tabId, repo, jobId: state.jobId })), this.deps.render)
        : { status: 'error', message: this.deps.t('The repository of this job is no longer open.') };
    } catch (err) {
      this.deps.log(`[forge] reading the log of job ${state.jobId} failed: ${err instanceof Error ? err.message : String(err)}`);
      view = { status: 'error', message: this.deps.t('Damocles could not reach its engine. Try again.') };
    }
    if (gen !== state.gen || this.tabs.get(state.tabId) !== state) return;
    this.take(state, view);
    if (!state.visible || !this.deps.forge.isWindowFocused()) this.sendActive(state);
  }

  /** Holds the view; true when the held text was cut to the bound. */
  private take(state: TabState, view: JobLogView): boolean {
    let cut = false;
    if (view.status === 'ready') {
      if (view.reset) {
        state.chunks = [];
        state.length = 0;
        state.truncated = view.truncated;
      }
      if (view.text !== '') {
        state.chunks.push(view.text);
        state.length += view.text.length;
      }
      if (state.length > MAX_JOB_LOG_BYTES + TRIM_SLACK) {
        const joined = state.chunks.join('');
        const from = joined.length - MAX_JOB_LOG_BYTES;
        // the kept tail starts at a line, never inside an escape sequence or a character the cut split
        const newline = joined.indexOf('\n', from - 1);
        const kept = joined.slice(newline < 0 ? from : newline + 1);
        state.chunks = [kept];
        state.length = kept.length;
        state.truncated = true;
        cut = true;
      }
      state.truncated ||= view.truncated;
      state.shown = { ...view, reset: true, text: '' };
      state.error = undefined;
    } else if (view.status === 'error') {
      state.error = view;
    } else {
      state.shown = view;
      state.error = undefined;
    }
    const job = view.status === 'loading' ? undefined : view.job;
    // core's watch followed a rerun to its newer attempt, whose id is greater (coreLog drops a late view of a job it left)
    if (job && job.id > state.jobId) state.jobId = job.id;
    const descriptor = this.deps.pane.jobLogTab(state.tabId);
    if (!job || !descriptor) return cut;
    const github = view.status === 'githubRunning' || (view.status === 'ready' && view.kind === 'github');
    this.deps.pane.updateJobLog(state.tabId, {
      ...descriptor,
      jobId: job.id,
      jobName: job.name,
      state: job.state,
      ...(view.status === 'ready' && view.kind === 'gitlab' ? { pipelineNumber: view.pipeline.number } : {}),
      ...(github && job.stage !== '' ? { workflow: job.stage } : {}),
    });
    return cut;
  }

  /** What the shell gets for a view core sent: a failure over a kept log comes as that log, unchanged, with the failure. */
  private update(state: TabState, view: JobLogView): JobLogView {
    if (view.status !== 'error' || state.shown.status !== 'ready') return view;
    return { ...state.shown, reset: false, text: '', truncated: state.truncated, error: view.message };
  }

  private whole(state: TabState): JobLogView {
    const { shown, error } = state;
    if (shown.status !== 'ready') return error ?? shown;
    if (state.chunks.length > 1) state.chunks = [state.chunks.join('')];
    return { ...shown, reset: true, text: state.chunks[0] ?? '', truncated: state.truncated, ...(error ? { error: error.message } : {}) };
  }

  private sendActive(state: TabState): void {
    const active = state.visible && this.deps.forge.isWindowFocused();
    this.deps.core('forge ci watch', (client) => client.forgeCiWatch({ id: LOG_WATCH + state.tabId, active })).catch((err: unknown) => {
      this.deps.log(`[forge] showing or hiding the log of job ${state.jobId} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** endWatch: core still holds the tab's log watch, which a core that ended took with it. */
  private closed(tabId: string, endWatch: boolean): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    this.tabs.delete(tabId);
    state.gen++;
    if (!endWatch) return;
    this.deps.core('forge ci unwatch', (client) => client.forgeCiUnwatch(LOG_WATCH + tabId)).catch((err: unknown) => {
      this.deps.log(`[forge] ending the log watch of job ${state.jobId} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
