// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import SubagentCard from '../SubagentCard.vue';
import { createUIHandlers } from '@/composables/message-handler/handlers/ui-handlers';
import type { HandlerContext, StoreContext } from '@/composables/message-handler/types';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';

vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: () => undefined, onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

/** A subagent over `damocles.subagents.maxConcurrent` waits for a slot; its card says so, from core's message alone, and times only the run. */

type StatusUpdate = Extract<ExtensionToWebviewMessage, { type: 'statusUpdate' }>;

function context(): HandlerContext {
  return {
    stores: { subagentStore: useSubagentStore(), teamStore: useTeamStore(), uiStore: useUIStore(), settingsStore: useSettingsStore() } as unknown as StoreContext,
  } as unknown as HandlerContext;
}

const ui = createUIHandlers();
function queueWait(owner: string, queued: boolean): void {
  const msg: StatusUpdate = { type: 'statusUpdate', status: 'queued', queued, parentToolUseId: owner };
  ui.statusUpdate!(msg, context());
}

function card(): VueWrapper {
  return mount(SubagentCard, {
    props: { subagent: useSubagentStore().subagents['tc-1']! },
    global: { plugins: [i18n], stubs: { AgentUsageStats: true } },
  });
}

async function rerender(wrapper: VueWrapper): Promise<void> {
  await wrapper.setProps({ subagent: useSubagentStore().subagents['tc-1']! });
}

const chip = (wrapper: VueWrapper) => wrapper.get('[data-testid="subagent-status"]').text();
const statusLine = (wrapper: VueWrapper) => wrapper.find('[data-testid="subagent-status-line"]');
const stats = (wrapper: VueWrapper) => wrapper.get('[data-testid="subagent-stats"]').text();

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a queued subagent's card", () => {
  it('reads Pending and waits with no running time, then runs with its time counted from the start', async () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc-1', { description: 'dig', prompt: 'go', subagent_type: 'Explore' });
    queueWait('tc-1', true);
    const wrapper = card();

    expect(chip(wrapper)).toBe('Pending');
    expect(statusLine(wrapper).text()).toBe('Waiting for a free slot (Subagents at once)');
    vi.advanceTimersByTime(3_000);
    await nextTick();
    expect(stats(wrapper)).not.toMatch(/\ds/);

    vi.setSystemTime(1_030_000);
    queueWait('tc-1', false);
    await rerender(wrapper);
    expect(chip(wrapper)).toBe('Running');
    expect(statusLine(wrapper).exists()).toBe(false);
    expect(store.subagents['tc-1']!.startTime).toBe(1_030_000);

    vi.advanceTimersByTime(5_000);
    await nextTick();
    expect(stats(wrapper)).toContain('tools5s');
  });

  it('drops the wait when the card ends, and ignores one for a card that already ended', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc-1', { description: 'dig', prompt: 'go' });
    queueWait('tc-1', true);

    store.endSubagent('tc-1', 'cancelled');
    expect(store.subagents['tc-1']!.queued).toBeUndefined();
    queueWait('tc-1', true);
    queueWait('tc-1', false);
    expect(store.subagents['tc-1']).toMatchObject({ status: 'cancelled', startTime: 1_000_000 });
    expect(store.subagents['tc-1']!.queued).toBeUndefined();
  });

  it('starts no new time for a run that never waited', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc-1', { description: 'dig', prompt: 'go' });
    vi.setSystemTime(1_010_000);
    queueWait('tc-1', false);
    expect(store.subagents['tc-1']!.startTime).toBe(1_000_000);
  });

  it('is waiting again after a reload only when core says so, since the replay restarts every live card as running', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc-1', { description: 'dig', prompt: 'go' });
    queueWait('tc-1', true);

    store.resetToRunning('tc-1', 'dig', true);
    expect(store.subagents['tc-1']!.queued).toBeUndefined();
    queueWait('tc-1', true);
    expect(store.subagents['tc-1']!.queued).toBe(true);
  });
});
