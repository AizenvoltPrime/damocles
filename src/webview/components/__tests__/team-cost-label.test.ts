// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount, type VueWrapper, type DOMWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { TeamAgent, TeamRunSummary, TeamState } from '@shared/types/team';
import { addAgentUsage, emptyAgentUsage, type AgentUsageTotals } from '@shared/usage-accounting';
import TeamAgentCard from '../TeamAgentCard.vue';
import TeamAgentOverlay from '../TeamAgentOverlay.vue';
import TeamOverlay from '../TeamOverlay.vue';
import TeamCard from '../TeamCard.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';
import { defined } from '@/__tests__/helpers';

/**
 * A team role can run a model the panel does not, so the card and the overlay label each agent's cost
 * from that agent's own billing flag. The estimate marker carries a title everywhere it appears, since
 * the marker alone does not say why the figure is not a charge.
 */

const TEAM_ID = 'team-1';
const AGENT_ID = 'agent-1';
const ESTIMATE_TOOLTIP = 'Estimated at API rates. A subscription is not charged per call.';

/** Renders the named subtitle slot, which the real OverlayShell puts in its header. */
const ShellStub = defineComponent({
  template: '<div><div class="subtitle"><slot name="subtitle" /></div><slot /></div>',
});

function agent(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    agentId: AGENT_ID,
    name: 'worker',
    role: 'specialist',
    specialization: 'do the task',
    model: 'sonnet',
    profileId: null,
    attempt: 0,
    status: 'running',
    startTime: 1,
    endTime: null,
    toolCount: 1,
    lastToolName: 'Bash',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 26.45,
    dollarBilled: true,
    progressSummary: null,
    result: null,
    logFilePath: null,
    ...over,
  };
}

function team(agents: TeamAgent[]): TeamState {
  return {
    teamId: TEAM_ID,
    toolUseId: 'toolu_1',
    title: 'Team',
    status: 'running',
    phase: 'working',
    agents,
    messages: [],
    scratchpad: [],
    result: null,
    startTime: 1,
    endTime: null,
    totalToolCount: 1,
    // One run, so its usage is the whole team's.
    runs: [{ toolUseId: 'toolu_1', status: 'running', startTime: 1, endTime: null, toolCount: 1, usage: agents.reduce(addAgentUsage, emptyAgentUsage()) }],
  };
}

/** The panel account, which the agent flag overrides on a card and an agent overlay. */
function panelBilling(dollarBilled: boolean): void {
  useSettingsStore().setAccountInfo({ model: 'claude-opus-5-5', dollarBilled });
}

function mountCard(a: TeamAgent) {
  useTeamStore().restoreTeamFromHistory(team([a]));
  return mount(TeamAgentCard, {
    props: { agent: a, index: 0 },
    global: { plugins: [i18n], stubs: { LoadingSpinner: true } },
  });
}

function mountAgentOverlay(a: TeamAgent) {
  const store = useTeamStore();
  store.restoreTeamFromHistory(team([a]));
  store.openOverlay(TEAM_ID);
  store.openAgentOverlay(AGENT_ID);
  return mount(TeamAgentOverlay, {
    global: {
      plugins: [i18n],
      stubs: { OverlayShell: ShellStub, ScrollArea: true, Button: true, MarkdownRenderer: true, LoadingSpinner: true, ToolCallCard: true },
    },
  });
}

function mountTeamOverlay(agents: TeamAgent[]) {
  const store = useTeamStore();
  store.restoreTeamFromHistory(team(agents));
  store.openOverlay(TEAM_ID);
  return mount(TeamOverlay, {
    global: {
      plugins: [i18n],
      stubs: { OverlayShell: ShellStub, ScrollArea: true, Button: true, MarkdownRenderer: true, LoadingSpinner: true, TeamTimeline: true, TeamScratchpad: true, TeamAgentCard: true },
    },
  });
}

function mountTeamCard(agents: TeamAgent[], run?: TeamRunSummary) {
  const state = team(agents);
  return mount(TeamCard, {
    props: { team: state, run: run ?? state.runs[0]! },
    global: { plugins: [i18n], stubs: { LoadingSpinner: true } },
  });
}

/** The single element carrying the estimate tooltip, or undefined when nothing carries it. */
function titled(wrapper: VueWrapper): DOMWrapper<Element> | undefined {
  return wrapper.findAll('span').find((s) => s.attributes('title') === ESTIMATE_TOOLTIP);
}

beforeEach(() => setActivePinia(createPinia()));

describe('agent cost labels', () => {
  it('marks a subscription agent an estimate inside an API-key panel', () => {
    panelBilling(true);
    const wrapper = mountCard(agent({ dollarBilled: false }));
    expect(wrapper.text()).toContain('~$26.45 est.');
    expect(defined(titled(wrapper)).text()).toBe('~$26.45 est.');
  });

  it('charges a metered agent inside a subscription panel', () => {
    panelBilling(false);
    const wrapper = mountCard(agent({ dollarBilled: true }));
    expect(wrapper.text()).toContain('$26.45');
    expect(wrapper.text()).not.toContain('est.');
    expect(titled(wrapper)).toBeUndefined();
  });

  it('explains the estimate marker in the agent overlay subtitle', () => {
    panelBilling(true);
    const wrapper = mountAgentOverlay(agent({ dollarBilled: false }));
    const subtitle = wrapper.get('.subtitle');
    expect(subtitle.text()).toContain('~$26.45 est.');
    expect(defined(titled(wrapper)).text()).toBe('~$26.45 est.');
  });
});

describe('a live specialist label', () => {
  it('follows the status update that carries the agent billing flag, before any reload', async () => {
    panelBilling(true);
    // The team list reaches the webview before any specialist spawns, so the card starts on the placeholder.
    const wrapper = mountAgentOverlay(agent({ dollarBilled: true }));
    expect(wrapper.get('.subtitle').text()).toContain('$26.45');
    expect(titled(wrapper)).toBeUndefined();

    useTeamStore().handleAgentStatusUpdate(TEAM_ID, AGENT_ID, 'running', undefined, undefined, 'sonnet', false);
    await nextTick();

    expect(wrapper.get('.subtitle').text()).toContain('~$26.45 est.');
    expect(defined(titled(wrapper)).text()).toBe('~$26.45 est.');
  });

  it('keeps the flag when a later status update omits it', async () => {
    panelBilling(true);
    const wrapper = mountAgentOverlay(agent({ dollarBilled: false }));
    expect(wrapper.get('.subtitle').text()).toContain('~$26.45 est.');

    useTeamStore().handleAgentStatusUpdate(TEAM_ID, AGENT_ID, 'completed');
    await nextTick();

    // A partial delta that says nothing about billing must not relabel a subscription cost as a charge.
    expect(wrapper.get('.subtitle').text()).toContain('~$26.45 est.');
    expect(defined(titled(wrapper)).text()).toBe('~$26.45 est.');
  });
});

/**
 * The team total is a sum over agents, so it is labelled from their flags. Those flags survive a reload
 * and the panel account does not, which is how a restored team lost its estimate marker.
 */
describe('team total cost label', () => {
  const surfaces = [
    { name: 'team overlay', mount: mountTeamOverlay },
    { name: 'team card', mount: mountTeamCard },
  ] as const;

  it.each(surfaces)('marks the $name total an estimate when no agent with cost is billed', ({ mount: mountSurface }) => {
    // The panel says charge, so a total that reads as an estimate can only come from the agents.
    panelBilling(true);
    const wrapper = mountSurface([agent({ costUsd: 20, dollarBilled: false }), agent({ agentId: 'agent-2', costUsd: 6.45, dollarBilled: false })]);
    expect(wrapper.text()).toContain('~$26.45 est.');
    expect(defined(titled(wrapper)).text()).toBe('~$26.45 est.');
  });

  it.each(surfaces)('charges the $name total when a single agent with cost is billed', ({ mount: mountSurface }) => {
    panelBilling(false);
    const wrapper = mountSurface([agent({ costUsd: 20, dollarBilled: false }), agent({ agentId: 'agent-2', costUsd: 6.45, dollarBilled: true })]);
    expect(wrapper.text()).toContain('$26.45');
    expect(wrapper.text()).not.toContain('est.');
    expect(titled(wrapper)).toBeUndefined();
  });

  it('labels a restored team from its agents when no account ever reached the panel', () => {
    // A reopened session begins no turn, so the extension sends no accountInfo and the panel default
    // would call every total a charge.
    expect(useSettingsStore().accountInfo).toBeNull();
    const wrapper = mountTeamOverlay([agent({ costUsd: 26.45, dollarBilled: false })]);
    expect(defined(titled(wrapper)).text()).toBe('~$26.45 est.');
  });
});

describe('agent and team usage', () => {
  const busy = (over: Partial<TeamAgent> = {}) =>
    agent({ totalInputTokens: 50, totalOutputTokens: 950, cacheReadTokens: 7000, cacheCreationTokens: 2000, costUsd: 1.5, ...over });

  it('an agent card counts every prompt token and itemises them in a localized tooltip', () => {
    const wrapper = mountCard(busy());
    const tokens = wrapper.get('[data-part="tokens"]');
    expect(tokens.text()).toBe('10.0K tokens');
    expect(tokens.attributes('title')).toBe('Uncached input: 50\nCache read: 7,000\nCache write: 2,000\nOutput: 950');
    expect(wrapper.get('[data-part="cache"]').text()).toBe('77% cache');
  });

  it('the team card of a single run adds the cache hit rate of all its agents', () => {
    // (7000 + 1000) cache read over (9050 + 1950) prompt tokens is 72.7%.
    const wrapper = mountTeamCard([busy(), busy({ agentId: 'agent-2', totalInputTokens: 950, cacheReadTokens: 1000, cacheCreationTokens: 0 })]);
    expect(wrapper.text()).toContain('72% cache');
  });

  it('each run card of a resumed team shows its own run’s tokens and cache hit rate, not the team’s', () => {
    const spend = (totalInputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, costUsd: number): AgentUsageTotals =>
      ({ totalInputTokens, totalOutputTokens: 1000, cacheReadTokens, cacheCreationTokens, costUsd });
    const run = (toolUseId: string, usage: AgentUsageTotals): TeamRunSummary =>
      ({ toolUseId, status: 'completed', startTime: 1, endTime: 2, toolCount: 1, usage });
    const first = run('toolu_1', spend(1000, 0, 2000, 1));
    const second = run('toolu_2', spend(1000, 8000, 1000, 0.5));
    // The agent's usage is cumulative across both runs: 8000 cache read over 13000 prompt tokens is 61%.
    const lead = agent({ ...addAgentUsage(first.usage, second.usage) });

    const firstCard = mountTeamCard([lead], first);
    const secondCard = mountTeamCard([lead], second);

    expect(firstCard.get('[data-part="tokens"]').text()).toBe('4.0K tokens');
    expect(firstCard.find('[data-part="cache"]').exists()).toBe(false);
    expect(firstCard.text()).toContain('$1.00');
    expect(secondCard.get('[data-part="tokens"]').text()).toBe('11.0K tokens');
    expect(secondCard.get('[data-part="cache"]').text()).toBe('80% cache');
    expect(secondCard.text()).toContain('$0.50');
  });

  it('a run card from an older log shows the tokens it recorded, and no cache hit rate', () => {
    const legacy: TeamRunSummary = {
      toolUseId: 'toolu_1', status: 'completed', startTime: 1, endTime: 2, toolCount: 1,
      usage: { ...emptyAgentUsage(), costUsd: 0.75 }, legacyTokens: 1500,
    };
    const wrapper = mountTeamCard([busy()], legacy);
    expect(wrapper.get('[data-part="tokens"]').text()).toBe('1.5K tokens');
    expect(wrapper.find('[data-part="cache"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('$0.75');
  });

  it('the live team card counts the same tokens as the team overlay', async () => {
    const store = useTeamStore();
    const start = team([agent({ costUsd: 0 }), agent({ agentId: 'agent-2', costUsd: 0 })]);
    store.handleTeamStarted(start);
    store.handleAgentUsageUpdate(TEAM_ID, AGENT_ID, { totalInputTokens: 50, totalOutputTokens: 950, cacheReadTokens: 7000, cacheCreationTokens: 2000, costUsd: 1.5 });
    store.handleAgentUsageUpdate(TEAM_ID, 'agent-2', { totalInputTokens: 950, totalOutputTokens: 950, cacheReadTokens: 1000, cacheCreationTokens: 0, costUsd: 1.5 });
    const live = defined(store.teams[TEAM_ID]);
    const card = mount(TeamCard, {
      props: { team: live, run: defined(live.runs[0]) },
      global: { plugins: [i18n], stubs: { LoadingSpinner: true } },
    });
    store.openOverlay(TEAM_ID);
    const overlay = mount(TeamOverlay, {
      global: {
        plugins: [i18n],
        stubs: { OverlayShell: ShellStub, ScrollArea: true, Button: true, MarkdownRenderer: true, LoadingSpinner: true, TeamTimeline: true, TeamScratchpad: true, TeamAgentCard: true },
      },
    });
    await nextTick();

    expect(card.get('[data-part="tokens"]').text()).toBe('12.9K tokens');
    expect(card.get('[data-part="tokens"]').text()).toBe(overlay.get('.subtitle [data-part="tokens"]').text());
    expect(card.get('[data-part="cache"]').text()).toBe(overlay.get('.subtitle [data-part="cache"]').text());
  });

  it('the team overlay totals every agent’s tokens, cache hit rate and cost', () => {
    const wrapper = mountTeamOverlay([busy(), busy({ agentId: 'agent-2', totalInputTokens: 950, cacheReadTokens: 1000, cacheCreationTokens: 0 })]);
    const subtitle = wrapper.get('.subtitle').text();
    expect(subtitle).toContain('12.9K tokens');
    expect(subtitle).toContain('72% cache');
    expect(subtitle).toContain('$3.00');
  });
});
