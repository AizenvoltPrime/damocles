// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import ToolOverlay from '../ToolOverlay.vue';
import { hasOpenOverlay } from '@/composables/useOverlayEscape';
import { useUIStore } from '@/stores/useUIStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { i18n } from '@/i18n';

/**
 * The seam between the overlay stack and the cancel control. A tool id is not unique across stores, so
 * a cancel from an overlay opened off a subagent card has to reach the subagent store and leave an
 * identically numbered session call alone. The overlay takes its source from the same store field that
 * chose which tool it is showing.
 */

const RUNNING: Omit<ToolCall, 'status'> = { id: 't-1', name: 'Bash', input: { command: 'sleep 300' } };

/** Every overlay registers in a module-scoped stack, so one left mounted would follow the next case in. */
const mounted: VueWrapper[] = [];

function overlayFor(source: 'session' | 'subagent'): VueWrapper {
  useUIStore().expandTool('t-1', source);
  const wrapper = mount(ToolOverlay, {
    props: { tool: { ...RUNNING, status: 'running' } },
    global: { plugins: [i18n], stubs: { LiveOutputPane: true, MarkdownRenderer: true, CodeBlock: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

/** Presses Stop, then Send, and returns what the webview posted. */
async function cancelFromOverlay(wrapper: VueWrapper): Promise<Record<string, unknown>> {
  const posted = vi.spyOn(globalThis.acquireVsCodeApi(), 'postMessage');
  const trigger = wrapper.get(`[aria-label="${i18n.global.t('toolCall.stopWithNote')}"]`);
  await trigger.trigger('click');
  await wrapper.vm.$nextTick();

  const send = wrapper.findAll('button').find((b) => b.text() === i18n.global.t('toolCall.cancelNoteSubmit'));
  if (!send) throw new Error('the note box rendered no Send button');
  await send.trigger('click');
  await wrapper.vm.$nextTick();

  const [message] = posted.mock.calls[0] as [Record<string, unknown>];
  posted.mockRestore();
  return message;
}

function seedBothStoresWithTheSameId(): { streaming: ReturnType<typeof useStreamingStore>; subagent: ReturnType<typeof useSubagentStore> } {
  const streaming = useStreamingStore();
  streaming.addToolCall({ ...RUNNING });
  streaming.updateToolStatus('t-1', 'running');

  const subagent = useSubagentStore();
  subagent.registerAgentTool('sub-1', { description: 'work', prompt: 'go' });
  subagent.addToolCallToSubagent('sub-1', { ...RUNNING, status: 'running' });

  return { streaming, subagent };
}

function sessionCall(streaming: ReturnType<typeof useStreamingStore>): ToolCall | undefined {
  return streaming.messages[0]?.toolCalls?.[0];
}

function subagentCall(subagent: ReturnType<typeof useSubagentStore>): ToolCall | undefined {
  return subagent.getSubagent('sub-1')?.toolCalls[0];
}

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe('a cancel issued from inside the tool overlay', () => {
  it('marks the subagent store and leaves the identically numbered session call alone', async () => {
    const { streaming, subagent } = seedBothStoresWithTheSameId();
    const wrapper = overlayFor('subagent');

    await cancelFromOverlay(wrapper);

    expect(subagentCall(subagent)?.cancelRequested).toBe(true);
    expect(sessionCall(streaming)?.cancelRequested).toBeUndefined();
  });

  it('marks the session store and leaves the identically numbered subagent call alone', async () => {
    // Pins the contrast: without this, an overlay hardwired to the subagent store would pass the case above.
    const { streaming, subagent } = seedBothStoresWithTheSameId();
    const wrapper = overlayFor('session');

    await cancelFromOverlay(wrapper);

    expect(sessionCall(streaming)?.cancelRequested).toBe(true);
    expect(subagentCall(subagent)?.cancelRequested).toBeUndefined();
  });

  it('carries a request id so the extension can reject this cancel specifically', async () => {
    seedBothStoresWithTheSameId();
    const message = await cancelFromOverlay(overlayFor('subagent'));

    expect(message.type).toBe('cancelToolCall');
    expect(message.toolUseId).toBe('t-1');
    expect(typeof message.requestId).toBe('string');
  });
});

describe('the overlay stack around the tool overlay', () => {
  it('registers while the overlay is open', () => {
    seedBothStoresWithTheSameId();
    overlayFor('subagent');

    expect(hasOpenOverlay()).toBe(true);
  });

  it('leaves the stack empty on unmount, so the next overlay opened takes Escape', async () => {
    seedBothStoresWithTheSameId();
    overlayFor('subagent').unmount();
    expect(hasOpenOverlay()).toBe(false);

    const reopened = overlayFor('subagent');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await reopened.vm.$nextTick();

    expect(reopened.emitted('close')).toHaveLength(1);
  });

  it('leaves the stack empty even when a cancel left the control stopping', async () => {
    seedBothStoresWithTheSameId();
    const wrapper = overlayFor('subagent');
    await cancelFromOverlay(wrapper);

    wrapper.unmount();

    expect(hasOpenOverlay()).toBe(false);
  });
});
