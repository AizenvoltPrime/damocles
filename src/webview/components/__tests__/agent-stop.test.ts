// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { enableAutoUnmount, mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { SubagentState } from '@shared/types/subagents';
import type { TeamAgent, TeamState } from '@shared/types/team';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import SubagentCard from '../SubagentCard.vue';
import SubagentOverlay from '../SubagentOverlay.vue';
import BackgroundTasksOverlay from '../BackgroundTasksOverlay.vue';
import TeamOverlay from '../TeamOverlay.vue';
import TeamAgentOverlay from '../TeamAgentOverlay.vue';
import TeamCard from '../TeamCard.vue';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { useSubagentStop } from '@/composables/useSubagentStop';
import { createSubagentHandlers } from '@/composables/message-handler/handlers/subagent-handlers';
import { createTeamHandlers } from '@/composables/message-handler/handlers/team-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { i18n } from '@/i18n';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m) }),
}));

enableAutoUnmount(afterEach);

const Shell = defineComponent({ template: '<div><slot name="header-actions" /><slot /><slot name="footer" /></div>' });
const stubs = { OverlayShell: Shell, MarkdownRenderer: true };

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  document.body.innerHTML = '';
  i18n.global.locale.value = 'en';
});

function card(over: Partial<SubagentState> = {}): SubagentState {
  return {
    id: 'tc1', agentType: 'Explore', description: 'Survey', prompt: 'Find the limiter', status: 'running', startTime: Date.now(),
    messages: [], toolCalls: [], messagesSealed: false, sdkAgentId: 'agent-7', isBackground: false, ...over,
  };
}

/** Seeds the card into the store, which is where the stop request and the card's status live. */
function seed(over: Partial<SubagentState> = {}): SubagentState {
  const store = useSubagentStore();
  store.subagents = { ...store.subagents, [over.id ?? 'tc1']: card(over) };
  return store.subagents[over.id ?? 'tc1']!;
}

const stops = (): WebviewToExtensionMessage[] => posted.filter((m) => m.type === 'stopSubagent');

function rejectStop(agentId: string): void {
  const ctx = { stores: { subagentStore: useSubagentStore() } } as unknown as HandlerContext;
  createSubagentHandlers().subagentStopRejected!({ type: 'subagentStopRejected', agentId }, ctx);
}

describe('Stop on a subagent card', () => {
  const mountCard = () => mount(SubagentCard, { props: { subagent: useSubagentStore().subagents['tc1']! }, global: { plugins: [i18n] } });

  it.each([
    ['a foreground', false],
    ['a background', true],
  ])('stops %s agent by its record id without opening the card, and shows it stopping', async (_label, isBackground) => {
    seed({ isBackground });
    const wrapper = mountCard();
    const button = wrapper.get('[data-testid="subagent-card-stop"]');
    expect(button.attributes('aria-label')).toBe('Stop subagent Survey');

    await button.trigger('click');
    await wrapper.setProps({ subagent: useSubagentStore().subagents['tc1']! });

    expect(stops()).toEqual([{ type: 'stopSubagent', agentId: 'agent-7' }]);
    expect(wrapper.emitted('expand')).toBeUndefined();
    const pending = wrapper.get('[data-testid="subagent-card-stop"]');
    expect(pending.attributes('aria-label')).toBe('Stopping...');
    expect(pending.attributes('disabled')).toBeDefined();
    await pending.trigger('click');
    expect(stops()).toHaveLength(1);
  });

  it('leaves the stopping state once the card stops running', async () => {
    seed();
    const wrapper = mountCard();
    await wrapper.get('[data-testid="subagent-card-stop"]').trigger('click');

    useSubagentStore().endSubagent('tc1', 'cancelled');
    await wrapper.setProps({ subagent: useSubagentStore().subagents['tc1']! });

    expect(wrapper.find('[data-testid="subagent-card-stop"]').exists()).toBe(false);
    expect(useSubagentStop().isStopping(useSubagentStore().subagents['tc1']!)).toBe(false);
  });

  it('does not carry a stop of an earlier run onto a resume of the same agent', async () => {
    seed();
    await mountCard().get('[data-testid="subagent-card-stop"]').trigger('click');
    useSubagentStore().endSubagent('tc1', 'cancelled');

    const store = useSubagentStore();
    store.registerAgentTool('tc2', { resume: 'agent-7', message: 'Go on' });
    const ctx = { stores: { subagentStore: store } } as unknown as HandlerContext;
    createSubagentHandlers().subagentStart!({ type: 'subagentStart', agentId: 'agent-7', agentType: 'Explore', toolUseId: 'tc2', isBackground: false, resumedFrom: 'agent-7' }, ctx);
    const resumed = mount(SubagentCard, { props: { subagent: store.subagents['tc2']! }, global: { plugins: [i18n] } });

    const button = resumed.get('[data-testid="subagent-card-stop"]');
    expect(button.attributes('disabled')).toBeUndefined();
    await button.trigger('click');
    expect(stops()).toHaveLength(2);
  });

  it('leaves the stopping state when the extension says the agent had already finished', async () => {
    seed();
    const wrapper = mountCard();
    await wrapper.get('[data-testid="subagent-card-stop"]').trigger('click');

    rejectStop('agent-7');
    await nextTick();

    const button = wrapper.get('[data-testid="subagent-card-stop"]');
    expect(button.attributes('aria-label')).toBe('Stop subagent Survey');
    expect(button.attributes('disabled')).toBeUndefined();
  });

  it('offers no Stop before core has named the agent, or once it has finished', () => {
    const { sdkAgentId: _unannounced, ...unnamed } = card();
    useSubagentStore().subagents = { tc1: unnamed };
    expect(mountCard().find('[data-testid="subagent-card-stop"]').exists()).toBe(false);
    seed({ status: 'completed' });
    expect(mountCard().find('[data-testid="subagent-card-stop"]').exists()).toBe(false);
  });
});

describe('Stop in the subagent overlay header', () => {
  const mountOverlay = () => mount(SubagentOverlay, { props: { subagent: useSubagentStore().subagents['tc1']! }, global: { plugins: [i18n], stubs } });

  it.each([
    ['a foreground', false],
    ['a background', true],
  ])('stops %s agent and turns busy until the stop resolves', async (_label, isBackground) => {
    seed({ isBackground });
    const wrapper = mountOverlay();

    await wrapper.get('[data-testid="subagent-stop"]').trigger('click');
    await nextTick();

    expect(stops()).toEqual([{ type: 'stopSubagent', agentId: 'agent-7' }]);
    expect(wrapper.get('[data-testid="subagent-stop"]').attributes('aria-busy')).toBe('true');

    rejectStop('agent-7');
    await nextTick();
    expect(wrapper.get('[data-testid="subagent-stop"]').attributes('aria-busy')).toBeUndefined();
  });

  it('shares the stopping state with the card and the Background Tasks overlay', async () => {
    seed({ isBackground: true });
    useBackgroundTaskStore().handleTaskStarted({ taskId: 'agent-7', toolUseId: 'tc1', description: 'Survey', status: 'running' });
    const overlay = mountOverlay();
    const tasks = mount(BackgroundTasksOverlay, { global: { plugins: [i18n], stubs } });

    await overlay.get('[data-testid="subagent-stop"]').trigger('click');
    await nextTick();

    const taskStop = tasks.get('[data-action="stop"]');
    expect(taskStop.attributes('aria-busy')).toBe('true');
    await taskStop.trigger('click');
    expect(stops()).toHaveLength(1);
  });
});

describe('Stop of a background task with no card in this panel', () => {
  const mountTasks = () => mount(BackgroundTasksOverlay, { global: { plugins: [i18n], stubs } });

  beforeEach(() => {
    useBackgroundTaskStore().handleTaskStarted({ taskId: 'agent-7', toolUseId: 'tc-elsewhere', description: 'Survey', status: 'running' });
  });

  it('turns busy and sends one stop until the task settles', async () => {
    const tasks = mountTasks();
    expect(tasks.find('[data-testid="task-fallback-row"]').exists()).toBe(true);

    await tasks.get('[data-action="stop"]').trigger('click');
    const busy = tasks.get('[data-action="stop"]');
    expect(busy.attributes('aria-busy')).toBe('true');
    expect(busy.attributes('aria-label')).toBe('Stopping...');
    expect(busy.attributes('disabled')).toBeDefined();
    useSubagentStop().stop('agent-7');
    expect(stops()).toEqual([{ type: 'stopSubagent', agentId: 'agent-7' }]);

    useBackgroundTaskStore().handleTaskCompleted('agent-7', 'stopped');
    await nextTick();
    expect(tasks.find('[data-action="stop"]').exists()).toBe(false);
  });

  it('leaves the stopping state when the extension says the agent had already finished', async () => {
    const tasks = mountTasks();
    await tasks.get('[data-action="stop"]').trigger('click');

    rejectStop('agent-7');
    await nextTick();

    const button = tasks.get('[data-action="stop"]');
    expect(button.attributes('aria-busy')).toBeUndefined();
    expect(button.attributes('aria-label')).toBe('Stop task');
  });
});

function agent(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    agentId: 'a1', name: 'Atlas', role: 'lead', specialization: '', model: 'm', profileId: null, attempt: 0,
    status: 'running', activeMs: 0, runningSince: null, toolCount: 0, lastToolName: null, totalInputTokens: 0, totalOutputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, dollarBilled: true, effort: null, progressSummary: null, result: null,
    logFilePath: null, ...over,
  };
}

function team(over: Partial<TeamState> = {}): TeamState {
  const store = useTeamStore();
  store.restoreTeamFromHistory({
    teamId: 't1', toolUseId: 'tc-team', title: 'Lockout', status: 'running', phase: 'working',
    agents: [
      agent(),
      agent({ agentId: 'a2', name: 'Mira', role: 'specialist', status: 'awaiting-review' }),
      agent({ agentId: 'a3', name: 'Theo', role: 'specialist', status: 'completed' }),
    ],
    messages: [], scratchpad: [], result: null, startTime: 0, endTime: null, totalToolCount: 0,
    runs: [{ toolUseId: 'tc-team', status: 'running', startTime: 0, endTime: null, toolCount: 0, usage: { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 } }],
    ...over,
  });
  return store.teams['t1']!;
}

const confirmation = (): HTMLElement | null => document.body.querySelector('[data-testid="stop-team-confirm"]');
const confirmButton = (label: string): HTMLButtonElement =>
  [...confirmation()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;
const teamStops = (): WebviewToExtensionMessage[] => posted.filter((m) => m.type === 'cancelTeam');

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
}

describe('Stop team', () => {
  const mountTeamOverlay = (): VueWrapper => {
    useTeamStore().openOverlay('t1');
    return mount(TeamOverlay, { attachTo: document.body, global: { plugins: [i18n], stubs } });
  };

  it('asks first, naming the working agents, and Cancel keeps the team', async () => {
    team();
    const wrapper = mountTeamOverlay();

    await wrapper.get('[data-testid="team-stop"]').trigger('click');
    await settle();

    expect(confirmation()!.textContent).toContain('Stop the team?');
    expect(confirmation()!.textContent).toContain('2 agents are working. Their work so far is kept, and the main agent can resume the team later.');
    confirmButton('Cancel').click();
    await settle();

    expect(teamStops()).toEqual([]);
    expect(useTeamStore().isCancelPending('t1')).toBe(false);
  });

  it('posts the stop once on confirm and stays busy until the team ends', async () => {
    team();
    const wrapper = mountTeamOverlay();
    await wrapper.get('[data-testid="team-stop"]').trigger('click');
    await settle();

    confirmButton('Stop team').click();
    await settle();

    expect(teamStops()).toEqual([{ type: 'cancelTeam', teamId: 't1' }]);
    const busy = wrapper.get('[data-testid="team-stop"]');
    expect(busy.attributes('aria-busy')).toBe('true');
    await busy.trigger('click');
    await settle();
    expect(confirmation()).toBeNull();

    createTeamHandlers().teamCompleted!({ type: 'teamCompleted', teamId: 't1', status: 'cancelled', result: null, run: { toolUseId: 'tc-team', status: 'cancelled', startTime: 0, endTime: 1, toolCount: 0, usage: { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 } } }, {} as HandlerContext);
    await settle();
    expect(wrapper.find('[data-testid="team-stop"]').exists()).toBe(false);
    expect(teamStops()).toHaveLength(1);
  });

  it('leaves the stopping state when the extension says the team had already finished', async () => {
    team();
    const wrapper = mountTeamOverlay();
    await wrapper.get('[data-testid="team-stop"]').trigger('click');
    await settle();
    confirmButton('Stop team').click();
    await settle();

    createTeamHandlers().teamCancelRejected!({ type: 'teamCancelRejected', teamId: 't1' }, {} as HandlerContext);
    await settle();

    expect(wrapper.get('[data-testid="team-stop"]').attributes('aria-busy')).toBeUndefined();
  });

  it("is the lead's Stop in the Agents grid, with the same confirmation", async () => {
    team();
    const wrapper = mountTeamOverlay();
    const leadStop = wrapper.findAll('[data-testid="team-agent-card"]')[0]!.get('[data-testid="team-agent-card-stop"]');
    expect(leadStop.attributes('aria-label')).toBe('Stop team');

    await leadStop.trigger('click');
    await settle();
    confirmButton('Stop team').click();
    await settle();

    expect(posted).toEqual([{ type: 'cancelTeam', teamId: 't1' }]);
  });

  it("is the lead's Stop in its own overlay, with the same confirmation", async () => {
    team();
    const store = useTeamStore();
    store.openOverlay('t1');
    store.openAgentOverlay('a1');
    const wrapper = mount(TeamAgentOverlay, { attachTo: document.body, global: { plugins: [i18n], stubs } });

    await wrapper.get('[data-testid="team-agent-stop"]').trigger('click');
    await settle();
    expect(confirmation()).not.toBeNull();
    confirmButton('Stop team').click();
    await settle();

    expect(posted.filter((m) => m.type === 'cancelTeam' || m.type === 'cancelTeamAgent')).toEqual([{ type: 'cancelTeam', teamId: 't1' }]);
  });

  it('is on the team card in the message list, and Cancel there keeps the team', async () => {
    const state = team();
    const wrapper = mount(TeamCard, { attachTo: document.body, props: { team: state, run: state.runs[0]! }, global: { plugins: [i18n] } });

    await wrapper.get('[data-testid="team-card-stop"]').trigger('click');
    await settle();
    expect(wrapper.emitted('expand')).toBeUndefined();
    confirmButton('Cancel').click();
    await settle();
    expect(teamStops()).toEqual([]);

    await wrapper.get('[data-testid="team-card-stop"]').trigger('click');
    await settle();
    confirmButton('Stop team').click();
    await settle();
    expect(teamStops()).toEqual([{ type: 'cancelTeam', teamId: 't1' }]);
  });

  it('counts a member not yet started as working', async () => {
    team({ agents: [agent({ status: 'pending' }), agent({ agentId: 'a2', name: 'Mira', role: 'specialist', status: 'pending' })] });
    const wrapper = mountTeamOverlay();
    await wrapper.get('[data-testid="team-stop"]').trigger('click');
    await settle();
    expect(confirmation()!.textContent).toContain('2 agents are working.');
  });

  it('counts one working agent in the singular, and in Greek', async () => {
    team({ agents: [agent(), agent({ agentId: 'a2', name: 'Mira', role: 'specialist', status: 'completed' })] });
    const wrapper = mountTeamOverlay();
    await wrapper.get('[data-testid="team-stop"]').trigger('click');
    await settle();
    expect(confirmation()!.textContent).toContain('1 agent is working.');
    confirmButton('Cancel').click();
    await settle();

    i18n.global.locale.value = 'el';
    await settle();
    await wrapper.get('[data-testid="team-stop"]').trigger('click');
    await settle();
    expect(confirmation()!.textContent).toContain('Να σταματήσει η ομάδα;');
    expect(confirmation()!.textContent).toContain('1 πράκτορας εργάζεται.');
  });

  it('confirming after the team finished posts nothing', async () => {
    team();
    const wrapper = mountTeamOverlay();
    await wrapper.get('[data-testid="team-stop"]').trigger('click');
    await settle();

    useTeamStore().teams['t1']!.status = 'completed';
    confirmButton('Stop team').click();
    await settle();

    expect(teamStops()).toEqual([]);
  });

  it.each([
    ['disabled', false],
    ['removed because the team ended at once', true],
  ])('hands focus to the region holding the Stop once confirmed, with the Stop %s', async (_label, endsAtOnce) => {
    const region = document.createElement('div');
    region.tabIndex = -1;
    document.body.append(region);
    const state = team();
    const wrapper = mount(TeamCard, { attachTo: region, props: { team: state, run: state.runs[0]! }, global: { plugins: [i18n] } });

    const stop = wrapper.get<HTMLButtonElement>('[data-testid="team-card-stop"]');
    stop.element.focus();
    await stop.trigger('click');
    await settle();
    confirmButton('Stop team').click();
    if (endsAtOnce) {
      const run = { ...state.runs[0]!, status: 'cancelled' as const, endTime: 1 };
      createTeamHandlers().teamCompleted!({ type: 'teamCompleted', teamId: 't1', status: 'cancelled', result: null, run }, {} as HandlerContext);
      await wrapper.setProps({ team: useTeamStore().teams['t1']!, run });
    }
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (endsAtOnce) expect(stop.element.isConnected).toBe(false);
    else expect(stop.element.disabled).toBe(true);
    expect(document.activeElement).toBe(region);
  });

  it('hands focus back to an opener that stayed enabled', async () => {
    team();
    const wrapper = mountTeamOverlay();
    const stop = wrapper.get<HTMLButtonElement>('[data-testid="team-stop"]');
    stop.element.focus();
    await stop.trigger('click');
    await settle();
    confirmButton('Cancel').click();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(stop.element);
  });
});

describe('Stop of one specialist', () => {
  const cancels = (): WebviewToExtensionMessage[] => posted.filter((m) => m.type === 'cancelTeamAgent');
  const update = (status: TeamAgent['status']): void => useTeamStore().handleAgentStatusUpdate('t1', 'a2', status);

  it('turns busy on its card and in its overlay, and sends one cancel until its status changes', async () => {
    team();
    const store = useTeamStore();
    store.openOverlay('t1');
    const grid = mount(TeamOverlay, { attachTo: document.body, global: { plugins: [i18n], stubs } });
    store.openAgentOverlay('a2');
    const overlay = mount(TeamAgentOverlay, { attachTo: document.body, global: { plugins: [i18n], stubs } });
    const cardStop = () => grid.findAll('[data-testid="team-agent-card"]')[1]!.get('[data-testid="team-agent-card-stop"]');

    await cardStop().trigger('click');
    await nextTick();

    expect(cancels()).toEqual([{ type: 'cancelTeamAgent', teamId: 't1', agentId: 'a2' }]);
    expect(cardStop().attributes('aria-label')).toBe('Stopping...');
    expect(cardStop().attributes('disabled')).toBeDefined();
    expect(overlay.get('[data-testid="team-agent-stop"]').attributes('aria-busy')).toBe('true');
    await overlay.get('[data-testid="team-agent-stop"]').trigger('click');
    expect(cancels()).toHaveLength(1);

    update('cancelled');
    await nextTick();
    expect(grid.findAll('[data-testid="team-agent-card"]')[1]!.find('[data-testid="team-agent-card-stop"]').exists()).toBe(false);
  });

  it('is offered again when a resumed member returns to the status it was stopped in', async () => {
    team();
    useTeamStore().openOverlay('t1');
    const grid = mount(TeamOverlay, { attachTo: document.body, global: { plugins: [i18n], stubs } });
    const cardStop = () => grid.findAll('[data-testid="team-agent-card"]')[1]!.get('[data-testid="team-agent-card-stop"]');
    await cardStop().trigger('click');

    update('cancelled');
    update('awaiting-review');
    await nextTick();

    expect(cardStop().attributes('disabled')).toBeUndefined();
    await cardStop().trigger('click');
    expect(cancels()).toHaveLength(2);
  });
});
