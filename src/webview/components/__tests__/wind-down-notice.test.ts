// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { TeamAgent, TeamState } from '@shared/types/team';
import type { AgentWindDown } from '@shared/types/wind-down';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { emptyAgentUsage } from '@shared/usage-accounting';
import TeamAgentCard from '../TeamAgentCard.vue';
import SubagentCard from '../SubagentCard.vue';
import { createUIHandlers } from '@/composables/message-handler/handlers/ui-handlers';
import type { HandlerContext, StoreContext } from '@/composables/message-handler/types';
import { useTeamStore } from '@/stores/useTeamStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';

vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: () => undefined, onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

/**
 * A stopped nested agent whose run outlasts core's notice delay shows what pi still awaits, from core's message alone,
 * until core clears it or the agent settles; a reload, which rebuilds the cards from core's state, shows none.
 */

const EXTENSION = '/home/user/.pi/agent/extensions/held-settle.js';
const SETTLE: AgentWindDown = { phase: 'settle', events: ['agent_settled'], extensions: [EXTENSION] };
const RUN: AgentWindDown = { phase: 'run', events: [], extensions: [] };

type StatusUpdate = Extract<ExtensionToWebviewMessage, { type: 'statusUpdate' }>;

function context(): HandlerContext {
  return {
    stores: {
      subagentStore: useSubagentStore(),
      teamStore: useTeamStore(),
      uiStore: useUIStore(),
      settingsStore: useSettingsStore(),
    } as unknown as StoreContext,
  } as unknown as HandlerContext;
}

const ui = createUIHandlers();
function windingDown(owner: string, windDown: AgentWindDown | null): void {
  const msg: StatusUpdate = { type: 'statusUpdate', status: 'windingDown', windDown, parentToolUseId: owner };
  ui.statusUpdate!(msg, context());
}

function member(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    agentId: 'agent-1', name: 'backend', role: 'specialist', description: 'build it', task: null, model: '', profileId: null, attempt: 0,
    status: 'running', activeMs: 0, runningSince: null, toolCount: 0, lastToolName: null,
    totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    dollarBilled: true, effort: null, progressSummary: null, result: null, logFilePath: null,
    ...over,
  };
}

function team(): TeamState {
  return {
    teamId: 'team-1', toolUseId: 'tc-create', title: 'Team', status: 'running', phase: 'working',
    agents: [member()], messages: [], scratchpad: [], result: null, startTime: 0, endTime: null, totalToolCount: 0,
    runs: [{ toolUseId: 'tc-create', status: 'running', startTime: 0, endTime: null, toolCount: 0, usage: emptyAgentUsage() }],
  };
}

function memberCard(): VueWrapper {
  const store = useTeamStore();
  store.openOverlay('team-1');
  return mount(TeamAgentCard, {
    props: { agent: store.teams['team-1']!.agents[0]!, index: 0 },
    global: { plugins: [i18n], stubs: { AgentUsageStats: true } },
  });
}

async function rerenderMember(wrapper: VueWrapper): Promise<void> {
  await wrapper.setProps({ agent: useTeamStore().teams['team-1']!.agents[0]! });
  await nextTick();
}

const memberLine = (wrapper: VueWrapper) => wrapper.find('[data-testid="team-agent-wind-down"]');

beforeEach(() => setActivePinia(createPinia()));

describe("a stopped team member's card", () => {
  it('shows what pi awaits and the extensions loaded for it, and clears it when core does', async () => {
    useTeamStore().restoreTeamFromHistory(team());
    const wrapper = memberCard();
    expect(memberLine(wrapper).exists()).toBe(false);

    windingDown('agent-1', SETTLE);
    await nextTick();
    expect(memberLine(wrapper).text()).toBe(`Stopping: waiting for pi's agent_settled handlers to return. pi gives them no abort signal. pi extensions with such a handler: ${EXTENSION}.`);

    windingDown('agent-1', RUN);
    await nextTick();
    expect(memberLine(wrapper).text()).toBe("Stopping: waiting for the run's tool calls and event handlers to end.");

    windingDown('agent-1', null);
    await nextTick();
    expect(memberLine(wrapper).exists()).toBe(false);
  });

  it('drops it when the member settles, which a runner that already ended the team cannot clear', async () => {
    const store = useTeamStore();
    store.restoreTeamFromHistory(team());
    const wrapper = memberCard();
    windingDown('agent-1', SETTLE);
    await nextTick();
    expect(memberLine(wrapper).exists()).toBe(true);

    store.handleAgentStatusUpdate('team-1', 'agent-1', 'cancelled');
    await rerenderMember(wrapper);
    expect(memberLine(wrapper).exists()).toBe(false);
  });

  it('shows none after a reload, which rebuilds the team from core', async () => {
    windingDown('agent-1', SETTLE);
    useTeamStore().restoreTeamFromHistory(team());
    windingDown('agent-1', SETTLE);
    setActivePinia(createPinia());

    useTeamStore().handleTeamStarted(team());
    expect(memberLine(memberCard()).exists()).toBe(false);
  });
});

describe("a stopped subagent's card", () => {
  function subagentCard(): VueWrapper {
    return mount(SubagentCard, {
      props: { subagent: useSubagentStore().subagents['tc-1']! },
      global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    });
  }

  async function rerender(wrapper: VueWrapper): Promise<void> {
    await wrapper.setProps({ subagent: useSubagentStore().subagents['tc-1']! });
  }

  const statusLine = (wrapper: VueWrapper) => wrapper.find('[data-testid="subagent-status-line"]');

  it('shows what pi awaits in its status line, ahead of a retry, and clears it when core does', async () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc-1', { description: 'dig', prompt: 'go', subagent_type: 'Explore' });
    store.setSubagentRetry('tc-1', { attempt: 1, maxAttempts: 3 });
    const wrapper = subagentCard();

    windingDown('tc-1', SETTLE);
    await rerender(wrapper);
    expect(statusLine(wrapper).text()).toBe(`Stopping: waiting for pi's agent_settled handlers to return. pi gives them no abort signal. pi extensions with such a handler: ${EXTENSION}.`);

    windingDown('tc-1', null);
    store.setSubagentRetry('tc-1', null);
    await rerender(wrapper);
    expect(statusLine(wrapper).exists()).toBe(false);
  });

  it('drops it when the card resolves, and ignores one for a card that already ended', async () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc-1', { description: 'dig', prompt: 'go' });
    windingDown('tc-1', SETTLE);
    expect(store.subagents['tc-1']!.windDown).toEqual(SETTLE);

    store.endSubagent('tc-1', 'cancelled');
    expect(store.subagents['tc-1']!.windDown).toBeUndefined();
    windingDown('tc-1', SETTLE);
    expect(store.subagents['tc-1']!.windDown).toBeUndefined();
  });

  it('shows none after a reload, which rebuilds the card from the transcript', async () => {
    useSubagentStore().registerAgentTool('tc-1', { description: 'dig', prompt: 'go' });
    windingDown('tc-1', SETTLE);
    setActivePinia(createPinia());

    useSubagentStore().registerAgentTool('tc-1', { description: 'dig', prompt: 'go' });
    expect(statusLine(subagentCard()).exists()).toBe(false);
  });
});
