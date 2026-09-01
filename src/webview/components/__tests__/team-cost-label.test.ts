// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount, type VueWrapper, type DOMWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { TeamAgent, TeamState } from '@shared/types/team';
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
  };
}

/** The panel account, which the agent flag overrides on a card and an agent overlay. */
function panelBilling(dollarBilled: boolean): void {
  useSettingsStore().setAccountInfo({ model: 'claude-opus-5', dollarBilled });
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

function mountTeamCard(agents: TeamAgent[]) {
  return mount(TeamCard, {
    props: { team: team(agents) },
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
