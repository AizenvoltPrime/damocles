// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ConsolidationOverlay from '../ConsolidationOverlay.vue';
import ConsolidationStepper from '../ConsolidationStepper.vue';
import { i18n } from '@/i18n';
import { useConsolidationStore } from '@/stores/useConsolidationStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { createConsolidationHandlers } from '@/composables/message-handler/handlers/consolidation-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { VSCODE_HOST_CAPABILITIES, type ExtensionToWebviewMessage, type WebviewToExtensionMessage } from '@shared/types/messages';
import type { ConsolidationFailure, ConsolidationResult } from '@shared/types/consolidation';
import { MAX_FAILED_ANSWERS } from '@shared/consolidation';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const mounted: VueWrapper[] = [];

function mountOverlay(failure?: ConsolidationFailure, setAside = 0): VueWrapper {
  if (failure) {
    useConsolidationStore().setResult({
      ranAt: Date.now(),
      trigger: 'manual',
      status: 'failed',
      extracted: [],
      maintenance: { promoted: 0, decayed: 0, pruned: 0 },
      candidatesReviewed: 0,
      failure,
    });
  }
  useConsolidationStore().setPendingCount(0, setAside);
  const wrapper = mount(ConsolidationOverlay, { global: { plugins: [i18n], stubs: { MarkdownRenderer: true } }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

const run = (contents: string[]): ConsolidationResult => ({
  ranAt: Date.now(),
  trigger: 'manual',
  status: contents.length ? 'extracted' : 'empty',
  extracted: contents.map((content) => ({ kind: 'fact', scope: 'project', content, outcome: 'inserted' as const })),
  maintenance: { promoted: 0, decayed: 0, pruned: 0 },
  candidatesReviewed: contents.length,
});

const signInButton = (wrapper: VueWrapper) => wrapper.findAll('button').find((b) => b.text() === i18n.global.t('consolidation.signIn'));

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('ConsolidationOverlay actions', () => {
  it('Run now triggers a pass', async () => {
    const wrapper = mountOverlay();
    await wrapper.get('[data-testid="consolidation-run"]').trigger('click');

    expect(posted).toEqual([{ type: 'triggerConsolidation' }]);
  });

  it('Retry triggers a pass after a failure', async () => {
    const wrapper = mountOverlay({ kind: 'error', detail: 'boom', phase: 'extract' });
    expect(signInButton(wrapper)).toBeUndefined();

    await wrapper.get('[data-testid="consolidation-retry"]').trigger('click');

    expect(posted).toEqual([{ type: 'triggerConsolidation' }]);
  });

  it('shows the set-aside count, with no pass run yet, and an action that returns those turns to the queue', async () => {
    const wrapper = mountOverlay(undefined, 2);
    const notice = wrapper.get('[data-testid="consolidation-set-aside"]');
    expect(notice.text()).toContain(i18n.global.t('consolidation.setAside.summary', { n: 2, attempts: MAX_FAILED_ANSWERS }, 2));
    expect(notice.text()).toContain(String(MAX_FAILED_ANSWERS));

    const action = wrapper.get('[data-testid="consolidation-set-aside-retry"]');
    expect(action.text()).toBe(i18n.global.t('consolidation.setAside.returnToQueue'));
    expect(action.text()).not.toBe(i18n.global.t('consolidation.retryNow'));
    await action.trigger('click');

    expect(posted).toEqual([{ type: 'retrySetAsideTurns' }]);
  });

  it('announces only the set-aside summary, never the button label', () => {
    const wrapper = mountOverlay(undefined, 1);
    const notice = wrapper.get('[data-testid="consolidation-set-aside"]');
    expect(notice.attributes('role')).toBeUndefined();
    const live = notice.get('[role="status"]');
    expect(live.text()).toBe(i18n.global.t('consolidation.setAside.summary', { n: 1, attempts: MAX_FAILED_ANSWERS }, 1));
    expect(live.find('button').exists()).toBe(false);
  });

  it('localizes the stepper reasons and counts extraction progress in turns', async () => {
    const store = useConsolidationStore();
    const wrapper = mountOverlay();
    store.startRun();
    store.applyProgress({ phase: 'extract', status: 'active', meta: { count: 4, done: 2, total: 4 } });
    await wrapper.vm.$nextTick();
    const extract = () => wrapper.findAll('[data-testid="consolidation-phase"]')[1]!;
    expect(extract().text()).toContain('2/4');

    store.applyProgress({ phase: 'extract', status: 'failed', meta: { reason: 'rejected' } });
    store.applyProgress({ phase: 'persist', status: 'skipped', meta: { reason: 'no-queued-turns' } });
    await wrapper.vm.$nextTick();
    expect(extract().text()).toContain(i18n.global.t('consolidation.stepper.reason.rejected'));
    const persist = wrapper.findAll('[data-testid="consolidation-phase"]')[2]!;
    expect(persist.text()).toContain(i18n.global.t('consolidation.stepper.reason.noQueuedTurns'));
  });

  it('shows no set-aside notice when no turn is set aside', () => {
    const wrapper = mountOverlay({ kind: 'error', detail: 'boom', phase: 'extract' });
    expect(wrapper.find('[data-testid="consolidation-set-aside"]').exists()).toBe(false);
  });

  it('Sign in opens the Accounts settings in the page when the host keeps settings there', async () => {
    const wrapper = mountOverlay({ kind: 'no-model' });

    await signInButton(wrapper)!.trigger('click');

    expect(useUIStore().showSettingsModal).toBe(true);
    expect(useUIStore().settingsTarget).toEqual({ section: 'accounts' });
    expect(posted).toEqual([]);
  });

  it('words a refused credential as a sign-in problem and offers Sign in', async () => {
    const wrapper = mountOverlay({ kind: 'error', reason: 'credential', phase: 'extract' });

    const strip = wrapper.get('[data-testid="consolidation-strip"]').text();
    expect(strip).toContain(i18n.global.t('consolidation.failure.extract', { reason: i18n.global.t('consolidation.stepper.reason.credential') }));
    expect(strip).not.toContain(i18n.global.t('consolidation.stepper.reason.unreachable'));
    await signInButton(wrapper)!.trigger('click');

    expect(useUIStore().settingsTarget).toEqual({ section: 'accounts' });
  });

  it('words a refused access (HTTP 403) as the provider refusing access and offers no Sign in', () => {
    const wrapper = mountOverlay({ kind: 'error', reason: 'forbidden', phase: 'extract' });

    const strip = wrapper.get('[data-testid="consolidation-strip"]').text();
    expect(strip).toContain(i18n.global.t('consolidation.failure.extract', { reason: i18n.global.t('consolidation.stepper.reason.forbidden') }));
    expect(i18n.global.t('consolidation.stepper.reason.forbidden')).not.toBe('consolidation.stepper.reason.forbidden');
    expect(signInButton(wrapper)).toBeUndefined();
  });

  it('offers no Sign in for an unreachable model', () => {
    const wrapper = mountOverlay({ kind: 'error', reason: 'unreachable', phase: 'extract' });
    expect(signInButton(wrapper)).toBeUndefined();
  });

  it('dates the failure footer from the newest pass as soon as its result arrives', async () => {
    const store = useConsolidationStore();
    store.setResult({
      ranAt: Date.now() - 2 * 60_000,
      trigger: 'manual',
      status: 'failed',
      extracted: [],
      maintenance: { promoted: 0, decayed: 0, pruned: 0 },
      candidatesReviewed: 1,
      failure: { kind: 'error', reason: 'unreachable', phase: 'extract' },
    });
    const wrapper = mountOverlay();
    await wrapper.vm.$nextTick();
    const footer = () => i18n.global.t('consolidation.failedAt', { phase: i18n.global.t('consolidation.phase.extract'), when: '' });
    expect(wrapper.text()).toContain(`${footer()}${i18n.global.t('time.minutesAgo', { n: 2 })}`);

    store.setResult({ ...store.lastResult!, ranAt: Date.now() });
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain(`${footer()}${i18n.global.t('time.justNow')}`);
  });

  it('shows a run that extracted before it failed: its memories, their count and the failure', () => {
    useConsolidationStore().setResult({
      ranAt: Date.now(),
      trigger: 'manual',
      status: 'failed',
      extracted: [
        { kind: 'fact', scope: 'project', content: 'The build uses esbuild.', outcome: 'inserted' },
        { kind: 'fact', scope: 'project', content: 'Tests run under vitest.', outcome: 'inserted' },
      ],
      maintenance: { promoted: 0, decayed: 0, pruned: 0 },
      candidatesReviewed: 3,
      failure: { kind: 'error', reason: 'unreachable', phase: 'extract' },
    });
    const wrapper = mountOverlay();

    const strip = wrapper.get('[data-testid="consolidation-strip"]').text();
    expect(strip).toContain(i18n.global.t('consolidation.extracted', { n: 2 }));
    expect(strip).toContain(i18n.global.t('consolidation.failure.extract', { reason: i18n.global.t('consolidation.stepper.reason.unreachable') }));
    expect(wrapper.find('[data-testid="consolidation-retry"]').exists()).toBe(true);
    expect(wrapper.text()).toContain(i18n.global.t('overlays.consolidation.lastRun', { n: 2 }));
    expect(wrapper.findAll('[data-testid="consolidation-extracted"]')).toHaveLength(2);
  });

  it('starts the stepper over when the next pass of a run claims', async () => {
    const store = useConsolidationStore();
    const wrapper = mountOverlay();
    store.setRunning(true);
    for (const phase of store.phaseIds) store.applyProgress({ phase, status: 'done' });

    store.applyProgress({ phase: 'claim', status: 'done', meta: { count: 1 } });
    await wrapper.vm.$nextTick();

    expect(store.isRunning).toBe(true);
    expect(store.phaseStatus).toEqual({ claim: 'done', extract: 'pending', persist: 'pending', maintain: 'pending', profiles: 'pending' });
  });

  it('keeps the last run in view through a run\'s first pass, then shows this run\'s memories and names the pass in the strip', async () => {
    const store = useConsolidationStore();
    store.setResult(run(['Previous run memory.']));
    const wrapper = mountOverlay();
    const heading = () => wrapper.get('[data-testid="consolidation-results-heading"]').text();
    const extracted = () => wrapper.findAll('[data-testid="consolidation-extracted"]').map((m) => m.html());
    const strip = () => wrapper.get('[data-testid="consolidation-strip"]').text();
    const stepperRows = () => wrapper.getComponent(ConsolidationStepper).element.childElementCount;

    store.setRunning(true, 1);
    await wrapper.vm.$nextTick();
    expect(heading()).toBe(i18n.global.t('overlays.consolidation.lastRun', { n: 1 }));
    expect(extracted()).toHaveLength(1);
    expect(extracted()[0]).toContain('Previous run memory.');
    expect(strip()).not.toContain(i18n.global.t('consolidation.strip.pass', { n: 1 }));
    const firstPassRows = stepperRows();

    store.setRunning(true, 2, run(['First pass memory.']));
    store.applyProgress({ phase: 'claim', status: 'done', meta: { count: 1 } });
    await wrapper.vm.$nextTick();
    expect(heading()).toBe(i18n.global.t('overlays.consolidation.thisRun', { n: 1 }));
    expect(extracted()).toHaveLength(1);
    expect(extracted()[0]).toContain('First pass memory.');
    expect(wrapper.html()).not.toContain('Previous run memory.');
    expect(strip()).toContain(i18n.global.t('consolidation.strip.pass', { n: 2 }));
    expect(stepperRows()).toBe(firstPassRows);

    store.setResult(run(['First pass memory.', 'Second pass memory.']));
    store.setRunning(false);
    await wrapper.vm.$nextTick();
    expect(heading()).toBe(i18n.global.t('overlays.consolidation.lastRun', { n: 2 }));
    expect(extracted()).toHaveLength(2);
    expect(strip()).not.toContain(i18n.global.t('consolidation.strip.pass', { n: 2 }));
  });

  it('says a later pass has kept nothing yet when the run\'s earlier passes kept nothing', async () => {
    const store = useConsolidationStore();
    store.setResult(run(['Previous run memory.']));
    const wrapper = mountOverlay();

    store.setRunning(true, 2, run([]));
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[data-testid="consolidation-results-heading"]').text()).toBe(i18n.global.t('overlays.consolidation.thisRun', { n: 0 }));
    expect(wrapper.text()).toContain(i18n.global.t('overlays.consolidation.thisRunEmpty'));
    expect(wrapper.findAll('[data-testid="consolidation-extracted"]')).toEqual([]);
  });

  it('restores a run in flight from the replay core sends when the overlay opens mid-run', async () => {
    // The order core's `requestConsolidationPreview` posts; consolidation-replay-parity.test.ts feeds core's own replay to the store.
    const sent: ExtensionToWebviewMessage[] = [
      { type: 'consolidationPreview', candidates: [] },
      { type: 'consolidationPendingCount', count: 1, setAside: 0 },
      { type: 'consolidationResult', result: run(['Previous run memory.']) },
      { type: 'consolidationRunning', running: true, pass: 2, runSoFar: run(['First pass memory.']) },
      { type: 'consolidationProgress', event: { phase: 'claim', status: 'active' } },
      { type: 'consolidationProgress', event: { phase: 'claim', status: 'done', meta: { count: 1 } } },
      { type: 'consolidationProgress', event: { phase: 'extract', status: 'active' } },
    ];

    const wrapper = mountOverlay();
    const handlers = createConsolidationHandlers();
    const ctx = { stores: { consolidationStore: useConsolidationStore() } } as unknown as HandlerContext;
    for (const msg of sent) (handlers[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined)!(msg, ctx);
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[data-testid="consolidation-results-heading"]').text()).toBe(i18n.global.t('overlays.consolidation.thisRun', { n: 1 }));
    const extracted = wrapper.findAll('[data-testid="consolidation-extracted"]');
    expect(extracted).toHaveLength(1);
    expect(extracted[0]!.html()).toContain('First pass memory.');
    expect(wrapper.get('[data-testid="consolidation-strip"]').text()).toContain(i18n.global.t('consolidation.strip.pass', { n: 2 }));
    expect(useConsolidationStore().phaseStatus).toMatchObject({ claim: 'done', extract: 'active' });
  });

  it('keys each extracted memory uniquely, so a memory a run kept twice renders twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = useConsolidationStore();
    store.setResult(run(['Earlier memory.']));
    const wrapper = mountOverlay();

    const twice: ConsolidationResult = {
      ...run([]),
      status: 'extracted',
      extracted: [
        { kind: 'preference', scope: 'global', content: 'Prefers tabs.', outcome: 'inserted' },
        { kind: 'preference', scope: 'global', content: 'Prefers tabs.', outcome: 'deduped' },
      ],
    };
    store.setResult(twice);
    await wrapper.vm.$nextTick();

    const extracted = wrapper.findAll('[data-testid="consolidation-extracted"]');
    expect(extracted.map((m) => m.text())).toEqual([
      expect.stringContaining(i18n.global.t('consolidation.outcome.inserted')),
      expect.stringContaining(i18n.global.t('consolidation.outcome.deduped')),
    ]);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('Duplicate keys');
    warn.mockRestore();
  });

  it('Sign in asks core for the Accounts settings when the host keeps them outside the page', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, settingsInPanel: false });
    const wrapper = mountOverlay({ kind: 'no-model' });

    await signInButton(wrapper)!.trigger('click');

    expect(posted).toEqual([{ type: 'openAppSettings', section: 'accounts' }]);
  });
});
