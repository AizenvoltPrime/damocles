// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { SubagentState } from '@shared/types/subagents';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import SubagentOverlay from '../SubagentOverlay.vue';
import { settleOverlaySteer } from '@/composables/useOverlaySteer';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { i18n } from '@/i18n';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m) }),
}));

enableAutoUnmount(beforeEach);

const Shell = defineComponent({
  template: '<div><slot name="header-actions" /><slot /><slot name="footer" /></div>',
});

function subagent(over: Partial<SubagentState> = {}): SubagentState {
  return {
    id: 'tc1', agentType: 'Explore', description: 'Survey', prompt: 'Find the limiter', status: 'running', startTime: Date.now(),
    messages: [], toolCalls: [], messagesSealed: false, sdkAgentId: 'agent-7', isBackground: true, ...over,
  };
}

function open(state: SubagentState) {
  return mount(SubagentOverlay, { props: { subagent: state }, global: { plugins: [i18n], stubs: { OverlayShell: Shell, MarkdownRenderer: true } } });
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});

describe('the subagent overlay steer bar', () => {
  it('sends a steer to the running agent and clears the input once it is delivered', async () => {
    const wrapper = open(subagent());
    const input = wrapper.get('[data-testid="agent-steer-input"]');
    await input.setValue('also check /refresh');

    await input.trigger('keydown', { key: 'Enter' });
    const steer = posted.find((m) => m.type === 'steerAgent');
    expect(steer).toMatchObject({ type: 'steerAgent', agentId: 'agent-7', message: 'also check /refresh' });

    settleOverlaySteer((steer as { requestId: string }).requestId, true);
    await nextTick();
    expect((input.element as HTMLInputElement).value).toBe('');
  });

  it('keeps the note and says so when the steer is not delivered', async () => {
    const wrapper = open(subagent());
    const input = wrapper.get('[data-testid="agent-steer-input"]');
    await input.setValue('stop after the tests');
    await wrapper.get('[data-testid="agent-steer-send"]').trigger('click');
    const steer = posted.find((m) => m.type === 'steerAgent') as { requestId: string };

    settleOverlaySteer(steer.requestId, false);
    await nextTick();
    expect((input.element as HTMLInputElement).value).toBe('stop after the tests');
    expect(wrapper.text()).toContain('The note was not delivered.');
  });

  it('offers no steer bar once the agent has finished', () => {
    expect(open(subagent({ status: 'completed' })).find('[data-testid="agent-steer-bar"]').exists()).toBe(false);
  });
});

describe('the subagent overlay actions', () => {
  it('stops a running subagent by the record id core announced', async () => {
    const wrapper = open(subagent());
    await wrapper.get('[data-testid="subagent-stop"]').trigger('click');
    expect(posted).toEqual([{ type: 'stopSubagent', agentId: 'agent-7' }]);
  });

  it('opens the background tasks overlay from its Background chip, and the log from its header', async () => {
    const wrapper = open(subagent());
    await wrapper.get('[data-testid="subagent-background-chip"]').trigger('click');
    expect(useBackgroundTaskStore().isOverlayOpen).toBe(true);
    await wrapper.get('button[title="Open agent log file"]').trigger('click');
    expect(wrapper.emitted('openLog')).toEqual([['agent-7']]);
  });
});
