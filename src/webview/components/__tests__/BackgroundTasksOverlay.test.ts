// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { BackgroundTask } from '@shared/types/background-tasks';
import type { SubagentState } from '@shared/types/subagents';
import BackgroundTasksOverlay from '../BackgroundTasksOverlay.vue';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { i18n } from '@/i18n';

vi.mock('@/composables/useVSCode', () => ({ useVSCode: () => ({ postMessage: vi.fn() }) }));

const ShellStub = defineComponent({ template: '<div><slot name="header-actions" /><slot /></div>' });

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: 'a1', toolUseId: 'tc1', description: 'dig in', taskType: 'Explore', status: 'running',
    startTime: Date.now(), endTime: null, outputFile: null, summary: null, progressSummary: 'reading files',
    usage: null, lastToolName: null,
    ...over,
  };
}

function card(over: Partial<SubagentState> = {}): SubagentState {
  return {
    id: 'tc1', agentType: 'Explore', description: 'dig in', prompt: '', status: 'running', startTime: Date.now(),
    messages: [], toolCalls: [], messagesSealed: false,
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

beforeEach(() => setActivePinia(createPinia()));

describe('background task usage', () => {
  it('shows a running agent’s live usage in its row and its detail view', async () => {
    useBackgroundTaskStore().handleTaskStarted(task());
    useSubagentStore().subagents = { tc1: card() };
    const wrapper = render();

    expect(wrapper.get('[data-part="tokens"]').text()).toBe('10.0K tokens');
    expect(wrapper.get('[data-part="cache"]').text()).toBe('86% cache');
    expect(wrapper.get('[data-part="cost"]').text()).toBe('$0.40');

    useBackgroundTaskStore().selectTask('a1');
    await nextTick();
    expect(wrapper.get('[data-part="tokens"]').text()).toBe('10.0K tokens');
  });

  it('falls back to the task’s own total, counted the same way, when no card carries usage', () => {
    useBackgroundTaskStore().handleTaskStarted(task({ status: 'completed', endTime: Date.now(), usage: { totalTokens: 10_000, toolUses: 3, durationMs: 1 } }));
    const wrapper = render();

    expect(wrapper.text()).toContain('3');
    expect(wrapper.text()).toContain('10.0K tokens');
    expect(wrapper.find('[data-part="cache"]').exists()).toBe(false);
  });
});
