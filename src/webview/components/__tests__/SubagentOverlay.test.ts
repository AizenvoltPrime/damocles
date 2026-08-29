// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import SubagentOverlay from '../SubagentOverlay.vue';
import { useExpandedTool } from '@/composables/useExpandedTool';
import { useUIStore } from '@/stores/useUIStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { i18n } from '@/i18n';
import { at, defined } from '@/__tests__/helpers';

/**
 * The dead click this slice removes: a tool card inside a subagent overlay set an expanded tool id
 * that nothing could resolve, so no overlay ever appeared.
 *
 * The two suites next door cover the halves. This covers the seam: the card's `expand` emit has to
 * reach `expandTool` with the `'subagent'` source, at both card sites, so the resolver reads the store
 * that actually holds the call. `ToolCallCard` is stubbed down to its emit because the card's own
 * rendering is not what is under test here; everything between the emit and the resolved call is real.
 */

const ToolCallCardStub = defineComponent({
  props: { toolCall: { type: Object as () => ToolCall, required: true } },
  emits: ['expand'],
  template: `<button class="tool-card" @click="$emit('expand', toolCall.id)">{{ toolCall.id }}</button>`,
});

const PassThroughStub = defineComponent({ template: '<div><slot /></div>' });

function subagent(over: Partial<SubagentState> = {}): SubagentState {
  return {
    id: 'sub-1',
    agentType: 'general-purpose',
    description: 'a subagent',
    prompt: '',
    status: 'running',
    startTime: Date.now(),
    messages: [],
    toolCalls: [],
    messagesSealed: false,
    ...over,
  };
}

function sealedMessage(tool: ToolCall): ChatMessage {
  return {
    id: 'sub-1-msg-0',
    role: 'assistant',
    content: '',
    contentBlocks: [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }],
    toolCalls: [tool],
    timestamp: 1,
  };
}

function open(state: SubagentState) {
  useSubagentStore().subagents = { [state.id]: state };
  return mount(SubagentOverlay, {
    props: { subagent: state },
    global: {
      plugins: [i18n],
      stubs: {
        ToolCallCard: ToolCallCardStub,
        OverlayShell: PassThroughStub,
        MarkdownRenderer: true,
        ThinkingIndicator: true,
        LoadingSpinner: true,
      },
    },
  });
}

beforeEach(() => setActivePinia(createPinia()));

describe('clicking a tool card inside a subagent overlay', () => {
  it('opens the call that is still in the live tool list', async () => {
    const tool: ToolCall = { id: 't-live', name: 'Bash', input: {}, status: 'running' };
    const wrapper = open(subagent({ toolCalls: [tool] }));

    const cards = wrapper.findAll('.tool-card');
    expect(cards).toHaveLength(1);
    await at(cards, 0).trigger('click');

    expect(useUIStore().expandedToolSource).toBe('subagent');
    expect(defined(useExpandedTool().value).name).toBe('Bash');
  });

  it('opens the call that has sealed into a subagent message', async () => {
    const tool: ToolCall = { id: 't-sealed', name: 'Grep', input: {}, status: 'completed' };
    const wrapper = open(subagent({ messagesSealed: true, messages: [sealedMessage(tool)] }));

    const cards = wrapper.findAll('.tool-card');
    expect(cards).toHaveLength(1);
    await at(cards, 0).trigger('click');

    expect(useUIStore().expandedToolSource).toBe('subagent');
    expect(defined(useExpandedTool().value).name).toBe('Grep');
  });
});
