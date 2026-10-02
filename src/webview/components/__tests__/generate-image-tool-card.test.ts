// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia, type Pinia } from 'pinia';
import type { ToolCall, ToolResultOwner } from '@shared/types/session';
import { TOOL_GENERATE_IMAGE } from '@shared/tool-names';
import ToolCallCard from '../ToolCallCard.vue';
import ToolOverlay from '../ToolOverlay.vue';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { i18n } from '@/i18n';

/**
 * A generated image reaches the screen only through `imageCount`: the card opens the overlay, and the
 * overlay's `ToolResultImages` fetches the block on demand. The base64 must never land in a store.
 */

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
const BASE64 = 'R0VORVJBVEVEX0lNQUdF';
const SESSION: ToolResultOwner = { kind: 'session' };

const GENERATED: ToolCall = {
  id: 'g-1',
  name: TOOL_GENERATE_IMAGE,
  input: { prompt: 'A red fox in snow', file_path: 'assets/fox.png' },
  status: 'completed',
  result: 'Saved image/png (1234 bytes) to assets/fox.png',
  imageCount: 1,
};

let pinia: Pinia;
let posted: Array<Record<string, unknown>> = [];
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as Record<string, unknown>));
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
});

describe('GenerateImage tool card', () => {
  it('summarizes the target path and opens the overlay', async () => {
    const wrapper = mount(ToolCallCard, {
      props: { toolCall: GENERATED, source: 'session' },
      global: { plugins: [i18n], stubs: { LiveOutputPane: true, DiffView: true, MarkdownRenderer: true } },
    });
    mounted.push(wrapper);

    expect(wrapper.text()).toContain('assets/fox.png');
    await wrapper.get(`[aria-label="${i18n.global.t('toolCall.expandDetails', { name: TOOL_GENERATE_IMAGE })}"]`).trigger('click');
    expect(wrapper.emitted('expand')).toEqual([['g-1']]);
  });

  it('renders ToolResultImages by imageCount, fetched on demand and kept out of every store', async () => {
    useStreamingStore().addToolCall({ id: GENERATED.id, name: GENERATED.name, input: GENERATED.input });
    useStreamingStore().updateToolStatus(GENERATED.id, 'completed', { result: GENERATED.result!, imageCount: 1 });

    const wrapper = mount(ToolOverlay, {
      props: { tool: GENERATED, owner: SESSION },
      global: { plugins: [i18n], stubs: { LiveOutputPane: true, MarkdownRenderer: true, CodeBlock: true } },
      attachTo: document.body,
    });
    mounted.push(wrapper);

    const request = posted.find((m) => m.type === 'requestToolResultImages');
    expect(request).toEqual({ type: 'requestToolResultImages', requestId: expect.any(String), toolUseId: 'g-1', owner: SESSION });
    expect(document.body.querySelectorAll('[data-testid="tool-result-image-placeholder"]')).toHaveLength(1);

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'toolResultImages',
        requestId: request!.requestId,
        images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64 } }],
      },
    }));
    await nextTick();

    const img = document.body.querySelector<HTMLImageElement>('[data-testid="tool-result-images"] img');
    expect(img?.getAttribute('src')).toBe(`data:image/png;base64,${BASE64}`);
    expect(JSON.stringify(pinia.state.value)).not.toContain(BASE64);
  });
});
