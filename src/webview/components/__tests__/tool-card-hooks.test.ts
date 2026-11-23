// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { Comment, Transition, defineComponent, h, provide, type PropType } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { Wrench } from 'lucide-vue-next';
import ToolCardFrame from '../ToolCardFrame.vue';
import ToolCallRouter from '../ToolCallRouter.vue';
import SubagentOverlay from '../SubagentOverlay.vue';
import { i18n } from '@/i18n';
import { agentHookStatus, toolHookStatus, type ToolHookStatus } from '@/composables/useToolCardStatus';
import { IN_TRANSCRIPT } from '@/composables/transcript-scope';
import { useSessionStore } from '@/stores/useSessionStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { emptyAgentUsage } from '@shared/usage-accounting';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import type { TeamRunSummary } from '@shared/types/team';

// docs/themes.md promises theme authors these attributes on every transcript tool card; removing or renaming one breaks
// published themes, so each is pinned here.

beforeEach(() => setActivePinia(createPinia()));

const STATUSES: Record<ToolCall['status'], ToolHookStatus> = {
  pending: 'running',
  running: 'running',
  awaiting_approval: 'blocked',
  blocked: 'blocked',
  approved: 'done',
  completed: 'done',
  denied: 'error',
  failed: 'error',
  abandoned: 'stopped',
  cancelled: 'stopped',
  unrecorded: 'stopped',
};

const MESSAGE: ChatMessage = { id: 'a1', role: 'assistant', content: '', timestamp: 1 };

// A row of the main transcript provides the flag; a card anywhere else has none. The real Transition, as the app renders it.
const inTranscript = { plugins: [i18n], provide: { [IN_TRANSCRIPT as symbol]: true }, stubs: { transition: false } };

function route(call: ToolCall, subagents?: Record<string, SubagentState>): VueWrapper {
  return mount(ToolCallRouter, { props: { toolCall: call, toolUseId: call.id, toolName: call.name, message: MESSAGE, subagents }, global: inTranscript });
}

// Theme CSS reaches only a scope root's descendants, so the hooked card must sit strictly inside its root.
function expectHooks(card: Element, tool: string, status: ToolHookStatus): void {
  expect(card.hasAttribute('data-theme-scope')).toBe(false);
  expect(card.parentElement?.getAttribute('data-theme-scope')).toBe('transcript');
  expect(card.hasAttribute('data-tool-card')).toBe(true);
  expect(card.getAttribute('data-tool')).toBe(tool);
  expect(card.getAttribute('data-tool-status')).toBe(status);
  expect(card.querySelector(':scope > [data-part="header"]')).not.toBeNull();
  expect(card.querySelector('[data-part="header"] > [data-part="tile"]')).not.toBeNull();
}

function subagent(over: Partial<SubagentState>): SubagentState {
  return { id: 'c2', description: 'Scan', prompt: 'scan', status: 'completed', startTime: 1, messages: [], toolCalls: [], messagesSealed: true, ...over };
}

function teamRun(status: TeamRunSummary['status']): void {
  useTeamStore().restoreTeamFromHistory({
    teamId: 't1', toolUseId: 'c3', title: 'Lockout', status, phase: 'working', messages: [], scratchpad: [], result: null, startTime: 0, endTime: null, totalToolCount: 0,
    agents: [{
      agentId: 'a1', name: 'Atlas', role: 'lead', description: null, task: null, model: 'm', profileId: null, attempt: 0, status: 'running', activeMs: 0, runningSince: null,
      toolCount: 0, lastToolName: null, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, dollarBilled: true, effort: null,
      progressSummary: null, result: null, logFilePath: null,
    }],
    runs: [{ toolUseId: 'c3', status, startTime: 0, endTime: null, toolCount: 0, usage: emptyAgentUsage() }],
  });
}

describe('tool card hooks', () => {
  it.each(Object.entries(STATUSES))('maps the %s status to data-tool-status %s', (status, hook) => {
    expect(toolHookStatus(status as ToolCall['status'])).toBe(hook);
  });

  it.each([
    ['running', false, 'running'],
    ['running', true, 'blocked'],
    ['completed', false, 'done'],
    ['failed', false, 'error'],
    ['cancelled', false, 'stopped'],
  ] as const)('maps a %s agent or run (waiting for the user: %s) to data-tool-status %s', (status, awaiting, hook) => {
    expect(agentHookStatus(status, awaiting)).toBe(hook);
  });

  it('puts the scope root, the tool name, its status and every part on the shared frame', () => {
    const wrapper = mount(ToolCardFrame, {
      props: { tool: 'Bash', icon: Wrench, name: 'Run command', arg: 'ls -la', status: 'failed' },
      slots: { default: '<pre>output</pre>' },
      attrs: { 'data-testid': 'bash-card' },
      global: inTranscript,
    });
    const card = wrapper.get('[data-tool-card]');
    expectHooks(card.element, 'Bash', 'error');
    expect(card.attributes('data-testid')).toBe('bash-card');
    expect(card.get('[data-part="header"] [data-part="summary"]').text()).toBe('ls -la');
    expect(card.get(':scope > [data-part="body"]').text()).toBe('output');
  });

  it('keeps the summary part around a card\'s own argument slot', () => {
    const wrapper = mount(ToolCardFrame, {
      props: { tool: 'Read', icon: Wrench, name: 'Read', status: 'completed' },
      slots: { arg: '<button>src/a.ts</button>' },
      global: inTranscript,
    });
    expect(wrapper.get('[data-part="summary"] button').text()).toBe('src/a.ts');
    expect(wrapper.find('[data-part="body"]').exists()).toBe(false);
  });

  it('draws the body part only while the card\'s body slot renders something', async () => {
    const Card = defineComponent({
      props: { output: { type: String as PropType<string | undefined>, default: undefined } },
      setup(props) {
        provide(IN_TRANSCRIPT, true);
        // What a card's template compiles to: a false v-if is a comment, and a Transition around one renders nothing.
        const part = (): ReturnType<typeof h> => (props.output === undefined ? h(Comment, 'v-if') : h('pre', props.output));
        return () => h(ToolCardFrame, { tool: 'Bash', icon: Wrench, name: 'Bash', status: 'completed' }, { default: () => [part(), h(Transition, { name: 't-tuck' }, { default: () => [h(Comment, 'v-if')] })] });
      },
    });
    const wrapper = mount(Card, { global: { plugins: [i18n], stubs: { transition: false } } });
    expect(wrapper.find('[data-part="body"]').exists()).toBe(false);

    await wrapper.setProps({ output: 'done' });
    expect(wrapper.get('[data-tool-card] > [data-part="body"]').text()).toBe('done');

    await wrapper.setProps({ output: undefined });
    expect(wrapper.find('[data-part="body"]').exists()).toBe(false);
  });

  it('gives a routed call that shows nothing below its header no body part', async () => {
    const wrapper = route({ id: 'c0', name: 'mcp__notes__sync', input: {}, status: 'completed' });
    await flushPromises();
    expectHooks(wrapper.get('[data-tool-card]').element, 'mcp__notes__sync', 'done');
    expect(wrapper.find('[data-part="body"]').exists()).toBe(false);
  });

  it('names the tool, not its shown label, on a routed card', async () => {
    const wrapper = route({ id: 'c1', name: 'get_team_status', input: { team_id: 't1' }, status: 'running' });
    await flushPromises();
    const card = wrapper.get('[data-tool-card]');
    expectHooks(card.element, 'get_team_status', 'running');
    const header = card.get('[data-part="header"]').text();
    expect(header).toContain('Get team status');
    expect(header).not.toContain('get_team_status');
  });

  it('gives an agent card, which is built without the frame, the same scope root and hooks', async () => {
    const wrapper = route({ id: 'c2', name: 'Agent', input: { description: 'Scan' }, status: 'completed' }, { c2: subagent({}) });
    await flushPromises();
    expectHooks(wrapper.get('[data-testid="subagent-card"]').element, 'Agent', 'done');
  });

  // A background agent's call returns as soon as the agent is launched, so the call is completed while the card shows it running.
  it.each([
    ['running', 'running'],
    ['failed', 'error'],
    ['cancelled', 'stopped'],
  ] as const)('publishes the state a %s agent\'s card draws, not its completed call\'s', async (status, hook) => {
    const wrapper = route({ id: 'c2', name: 'Agent', input: { description: 'Scan', run_in_background: true }, status: 'completed' }, { c2: subagent({ status, isBackground: true }) });
    await flushPromises();
    expectHooks(wrapper.get('[data-testid="subagent-card"]').element, 'Agent', hook);
  });

  it('gives a team card the same scope root and hooks, from its run\'s state', async () => {
    teamRun('completed');
    const wrapper = route({ id: 'c3', name: 'create_team', input: { title: 'Lockout' }, status: 'running' });
    await flushPromises();
    expectHooks(wrapper.get('[data-testid="team-card"]').element, 'create_team', 'done');
  });

  it('publishes a running team with a member waiting for the user as blocked', async () => {
    teamRun('running');
    const wrapper = route({ id: 'c3', name: 'create_team', input: { title: 'Lockout' }, status: 'running' });
    await flushPromises();
    const card = wrapper.get('[data-testid="team-card"]');
    expectHooks(card.element, 'create_team', 'running');

    useSessionStore().setSessionState('requires_action', [{ id: 'p1', owner: { kind: 'team', teamId: 't1', agentId: 'a1', teamTitle: 'Lockout', agentName: 'Atlas' } }]);
    await flushPromises();
    expectHooks(card.element, 'create_team', 'blocked');
  });
});

describe('a tool card outside the main transcript', () => {
  it('is no scope root on its own, so a dialog that shows one takes no theme CSS', () => {
    const wrapper = mount(ToolCardFrame, { props: { tool: 'Bash', icon: Wrench, name: 'Bash', status: 'completed' }, global: { plugins: [i18n] } });
    expect(wrapper.get('[data-tool-card]').attributes('data-tool')).toBe('Bash');
    expect(wrapper.element.hasAttribute('data-theme-scope')).toBe(false);
    expect(wrapper.find('[data-theme-scope]').exists()).toBe(false);
  });

  it('has no scope root anywhere in the agent overlay', async () => {
    const Shell = defineComponent({ template: '<div role="dialog"><slot name="header-actions" /><slot /></div>' });
    const tool: ToolCall = { id: 't1', name: 'Bash', input: { command: 'ls' }, status: 'completed', result: 'a.ts' };
    const wrapper = mount(SubagentOverlay, {
      props: { subagent: subagent({ status: 'running', toolCalls: [tool], messagesSealed: false }) },
      global: { plugins: [i18n], stubs: { OverlayShell: Shell } },
    });
    await flushPromises();
    expect(wrapper.find('[data-tool-card]').exists()).toBe(true);
    expect(wrapper.find('[data-theme-scope]').exists()).toBe(false);
  });
});
