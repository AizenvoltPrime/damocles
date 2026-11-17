// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { TeamAgent, TeamRunSummary, TeamState } from '@shared/types/team';
import { emptyAgentUsage } from '@shared/usage-accounting';
import TeamAgentCard from '../TeamAgentCard.vue';
import TeamCard from '../TeamCard.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { createTeamHandlers } from '@/composables/message-handler/handlers/team-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { i18n } from '@/i18n';

/** A run the lead's rejected call stopped, and a member whose turn a rejected call ended, name the cause on their cards. */

const TEAM_ID = 'team-1';
const AGENT_ID = 'agent-1';

function agent(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    agentId: AGENT_ID, name: 'backend', role: 'specialist', description: null, task: null, model: 'm', profileId: null, attempt: 0,
    status: 'running', activeMs: 0, runningSince: null, toolCount: 0, lastToolName: null,
    totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    dollarBilled: true, effort: null, progressSummary: null, result: null, logFilePath: null,
    ...over,
  };
}

function run(over: Partial<TeamRunSummary> = {}): TeamRunSummary {
  return { toolUseId: 'tc-create', status: 'cancelled', startTime: 1_000, endTime: 2_000, toolCount: 0, usage: emptyAgentUsage(), ...over };
}

function team(agents: TeamAgent[], runs: TeamRunSummary[] = [run()]): TeamState {
  return {
    teamId: TEAM_ID, toolUseId: 'tc-create', title: 'Team', status: 'running', phase: 'working', agents,
    messages: [], scratchpad: [], result: null, startTime: 1_000, endTime: null, totalToolCount: 0, runs,
  };
}

type StatusUpdate = Extract<ExtensionToWebviewMessage, { type: 'teamAgentStatusUpdate' }>;

const update = (msg: Partial<StatusUpdate>): void => {
  createTeamHandlers().teamAgentStatusUpdate!({ type: 'teamAgentStatusUpdate', teamId: TEAM_ID, agentId: AGENT_ID, status: 'running', ...msg }, {} as HandlerContext);
};

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
});

describe("the team card of a run the lead's rejected call stopped", () => {
  it.each([
    ['denied', "stopped: you rejected the lead's tool call"],
    ['hookDenied', "stopped: a hook rejected the lead's tool call"],
  ] as const)('names the %s cause, where a plain stop says stopped', (stopReason, line) => {
    const stopped = run({ stopReason });
    const wrapper = mount(TeamCard, { props: { team: team([agent()], [stopped]), run: stopped }, global: { plugins: [i18n] } });
    expect(wrapper.text()).toContain(line);

    const plain = mount(TeamCard, { props: { team: team([agent()]), run: run() }, global: { plugins: [i18n] } });
    expect(plain.text()).toContain('· stopped');
    expect(plain.text()).not.toContain('rejected');
  });
});

describe('a member whose turn a rejected call ended', () => {
  const line = (member: TeamAgent): string | undefined => {
    const found = mount(TeamAgentCard, { props: { agent: member, index: 0 }, global: { plugins: [i18n] } }).find('[data-testid="team-agent-stop-reason"]');
    return found.exists() ? found.text() : undefined;
  };

  it.each([
    ['standby', 'denied', 'Waiting for the lead: you rejected a tool call'],
    ['standby', 'hookDenied', 'Waiting for the lead: a hook rejected a tool call'],
    ['cancelled', 'denied', 'Stopped: you rejected a tool call'],
    ['cancelled', 'hookDenied', 'Stopped: a hook rejected a tool call'],
  ] as const)('shows %s with %s as its cause', (status, stopReason, text) => {
    expect(line(agent({ status, stopReason }))).toBe(text);
  });

  it('shows no cause line without one', () => {
    expect(line(agent({ status: 'standby' }))).toBeUndefined();
  });

  it('keeps the cause a status update names until an update ends the park or the attempt advances', () => {
    const store = useTeamStore();
    store.restoreTeamFromHistory(team([agent()]));
    const stopReason = (): TeamAgent['stopReason'] => store.teams[TEAM_ID]!.agents[0]!.stopReason;

    update({ status: 'standby', stopReason: 'denied' });
    expect(stopReason()).toBe('denied');
    update({ status: 'standby' });
    expect(stopReason()).toBe('denied');
    update({ status: 'running', stopReason: null });
    expect(stopReason()).toBeUndefined();

    update({ status: 'cancelled', stopReason: 'hookDenied' });
    expect(stopReason()).toBe('hookDenied');
    update({ status: 'running', attempt: 1 });
    expect(stopReason()).toBeUndefined();
  });

  it('drops the cause of a parked member whose cancel settles with none', () => {
    const store = useTeamStore();
    store.restoreTeamFromHistory(team([agent()]));

    update({ status: 'standby', stopReason: 'denied' });
    update({ status: 'cancelled', stopReason: null });

    expect(store.teams[TEAM_ID]!.agents[0]).not.toHaveProperty('stopReason');
    expect(line(store.teams[TEAM_ID]!.agents[0]!)).toBeUndefined();
  });
});
