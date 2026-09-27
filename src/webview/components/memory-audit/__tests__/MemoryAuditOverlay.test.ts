// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import MemoryAuditOverlay from '../MemoryAuditOverlay.vue';
import MemoryPanel from '../../MemoryPanel.vue';
import { i18n } from '@/i18n';
import { useMemoryAuditStore } from '@/stores/useMemoryAuditStore';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useConsolidationStore } from '@/stores/useConsolidationStore';
import { useUIStore } from '@/stores/useUIStore';
import { createMemoryHandlers } from '@/composables/message-handler/handlers/memory-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import {
  MEMORY_AUDIT_BANNER_MIN_ELIGIBLE,
  QUALITY_AUDIT_FORGET_REASON,
  type MemoryAuditEstimate,
  type MemoryAuditProposalView,
  type MemoryAuditRunView,
  type MemoryAuditStatePayload,
  type MemoryAuditSummary,
} from '@shared/types/memory-audit';
import type { MemoryEntry } from '@shared/types/memory';

const host = vi.hoisted(() => ({ posted: [] as WebviewToExtensionMessage[], persisted: undefined as unknown }));
vi.mock('@/composables/useVSCode', () => ({
  useVSCode: () => ({
    postMessage: (m: WebviewToExtensionMessage) => host.posted.push(m),
    getState: () => host.persisted,
    setState: (s: unknown) => { host.persisted = s; },
  }),
}));
const toasts = vi.hoisted((): string[] => []);
vi.mock('vue-sonner', () => {
  const record = (text: string) => void toasts.push(text);
  return { toast: Object.assign(record, { success: record, error: record, info: record }) };
});

const RUN_ID = 'run-1';

function estimate(over: Partial<MemoryAuditEstimate> = {}): MemoryAuditEstimate {
  return {
    memoryCount: 1000, profileCount: 2, batchCount: 50, inputTokens: 200_000, outputTokens: 45_000,
    model: { provider: 'anthropic', id: 'claude-haiku', inputPerMTok: 1, outputPerMTok: 5, dollarBilled: true },
    unpriced: false, costUsd: 0.4, ...over,
  };
}

function run(over: Partial<MemoryAuditRunView> = {}): MemoryAuditRunView {
  return {
    id: RUN_ID, status: 'completed', startedAt: 1, finishedAt: 2, total: 20, graded: 20, failedBatches: 0,
    rubricVersion: 1, ownedByThisWindow: true, leaseActive: false, ...over,
  };
}

function proposal(id: string, over: Partial<MemoryAuditProposalView> = {}): MemoryAuditProposalView {
  return {
    id, runId: RUN_ID, action: 'forget', status: 'pending', reason: `reason ${id}`, memoryId: `m-${id}`, kind: 'fact',
    title: `title ${id}`, contentPreview: `content ${id}`, currentScope: 'project', currentWorkspace: 'c:/work/alpha',
    targetWorkspace: null, profileScope: null, profileWorkspace: null, profileBefore: null, profileAfter: null, ...over,
  };
}

function payload(over: Partial<MemoryAuditStatePayload> = {}): MemoryAuditStatePayload {
  return { run: null, proposals: [], estimate: estimate(), hasAnyRun: false, eligibleCount: 1000, startEndsLatestRun: false, ...over };
}

function summary(over: Partial<MemoryAuditSummary> = {}): MemoryAuditSummary {
  return { hasAnyRun: false, eligibleCount: 1000, running: false, runningHere: false, pendingCount: 0, ...over };
}

function handlerContext(): HandlerContext {
  return {
    stores: {
      memoryStore: useMemoryStore(),
      contextInjectionStore: useContextInjectionStore(),
      consolidationStore: useConsolidationStore(),
      uiStore: useUIStore(),
      memoryAuditStore: useMemoryAuditStore(),
    },
  } as unknown as HandlerContext;
}

/** Delivers a host message through the real webview handler, as the dispatcher does. */
async function deliver(msg: ExtensionToWebviewMessage): Promise<void> {
  const handler = createMemoryHandlers()[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`no handler for ${msg.type}`);
  handler(msg, handlerContext());
  await nextTick();
}

const mounted: VueWrapper[] = [];

async function openOverlay(state: MemoryAuditStatePayload | null = payload()): Promise<VueWrapper> {
  useMemoryAuditStore().openOverlay();
  const wrapper = mount(MemoryAuditOverlay, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  if (state) await deliver({ type: 'memoryAuditState', state });
  await nextTick();
  return wrapper;
}

const ofType = <T extends WebviewToExtensionMessage['type']>(type: T) =>
  host.posted.filter((m): m is Extract<WebviewToExtensionMessage, { type: T }> => m.type === type);

beforeEach(() => {
  host.posted.length = 0;
  host.persisted = undefined;
  toasts.length = 0;
  setActivePinia(createPinia());
  document.body.innerHTML = '';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
});

describe('estimate', () => {
  it('asks for the audit state on open and renders the estimate with grouped counts', async () => {
    const wrapper = await openOverlay();

    expect(ofType('requestMemoryAudit')).toHaveLength(1);
    const est = wrapper.get('[data-audit-estimate]');
    expect(est.get('[data-estimate="memories"]').text()).toBe('1,000');
    expect(est.get('[data-estimate="profiles"]').text()).toBe('2');
    expect(est.get('[data-estimate="input-tokens"]').text()).toBe('200.0K');
    expect(est.get('[data-estimate="output-tokens"]').text()).toBe('45.0K');
    expect(est.get('[data-estimate="model"]').text()).toBe('anthropic/claude-haiku');
  });

  it('shows a billed cost as a plain amount', async () => {
    const wrapper = await openOverlay();

    expect(wrapper.get('[data-estimate="cost-label"]').text()).toBe('Estimated cost');
    expect(wrapper.get('[data-estimate="cost"]').text()).toBe('$0.40');
    expect(wrapper.get('[data-estimate="cost"]').attributes('title')).toBeUndefined();
  });

  it('shows a subscription cost as an API-equivalent estimate', async () => {
    const e = estimate();
    const wrapper = await openOverlay(payload({ estimate: { ...e, model: { ...e.model!, dollarBilled: false } } }));

    expect(wrapper.get('[data-estimate="cost-label"]').text()).toBe('API-equivalent cost');
    expect(wrapper.get('[data-estimate="cost"]').text()).toBe('~$0.40 est.');
    expect(wrapper.get('[data-estimate="cost"]').attributes('title')).toBe(i18n.global.t('team.costEstimateTooltip'));
  });

  it('shows an unpriced model as unpriced, never as a price', async () => {
    const wrapper = await openOverlay(payload({ estimate: estimate({ unpriced: true, costUsd: null }) }));

    expect(wrapper.get('[data-estimate="cost"]').text()).toBe('unpriced');
    expect(wrapper.get('[data-estimate="cost"]').attributes('title')).toBe(i18n.global.t('common.unpricedTooltip'));
    expect(wrapper.get('[data-audit-start]').attributes('disabled')).toBeUndefined();
  });

  it('cannot start without a sub-call model', async () => {
    const wrapper = await openOverlay(payload({ estimate: estimate({ model: null, costUsd: null }) }));

    expect(wrapper.find('[data-audit-no-model]').exists()).toBe(true);
    expect(wrapper.find('[data-estimate="cost"]').exists()).toBe(false);
    expect(wrapper.get('[data-audit-start]').attributes('disabled')).toBeDefined();
  });

  it('starts a run and holds the button until the host answers', async () => {
    const wrapper = await openOverlay();

    await wrapper.get('[data-audit-start]').trigger('click');

    expect(ofType('startMemoryAudit')).toHaveLength(1);
    expect(wrapper.get('[data-audit-start]').attributes('disabled')).toBeDefined();
  });

  it('warns before a new run ends review and revert of the current one', async () => {
    const wrapper = await openOverlay(payload({ hasAnyRun: true, run: run(), proposals: [proposal('p1')], startEndsLatestRun: true }));

    await wrapper.get('[data-audit-start]').trigger('click');
    expect(ofType('startMemoryAudit')).toHaveLength(0);
    expect(wrapper.get('[data-audit-start-prompt]').text()).toContain('ends review and revert of the current run');

    await wrapper.get('[data-audit-start-cancel]').trigger('click');
    expect(wrapper.find('[data-audit-start-prompt]').exists()).toBe(false);
    expect(ofType('startMemoryAudit')).toHaveLength(0);

    await wrapper.get('[data-audit-start]').trigger('click');
    await wrapper.get('[data-audit-start-confirm]').trigger('click');
    expect(ofType('startMemoryAudit')).toHaveLength(1);
  });
});

describe('progress', () => {
  it('replaces the estimate with live counts and holds a cancel until its definite answer', async () => {
    const wrapper = await openOverlay();
    await wrapper.get('[data-audit-start]').trigger('click');

    await deliver({ type: 'memoryAuditProgress', progress: { runId: RUN_ID, graded: 5, total: 20, failedBatches: 1, status: 'running' } });

    expect(wrapper.find('[data-audit-estimate]').exists()).toBe(false);
    expect(wrapper.get('[data-audit-progress-count]').text()).toBe('5 of 20 graded');
    expect(wrapper.get('[data-audit-progress-failed]').text()).toBe('1 batch failed');

    await wrapper.get('[data-audit-cancel]').trigger('click');
    expect(ofType('cancelMemoryAudit')).toHaveLength(1);
    expect(wrapper.get('[data-audit-cancel]').attributes('disabled')).toBeDefined();

    await deliver({ type: 'memoryAuditState', state: payload({ run: run({ status: 'running', graded: 6 }), hasAnyRun: true }) });
    expect(useMemoryAuditStore().pendingAction).toBe('cancel');

    await deliver({ type: 'memoryAuditState', state: payload({ run: run({ status: 'cancelled', graded: 6 }), hasAnyRun: true }) });
    await deliver({ type: 'memoryAuditCancelResult', result: 'cancelled' });

    expect(useMemoryAuditStore().pendingAction).toBeNull();
    expect(wrapper.find('[data-audit-progress]').exists()).toBe(false);
    expect(wrapper.get('[data-audit-run-summary]').text()).toContain('cancelled: 6 of 20 graded');
  });

  it('explains that a run held by another window can only be cancelled there', async () => {
    const wrapper = await openOverlay(payload({ run: run({ status: 'running', graded: 3 }), hasAnyRun: true }));
    await wrapper.get('[data-audit-cancel]').trigger('click');

    await deliver({ type: 'memoryAuditCancelResult', result: 'held-elsewhere' });

    expect(wrapper.get('[data-audit-cancel-held]').text()).toBe(i18n.global.t('memoryAudit.cancelHeldElsewhere'));
    expect(wrapper.get('[data-audit-cancel]').attributes('disabled')).toBeUndefined();
    expect(toasts).toEqual([]);
  });

  it('shows a notice and no progress when another window holds the run', async () => {
    const wrapper = await openOverlay(payload({
      run: run({ status: 'running', graded: 3, ownedByThisWindow: false, leaseActive: true }), hasAnyRun: true,
    }));

    expect(wrapper.find('[data-audit-held]').exists()).toBe(true);
    expect(wrapper.find('[data-audit-progress]').exists()).toBe(false);
    expect(wrapper.get('[data-audit-start]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-audit-refresh]').trigger('click');
    expect(ofType('requestMemoryAudit')).toHaveLength(2);
  });
});

describe('review', () => {
  const reviewState = (): MemoryAuditStatePayload => payload({
    hasAnyRun: true,
    run: run(),
    proposals: [
      proposal('p-ep', { action: 'to_episode' }),
      proposal('p-f1'),
      proposal('p-f2'),
      proposal('p-f3', { status: 'stale' }),
      proposal('p-ws', { action: 'rescope_workspace', targetWorkspace: 'c:/work/beta' }),
      proposal('p-gl', { action: 'rescope_global' }),
      proposal('p-prof', {
        action: 'profile_rewrite', memoryId: null, kind: null, title: null, contentPreview: null, currentScope: null,
        currentWorkspace: null, profileScope: 'project', profileWorkspace: 'c:/work/alpha',
        profileBefore: { static: 'old static', dynamic: 'old dynamic' },
        profileAfter: { static: 'new static', dynamic: '' },
      }),
    ],
  });

  const row = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-audit-proposal="${id}"]`);
  const decide = (wrapper: VueWrapper, id: string, decision: string) =>
    row(wrapper, id).get(`[data-audit-decision-option="${decision}"]`).trigger('click');
  const decideGroup = (wrapper: VueWrapper, group: string, decision: string) =>
    wrapper.get(`[data-audit-group="${group}"] [data-audit-group-decision] [data-audit-decision-option="${decision}"]`).trigger('click');
  const groupState = (wrapper: VueWrapper, group: string) =>
    wrapper.get(`[data-audit-group="${group}"] [data-audit-group-decision]`).attributes('data-decision');

  it('groups proposals by action in a fixed order with reasons, scope changes and the profile diff', async () => {
    const wrapper = await openOverlay(reviewState());

    const groups = wrapper.findAll('[data-audit-group]').map((g) => g.attributes('data-audit-group'));
    expect(groups).toEqual(['forget', 'rescope_global', 'rescope_workspace', 'to_episode', 'profile_rewrite']);
    expect(wrapper.findAll('[data-audit-group="forget"] [data-audit-proposal]')).toHaveLength(3);

    const ws = row(wrapper, 'p-ws');
    expect(ws.get('[data-audit-reason]').text()).toBe('Reason: reason p-ws');
    expect(ws.get('[data-audit-change]').text()).toContain('Project · alpha');
    expect(ws.get('[data-audit-change]').text()).toContain('Project · beta');
    expect(row(wrapper, 'p-gl').get('[data-audit-change]').text()).toContain('Global');

    const prof = row(wrapper, 'p-prof');
    expect(prof.text()).toContain('Project profile (alpha)');
    expect(prof.find('[data-audit-profile-diff]').exists()).toBe(true);
    expect(prof.get('[data-profile-before="static"]').text()).toBe('old static');
    expect(prof.get('[data-profile-after="static"]').text()).toBe('new static');
    expect(prof.get('[data-profile-after="dynamic"]').text()).toBe('(empty)');
    expect(row(wrapper, 'p-f1').find('[data-audit-profile-diff]').exists()).toBe(false);
  });

  it('starts every pending proposal undecided, and apply stays off until something is decided', async () => {
    const wrapper = await openOverlay(reviewState());

    const controls = wrapper.findAll('[data-audit-decision]');
    expect(controls).toHaveLength(6);
    for (const control of controls) expect(control.attributes('data-decision')).toBe('undecided');
    const stale = row(wrapper, 'p-f3');
    expect(stale.find('[data-audit-decision]').exists()).toBe(false);
    expect(stale.get('[data-audit-status]').text()).toBe('Stale');
    expect(wrapper.get('[data-audit-apply-summary]').text()).toBe('0 to apply, 0 to reject, 6 undecided');
    expect(wrapper.get('[data-audit-apply]').attributes('disabled')).toBeDefined();
  });

  it('sends only explicit decisions and leaves undecided proposals out of both lists', async () => {
    const wrapper = await openOverlay(reviewState());

    await decide(wrapper, 'p-f1', 'accept');
    await decide(wrapper, 'p-prof', 'accept');
    await decide(wrapper, 'p-ep', 'reject');
    await decide(wrapper, 'p-ws', 'accept');
    await decide(wrapper, 'p-ws', 'undecided');
    expect(wrapper.get('[data-audit-apply-summary]').text()).toBe('2 to apply, 1 to reject, 3 undecided');

    await wrapper.get('[data-audit-apply]').trigger('click');

    const [apply] = ofType('applyMemoryAudit');
    expect(apply?.runId).toBe(RUN_ID);
    expect(apply?.accept.sort()).toEqual(['p-f1', 'p-prof']);
    expect(apply?.reject).toEqual(['p-ep']);
    expect(wrapper.get('[data-audit-apply]').attributes('disabled')).toBeDefined();
  });

  it('keeps a decision when its pressed option is clicked again', async () => {
    const wrapper = await openOverlay(reviewState());

    await decide(wrapper, 'p-f1', 'reject');
    await decide(wrapper, 'p-f1', 'reject');

    expect(row(wrapper, 'p-f1').get('[data-audit-decision]').attributes('data-decision')).toBe('reject');
  });

  it('sets every pending row of a group at once, and shows a mixed group when the rows differ', async () => {
    const wrapper = await openOverlay(reviewState());

    await decideGroup(wrapper, 'forget', 'accept');
    expect(groupState(wrapper, 'forget')).toBe('accept');
    for (const id of ['p-f1', 'p-f2']) expect(row(wrapper, id).get('[data-audit-decision]').attributes('data-decision')).toBe('accept');
    expect(wrapper.find('[data-audit-group="forget"] [data-audit-group-mixed]').exists()).toBe(false);

    await decide(wrapper, 'p-f2', 'reject');
    expect(groupState(wrapper, 'forget')).toBe('mixed');
    expect(wrapper.get('[data-audit-group="forget"] [data-audit-group-mixed]').text()).toBe('Mixed');

    await decideGroup(wrapper, 'forget', 'reject');
    expect(groupState(wrapper, 'forget')).toBe('reject');
    expect(wrapper.get('[data-audit-apply-summary]').text()).toBe('0 to apply, 2 to reject, 4 undecided');
  });

  it('names each decision control after its memory, capped for long previews', async () => {
    const long = 'x'.repeat(240);
    const state = reviewState();
    state.proposals.push(proposal('p-long', { title: null, contentPreview: long }));
    const wrapper = await openOverlay(state);

    expect(row(wrapper, 'p-f1').get('[data-audit-decision]').attributes('aria-label')).toBe('Decision for title p-f1');
    expect(row(wrapper, 'p-prof').get('[data-audit-decision]').attributes('aria-label')).toBe('Decision for Project profile (alpha)');
    const label = row(wrapper, 'p-long').get('[data-audit-decision]').attributes('aria-label')!;
    expect(label).toBe(`Decision for ${'x'.repeat(59)}…`);
    expect(wrapper.get('[data-audit-group="forget"] [data-audit-group-decision]').attributes('aria-label'))
      .toBe('Decision for every proposal in Forget');
  });

  it('holds apply until its result, then reports what was left alone', async () => {
    const wrapper = await openOverlay(reviewState());
    await decide(wrapper, 'p-f1', 'accept');
    await decide(wrapper, 'p-f2', 'accept');
    await decide(wrapper, 'p-ep', 'reject');
    await wrapper.get('[data-audit-apply]').trigger('click');

    const after = reviewState();
    after.proposals = after.proposals.map((p) => {
      if (p.id === 'p-f1') return { ...p, status: 'applied' as const };
      if (p.id === 'p-f2') return { ...p, status: 'stale' as const };
      if (p.id === 'p-ep') return { ...p, status: 'rejected' as const };
      return p;
    });
    await deliver({ type: 'memoryAuditState', state: after });
    expect(wrapper.get('[data-audit-apply]').text()).toBe('Applying…');

    await deliver({ type: 'memoryAuditResult', result: { action: 'apply', applied: 1, stale: 1, rejected: 1 } });

    expect(wrapper.get('[data-audit-result]').text()).toBe(
      'Applied 1 change. 1 proposal rejected. 1 accepted change was not applied because its memory changed after grading.',
    );
    expect(wrapper.get('[data-audit-apply]').text()).toBe('Apply decisions');
    expect(toasts).toEqual([]);
  });

  it('toasts an apply result that arrives after the overlay closed', async () => {
    await deliver({ type: 'memoryAuditResult', result: { action: 'apply', applied: 2, stale: 0, rejected: 0 } });
    expect(toasts).toEqual(['Applied 2 changes.']);
  });

  it('reverts a run with applied proposals only after confirmation, and reports skipped rows', async () => {
    const state = reviewState();
    state.proposals = state.proposals.map((p) => (p.status === 'pending' ? { ...p, status: 'applied' as const } : p));
    const wrapper = await openOverlay(state);

    expect(row(wrapper, 'p-f1').get('[data-audit-status]').text()).toBe('Applied');
    await wrapper.get('[data-audit-revert]').trigger('click');
    expect(wrapper.get('[data-audit-revert-prompt]').text()).toContain('6 applied changes');
    await wrapper.get('[data-audit-revert-cancel]').trigger('click');
    expect(ofType('revertMemoryAudit')).toHaveLength(0);

    await wrapper.get('[data-audit-revert]').trigger('click');
    await wrapper.get('[data-audit-revert-confirm]').trigger('click');

    expect(ofType('revertMemoryAudit')).toEqual([{ type: 'revertMemoryAudit', runId: RUN_ID }]);

    const reverted = state.proposals.map((p) => (p.status === 'applied' ? { ...p, status: 'reverted' as const } : p));
    await deliver({ type: 'memoryAuditState', state: { ...state, proposals: reverted } });
    await deliver({ type: 'memoryAuditResult', result: { action: 'revert', reverted: 5, skipped: 1 } });
    expect(wrapper.find('[data-audit-revert]').exists()).toBe(false);
    expect(row(wrapper, 'p-f1').get('[data-audit-status]').text()).toBe('Reverted');
    expect(wrapper.get('[data-audit-result]').text()).toBe(
      'Reverted 5 changes. 1 change was left as it is because its memory changed after the audit applied it.',
    );
  });

  it('drops a revert prompt left open when a new state arrives', async () => {
    const state = reviewState();
    state.proposals = state.proposals.map((p) => (p.status === 'pending' ? { ...p, status: 'applied' as const } : p));
    const wrapper = await openOverlay(state);
    await wrapper.get('[data-audit-revert]').trigger('click');

    await deliver({ type: 'memoryAuditState', state: { ...state } });

    expect(wrapper.find('[data-audit-revert-prompt]').exists()).toBe(false);
    expect(wrapper.find('[data-audit-revert]').exists()).toBe(true);
  });

  it('says so when a finished run proposed nothing', async () => {
    const wrapper = await openOverlay(payload({ hasAnyRun: true, run: run() }));
    expect(wrapper.get('[data-audit-no-proposals]').text()).toBe('The audit proposed no changes.');
  });
});

describe('errors', () => {
  it('shows a localized audit error in the overlay without a toast and releases the pending action', async () => {
    const wrapper = await openOverlay();
    await wrapper.get('[data-audit-start]').trigger('click');

    await deliver({ type: 'memoryError', source: 'audit', code: 'busy', message: 'A quality audit is already running in this or another window.' });

    expect(wrapper.get('[data-audit-error]').text()).toBe(i18n.global.t('memoryAudit.error.busy'));
    expect(toasts).toEqual([]);
    expect(wrapper.get('[data-audit-start]').attributes('disabled')).toBeUndefined();
  });

  it('renders the error code in the UI locale, keeping the English message for the log', async () => {
    const wrapper = await openOverlay();
    i18n.global.locale.value = 'el';
    try {
      await deliver({ type: 'memoryError', source: 'audit', code: 'no-model', message: 'No model with a configured credential' });
      expect(wrapper.get('[data-audit-error]').text()).toBe(i18n.global.t('memoryAudit.error.no-model'));
      expect(wrapper.get('[data-audit-error]').text()).not.toContain('No model');
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No model with a configured credential'));
    } finally {
      i18n.global.locale.value = 'en';
    }
  });

  it('replaces the loading spinner with the error when the state cannot load', async () => {
    const wrapper = await openOverlay(null);
    expect(wrapper.find('[data-audit-loading]').exists()).toBe(true);

    await deliver({ type: 'memoryError', source: 'audit', code: 'unavailable', message: 'Memory system is not available' });

    expect(wrapper.find('[data-audit-loading]').exists()).toBe(false);
    expect(wrapper.get('[data-audit-error]').text()).toBe(i18n.global.t('memoryAudit.error.unavailable'));
  });

  it('toasts an error while the overlay is closed only when it answers a pending action or ends a run', async () => {
    await deliver({ type: 'memoryError', source: 'audit', code: 'unavailable', message: 'Memory system is not available' });
    expect(toasts).toEqual([]);
    expect(useMemoryAuditStore().error).toBeNull();

    await deliver({ type: 'memoryError', source: 'audit', code: 'all-failed', message: 'every call failed' });
    expect(toasts).toEqual([i18n.global.t('memoryAudit.error.all-failed')]);

    useMemoryAuditStore().start();
    await deliver({ type: 'memoryError', source: 'audit', code: 'no-model', message: 'no model' });
    expect(toasts.at(-1)).toBe(i18n.global.t('memoryAudit.error.no-model'));
    expect(useMemoryAuditStore().pendingAction).toBeNull();
  });
});

describe('state retention', () => {
  it('holds the full state only while the overlay is open, and asks again on the next open', async () => {
    await openOverlay();
    const store = useMemoryAuditStore();
    expect(store.state).not.toBeNull();

    store.closeOverlay();
    expect(store.state).toBeNull();
    await deliver({ type: 'memoryAuditState', state: payload() });
    expect(store.state).toBeNull();

    store.openOverlay();
    expect(ofType('requestMemoryAudit')).toHaveLength(2);
  });
});

describe('memory panel entry points', () => {
  function mountPanel(): VueWrapper {
    const wrapper = mount(MemoryPanel, {
      props: { notes: [], observations: [], searchResults: [], hasMoreObservations: false, loadingObservations: false },
      global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
  }

  it('asks only for the summary, and shows the banner with no run and enough eligible memories', async () => {
    const wrapper = mountPanel();
    expect(ofType('requestMemoryAuditSummary')).toHaveLength(1);
    expect(ofType('requestMemoryAudit')).toHaveLength(0);

    await deliver({ type: 'memoryAuditSummary', summary: summary({ eligibleCount: MEMORY_AUDIT_BANNER_MIN_ELIGIBLE - 1 }) });
    expect(wrapper.find('[data-audit-banner]').exists()).toBe(false);

    await deliver({ type: 'memoryAuditSummary', summary: summary({ eligibleCount: MEMORY_AUDIT_BANNER_MIN_ELIGIBLE }) });
    expect(wrapper.get('[data-audit-banner]').text()).toContain(`${MEMORY_AUDIT_BANNER_MIN_ELIGIBLE} memories`);

    await deliver({ type: 'memoryAuditSummary', summary: summary({ eligibleCount: 500, hasAnyRun: true }) });
    expect(wrapper.find('[data-audit-banner]').exists()).toBe(false);
  });

  it('shows no banner and no error when memory is off', async () => {
    const wrapper = mountPanel();
    await deliver({ type: 'memoryAuditSummary', summary: null });

    expect(wrapper.find('[data-audit-banner]').exists()).toBe(false);
    expect(toasts).toEqual([]);
  });

  it('opens the audit overlay from the banner', async () => {
    const wrapper = mountPanel();
    await deliver({ type: 'memoryAuditSummary', summary: summary() });

    await wrapper.get('[data-audit-banner-open]').trigger('click');

    expect(useMemoryAuditStore().isOverlayOpen).toBe(true);
    expect(ofType('requestMemoryAudit')).toHaveLength(1);
  });

  it('keeps a dismissed banner hidden in the persisted webview state', async () => {
    const wrapper = mountPanel();
    await deliver({ type: 'memoryAuditSummary', summary: summary() });

    await wrapper.get('[data-audit-banner-dismiss]').trigger('click');
    expect(wrapper.find('[data-audit-banner]').exists()).toBe(false);
    expect(host.persisted).toEqual({ memoryAuditBannerDismissed: true });

    wrapper.unmount();
    mounted.length = 0;
    setActivePinia(createPinia());
    const reopened = mountPanel();
    await deliver({ type: 'memoryAuditSummary', summary: summary() });
    expect(reopened.find('[data-audit-banner]').exists()).toBe(false);
  });

  it('keeps other keys of the persisted webview state when dismissing', async () => {
    host.persisted = { other: 1 };
    const wrapper = mountPanel();
    await deliver({ type: 'memoryAuditSummary', summary: summary() });

    await wrapper.get('[data-audit-banner-dismiss]').trigger('click');

    expect(host.persisted).toEqual({ other: 1, memoryAuditBannerDismissed: true });
  });

  it('opens the audit overlay from the header button', async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-audit-open]').trigger('click');

    expect(useMemoryAuditStore().isOverlayOpen).toBe(true);
    expect(ofType('requestMemoryAudit')).toHaveLength(1);
  });

  it('labels a memory the audit forgot', async () => {
    const store = useMemoryStore();
    const entry = (id: string, forgetReason: string): MemoryEntry => ({
      id, tier: 'project', kind: 'fact', content: id, sessionId: null, workspace: null, createdAt: 1, updatedAt: 1,
      tags: [], forgotten: true, forgetReason,
    });
    store.setMemories([entry('audited', QUALITY_AUDIT_FORGET_REASON), entry('merged', 'merged')]);
    store.setShowForgotten(true);
    const wrapper = mountPanel();
    await nextTick();

    expect(wrapper.get(`[data-memory-id="audited"] [data-forget-reason="${QUALITY_AUDIT_FORGET_REASON}"]`).text()).toBe('Removed by quality audit');
    expect(wrapper.find('[data-memory-id="merged"] [data-forget-reason]').exists()).toBe(false);
  });
});
