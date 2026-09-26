// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import type { TeamAgent, TeamState } from '@shared/types/team';
import type { ImageBlock } from '@shared/types/content';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import { wrapSteerMessage } from '@shared/steer';
import TeamAgentOverlay from '../TeamAgentOverlay.vue';
import { useExpandedTool } from '@/composables/useExpandedTool';
import { useUIStore } from '@/stores/useUIStore';
import { useTeamStore, type AgentChatMessage } from '@/stores/useTeamStore';
import { i18n } from '@/i18n';
import { at, defined } from '@/__tests__/helpers';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/useVSCode', () => ({
  useVSCode: () => ({
    postMessage: (m: WebviewToExtensionMessage) => posted.push(m),
    onMessage: () => () => {},
    getState: () => undefined,
    setState: () => {},
  }),
}));

/**
 * The seam between the agent transcript and the tool overlay. The two suites next door cover the
 * halves: the store builds `ToolCall`s, and the resolver reads the store its source names. This covers
 * what neither can see, that the overlay renders one card per call and that the card's `expand` emit
 * carries the `'team'` source. A binding that passed `'session'` would leave both halves green and
 * still open nothing. `ToolCallCard` is stubbed to its emit; everything after the emit is real.
 */

const TEAM_ID = 'team-1';
const AGENT_ID = 'agent-1';

const ToolCallCardStub = defineComponent({
  props: { toolCall: { type: Object as () => ToolCall, required: true } },
  emits: ['expand'],
  template: `<button class="tool-card" @click="$emit('expand', toolCall.id)">{{ toolCall.name }}</button>`,
});

const PassThroughStub = defineComponent({ template: '<div><slot /></div>' });

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
    costUsd: 0,
    dollarBilled: true,
    progressSummary: null,
    result: null,
    logFilePath: null,
    ...over,
  };
}

function team(): TeamState {
  return {
    teamId: TEAM_ID,
    toolUseId: 'toolu_1',
    title: 'Team',
    status: 'running',
    phase: 'working',
    agents: [agent()],
    messages: [],
    scratchpad: [],
    result: null,
    startTime: 1,
    endTime: null,
    totalToolCount: 1,
    runs: [],
  };
}

function open(toolCalls: ToolCall[]) {
  return openWith([{ id: 'msg-1', role: 'assistant', content: 'working', toolCalls, timestamp: 1 }]);
}

function openWith(messages: AgentChatMessage[]) {
  useTeamStore().agentMessages = { [AGENT_ID]: messages };
  return mountOverlay();
}

function mountOverlay(options: { attachTo?: HTMLElement } = {}) {
  const store = useTeamStore();
  store.restoreTeamFromHistory(team());
  store.openOverlay(TEAM_ID);
  store.openAgentOverlay(AGENT_ID);

  return mount(TeamAgentOverlay, {
    ...options,
    global: {
      plugins: [i18n],
      stubs: {
        ToolCallCard: ToolCallCardStub,
        OverlayShell: PassThroughStub,
        ScrollArea: PassThroughStub,
        Button: true,
        MarkdownRenderer: true,
        LoadingSpinner: true,
      },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});

function historyRequests(): WebviewToExtensionMessage[] {
  return posted.filter((m) => m.type === 'requestTeamAgentData');
}

describe('a steering message inside a team agent overlay', () => {
  // A resumed lead's prompt carries the same marker as an operator /steer, so the label names no sender.
  it('is labelled Steered, not as something the user sent, and shows the text without the marker', () => {
    const wrapper = openWith([{ id: 'u-1', role: 'user', content: wrapSteerMessage('check the tests'), timestamp: 1 }]);

    expect(wrapper.text()).toContain('Steered');
    expect(wrapper.text()).not.toContain('You steered');
    expect(wrapper.find('markdown-renderer-stub').attributes('content')).toBe('check the tests');
  });

  it('shows the images of an image steer as chips, live and after a reload', () => {
    const image: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
    const live = openWith([{ id: 'u-1', role: 'user', content: wrapSteerMessage('use this layout'), images: [image, image], timestamp: 1 }]);
    expect(live.findAllComponents({ name: 'UserMessageImageChip' })).toHaveLength(2);
    live.unmount();

    setActivePinia(createPinia());
    useTeamStore().handleAgentDataLoaded(AGENT_ID, [{ id: '0:a1', role: 'user', content: [{ type: 'text', text: wrapSteerMessage('') }, image] }]);
    expect(mountOverlay().findAllComponents({ name: 'UserMessageImageChip' })).toHaveLength(1);
  });

  it('opens a clicked chip in the lightbox the overlay hosts', async () => {
    const image: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
    useTeamStore().agentMessages = { [AGENT_ID]: [{ id: 'u-1', role: 'user', content: wrapSteerMessage('use this'), images: [image], timestamp: 1 }] };
    const wrapper = mountOverlay({ attachTo: document.body });

    await wrapper.findComponent({ name: 'UserMessageImageChip' }).trigger('click');
    await nextTick();

    expect(document.body.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    wrapper.unmount();
  });

  it('shows no chips for a steer without images', () => {
    const wrapper = openWith([{ id: 'u-1', role: 'user', content: wrapSteerMessage('check the tests'), timestamp: 1 }]);

    expect(wrapper.findAllComponents({ name: 'UserMessageImageChip' })).toHaveLength(0);
  });

  it('shows a peer message as plain user text', () => {
    const wrapper = openWith([{ id: 'u-1', role: 'user', content: '[Message from lead]: go', timestamp: 1 }]);

    expect(wrapper.text()).not.toContain('Steered');
  });
});

describe('a member history loaded from its session file', () => {
  /** How the overlay presented each message, read from the wrapper around its rendered text. */
  function rendered(wrapper: ReturnType<typeof mountOverlay>): Array<[string, string | undefined]> {
    return wrapper.findAll('markdown-renderer-stub').map((stub) => {
      const within = (cls: string): boolean => {
        for (let el: Element | null = stub.element; el; el = el.parentElement) if (el.classList.contains(cls)) return true;
        return false;
      };
      const kind = within('border-warning/50') ? 'steer' : within('border-foreground/20') ? 'user' : 'assistant';
      return [kind, stub.attributes('content')];
    });
  }

  it('shows the task and a peer message as user text, a steer as Steered, and the reply as output', () => {
    useTeamStore().handleAgentDataLoaded(AGENT_ID, [
      { id: '0:a1', role: 'user', content: [{ type: 'text', text: 'fix the parser' }] },
      { id: '0:a2', role: 'user', content: [{ type: 'text', text: '[Message from lead]: go' }] },
      { id: '0:a3', role: 'user', content: [{ type: 'text', text: wrapSteerMessage('check the tests') }] },
      { id: '0:a4', role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
    ]);

    const wrapper = mountOverlay();

    expect(rendered(wrapper)).toEqual([
      ['user', 'fix the parser'],
      ['user', '[Message from lead]: go'],
      ['steer', 'check the tests'],
      ['assistant', 'On it.'],
    ]);
    expect(wrapper.text()).toContain('Steered');
  });
});

describe('the member history request', () => {
  it('asks for the member file on open even while live messages are showing', () => {
    openWith([{ id: 'u-1', role: 'user', content: 'You were interrupted. Continue.', timestamp: 1 }]);

    expect(historyRequests()).toEqual([{ type: 'requestTeamAgentData', teamId: TEAM_ID, agentId: AGENT_ID }]);
  });

  it('does not ask again once the member file has loaded', () => {
    useTeamStore().handleAgentDataLoaded(AGENT_ID, []);

    openWith([]);

    expect(historyRequests()).toEqual([]);
  });
});

describe('tool calls inside a team agent overlay', () => {
  it('renders one card per tool call instead of a name chip', () => {
    const wrapper = open([
      { id: 't-1', name: 'Bash', input: { command: 'ls' }, status: 'running' },
      { id: 't-2', name: 'Read', input: { file_path: 'c:/x.ts' }, status: 'completed' },
    ]);

    const cards = wrapper.findAll('.tool-card');
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.text())).toEqual(['Bash', 'Read']);
  });

  it('expands the clicked call against the team store', async () => {
    const wrapper = open([{ id: 't-1', name: 'Bash', input: { command: 'ls' }, status: 'running' }]);

    await at(wrapper.findAll('.tool-card'), 0).trigger('click');

    expect(useUIStore().expandedToolSource).toBe('team');
    expect(useUIStore().expandedToolId).toBe('t-1');
    expect(defined(useExpandedTool().tool.value).name).toBe('Bash');
  });
});

describe('the team agent overlay subtitle', () => {
  const SubtitleShell = defineComponent({ template: '<div><div class="subtitle"><slot name="subtitle" /></div><slot /></div>' });

  it('counts every prompt token and shows the cache hit rate next to the cost', () => {
    const store = useTeamStore();
    store.restoreTeamFromHistory({
      ...team(),
      agents: [agent({ totalInputTokens: 50, totalOutputTokens: 950, cacheReadTokens: 7000, cacheCreationTokens: 2000, costUsd: 1.5 })],
    });
    store.openOverlay(TEAM_ID);
    store.openAgentOverlay(AGENT_ID);
    const text = mount(TeamAgentOverlay, {
      global: { plugins: [i18n], stubs: { OverlayShell: SubtitleShell, ScrollArea: PassThroughStub, Button: true, MarkdownRenderer: true, LoadingSpinner: true, ToolCallCard: ToolCallCardStub } },
    }).get('.subtitle').text();

    expect(text).toContain('10.0K tokens');
    expect(text).toContain('77% cache');
    expect(text).toContain('$1.50');
  });
});
