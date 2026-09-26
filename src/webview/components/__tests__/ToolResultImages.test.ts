// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { ToolCall, ToolResultOwner } from '@shared/types/session';
import type { ImageBlock } from '@shared/types/content';
import ToolResultImages from '../ToolResultImages.vue';
import { i18n } from '@/i18n';

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

interface Request { type: string; requestId: string; toolUseId: string; owner: ToolResultOwner }

const PNG: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
const JPEG: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } };
const SESSION: ToolResultOwner = { kind: 'session' };

const tool = (over: Partial<ToolCall> = {}): ToolCall => ({ id: 't-1', name: 'Read', input: {}, status: 'completed', result: 'Read image file [image/png]', imageCount: 1, ...over });
const TEXT_ONLY: ToolCall = { id: 't-1', name: 'Read', input: {}, status: 'completed', result: 'a.ts' };
const RUNNING: ToolCall = { id: 't-1', name: 'Read', input: {}, status: 'running' };

let posted: Request[] = [];
const mounted: VueWrapper[] = [];

function mountImages(props: { tool: ToolCall; owner?: ToolResultOwner }): VueWrapper {
  const wrapper = mount(ToolResultImages, { props, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

async function reply(requestId: string, images: unknown[]): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolResultImages', requestId, images } }));
  await nextTick();
}

beforeEach(() => {
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as Request));
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
});

describe('ToolResultImages', () => {
  it('sends one request per open and shows a placeholder per image until the reply lands', async () => {
    const wrapper = mountImages({ tool: tool({ imageCount: 2 }), owner: SESSION });

    expect(posted).toEqual([{ type: 'requestToolResultImages', requestId: expect.any(String), toolUseId: 't-1', owner: SESSION }]);
    expect(wrapper.findAll('[data-testid="tool-result-image-placeholder"]')).toHaveLength(2);

    await reply(posted[0]!.requestId, [PNG, JPEG]);

    expect(wrapper.findAll('img').map((img) => img.attributes('src'))).toEqual(['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB']);
    expect(posted).toHaveLength(1);
  });

  it('sends nothing and renders nothing for a result without images', () => {
    const wrapper = mountImages({ tool: TEXT_ONLY, owner: SESSION });

    expect(posted).toEqual([]);
    expect(wrapper.find('[data-testid="tool-result-images"]').exists()).toBe(false);
  });

  it('ignores a reply to a request it no longer waits on', async () => {
    const wrapper = mountImages({ tool: tool(), owner: SESSION });
    const first = posted[0]!.requestId;
    await wrapper.setProps({ tool: tool({ id: 't-2' }) });
    expect(posted).toHaveLength(2);

    await reply(first, [PNG]);
    expect(wrapper.findAll('img')).toHaveLength(0);
    expect(wrapper.findAll('[data-testid="tool-result-image-placeholder"]')).toHaveLength(1);

    await reply(posted[1]!.requestId, [JPEG]);
    expect(wrapper.findAll('img').map((img) => img.attributes('src'))).toEqual(['data:image/jpeg;base64,BBBB']);
  });

  it('shows unavailable for an empty reply', async () => {
    const wrapper = mountImages({ tool: tool(), owner: SESSION });

    await reply(posted[0]!.requestId, []);

    expect(wrapper.text()).toContain('Image unavailable');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('drops reply entries that are not valid image blocks', async () => {
    const wrapper = mountImages({ tool: tool(), owner: SESSION });

    await reply(posted[0]!.requestId, [{ type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' } }]);

    expect(wrapper.text()).toContain('Image unavailable');
  });

  it('shows unavailable without asking when the owner is unknown', () => {
    const wrapper = mountImages({ tool: tool() });

    expect(posted).toEqual([]);
    expect(wrapper.text()).toContain('Image unavailable');
  });

  it('requests when a running call completes with images while it is on screen', async () => {
    const wrapper = mountImages({ tool: RUNNING, owner: SESSION });
    expect(posted).toEqual([]);

    await wrapper.setProps({ tool: tool() });

    expect(posted).toHaveLength(1);
  });

  it('asks again when the owner changes mid-request and ignores the reply to the first ask', async () => {
    const wrapper = mountImages({ tool: tool(), owner: SESSION });
    const first = posted[0]!.requestId;
    const subagentOwner: ToolResultOwner = { kind: 'subagent', agentId: 'agent-9' };

    await wrapper.setProps({ owner: subagentOwner });

    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual({ type: 'requestToolResultImages', requestId: expect.any(String), toolUseId: 't-1', owner: subagentOwner });
    expect(posted[1]!.requestId).not.toBe(first);

    await reply(first, [PNG]);
    expect(wrapper.findAll('img')).toHaveLength(0);

    await reply(posted[1]!.requestId, [JPEG]);
    expect(wrapper.findAll('img').map((img) => img.attributes('src'))).toEqual(['data:image/jpeg;base64,BBBB']);
  });

  it('stops listening once unmounted, so a late reply changes nothing', async () => {
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const wrapper = mountImages({ tool: tool(), owner: SESSION });
    const requestId = posted[0]!.requestId;
    const listener = addListener.mock.calls.find(([type]) => type === 'message')?.[1];
    expect(listener).toBeDefined();

    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);

    expect(removeListener).toHaveBeenCalledWith('message', listener);
    await reply(requestId, [PNG]);
    expect(posted).toHaveLength(1);
  });

  it('announces the loading state and names each thumbnail by its position', async () => {
    const wrapper = mountImages({ tool: tool({ imageCount: 2 }), owner: SESSION });

    const status = wrapper.get('[role="status"]');
    expect(status.attributes('aria-busy')).toBe('true');
    expect(status.text()).toBe('Loading images');

    await reply(posted[0]!.requestId, [PNG, JPEG]);

    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.findAll('button').map((b) => b.attributes('aria-label'))).toEqual(['Open image 1 of 2', 'Open image 2 of 2']);
    expect(wrapper.findAll('img').map((img) => img.attributes('alt'))).toEqual(['', '']);
  });

  it('emits the data URL of a clicked thumbnail', async () => {
    const wrapper = mountImages({ tool: tool(), owner: SESSION });
    await reply(posted[0]!.requestId, [PNG]);

    await wrapper.get('button').trigger('click');

    expect(wrapper.emitted('open')).toEqual([['data:image/png;base64,AAAA']]);
  });
});
