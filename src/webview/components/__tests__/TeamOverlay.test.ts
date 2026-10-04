// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { TeamAgent, TeamState } from '@shared/types/team';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import TeamOverlay from '../TeamOverlay.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { i18n } from '@/i18n';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m) }),
}));

enableAutoUnmount(beforeEach);

const Shell = defineComponent({ template: '<div><slot name="header-actions" /><slot /><slot name="footer" /></div>' });

function agent(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    agentId: 'a1', name: 'Atlas', role: 'lead', specialization: 'Splits the work', model: 'm', profileId: null, attempt: 0,
    status: 'running', activeMs: 0, runningSince: null, toolCount: 3, lastToolName: 'Bash', totalInputTokens: 0, totalOutputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, dollarBilled: true, effort: null, progressSummary: null, result: null,
    logFilePath: 'C:/logs/atlas.jsonl', ...over,
  };
}

function open(over: Partial<TeamState> = {}) {
  const store = useTeamStore();
  store.restoreTeamFromHistory({
    teamId: 't1', toolUseId: 'tc1', title: 'Lockout', status: 'running', phase: 'working',
    agents: [agent(), agent({ agentId: 'a2', name: 'Mira', role: 'specialist', status: 'standby' })],
    messages: [{ messageId: 'm1', senderAgentId: 'a1', senderName: 'Atlas', recipientAgentId: null, recipientName: null, content: 'Kickoff', timestamp: 1 }],
    scratchpad: [], result: null, startTime: 0, endTime: null, totalToolCount: 3, runs: [],
    ...over,
  });
  store.openOverlay('t1');
  return mount(TeamOverlay, { attachTo: document.body, global: { plugins: [i18n], stubs: { OverlayShell: Shell, MarkdownRenderer: true } } });
}

const tabs = (wrapper: ReturnType<typeof open>) => wrapper.findAll('[role="tab"]');

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});

describe('TeamOverlay tabs', () => {
  it('is a tablist of four tabs with counts, the selected one owning a labelled panel', () => {
    const wrapper = open();
    expect(wrapper.get('[role="tablist"]').attributes('aria-label')).toBe('Team views');
    expect(tabs(wrapper).map((tab) => tab.text())).toEqual(['Agents 2', 'Timeline 1', 'Scratchpad', 'Result']);
    expect(tabs(wrapper).map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    const panel = wrapper.get('[role="tabpanel"]');
    expect(panel.attributes('aria-labelledby')).toBe('team-tab-agents');
    // Only the selected tab's panel is rendered, so no other tab may point at one.
    expect(tabs(wrapper).map((tab) => tab.attributes('aria-controls'))).toEqual([panel.attributes('id'), undefined, undefined, undefined]);
    expect(wrapper.findAll('[data-testid="team-agent-card"]')).toHaveLength(2);
  });

  it('moves with the arrow keys and skips the result tab while the team runs without one', async () => {
    const wrapper = open();
    const list = wrapper.get('[role="tablist"]');
    await list.trigger('keydown', { key: 'ArrowRight' });
    expect(useTeamStore().activeTab).toBe('timeline');
    await list.trigger('keydown', { key: 'End' });
    expect(useTeamStore().activeTab).toBe('scratchpad');
    await list.trigger('keydown', { key: 'ArrowRight' });
    expect(useTeamStore().activeTab).toBe('agents');
    expect(tabs(wrapper)[3]!.attributes('aria-disabled')).toBe('true');
    await tabs(wrapper)[3]!.trigger('click');
    expect(useTeamStore().activeTab).toBe('agents');
  });

  it('opens the result tab of a team that stopped without a result and says so', async () => {
    const wrapper = open({ status: 'cancelled' });
    await tabs(wrapper)[3]!.trigger('click');
    await nextTick();
    expect(wrapper.text()).toContain('The team stopped before writing a result.');
  });

  it('draws the selection as one sliding indicator', async () => {
    const wrapper = open();
    await nextTick();
    expect(wrapper.findAll('[role="tablist"] [data-testid="sliding-indicator"]')).toHaveLength(1);
  });
});

describe('TeamOverlay agent cards', () => {
  it('opens the agent, its log, and stops a live specialist', async () => {
    const wrapper = open();
    const [lead, member] = wrapper.findAll('[data-testid="team-agent-card"]');
    await lead!.get('button[data-card-open]').trigger('click');
    expect(useTeamStore().isAgentOverlayOpen).toBe(true);
    expect(useTeamStore().selectedAgent?.agentId).toBe('a1');

    await lead!.get('button[aria-label="Open agent log file"]').trigger('click');
    await member!.get('button[aria-label="Cancel agent"]').trigger('click');
    expect(posted).toEqual([
      { type: 'openFile', filePath: 'C:/logs/atlas.jsonl' },
      { type: 'cancelTeamAgent', teamId: 't1', agentId: 'a2' },
    ]);
  });
});
