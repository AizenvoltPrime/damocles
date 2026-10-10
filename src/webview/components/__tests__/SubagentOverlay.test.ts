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
import { useDiffStore } from '@/stores/useDiffStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { i18n } from '@/i18n';
import { at, defined } from '@/__tests__/helpers';

/**
 * The seam between the subagent transcript and the tool and diff overlays: both card sites must hand the
 * real `ToolCallCard` the `'subagent'` source, so a click opens the call from the store that holds it.
 */

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
        OverlayShell: PassThroughStub,
        LiveOutputPane: true,
        DiffView: true,
        MarkdownRenderer: true,
        ThinkingIndicator: true,
        LoadingSpinner: true,
      },
    },
  });
}

beforeEach(() => setActivePinia(createPinia()));

const cardsOf = (wrapper: ReturnType<typeof open>) => wrapper.findAll('[data-testid="tool-card"]');
const clickToExpand = () => i18n.global.t('toolCall.clickToExpand');

describe('clicking a tool card inside a subagent overlay', () => {
  it('opens the call that is still in the live tool list', async () => {
    const tool: ToolCall = { id: 't-live', name: 'Bash', input: {}, status: 'running' };
    const wrapper = open(subagent({ toolCalls: [tool] }));

    const cards = cardsOf(wrapper);
    expect(cards).toHaveLength(1);
    await at(cards, 0).trigger('click');

    expect(useUIStore().expandedToolSource).toBe('subagent');
    expect(defined(useExpandedTool().tool.value).name).toBe('Bash');
  });

  it('opens the call that has sealed into a subagent message', async () => {
    const tool: ToolCall = { id: 't-sealed', name: 'Grep', input: {}, status: 'completed' };
    const wrapper = open(subagent({ messagesSealed: true, messages: [sealedMessage(tool)] }));

    const cards = cardsOf(wrapper);
    expect(cards).toHaveLength(1);
    await at(cards, 0).trigger('click');

    expect(useUIStore().expandedToolSource).toBe('subagent');
    expect(defined(useExpandedTool().tool.value).name).toBe('Grep');
  });

  it.each([
    ['an Edit', { id: 't-edit', name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }, status: 'completed' }],
    ['a Write', { id: 't-write', name: 'Write', input: { file_path: '/w/a.ts', content: 'one\n' }, status: 'completed', metadata: { created: true } }],
  ] as Array<[string, ToolCall]>)('opens the diff of %s it made', async (_label, tool) => {
    const wrapper = open(subagent({ messagesSealed: true, messages: [sealedMessage(tool)] }));

    await wrapper.get(`[aria-label="${clickToExpand()}"]`).trigger('click');

    expect(useDiffStore().expandedDiff).toMatchObject({ filePath: '/w/a.ts', tool: tool.name });
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

describe('the subagent overlay meta chips', () => {
  const Shell = defineComponent({ template: '<div><slot name="header-actions" /><slot /><slot name="footer" /></div>' });

  function chips(state: SubagentState): string {
    return mount(SubagentOverlay, {
      props: { subagent: state },
      global: { plugins: [i18n], stubs: { OverlayShell: Shell, MarkdownRenderer: true, ThinkingIndicator: true } },
    }).findAll('[data-testid="agent-chip"]').map((chip) => chip.text()).join(' | ');
  }

  it('shows the run usage after the model, in place of the model-facing token total', () => {
    const text = chips(subagent({
      model: 'haiku',
      result: { content: 'done', totalTokens: 999 },
      usage: { totalInputTokens: 12, totalOutputTokens: 340, cacheReadTokens: 4800, cacheCreationTokens: 1200, costUsd: 0.37 },
      dollarBilled: true,
    }));

    expect(text).toContain('6.4K tokens');
    expect(text).toContain('79% cache');
    expect(text).toContain('$0.37');
    expect(text).not.toContain('999');
    expect(text.indexOf('haiku')).toBeLessThan(text.indexOf('6.4K tokens'));
  });

  it('shows no usage before the first response', () => {
    expect(chips(subagent({ result: { content: 'done', totalTokens: 999 } }))).not.toContain('tokens');
  });
});

describe('a failed model call in the subagent overlay', () => {
  it('shows the error the card holds as an error notice', () => {
    const wrapper = open(subagent({ messages: [{ id: 'e1', role: 'error', content: '529 overloaded_error', timestamp: 1 }] }));

    const notice = wrapper.get('[data-testid="agent-error"]');
    expect(notice.text()).toContain(i18n.global.t('common.error'));
    expect(notice.text()).toContain('529 overloaded_error');
  });

  it('names the retry on the working line while pi waits to re-send the call', () => {
    const wrapper = open(subagent({ retry: { attempt: 1, maxAttempts: 3 } }));

    expect(wrapper.get('[data-testid="agent-working"]').text()).toContain(i18n.global.t('status.retrying', { attempt: 1, max: 3 }));
  });
});
