// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { TeamAgent, TeamRunSummary, TeamState } from '@shared/types/team';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import ToolCallRouter from '../ToolCallRouter.vue';
import TeamCard from '../TeamCard.vue';
import LoadingSpinner from '../LoadingSpinner.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useTaskStore } from '@/stores/useTaskStore';
import { createHandlerRegistry } from '@/composables/message-handler/handler-registry';
import type { HandlerContext, HandlerRegistry } from '@/composables/message-handler/types';
import { i18n } from '@/i18n';

/**
 * A team is one entity with several runs: its create_team call and each resume_team call. Each call's
 * card shows only its own run, while a click on any of them opens the whole team.
 */

const TEAM_ID = '3f2b8c1e-9d4a-4e6b-8a1c-2b3d4e5f6a7b';
const LEAD = 'agent-lead';

function lead(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    agentId: LEAD, name: 'Lead', role: 'lead', specialization: '', model: 'm', profileId: null, attempt: 0,
    status: 'running', startTime: 1_000, endTime: null, toolCount: 0, lastToolName: null,
    totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    dollarBilled: true, progressSummary: null, result: null, logFilePath: null,
    ...over,
  };
}

function run(over: Partial<TeamRunSummary> = {}): TeamRunSummary {
  return { toolUseId: 'tc-create', status: 'running', startTime: 1_000, endTime: null, toolCount: 0, tokens: 0, costUsd: 0, ...over };
}

function team(over: Partial<TeamState> = {}): TeamState {
  return {
    teamId: TEAM_ID, toolUseId: 'tc-create', title: 'Resumable team', status: 'running', phase: 'working',
    agents: [lead()], messages: [], scratchpad: [], result: null, startTime: 1_000, endTime: null, totalToolCount: 0,
    runs: [run()],
    ...over,
  };
}

// The create run's own work: 3 tools, 1.5K tokens, $0.50 over one minute.
const CREATE_RUN = run({ status: 'cancelled', endTime: 61_000, toolCount: 3, tokens: 1_500, costUsd: 0.5 });
// The resume run's own work: 2 tools, 800 tokens, $0.25 over thirty seconds.
const RESUME_RUN = run({ toolUseId: 'tc-resume', status: 'completed', startTime: 120_000, endTime: 150_000, toolCount: 2, tokens: 800, costUsd: 0.25 });

const createCall: ToolCall = { id: 'tc-create', name: 'create_team', input: { title: 'Resumable team', brief: 'b', agents: [{ name: 'Lead', role: 'lead' }] }, status: 'completed', result: 'partial' };
const resumeCall = (over: Partial<ToolCall> = {}): ToolCall => ({ id: 'tc-resume', name: 'resume_team', input: { team_id: TEAM_ID }, status: 'running', ...over });

/** Resolves after the render that follows mount, which is when the card's elapsed time shows. */
async function route(toolCall: ToolCall): Promise<VueWrapper> {
  const wrapper = mount(ToolCallRouter, {
    props: { toolCall, toolUseId: toolCall.id, toolName: toolCall.name, message: { id: 'm1', role: 'assistant', content: '', timestamp: 1 } as unknown as ChatMessage },
    global: { plugins: [i18n], stubs: { ToolCallCard: true } },
  });
  await nextTick();
  return wrapper;
}

function card(wrapper: VueWrapper): VueWrapper {
  const found = wrapper.findComponent(TeamCard);
  expect(found.exists()).toBe(true);
  return found as VueWrapper;
}

/** The store as the host's messages leave it: the create run cancelled, then a resume run working live. */
function resumedLive(): void {
  const store = useTeamStore();
  store.registerTeamFromTool('tc-create', { title: 'Resumable team', agents: [{ name: 'Lead', role: 'lead' }] });
  store.handleTeamStarted(team());
  for (const tool of ['Read', 'Grep', 'Edit']) store.handleAgentToolCall(TEAM_ID, LEAD, tool);
  store.handleAgentUsageUpdate(TEAM_ID, LEAD, { totalInputTokens: 1_000, totalOutputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.5 });
  store.handleTeamCompleted(TEAM_ID, 'cancelled', 'partial', CREATE_RUN);

  // The resumed runner sends the whole team: the ended create run and its own run, which has done nothing yet.
  const carried = lead({ toolCount: 3, totalInputTokens: 1_000, totalOutputTokens: 500, costUsd: 0.5 });
  store.handleTeamStarted(team({ agents: [carried], runs: [CREATE_RUN, run({ toolUseId: 'tc-resume', startTime: 120_000 })] }));
  for (const tool of ['Read', 'Bash']) store.handleAgentToolCall(TEAM_ID, LEAD, tool);
  store.handleAgentUsageUpdate(TEAM_ID, LEAD, { totalInputTokens: 1_600, totalOutputTokens: 700, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.75 });
}

function expectEnded(wrapper: VueWrapper, status: string, figures: string[]): void {
  const text = card(wrapper).text();
  expect(text).toContain(status);
  for (const figure of figures) expect(text).toContain(figure);
  expect(text).not.toContain('active');
  expect(card(wrapper).findComponent(LoadingSpinner).exists()).toBe(false);
}

beforeEach(() => setActivePinia(createPinia()));

describe('the cards of a resumed team', () => {
  it('while the resume runs, the create_team card shows its own cancelled run and only the resume card is live', async () => {
    resumedLive();

    expectEnded(await route(createCall), 'cancelled', ['3 tools', '1:00', '1.5K tokens', '$0.50']);
    const resumed = card(await route(resumeCall()));
    expect(resumed.text()).toContain('running');
    expect(resumed.text()).toContain('2 tools');
    expect(resumed.text()).toContain('800 tokens');
    expect(resumed.text()).toContain('$0.25');
    expect(resumed.text()).toContain('Agent 1/1 active');
    expect(resumed.findComponent(LoadingSpinner).exists()).toBe(true);
    expect(useTeamStore().activeTeamCount).toBe(1);
  });

  it('labels the resume card resumed inside the card, and not the create_team card', async () => {
    resumedLive();

    expect(card(await route(resumeCall())).text()).toContain('Resumed');
    expect((await route(createCall)).text()).not.toContain('Resumed');
  });

  it('once the resume completes, each card shows how its own run ended', async () => {
    resumedLive();

    useTeamStore().handleTeamCompleted(TEAM_ID, 'completed', 'done', RESUME_RUN);

    expectEnded(await route(createCall), 'cancelled', ['3 tools', '1:00', '1.5K tokens', '$0.50']);
    expectEnded(await route(resumeCall({ status: 'completed' })), 'completed', ['2 tools', '30s', '800 tokens', '$0.25']);
    expect(useTeamStore().activeTeamCount).toBe(0);
  });

  it('opens the whole team from either card', async () => {
    resumedLive();

    await card(await route(createCall)).trigger('click');
    expect(useTeamStore().selectedTeamId).toBe(TEAM_ID);
    useTeamStore().closeOverlay();
    await card(await route(resumeCall())).trigger('click');
    expect(useTeamStore().selectedTeamId).toBe(TEAM_ID);
  });

  it.each([
    ['an errored call', resumeCall({ isError: true, status: 'failed', result: 'Team "x" is still running.' })],
    ['a failed call', resumeCall({ status: 'failed' })],
    ['a call naming another team', resumeCall({ input: { team_id: '7c6d5e4f-3a2b-4c1d-9e8f-0a1b2c3d4e5f' } })],
    ['a call naming an inherited key', resumeCall({ input: { team_id: '__proto__' } })],
    ['a call the host has not started a run for', resumeCall()],
  ])('shows no team card for %s', async (_label, call) => {
    useTeamStore().handleTeamStarted(team({ status: 'cancelled', runs: [CREATE_RUN] }));

    expect((await route(call)).findComponent(TeamCard).exists()).toBe(false);
  });

  it('shows no run on an errored call even when the team has a run under its id', async () => {
    useTeamStore().handleTeamStarted(team({ status: 'cancelled', runs: [CREATE_RUN, run({ toolUseId: 'tc-resume', status: 'cancelled', endTime: 2_000 })] }));

    expect((await route(resumeCall({ isError: true, status: 'failed' }))).findComponent(TeamCard).exists()).toBe(false);
  });
});

describe('a resumed team replayed from history', () => {
  function registry(): HandlerRegistry {
    let built!: HandlerRegistry;
    const app = createApp({ setup() { built = createHandlerRegistry(); return () => null; } });
    app.use(i18n);
    app.mount(document.createElement('div'));
    app.unmount();
    return built;
  }

  function replay(tools: ToolCall[]): WebviewToExtensionMessage[] {
    const posted: WebviewToExtensionMessage[] = [];
    const ctx = {
      stores: {
        sessionStore: useSessionStore(), streamingStore: useStreamingStore(), uiStore: useUIStore(),
        subagentStore: useSubagentStore(), taskStore: useTaskStore(), teamStore: useTeamStore(),
      },
      vscode: { postMessage: (m: WebviewToExtensionMessage) => { posted.push(m); } },
    } as unknown as HandlerContext;
    const handler = registry()['assistantReplay'] as (m: ExtensionToWebviewMessage, c: HandlerContext) => void;
    handler({ type: 'assistantReplay', content: '', tools } as unknown as ExtensionToWebviewMessage, ctx);
    return posted;
  }

  it('shows the same cards as the live session did', async () => {
    resumedLive();
    useTeamStore().handleTeamCompleted(TEAM_ID, 'completed', 'done', RESUME_RUN);
    const liveCreate = card(await route(createCall)).text();
    const liveResume = card(await route(resumeCall({ status: 'completed' }))).text();

    setActivePinia(createPinia());
    const posted = replay([createCall, resumeCall({ status: 'completed', result: 'synthesis' })]);
    expect(posted).toContainEqual({ type: 'requestTeamDataByToolUse', toolUseId: 'tc-resume' });
    const loaded = lead({ status: 'completed', toolCount: 5, totalInputTokens: 1_600, totalOutputTokens: 700, costUsd: 0.75 });
    useTeamStore().handleTeamStarted(team({ status: 'completed', phase: 'complete', agents: [loaded], runs: [CREATE_RUN, RESUME_RUN] }));

    expect(card(await route(createCall)).text()).toBe(liveCreate);
    expect(card(await route(resumeCall({ status: 'completed' }))).text()).toBe(liveResume);
    expect(liveCreate).toContain('cancelled');
    expect(liveResume).toContain('completed');
  });

  it('asks nothing for a resume call that errored', () => {
    const posted = replay([resumeCall({ isError: true, status: 'failed', result: 'nope' })]);

    expect(posted.filter((m) => m.type === 'requestTeamDataByToolUse')).toEqual([]);
  });
});
