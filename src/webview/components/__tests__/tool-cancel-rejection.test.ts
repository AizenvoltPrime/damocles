// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { computed, createApp, h } from 'vue';
import type { ToolCall } from '@shared/types/session';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { createHandlerRegistry } from '@/composables/message-handler/handler-registry';
import type { HandlerRegistry, HandlerContext } from '@/composables/message-handler/types';
import ToolCancelControl from '../ToolCancelControl.vue';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { i18n } from '@/i18n';

/**
 * The extension rejects a cancel it cannot honour, and the control has to come back to idle. The two
 * cases that differ are the one where a store held the call and the one where none did, because only
 * the first has a `cancelRequested` flag to clear. Both go through the real registry, since a handler
 * that is never routed is as broken as one that does nothing.
 */

type RejectionMessage = Extract<ExtensionToWebviewMessage, { type: 'toolCancelRejected' }>;

const RUNNING_SHELL_CALL: ToolCall = {
  id: 't-1',
  name: 'Bash',
  input: { command: 'sleep 300' },
  status: 'running',
};

function buildRegistry(): HandlerRegistry {
  let registry!: HandlerRegistry;
  const app = createApp({
    setup() {
      registry = createHandlerRegistry();
      return () => null;
    },
  });
  app.use(i18n);
  app.mount(document.createElement('div'));
  app.unmount();
  return registry;
}

function context(): HandlerContext {
  // Only the three tool stores are reachable from this handler; the rest of the context is absent
  // rather than stubbed into something a test could accidentally trust.
  return {
    stores: {
      streamingStore: useStreamingStore(),
      subagentStore: useSubagentStore(),
      teamStore: useTeamStore(),
    },
  } as unknown as HandlerContext;
}

function reject(message: RejectionMessage): void {
  const handler = buildRegistry().toolCancelRejected;
  if (!handler) throw new Error('toolCancelRejected is not routed by the registry');
  handler(message, context());
}

/** Mounts the control over whatever the streaming store currently holds, so a store edit reaches the props. */
function controlOverSessionStore(): VueWrapper {
  const Host = {
    setup() {
      const streaming = useStreamingStore();
      const toolCall = computed(() => streaming.messages[0]?.toolCalls?.[0]);
      return () =>
        toolCall.value ? h(ToolCancelControl, { toolCall: toolCall.value, source: 'session' }) : null;
    },
  };
  return mount(Host, { global: { plugins: [i18n] }, attachTo: document.body });
}

function controlOverDetachedCall(): VueWrapper {
  return mount(ToolCancelControl, {
    props: { toolCall: RUNNING_SHELL_CALL, source: 'session' },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
}

/** Opens the note and sends it, returning the request id the control minted. */
async function cancelOnce(wrapper: VueWrapper): Promise<string> {
  const posted = vi.spyOn(globalThis.acquireVsCodeApi(), 'postMessage');
  await wrapper.find('button').trigger('click');
  await wrapper.vm.$nextTick();

  const send = wrapper.findAll('button')[0];
  if (!send) throw new Error('the note box rendered no Send button');
  await send.trigger('click');
  await wrapper.vm.$nextTick();

  const [message] = posted.mock.calls[0] as [{ type: string; requestId?: unknown }];
  posted.mockRestore();
  if (message.type !== 'cancelToolCall' || typeof message.requestId !== 'string') {
    throw new Error('the control posted no cancelToolCall carrying a request id');
  }
  return message.requestId;
}

function label(wrapper: VueWrapper): string {
  return wrapper.find('button').text();
}

function isClickable(wrapper: VueWrapper): boolean {
  const button = wrapper.find('button');
  return button.attributes('aria-disabled') !== 'true' && button.attributes('disabled') === undefined;
}

const STOP = i18n.global.t('toolCall.stop');
const STOPPING = i18n.global.t('toolCall.stopping');

beforeEach(() => setActivePinia(createPinia()));

describe('a cancel the extension rejects, with the call in a store', () => {
  function seed(): ReturnType<typeof useStreamingStore> {
    const store = useStreamingStore();
    store.addToolCall({ id: 't-1', name: 'Bash', input: { command: 'sleep 300' } });
    store.updateToolStatus('t-1', 'running');
    return store;
  }

  it('returns the control to a clickable Stop and clears the store flag', async () => {
    const store = seed();
    const wrapper = controlOverSessionStore();

    const requestId = await cancelOnce(wrapper);
    expect(store.messages[0]?.toolCalls?.[0]?.cancelRequested).toBe(true);
    expect(label(wrapper)).toBe(STOPPING);
    expect(isClickable(wrapper)).toBe(false);

    reject({ type: 'toolCancelRejected', toolUseId: 't-1', requestId });
    await wrapper.vm.$nextTick();

    expect(Object.hasOwn(store.messages[0]?.toolCalls?.[0] ?? {}, 'cancelRequested')).toBe(false);
    expect(label(wrapper)).toBe(STOP);
    expect(isClickable(wrapper)).toBe(true);
  });

  it('opens the note again on the next click, so the cancel can be retried', async () => {
    seed();
    const wrapper = controlOverSessionStore();
    const requestId = await cancelOnce(wrapper);

    reject({ type: 'toolCancelRejected', toolUseId: 't-1', requestId });
    await wrapper.vm.$nextTick();

    await wrapper.find('button').trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('textarea').exists()).toBe(true);
  });
});

describe('a cancel the extension rejects, with the call in no store', () => {
  it('returns the control to a clickable Stop with nothing in a store to clear', async () => {
    const wrapper = controlOverDetachedCall();

    const requestId = await cancelOnce(wrapper);
    expect(RUNNING_SHELL_CALL.cancelRequested).toBeUndefined();
    expect(label(wrapper)).toBe(STOPPING);
    expect(isClickable(wrapper)).toBe(false);

    reject({ type: 'toolCancelRejected', toolUseId: 't-1', requestId });
    await wrapper.vm.$nextTick();

    expect(label(wrapper)).toBe(STOP);
    expect(isClickable(wrapper)).toBe(true);
  });

  it('falls back to the tool id when the extension echoes no request id', async () => {
    const wrapper = controlOverDetachedCall();
    await cancelOnce(wrapper);

    reject({ type: 'toolCancelRejected', toolUseId: 't-1' });
    await wrapper.vm.$nextTick();

    expect(label(wrapper)).toBe(STOP);
    expect(isClickable(wrapper)).toBe(true);
  });
});

describe('the request id is what decides which cancel a rejection clears', () => {
  it('leaves an accepted cancel stopping when a different request is rejected', async () => {
    const wrapper = controlOverDetachedCall();
    await cancelOnce(wrapper);

    reject({ type: 'toolCancelRejected', toolUseId: 't-1', requestId: 'a-request-this-webview-never-made' });
    await wrapper.vm.$nextTick();

    expect(label(wrapper)).toBe(STOPPING);
    expect(isClickable(wrapper)).toBe(false);
  });

  it('clears only the source the request marked, leaving a colliding id in another store alone', async () => {
    const streaming = useStreamingStore();
    streaming.addToolCall({ id: 't-1', name: 'Bash', input: { command: 'sleep 300' } });
    streaming.updateToolStatus('t-1', 'running');

    const team = useTeamStore();
    team.agentMessages = {
      'agent-1': [{
        id: 'msg-1',
        role: 'assistant',
        content: '',
        toolCalls: [{ ...RUNNING_SHELL_CALL, cancelRequested: true }],
        timestamp: 1,
      }],
    };

    const wrapper = controlOverSessionStore();
    const requestId = await cancelOnce(wrapper);

    reject({ type: 'toolCancelRejected', toolUseId: 't-1', requestId });
    await wrapper.vm.$nextTick();

    expect(Object.hasOwn(streaming.messages[0]?.toolCalls?.[0] ?? {}, 'cancelRequested')).toBe(false);
    expect(team.agentMessages['agent-1']?.[0]?.toolCalls?.[0]?.cancelRequested).toBe(true);
  });
});
