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
import { useDiffStore } from '@/stores/useDiffStore';
import { useTeamStore, type AgentChatMessage } from '@/stores/useTeamStore';
import { i18n } from '@/i18n';
import { at, defined } from '@/__tests__/helpers';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: (m: WebviewToExtensionMessage) => posted.push(m),
    onMessage: () => () => {},
    getState: () => undefined,
    setState: () => {},
  }),
}));

/**
 * The seam between the agent transcript and the tool and diff overlays: the overlay renders one real
 * `ToolCallCard` per call with the `'team'` source. A card given `'session'` would open nothing.
 */

const TEAM_ID = 'team-1';
const AGENT_ID = 'agent-1';

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
    activeMs: 0,
    runningSince: 1,
    toolCount: 1,
    lastToolName: 'Bash',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    dollarBilled: true,
    effort: null,
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
        OverlayShell: PassThroughStub,
        LiveOutputPane: true,
        DiffView: true,
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
  /** How the overlay presented each message, read from the block around its rendered text. */
  function rendered(wrapper: ReturnType<typeof mountOverlay>): Array<[string, string | undefined]> {
    return wrapper.findAll('markdown-renderer-stub').map((stub) => {
      const kind = stub.element.closest('[data-testid="agent-steer-message"]') ? 'steer'
        : stub.element.closest('[data-testid="agent-peer-message"]') ? 'peer'
          : 'assistant';
      return [kind, stub.attributes('content')];
    });
  }

  it('opens with the task as the prompt, a peer message from its sender, a steer as Steered, and the reply as output', () => {
    useTeamStore().handleAgentDataLoaded(AGENT_ID, [
      { id: '0:a1', role: 'user', content: [{ type: 'text', text: 'fix the parser' }] },
      { id: '0:a2', role: 'user', content: [{ type: 'text', text: '[Message from lead]: go' }] },
      { id: '0:a3', role: 'user', content: [{ type: 'text', text: wrapSteerMessage('check the tests') }] },
      { id: '0:a4', role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
    ]);

    const wrapper = mountOverlay();

    expect(wrapper.get('[data-testid="agent-prompt"]').text()).toContain('fix the parser');
    expect(rendered(wrapper)).toEqual([
      ['peer', 'go'],
      ['steer', 'check the tests'],
      ['assistant', 'On it.'],
    ]);
    expect(wrapper.get('[data-testid="agent-peer-message"]').text()).toContain('Message from lead');
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

    const cards = wrapper.findAll('[data-testid="tool-card"]');
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.get('[role="button"]').text())).toEqual(['Bash', 'Read']);
  });

  it('expands the clicked call against the team store', async () => {
    const wrapper = open([{ id: 't-1', name: 'Bash', input: { command: 'ls' }, status: 'running' }]);

    await at(wrapper.findAll('[data-testid="tool-card"]'), 0).trigger('click');

    expect(useUIStore().expandedToolSource).toBe('team');
    expect(useUIStore().expandedToolId).toBe('t-1');
    expect(defined(useExpandedTool().tool.value).name).toBe('Bash');
  });

  it.each([
    ['an Edit', { id: 't-edit', name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }, status: 'completed' }],
    ['a Write', { id: 't-write', name: 'Write', input: { file_path: '/w/a.ts', content: 'one\n' }, status: 'completed', metadata: { created: true } }],
  ] as Array<[string, ToolCall]>)('opens the diff of %s it made', async (_label, tool) => {
    const wrapper = open([tool]);

    await wrapper.get(`[aria-label="${i18n.global.t('toolCall.clickToExpand')}"]`).trigger('click');

    expect(useDiffStore().expandedDiff).toMatchObject({ filePath: '/w/a.ts', tool: tool.name });
  });
});

describe('the team agent overlay meta chips', () => {
  const Shell = defineComponent({ template: '<div><slot name="header-actions" /><slot /><slot name="footer" /></div>' });

  it('counts every prompt token and shows the cache hit rate next to the cost', () => {
    const store = useTeamStore();
    store.restoreTeamFromHistory({
      ...team(),
      agents: [agent({ totalInputTokens: 50, totalOutputTokens: 950, cacheReadTokens: 7000, cacheCreationTokens: 2000, costUsd: 1.5 })],
    });
    store.openOverlay(TEAM_ID);
    store.openAgentOverlay(AGENT_ID);
    const wrapper = mount(TeamAgentOverlay, {
      global: { plugins: [i18n], stubs: { OverlayShell: Shell, MarkdownRenderer: true, ToolCallCard: true } },
    });

    expect(wrapper.get('[data-part="tokens"]').text()).toBe('10.0K tokens');
    expect(wrapper.get('[data-part="cache"]').text()).toBe('77% cache');
    expect(wrapper.get('[data-part="cost"]').text()).toBe('$1.50');
  });
});

describe('a failed model call in the team agent overlay', () => {
  it('shows the error the transcript holds as an error notice', () => {
    const wrapper = openWith([{ id: 'e1', role: 'error', content: '529 overloaded_error', timestamp: 1 }]);

    const notice = wrapper.get('[data-testid="agent-error"]');
    expect(notice.text()).toContain(i18n.global.t('common.error'));
    expect(notice.text()).toContain('529 overloaded_error');
  });

  it('names the retry on the working line while pi waits to re-send the call', () => {
    const wrapper = openWith([]);
    useTeamStore().setAgentRetry(AGENT_ID, { attempt: 2, maxAttempts: 3 });

    return nextTick().then(() => {
      expect(wrapper.get('[data-testid="agent-working"]').text()).toContain(i18n.global.t('status.retrying', { attempt: 2, max: 3 }));
    });
  });
});
