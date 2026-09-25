// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { computed, defineComponent, h, nextTick } from 'vue';
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

describe('a steer row with images', () => {
  const PNG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

  function mountFromStore(id: string) {
    const state = defined(useSubagentStore().subagents[id], id);
    return mount(SubagentOverlay, {
      props: { subagent: state },
      global: { plugins: [i18n], stubs: { OverlayShell: PassThroughStub, MarkdownRenderer: true, ThinkingIndicator: true, LoadingSpinner: true } },
    });
  }

  it('shows one chip per image on a live steer', () => {
    const store = useSubagentStore();
    store.registerAgentTool('sub-1', { subagent_type: 'Explore', description: 'find' });
    store.addUserMessageToSubagent('sub-1', 'look', [PNG, PNG]);

    expect(mountFromStore('sub-1').findAllComponents({ name: 'UserMessageImageChip' })).toHaveLength(2);
  });

  it('shows the chips after the sealing snapshot replaces the transcript', () => {
    const store = useSubagentStore();
    store.registerAgentTool('sub-1', { subagent_type: 'Explore', description: 'find' });
    store.replaceSubagentMessages('sub-1', [
      { role: 'user', contentBlocks: [{ type: 'text', text: 'the task' }] },
      { role: 'user', contentBlocks: [{ type: 'text', text: 'look' }, PNG] },
    ]);

    expect(mountFromStore('sub-1').findAllComponents({ name: 'UserMessageImageChip' })).toHaveLength(1);
  });

  it('shows no chips on a text-only steer', () => {
    const store = useSubagentStore();
    store.registerAgentTool('sub-1', { subagent_type: 'Explore', description: 'find' });
    store.addUserMessageToSubagent('sub-1', 'look');

    expect(mountFromStore('sub-1').findAllComponents({ name: 'UserMessageImageChip' })).toHaveLength(0);
  });
});

describe('the image lightbox of a steer row', () => {
  const PNG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

  /** Reads the subagent from the store on every render, the way App passes it, so a store rebuild reaches the overlay. */
  function mountLive(id: string) {
    const store = useSubagentStore();
    const Host = defineComponent({
      setup() {
        const state = computed(() => defined(store.subagents[id], id));
        return () => h(SubagentOverlay, { subagent: state.value });
      },
    });
    return mount(Host, {
      attachTo: document.body,
      global: { plugins: [i18n], stubs: { OverlayShell: PassThroughStub, MarkdownRenderer: true, ThinkingIndicator: true, LoadingSpinner: true } },
    });
  }

  function lightboxImage(): HTMLImageElement | null {
    return document.body.querySelector<HTMLImageElement>('[role="dialog"] img');
  }

  it('stays open when the finished subagent snapshot rebuilds every row', async () => {
    const store = useSubagentStore();
    store.registerAgentTool('sub-1', { subagent_type: 'Explore', description: 'find' });
    store.addUserMessageToSubagent('sub-1', 'look', [PNG]);
    const wrapper = mountLive('sub-1');

    const chip = wrapper.findComponent({ name: 'UserMessageImageChip' });
    await chip.trigger('click');
    await nextTick();
    expect(lightboxImage()?.getAttribute('src')).toBe('data:image/png;base64,AAAA');

    store.replaceSubagentMessages('sub-1', [
      { role: 'user', contentBlocks: [{ type: 'text', text: 'the task' }] },
      { role: 'user', contentBlocks: [{ type: 'text', text: 'look' }, PNG] },
    ]);
    await nextTick();
    await nextTick();

    // The row remounted under its new id, so a lightbox owned by the row would be gone.
    expect(chip.element.isConnected).toBe(false);
    expect(wrapper.findAllComponents({ name: 'UserMessageImageChip' })).toHaveLength(1);
    expect(lightboxImage()?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    wrapper.unmount();
  });
});
