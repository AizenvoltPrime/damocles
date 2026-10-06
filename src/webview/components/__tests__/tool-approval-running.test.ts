// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { computed, createApp, h } from 'vue';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { createHandlerRegistry } from '@/composables/message-handler/handler-registry';
import type { HandlerRegistry, HandlerContext } from '@/composables/message-handler/types';
import ToolCallCard from '../ToolCallCard.vue';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { i18n } from '@/i18n';

/**
 * A prompt moves a shell card to awaiting approval, and only core knows when the gate lets the call
 * through. These replay the messages the extension sends, in its order, through the real registry.
 */

const CALL = 'b1';

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

function deliver(registry: HandlerRegistry, message: ExtensionToWebviewMessage): void {
  const handler = registry[message.type] as ((msg: ExtensionToWebviewMessage, ctx: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`${message.type} is not routed by the registry`);
  handler(message, {
    stores: {
      streamingStore: useStreamingStore(),
      subagentStore: useSubagentStore(),
      permissionStore: usePermissionStore(),
      sessionStore: useSessionStore(),
      uiStore: useUIStore(),
      teamStore: useTeamStore(),
    },
  } as unknown as HandlerContext);
}

/** The card over whatever the streaming store holds for the call, so every store edit reaches it. */
function cardOverStore(): VueWrapper {
  const Host = {
    setup() {
      const streaming = useStreamingStore();
      const toolCall = computed(() => streaming.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === CALL));
      return () => (toolCall.value ? h(ToolCallCard, { toolCall: toolCall.value, source: 'session' }) : null);
    },
  };
  return mount(Host, { global: { plugins: [i18n], stubs: { DiffView: true, MarkdownRenderer: true } }, attachTo: document.body });
}

const stopButton = (wrapper: VueWrapper) => wrapper.find(`button[aria-label="${i18n.global.t('toolCall.stopWithNote')}"]`);
const liveOutput = (wrapper: VueWrapper) => wrapper.find(`[role="log"][aria-label="${i18n.global.t('liveOutput.regionLabel')}"]`);

const input = { command: 'npm install' };
const running: ExtensionToWebviewMessage = { type: 'toolPending', toolUseId: CALL, toolName: 'Bash', input, parentToolUseId: null };
const prompt: ExtensionToWebviewMessage = { type: 'requestPermission', toolUseId: CALL, toolName: 'Bash', toolInput: input, command: 'npm install', owner: { kind: 'main' } };
const output: ExtensionToWebviewMessage = { type: 'toolProgress', toolUseId: CALL, toolName: 'Bash', parentToolUseId: null, elapsedTimeSeconds: 3, output: 'added 12 packages' };

/** pi's start, then the gate's prompt, as the extension sends them for a prompted shell call. */
function promptedCall(registry: HandlerRegistry): VueWrapper {
  deliver(registry, { type: 'toolStreaming', messageId: 'm1', tool: { id: CALL, name: 'Bash', input }, contentBlocks: [{ type: 'tool_use', id: CALL, name: 'Bash', input }] });
  deliver(registry, running);
  const wrapper = cardOverStore();
  expect(stopButton(wrapper).exists()).toBe(true);
  deliver(registry, prompt);
  return wrapper;
}

beforeEach(() => setActivePinia(createPinia()));

describe('a prompted shell call the gate lets through', () => {
  it('offers Stop and shows live output again once the user approves and core reports it running', async () => {
    const registry = buildRegistry();
    const wrapper = promptedCall(registry);
    await wrapper.vm.$nextTick();
    expect(stopButton(wrapper).exists()).toBe(false);

    // What the approve click does in App.vue; the card's status is core's to report.
    usePermissionStore().removePermission(CALL);
    deliver(registry, running);
    deliver(registry, output);
    await wrapper.vm.$nextTick();

    expect(stopButton(wrapper).exists()).toBe(true);
    expect(liveOutput(wrapper).text()).toBe('added 12 packages');
    wrapper.unmount();
  });
});

describe("a subagent's prompted shell call", () => {
  const AGENT_CALL = 'agent-call-1';
  const subagentRunning: ExtensionToWebviewMessage = { ...running, parentToolUseId: AGENT_CALL } as ExtensionToWebviewMessage;
  const subagentOutput: ExtensionToWebviewMessage = { ...output, parentToolUseId: AGENT_CALL } as ExtensionToWebviewMessage;

  function cardOverSubagentStore(): VueWrapper {
    const Host = {
      setup() {
        const subagents = useSubagentStore();
        const toolCall = computed(() => subagents.subagents[AGENT_CALL]?.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === CALL));
        return () => (toolCall.value ? h(ToolCallCard, { toolCall: toolCall.value, source: 'subagent' }) : null);
      },
    };
    return mount(Host, { global: { plugins: [i18n], stubs: { DiffView: true, MarkdownRenderer: true } }, attachTo: document.body });
  }

  it('needs approval with no Stop while its prompt is open, then offers Stop once core reports it running', async () => {
    const registry = buildRegistry();
    useSubagentStore().registerAgentTool(AGENT_CALL, { description: 'Install deps', subagent_type: 'general-purpose' });
    // pi seals the subagent's message, then starts the call, then the gate raises its prompt.
    deliver(registry, {
      type: 'assistant',
      data: { type: 'assistant', message: { id: 'sub:a:1', role: 'assistant', content: [{ type: 'tool_use', id: CALL, name: 'Bash', input }], model: '', stop_reason: null }, session_id: 's1' },
      parentToolUseId: AGENT_CALL,
    });
    deliver(registry, subagentRunning);
    const wrapper = cardOverSubagentStore();
    expect(stopButton(wrapper).exists()).toBe(true);

    deliver(registry, { ...prompt, owner: { kind: 'subagent', agentId: AGENT_CALL }, parentToolUseId: AGENT_CALL } as ExtensionToWebviewMessage);
    await wrapper.vm.$nextTick();
    expect(stopButton(wrapper).exists()).toBe(false);
    expect(wrapper.text()).toContain(i18n.global.t('toolCall.awaitingApproval'));

    usePermissionStore().removePermission(CALL);
    deliver(registry, subagentRunning);
    deliver(registry, subagentOutput);
    await wrapper.vm.$nextTick();

    expect(stopButton(wrapper).exists()).toBe(true);
    expect(wrapper.text()).not.toContain(i18n.global.t('toolCall.awaitingApproval'));
    expect(liveOutput(wrapper).text()).toBe('added 12 packages');
    wrapper.unmount();
  });
});
