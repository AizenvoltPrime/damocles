// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PipelineChip from '../forge/PipelineChip.vue';
import PipelinePopover from '../overlay/components/PipelinePopover.vue';
import { useRepoCi } from '../forge/repo-ci';
import { Hand } from 'lucide-vue-next';
import { ciDuration, ciLook, jobsByStage } from '../forge/ci-view';
import { applyShellLocale, shellI18n } from '../i18n';
import { CI_STATES, type CiJobView, type CiPipelineView, type CiStatusView } from '../../../shared/forge/ci';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import { fakeForgeShellApi, fakeOverlayApi, fakeShellApi, type FakeOverlayApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(async () => {
  await applyShellLocale('en');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

// a sample pipeline: build (compile, lint), test (unit running, e2e passed), deploy (review-app manual)
const job = (name: string, stage: string, state: CiJobView['state'], extra: Partial<CiJobView> = {}): CiJobView => ({
  id: name.length * 100 + stage.length,
  name,
  stage,
  state,
  kind: 'job',
  durationSeconds: 64,
  canRetry: state === 'passed' || state === 'failed' || state === 'canceled',
  canCancel: state === 'running' || state === 'pending',
  hasLog: true,
  ...extra,
});
const JOBS: readonly CiJobView[] = [
  job('compile', 'build', 'passed'),
  job('lint', 'build', 'passed', { durationSeconds: 38 }),
  job('unit', 'test', 'running', { durationSeconds: 150 }),
  job('e2e', 'test', 'passed', { durationSeconds: 231 }),
  (({ durationSeconds: _never, ...manual }) => manual)(job('review-app', 'deploy', 'manual', { canRetry: false, canCancel: false })),
];
const PIPELINE: CiPipelineView = {
  serverId: 'indigital',
  serverName: 'gitlab.indigital.gr',
  kind: 'gitlab',
  id: 99_001,
  number: 4312,
  state: 'running',
  ref: 'feature/forge-accounts',
  durationSeconds: 252,
  jobsDone: 3,
  jobsTotal: 5,
  failedCount: 0,
  canRetry: false,
  canCancel: true,
  jobs: JOBS,
};
const ready = (pipeline: Partial<CiPipelineView> = {}): Extract<CiStatusView, { status: 'ready' }> => ({ status: 'ready', pipeline: { ...PIPELINE, ...pipeline } });
const withJob = (name: string, patch: Partial<CiJobView>): readonly CiJobView[] => JOBS.map((each) => (each.name === name ? { ...each, ...patch } : each));

describe('the CI view helpers', () => {
  it('writes durations as the design does and groups jobs by stage in order', () => {
    const t = (key: string, values?: Record<string, unknown>) => shellI18n.global.t(key, values ?? {});
    expect(ciDuration(38, t)).toBe('38s');
    expect(ciDuration(64, t)).toBe('1m 04s');
    expect(ciDuration(3725, t)).toBe('1h 02m');
    expect(jobsByStage(JOBS).map((group) => [group.stage, group.jobs.map((each) => each.name)])).toEqual([
      ['build', ['compile', 'lint']],
      ['test', ['unit', 'e2e']],
      ['deploy', ['review-app']],
    ]);
  });
});

describe('PipelineChip', () => {
  function mountChip(status: Exclude<CiStatusView, { status: 'none' }>) {
    const api = fakeShellApi();
    const wrapper = mount(PipelineChip, { props: { api, repoId: 'r1', status }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    return { wrapper, api };
  }
  const chip = (wrapper: VueWrapper) => wrapper.get('[data-testid="forge-ci-chip"]');

  it('shows a running pipeline with a spinner, done of total and the contract name', () => {
    const { wrapper } = mountChip(ready());
    expect(chip(wrapper).attributes('aria-label')).toBe('Pipeline #4312 running, 3 of 5 jobs done');
    expect(chip(wrapper).attributes('aria-haspopup')).toBe('dialog');
    expect(chip(wrapper).attributes('title')).toBe('Pipeline #4312 running, 3 of 5 jobs done. Show jobs');
    expect(wrapper.get('[data-testid="forge-ci-chip-text"]').text()).toBe('3/5');
    expect(wrapper.get('[data-testid="forge-ci-chip-spinner"]').classes()).toContain('d-spinning');
    expect(wrapper.get('[data-testid="forge-ci-chip-icon"]').attributes('data-icon')).toBe('running');
  });

  it('gives passed, failed and canceled their own icon, the failed count, and no spin', () => {
    const passed = mountChip(ready({ state: 'passed', jobsDone: 5 }));
    expect(chip(passed.wrapper).attributes('aria-label')).toBe('Pipeline #4312 passed');
    expect(passed.wrapper.find('[data-testid="forge-ci-chip-text"]').exists()).toBe(false);
    expect(passed.wrapper.get('[data-testid="forge-ci-chip-spinner"]').classes()).not.toContain('d-spinning');
    expect(passed.wrapper.get('[data-testid="forge-ci-chip-icon"]').attributes('data-icon')).toBe('passed');

    const failed = mountChip(ready({ state: 'failed', failedCount: 2 }));
    expect(chip(failed.wrapper).attributes('aria-label')).toBe('Pipeline #4312 failed, 2 jobs failed');
    expect(failed.wrapper.get('[data-testid="forge-ci-chip-text"]').text()).toBe('2');

    const canceled = mountChip(ready({ state: 'canceled' }));
    expect(chip(canceled.wrapper).attributes('aria-label')).toBe('Pipeline #4312 canceled');
    expect(canceled.wrapper.get('[data-testid="forge-ci-chip-icon"]').attributes('data-icon')).toBe('canceled');
  });

  it('shows TriangleAlert and says why for an unreadable CI, and a skeleton while it loads', () => {
    const error = mountChip({ status: 'error', message: 'Damocles could not read CI from gitlab.indigital.gr.' });
    expect(chip(error.wrapper).attributes('aria-label')).toBe('CI status unavailable');
    expect(chip(error.wrapper).attributes('title')).toBe('Damocles could not read CI from gitlab.indigital.gr.');
    expect(error.wrapper.get('[data-testid="forge-ci-chip-icon"]').attributes('data-icon')).toBe('error');

    const loading = mountChip({ status: 'loading' });
    expect(loading.wrapper.get('[data-testid="forge-ci-chip-loading"]').attributes('aria-label')).toBe('Checking CI');
    expect(loading.wrapper.find('[data-testid="forge-ci-chip"]').exists()).toBe(false);
  });

  it('opens the job list at the chip and stays expanded until the popover settles', async () => {
    const { wrapper, api } = mountChip(ready());
    let settle!: () => void;
    vi.mocked(api.forge.showPipeline).mockImplementation(() => new Promise<void>((resolve) => (settle = resolve)));
    await chip(wrapper).trigger('click');
    expect(api.forge.showPipeline).toHaveBeenCalledWith('r1', expect.objectContaining({ x: expect.any(Number), width: expect.any(Number) }));
    expect(chip(wrapper).attributes('aria-expanded')).toBe('true');
    settle();
    await flushPromises();
    expect(chip(wrapper).attributes('aria-expanded')).toBe('false');
  });
});

describe('useRepoCi', () => {
  it('watches the shown repository only while Source Control shows it, and follows main\'s pushes', async () => {
    const api = fakeForgeShellApi();
    api.ci.set('r1', ready());
    const repoId = ref<string | undefined>('r1');
    const shown = ref(true);
    const scope = effectScope();
    const ci = scope.run(() => useRepoCi(api, repoId, shown, (key) => key))!;
    await flushPromises();
    expect(ci.status.value).toEqual(ready());
    expect(api.ciWatch).toHaveBeenLastCalledWith('r1', true);

    shown.value = false;
    await nextTick();
    expect(api.ciWatch).toHaveBeenLastCalledWith('r1', false);
    shown.value = true;
    await nextTick();
    expect(api.ciWatch).toHaveBeenLastCalledWith('r1', true);

    api.ciChanged({ repoId: 'r2', status: { status: 'none' } });
    expect(ci.status.value).toEqual(ready());
    api.ciChanged({ repoId: 'r1', status: ready({ state: 'passed' }) });
    expect(ci.status.value).toEqual(ready({ state: 'passed' }));

    repoId.value = 'r2';
    await flushPromises();
    expect(api.ciWatch).toHaveBeenCalledWith('r1', false);
    expect(api.ciWatch).toHaveBeenLastCalledWith('r2', true);
    expect(ci.status.value).toBeNull();

    scope.stop();
    expect(api.ciWatch).toHaveBeenLastCalledWith('r2', false);
  });
});

describe('the job list popover', () => {
  let api: FakeOverlayApi;
  const answers: OverlayAnswer[] = [];
  const request: Extract<OverlayRequest, { kind: 'pipeline' }> = { kind: 'pipeline', repoId: 'r1', anchor: { x: 200, y: 100, width: 40, height: 28 } };

  async function mountPopover(status: CiStatusView | null = ready()): Promise<VueWrapper> {
    api = fakeOverlayApi();
    if (status) api.pipelines.set('r1', status);
    answers.length = 0;
    const wrapper = mount(PipelinePopover, { props: { api, request, onAnswer: (answer: OverlayAnswer) => answers.push(answer) }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    return wrapper;
  }
  const button = (name: string): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>('button')].find((each) => each.getAttribute('aria-label') === name || each.textContent?.trim() === name);

  it('is the dialog "Pipeline #<n>" with the jobs by stage and an action per job; a waiting manual job has none', async () => {
    const wrapper = await mountPopover();
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.attributes('aria-label')).toBe('Pipeline #4312');
    expect(wrapper.get('[data-testid="forge-pipeline-title"]').text()).toBe('Pipeline #4312 · 3 of 5 jobs done');
    expect(wrapper.get('[data-testid="forge-pipeline-meta"]').text()).toBe('feature/forge-accounts · 4m 12s');
    expect(wrapper.findAll('[data-testid="forge-pipeline-stage"]').map((each) => each.text())).toEqual(['build', 'test', 'deploy']);
    expect(button('Cancel pipeline')).toBeDefined();
    expect(button('Cancel unit')).toBeDefined();
    expect(button('Retry e2e')).toBeDefined();
    expect(button('Open log: unit')).toBeDefined();
    const manual = wrapper.get('[data-job="review-app"]');
    expect(manual.findAll('button')).toHaveLength(0);
    expect(manual.text()).toContain('review-app, manual');
    expect(button('Open pipeline on gitlab.indigital.gr')).toBeDefined();
  });

  it('retries a job and hands focus to the Cancel that replaces Retry, then back', async () => {
    const wrapper = await mountPopover();
    const retry = button('Retry e2e')!;
    retry.focus();
    retry.click();
    await flushPromises();
    expect(api.forgeJobAction).toHaveBeenCalledWith('r1', { jobId: JOBS[3]!.id }, 'retry');
    // GitLab runs a retry as a new job with a new id
    api.forgeCiChanged({ repoId: 'r1', status: ready({ jobs: withJob('e2e', { id: 7777, state: 'running', canRetry: false, canCancel: true }) }) });
    await flushPromises();
    expect(button('Retry e2e')).toBeUndefined();
    expect(document.activeElement).toBe(button('Cancel e2e'));
    expect(wrapper.get('[data-testid="forge-pipeline-status"]').text()).toBe('e2e restarted.');

    button('Cancel e2e')!.click();
    await flushPromises();
    expect(api.forgeJobAction).toHaveBeenLastCalledWith('r1', { jobId: 7777 }, 'cancel');
    api.forgeCiChanged({ repoId: 'r1', status: ready({ jobs: withJob('e2e', { id: 7777, state: 'canceled', canRetry: true, canCancel: false }) }) });
    await flushPromises();
    expect(document.activeElement).toBe(button('Retry e2e'));
  });

  it('updates rows live and announces a job that finished politely', async () => {
    const wrapper = await mountPopover();
    api.forgeCiChanged({ repoId: 'r2', status: ready({ jobsDone: 0 }) });
    api.forgeCiChanged({ repoId: 'r1', status: ready({ jobsDone: 4, jobs: withJob('unit', { state: 'passed', canCancel: false, canRetry: true }) }) });
    await flushPromises();
    expect(wrapper.get('[data-job="unit"]').attributes('data-state')).toBe('passed');
    expect(wrapper.get('[data-testid="forge-pipeline-title"]').text()).toBe('Pipeline #4312 · 4 of 5 jobs done');
    const status = wrapper.get('[data-testid="forge-pipeline-status"]');
    expect(status.attributes('aria-live')).toBe('polite');
    expect(status.text()).toBe('unit passed. 4 of 5 jobs done.');
  });

  it('opens a job\'s log and closes itself; says so when an action is refused', async () => {
    const wrapper = await mountPopover();
    vi.mocked(api.forgeJobAction).mockResolvedValueOnce({ ok: true, value: false });
    button('Cancel unit')!.click();
    await flushPromises();
    expect(wrapper.get('[data-testid="forge-pipeline-alert"]').text()).toBe('Damocles could not cancel unit.');
    button('Open log: unit')!.click();
    await flushPromises();
    expect(api.forgeJobLogOpen).toHaveBeenCalledWith('r1', JOBS[2]!.id);
    expect(answers).toEqual([{ kind: 'dismissed' }]);
  });

  it('opens the pipeline on its server and says where', async () => {
    const wrapper = await mountPopover();
    button('Open pipeline on gitlab.indigital.gr')!.click();
    await flushPromises();
    expect(api.forgeOpenOnServer).toHaveBeenCalledWith('r1', { pipelineId: PIPELINE.id });
    expect(wrapper.get('[data-testid="forge-pipeline-status"]').text()).toBe('Opened Pipeline #4312 on gitlab.indigital.gr in your browser.');
  });

  it('shows why CI could not be read, with Try again', async () => {
    const wrapper = await mountPopover({ status: 'error', message: 'gitlab.indigital.gr did not answer in 25 seconds.' });
    expect(wrapper.get('[data-testid="forge-pipeline-error"]').attributes('role')).toBe('alert');
    expect(wrapper.get('[data-testid="forge-pipeline-error"]').text()).toContain('gitlab.indigital.gr did not answer in 25 seconds.');
    api.pipelines.set('r1', ready());
    await wrapper.get('[data-testid="forge-pipeline-retry-read"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Pipeline #4312');
  });

  it('shows a GitHub commit\'s checks by workflow, with each run\'s actions on its heading and none on other apps\' checks', async () => {
    const sha = '7c2d9e4f1a3b5c6d8e9f0a1b2c3d4e5f6a7b8c9d';
    const checks = ready({
      kind: 'github',
      id: 0,
      number: 0,
      state: 'failed',
      sha,
      failedCount: 1,
      jobsDone: 4,
      jobsTotal: 4,
      canRetry: false,
      canCancel: false,
      truncated: true,
      jobs: [
        job('unit', 'CI', 'failed', { id: 9401, runId: 64_312, canRetry: true, canCancel: false }),
        job('eslint', 'Lint', 'passed', { id: 9451, runId: 64_313, canRetry: true, canCancel: false }),
        job('deploy/netlify', '', 'passed', { id: 9601, kind: 'external', canRetry: false, canCancel: false, hasLog: false }),
        job('ci/circleci: build', '', 'passed', { id: 9501, kind: 'external', canRetry: false, canCancel: false, hasLog: false }),
      ],
      runs: [
        { id: 64_312, stage: 'CI', canRetry: true, canCancel: false },
        { id: 64_313, stage: 'Lint', canRetry: false, canCancel: true },
      ],
    });
    const wrapper = await mountPopover(checks);
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Checks');
    expect(wrapper.get('[data-testid="forge-pipeline-title"]').text()).toBe('Checks · failed');
    expect(wrapper.find('[data-testid="forge-pipeline-retry"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="forge-pipeline-stage"]').map((each) => each.text())).toEqual(['CI', 'Lint', 'Other checks']);
    for (const external of ['deploy/netlify', 'ci/circleci: build']) expect(wrapper.get(`[data-job="${external}"]`).findAll('button')).toHaveLength(0);
    expect(wrapper.get('[data-testid="forge-pipeline-truncated"]').text()).toBe('gitlab.indigital.gr lists more jobs than Damocles reads, so this list is cut.');
    button('Retry failed jobs of CI')!.click();
    await flushPromises();
    expect(api.forgeJobAction).toHaveBeenLastCalledWith('r1', { runId: 64_312 }, 'retry');
    button('Cancel Lint')!.click();
    await flushPromises();
    expect(api.forgeJobAction).toHaveBeenLastCalledWith('r1', { runId: 64_313 }, 'cancel');
    button('Retry unit')!.click();
    await flushPromises();
    expect(api.forgeJobAction).toHaveBeenLastCalledWith('r1', { jobId: 9401 }, 'retry');
    button('Open checks on gitlab.indigital.gr')!.click();
    await flushPromises();
    expect(api.forgeOpenOnServer).toHaveBeenCalledWith('r1', { sha });
    expect(wrapper.get('[data-testid="forge-pipeline-status"]').text()).toBe('Opened Checks on gitlab.indigital.gr in your browser.');
  });

  it('shows a failure its pipeline allows as a warning, in words too', async () => {
    const wrapper = await mountPopover(ready({ jobs: withJob('lint', { state: 'failed', allowedFailure: true }) }));
    const lint = wrapper.get('[data-job="lint"]');
    expect(lint.text()).toContain('lint, failed, allowed to fail');
    expect(lint.get('[data-testid="forge-pipeline-job-icon"]').classes()).toContain('text-(--d-warning-text)');
  });

  it('groups each stage under its heading, a list of its jobs inside', async () => {
    const wrapper = await mountPopover();
    const groups = wrapper.findAll('[role="group"]');
    expect(groups.map((group) => document.getElementById(group.attributes('aria-labelledby')!)?.textContent)).toEqual(['build', 'test', 'deploy']);
    expect(groups.map((group) => group.findAll('ul > li[data-testid="forge-pipeline-job"]').map((each) => each.attributes('data-job')))).toEqual([['compile', 'lint'], ['unit', 'e2e'], ['review-app']]);
  });

  it('sends one action for a double click, and says the action is under way', async () => {
    await mountPopover();
    let finish!: (done: { ok: true; value: boolean }) => void;
    vi.mocked(api.forgeJobAction).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const retry = button('Retry e2e')!;
    retry.click();
    retry.click();
    await flushPromises();
    expect(api.forgeJobAction).toHaveBeenCalledTimes(1);
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    finish({ ok: true, value: true });
    await flushPromises();
    expect(button('Retry e2e')!.getAttribute('aria-disabled')).toBeNull();
  });

  it('keeps two GitHub jobs of one name apart', async () => {
    const twins = ready({
      kind: 'github', id: 0, number: 0, state: 'running',
      jobs: [job('test', 'CI', 'running', { id: 9401, runId: 1 }), job('test', 'CI', 'passed', { id: 9402, runId: 1 })],
      runs: [{ id: 1, stage: 'CI', canRetry: false, canCancel: true }],
    });
    const wrapper = await mountPopover(twins);
    const rows = wrapper.findAll('[data-job="test"]');
    expect(rows.map((row) => row.attributes('data-state'))).toEqual(['running', 'passed']);
    expect(new Set(rows.map((row) => row.attributes('data-control-group'))).size).toBe(2);
  });

  it('names the commit of a pipeline that is not HEAD\'s, in the job list and the chip\'s tooltip', async () => {
    const sha = 'b'.repeat(40);
    const older = { ...ready({ sha }), head: 'c'.repeat(40) };
    const wrapper = await mountPopover(older);
    const hint = wrapper.get('[data-testid="forge-pipeline-other-commit"]');
    expect(hint.text()).toContain('bbbbbbb');
    expect(hint.attributes('title')).toBe('Shows commit bbbbbbb, not the current one');
    expect((await mountPopover({ ...ready({ sha }), head: sha })).find('[data-testid="forge-pipeline-other-commit"]').exists()).toBe(false);

    const chip = mount(PipelineChip, { props: { api: fakeShellApi(), repoId: 'r1', status: older }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(chip);
    expect(chip.get('[data-testid="forge-ci-chip"]').attributes('title')).toBe('Pipeline #4312 running, 3 of 5 jobs done, of commit bbbbbbb, not the current one. Show jobs');
    expect(chip.get('[data-testid="forge-ci-chip"]').attributes('aria-label')).toBe('Pipeline #4312 running, 3 of 5 jobs done');
  });

  it('gives every state its own icon, a waiting manual job a hand', async () => {
    expect(new Set(CI_STATES.map((state) => ciLook(state).icon)).size).toBe(CI_STATES.length);
    const wrapper = await mountPopover();
    expect(wrapper.get('[data-job="review-app"] [data-testid="forge-pipeline-job-icon"]').attributes('data-icon')).toBe('manual');
    expect(ciLook('manual').icon).toBe(Hand);
  });
});
