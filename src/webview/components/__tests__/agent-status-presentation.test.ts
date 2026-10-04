// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, type PropType } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { SubagentState } from '@shared/types/subagents';
import type { TeamAgent, TeamAgentStatus, TeamState } from '@shared/types/team';
import SubagentCard from '../SubagentCard.vue';
import SubagentOverlay from '../SubagentOverlay.vue';
import TeamCard from '../TeamCard.vue';
import TeamOverlay from '../TeamOverlay.vue';
import TeamAgentOverlay from '../TeamAgentOverlay.vue';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { i18n } from '@/i18n';

/** A status reads the same on a card as in its overlay's header, and a result box is tinted by how the agent ended. */

vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: () => {} }) }));

enableAutoUnmount(beforeEach);

const Shell = defineComponent({
  props: { statusBadge: { type: Object as PropType<{ label: string; class: string }>, default: undefined } },
  template: '<div><span data-testid="badge" :class="statusBadge?.class">{{ statusBadge?.label }}</span><slot name="header-actions" /><slot /></div>',
});
const global = { plugins: [i18n], stubs: { OverlayShell: Shell, MarkdownRenderer: true } };

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
});

function subagent(over: Partial<SubagentState>): SubagentState {
  return { id: 'tc1', agentType: 'Explore', description: 'Survey', prompt: '', status: 'running', startTime: 0, messages: [], toolCalls: [], messagesSealed: false, ...over };
}

function member(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    agentId: 'a1', name: 'Atlas', role: 'lead', specialization: '', model: 'm', profileId: null, attempt: 0, status: 'running', activeMs: 0,
    runningSince: null, toolCount: 0, lastToolName: null, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0, dollarBilled: true, effort: null, progressSummary: null, result: null, logFilePath: null, ...over,
  };
}

function team(status: TeamState['status'], agent: TeamAgent = member()): TeamState {
  const store = useTeamStore();
  store.restoreTeamFromHistory({
    teamId: 't1', toolUseId: 'tc-team', title: 'Lockout', status, phase: 'working', agents: [agent], messages: [], scratchpad: [], result: null,
    startTime: 0, endTime: null, totalToolCount: 0,
    runs: [{ toolUseId: 'tc-team', status, startTime: 0, endTime: null, toolCount: 0, usage: { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 } }],
  });
  store.openOverlay('t1');
  return store.teams['t1']!;
}

const read = (el: { text(): string; classes(): string[] }) => ({ text: el.text(), color: el.classes().find((c) => c.startsWith('text-(')) });

describe('one status presentation', () => {
  it.each([
    ['running', 'Running'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['cancelled', 'Stopped'],
  ] as const)('a %s subagent reads %s on its card and in its overlay', (status, label) => {
    const state = subagent({ status });
    useSubagentStore().subagents = { tc1: state };
    const onCard = read(mount(SubagentCard, { props: { subagent: state }, global }).get('[data-testid="subagent-status"]'));
    const inOverlay = read(mount(SubagentOverlay, { props: { subagent: state }, global }).get('[data-testid="badge"]'));

    expect(onCard.text).toBe(label);
    expect(onCard).toEqual(inOverlay);
  });

  it.each([
    ['running', 'Running'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['cancelled', 'Stopped'],
  ] as const)('a %s team reads %s on its card and in its overlay', (status, label) => {
    const state = team(status);
    const onCard = read(mount(TeamCard, { props: { team: state, run: state.runs[0]! }, global }).get('[data-testid="team-status"]'));
    const inOverlay = read(mount(TeamOverlay, { global }).get('[data-testid="badge"]'));

    expect(onCard.text).toBe(label);
    expect(onCard).toEqual(inOverlay);
  });

  it.each([
    ['awaiting-review', 'Awaiting review'],
    ['cancelled', 'Stopped'],
  ] as const)('a %s member reads %s on its card and in its overlay', (status: TeamAgentStatus, label) => {
    team('running', member({ role: 'specialist', status }));
    const onCard = mount(TeamOverlay, { global }).get('[data-testid="team-agent-status"]');
    useTeamStore().openAgentOverlay('a1');
    const inOverlay = read(mount(TeamAgentOverlay, { global }).get('[data-testid="badge"]'));

    expect(read(onCard)).toEqual({ text: label, color: inOverlay.color });
    expect(inOverlay.text).toBe(label);
  });

  it('reads the same in Greek on a card and in its overlay', () => {
    i18n.global.locale.value = 'el';
    const state = subagent({ status: 'cancelled' });
    useSubagentStore().subagents = { tc1: state };

    expect(mount(SubagentCard, { props: { subagent: state }, global }).get('[data-testid="subagent-status"]').text()).toBe('Διακόπηκε');
    expect(mount(SubagentOverlay, { props: { subagent: state }, global }).get('[data-testid="badge"]').text()).toBe('Διακόπηκε');
  });
});

describe('the result box', () => {
  it.each([
    ['completed', 'd-tone-success', 'Result returned to the main agent'],
    ['cancelled', 'd-tone-muted', 'Result Stopped · returned to the main agent'],
    ['failed', 'd-tone-danger', 'Result Failed · returned to the main agent'],
  ] as const)('of a %s subagent takes its tint and caption from the status', (status, color, heading) => {
    const state = subagent({ status, result: { content: 'Partial work. STOPPED BY THE USER before completion.' } });
    useSubagentStore().subagents = { tc1: state };
    const box = mount(SubagentOverlay, { props: { subagent: state }, global }).get('[data-testid="agent-result"]');

    expect(box.classes()).toContain(color);
    expect(box.get('div').text()).toBe(heading);
  });

  it.each([
    ['completed', 'd-tone-success', 'Result'],
    ['cancelled', 'd-tone-muted', 'Result Stopped'],
    ['failed', 'd-tone-danger', 'Result Failed'],
  ] as const)('of a %s team member takes its tint and caption from the status', (status, color, heading) => {
    team('completed', member({ status, result: 'What I found.' }));
    useTeamStore().openAgentOverlay('a1');
    const box = mount(TeamAgentOverlay, { global }).get('[data-testid="agent-result"]');

    expect(box.classes()).toContain(color);
    expect(box.get('div').text()).toBe(heading);
  });
});
