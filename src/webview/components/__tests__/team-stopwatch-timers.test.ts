// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { TeamAgent, TeamRunSummary, TeamState } from '@shared/types/team';
import { emptyAgentUsage } from '@shared/usage-accounting';
import TeamOverlay from '../TeamOverlay.vue';
import TeamCard from '../TeamCard.vue';
import TeamAgentCard from '../TeamAgentCard.vue';
import TeamAgentOverlay from '../TeamAgentOverlay.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { i18n } from '@/i18n';

vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: () => undefined, onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

/**
 * Every team timer reads a stopwatch the extension sent, never the team's creation time: the team overlay
 * sums its runs, a run card shows its own run, and a member's card and overlay tick while its run is live.
 */

const NOW = 10_000_000;
const TEAM_ID = 'team-1';
const AGENT_ID = 'agent-1';

const ShellStub = defineComponent({ template: '<div><div class="subtitle"><slot name="subtitle" /></div><slot /></div>' });
const PassThrough = defineComponent({ template: '<div><slot /></div>' });

function agent(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    agentId: AGENT_ID, name: 'backend', role: 'specialist', specialization: 'build it', model: 'm', profileId: null, attempt: 0,
    status: 'running', activeMs: 0, runningSince: null, toolCount: 0, lastToolName: null,
    totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    dollarBilled: true, effort: null, progressSummary: null, result: null, logFilePath: null,
    ...over,
  };
}

function run(over: Partial<TeamRunSummary> = {}): TeamRunSummary {
  return { toolUseId: 'tc-create', status: 'running', startTime: 0, endTime: null, toolCount: 0, usage: emptyAgentUsage(), ...over };
}

function team(over: Partial<TeamState> = {}): TeamState {
  return {
    teamId: TEAM_ID, toolUseId: 'tc-create', title: 'Team', status: 'running', phase: 'working',
    agents: [agent()], messages: [], scratchpad: [], result: null, startTime: 0, endTime: null, totalToolCount: 0,
    runs: [run()],
    ...over,
  };
}

async function tick(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe('the team overlay', () => {
  it('sums its runs, so the time the team sat stopped between them never counts', async () => {
    // A one-minute create run, then a resume that started ten seconds ago, long after the team was created.
    const store = useTeamStore();
    store.restoreTeamFromHistory(team({
      runs: [run({ status: 'cancelled', startTime: 0, endTime: 60_000 }), run({ toolUseId: 'tc-resume', startTime: NOW - 10_000 })],
    }));
    store.openOverlay(TEAM_ID);
    const wrapper = mount(TeamOverlay, {
      global: {
        plugins: [i18n],
        stubs: { OverlayShell: ShellStub, ScrollArea: PassThrough, TeamAgentCard: true, TeamTimeline: true, TeamScratchpad: true, MarkdownRenderer: true, AgentUsageStats: true },
      },
    });
    await nextTick();

    // The separators are literal, since a bare `|` is vue-i18n's plural separator and dropped the elapsed time.
    expect(wrapper.find('.subtitle').text()).toContain('1 agents | 0 tools | 1:10');
    await tick(5_000);
    expect(wrapper.find('.subtitle').text()).toContain('1:15');
  });
});

describe('a run card', () => {
  const mountCard = (r: TeamRunSummary): VueWrapper => mount(TeamCard, { props: { team: team({ runs: [r] }), run: r }, global: { plugins: [i18n] } });

  it("shows an ended run's own duration, however long ago it ended", async () => {
    const wrapper = mountCard(run({ toolUseId: 'tc-resume', status: 'completed', startTime: NOW - 500_000, endTime: NOW - 470_000 }));
    await nextTick();
    expect(wrapper.text()).toContain('30s');
    await tick(5_000);
    expect(wrapper.text()).toContain('30s');
  });

  it('counts a live run from its own start, not from the team creation', async () => {
    const wrapper = mountCard(run({ toolUseId: 'tc-resume', startTime: NOW - 5_000 }));
    await nextTick();
    expect(wrapper.text()).toContain('5s');
    await tick(3_000);
    expect(wrapper.text()).toContain('8s');
  });
});

describe('a member timer', () => {
  // Approved by the lead but still unwinding: the status is final, the run is not.
  const unwinding = agent({ status: 'completed', activeMs: 10_000, runningSince: NOW - 2_000 });

  it('on the card ticks while the run is live, whatever the status says', async () => {
    const wrapper = mount(TeamAgentCard, { props: { agent: unwinding, index: 0 }, global: { plugins: [i18n] } });
    await nextTick();
    expect(wrapper.text()).toContain('12s');
    await tick(3_000);
    expect(wrapper.text()).toContain('15s');
  });

  it('in the overlay ticks while the run is live, whatever the status says', async () => {
    const store = useTeamStore();
    store.restoreTeamFromHistory(team({ agents: [unwinding] }));
    store.openOverlay(TEAM_ID);
    store.openAgentOverlay(AGENT_ID);
    const wrapper = mount(TeamAgentOverlay, {
      global: { plugins: [i18n], stubs: { OverlayShell: ShellStub, ScrollArea: PassThrough, ToolCallCard: true, Button: true, MarkdownRenderer: true, LoadingSpinner: true } },
    });
    await nextTick();
    expect(wrapper.find('.subtitle').text()).toContain('12s');
    await tick(3_000);
    expect(wrapper.find('.subtitle').text()).toContain('15s');
  });
});
