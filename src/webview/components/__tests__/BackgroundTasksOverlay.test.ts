// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { BackgroundTask } from '@shared/types/background-tasks';
import type { SubagentState } from '@shared/types/subagents';
import BackgroundTasksOverlay from '../BackgroundTasksOverlay.vue';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { i18n } from '@/i18n';

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage }) }));

const ShellStub = defineComponent({ template: '<div><slot name="header-actions" /><slot /></div>' });

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: 'a1', toolUseId: 'tc1', description: 'dig in', status: 'running',
    ...over,
  };
}

function card(over: Partial<SubagentState> = {}): SubagentState {
  return {
    id: 'tc1', agentType: 'Explore', description: 'dig in', prompt: '', status: 'running', startTime: Date.now(),
    messages: [], toolCalls: [], messagesSealed: false, isBackground: true,
    usage: { totalInputTokens: 200, totalOutputTokens: 800, cacheReadTokens: 8000, cacheCreationTokens: 1000, costUsd: 0.4 },
    dollarBilled: true,
    ...over,
  };
}

function render() {
  return mount(BackgroundTasksOverlay, {
    global: { plugins: [i18n], stubs: { OverlayShell: ShellStub, LoadingSpinner: true } },
  });
}

// Running cards start a 1 s timer each, so every mount must be torn down.
enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  postMessage.mockClear();
});

describe('BackgroundTasksOverlay', () => {
  it('lists one subagent row per task, in launch order, with the run’s usage', () => {
    const tasks = useBackgroundTaskStore();
    tasks.handleTaskStarted(task({ taskId: 'a1', toolUseId: 'tc1' }));
    tasks.handleTaskStarted(task({ taskId: 'a2', toolUseId: 'tc2' }));
    useSubagentStore().subagents = {
      tc2: card({ id: 'tc2', description: 'second' }),
      tc1: card({ id: 'tc1', description: 'first' }),
    };
    const wrapper = render();

    const rows = wrapper.findAll('[data-testid="bg-subagent-row"]');
    expect(rows.map((row) => row.text())).toEqual([expect.stringContaining('first'), expect.stringContaining('second')]);
    expect(wrapper.findAll('[data-part="tokens"]').map((t) => t.text())).toEqual(['10.0K tokens', '10.0K tokens']);
  });

  it('counts a row\'s tools in one Greek phrase with the Greek plural', () => {
    i18n.global.locale.value = 'el';
    try {
      useBackgroundTaskStore().handleTaskStarted(task());
      useSubagentStore().subagents = { tc1: card({ toolCalls: [{ id: 't1', name: 'Read', input: {}, status: 'completed' }] as SubagentState['toolCalls'] }) };

      expect(render().get('[data-testid="bg-subagent-row"]').text()).toContain('1 εργαλείο');
    } finally {
      i18n.global.locale.value = 'en';
    }
  });

  it('opens the subagent overlay when a row is clicked', async () => {
    useBackgroundTaskStore().handleTaskStarted(task());
    useSubagentStore().subagents = { tc1: card() };
    const wrapper = render();

    await wrapper.get('[data-testid="bg-subagent-row"]').trigger('click');

    expect(useSubagentStore().expandedSubagentId).toBe('tc1');
  });

  it('stops a running task', async () => {
    useBackgroundTaskStore().handleTaskStarted(task());
    useSubagentStore().subagents = { tc1: card() };
    const wrapper = render();

    await wrapper.get('[data-action="stop"]').trigger('click');

    expect(postMessage).toHaveBeenCalledWith({ type: 'stopSubagent', agentId: 'a1' });
    expect(wrapper.find('[data-action="dismiss"]').exists()).toBe(false);
    expect(useSubagentStore().expandedSubagentId).toBeNull();
  });

  it('dismisses a finished task', async () => {
    useBackgroundTaskStore().handleTaskStarted(task({ status: 'completed' }));
    useSubagentStore().subagents = { tc1: card({ status: 'completed', endTime: Date.now() }) };
    const wrapper = render();

    await wrapper.get('[data-action="dismiss"]').trigger('click');
    await nextTick();

    expect(useBackgroundTaskStore().tasks).toEqual([]);
    expect(wrapper.find('[data-testid="bg-subagent-row"]').exists()).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('keeps a task with no card listed and stoppable', async () => {
    useBackgroundTaskStore().handleTaskStarted(task({ description: 'orphan' }));
    const wrapper = render();

    expect(wrapper.get('[data-testid="task-fallback-row"]').text()).toBe('orphan');
    expect(wrapper.text()).not.toContain('No background tasks');
    await wrapper.get('[data-action="stop"]').trigger('click');

    expect(postMessage).toHaveBeenCalledWith({ type: 'stopSubagent', agentId: 'a1' });
  });

  it('shows the empty state with no tasks', () => {
    const wrapper = render();

    expect(wrapper.text()).toContain('No background tasks');
  });
});
