// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import type { TeamAgent, TeamState } from '@shared/types/team';
import TeamAgentOverlay from '../TeamAgentOverlay.vue';
import { useExpandedTool } from '@/composables/useExpandedTool';
import { useUIStore } from '@/stores/useUIStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { i18n } from '@/i18n';
import { at, defined } from '@/__tests__/helpers';

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
  };
}

function open(toolCalls: ToolCall[]) {
  const store = useTeamStore();
  store.restoreTeamFromHistory(team());
  store.openOverlay(TEAM_ID);
  store.openAgentOverlay(AGENT_ID);
  store.agentMessages = {
    [AGENT_ID]: [{ id: 'msg-1', role: 'assistant', content: 'working', toolCalls, timestamp: 1 }],
  };

  return mount(TeamAgentOverlay, {
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

beforeEach(() => setActivePinia(createPinia()));

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
    expect(defined(useExpandedTool().value).name).toBe('Bash');
  });
});
