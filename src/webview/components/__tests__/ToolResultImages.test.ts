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

// The page's image cache outlives a test, so each test's calls have ids of their own.
let run = 0;
const id = (suffix = ''): string => `t-${run}${suffix}`;
const tool = (over: Partial<ToolCall> = {}): ToolCall => ({ id: id(), name: 'Read', input: {}, status: 'completed', result: 'Read image file [image/png]', imageCount: 1, ...over });

let posted: Request[] = [];
const mounted: VueWrapper[] = [];

function mountImages(props: { tool: ToolCall; owner?: ToolResultOwner; captions?: string[]; sizes?: ({ width: number; height: number } | undefined)[] }): VueWrapper {
  const wrapper = mount(ToolResultImages, { props, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

async function reply(requestId: string, images: unknown[]): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolResultImages', requestId, images } }));
  await nextTick();
}

const sources = (wrapper: VueWrapper): string[] => wrapper.findAll('img').map((img) => img.attributes('src') ?? '');

beforeEach(() => {
  run += 1;
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

    expect(posted).toEqual([{ type: 'requestToolResultImages', requestId: expect.any(String), toolUseId: id(), owner: SESSION }]);
    expect(wrapper.findAll('[data-testid="tool-result-image-placeholder"]')).toHaveLength(2);

    await reply(posted[0]!.requestId, [PNG, JPEG]);

    expect(sources(wrapper)).toEqual([expect.stringMatching(/^blob:/), expect.stringMatching(/^blob:/)]);
    expect(new Set(sources(wrapper)).size).toBe(2);
    expect(posted).toHaveLength(1);
  });

  it('reuses the decoded images when the card mounts again, asking core nothing', async () => {
    const first = mountImages({ tool: tool(), owner: SESSION });
    await reply(posted[0]!.requestId, [PNG]);
    const shown = sources(first);
    first.unmount();
    mounted.splice(mounted.indexOf(first), 1);

    const again = mountImages({ tool: tool(), owner: SESSION });

    expect(posted).toHaveLength(1);
    expect(sources(again)).toEqual(shown);
  });

  it('keeps one box for a thumbnail, sized from the capture before and after it loads, its aspect held within bounds', async () => {
    const wrapper = mountImages({ tool: tool({ imageCount: 3 }), owner: SESSION, sizes: [{ width: 1280, height: 900 }, { width: 640, height: 90 }, undefined] });
    const placeholders = wrapper.findAll('[data-testid="tool-result-image-placeholder"]');
    expect(placeholders[0]!.attributes('style')).toContain('aspect-ratio: 1.422');
    // A short strip still reads as a thumbnail.
    expect(placeholders[1]!.attributes('style')).toContain('aspect-ratio: 2');
    expect(placeholders[2]!.classes()).toContain('h-28');

    await reply(posted[0]!.requestId, [PNG, JPEG, PNG]);

    const boxes = wrapper.findAll('[data-testid="tool-result-image"] button');
    expect(boxes[0]!.attributes('style')).toContain('aspect-ratio: 1.422');
    expect(boxes[0]!.classes()).toContain('w-40');
    expect(boxes[2]!.classes()).toEqual(expect.arrayContaining(['w-40', 'h-28']));
  });

  it('revokes the URLs of images no card holds once the cache is full', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const first = mountImages({ tool: tool({ id: id('-first') }), owner: SESSION });
    await reply(posted[0]!.requestId, [PNG]);
    const firstUrl = sources(first)[0]!;
    first.unmount();
    mounted.splice(mounted.indexOf(first), 1);

    for (let index = 0; index < 4; index++) {
      const wrapper = mountImages({ tool: tool({ id: id(`-${index}`), imageCount: 12 }), owner: SESSION });
      await reply(posted.at(-1)!.requestId, Array.from({ length: 12 }, () => PNG));
      wrapper.unmount();
      mounted.splice(mounted.indexOf(wrapper), 1);
    }

    expect(revoke).toHaveBeenCalledWith(firstUrl);
  });

  it('sends nothing and renders nothing for a result without images', () => {
    const wrapper = mountImages({ tool: { id: id(), name: 'Read', input: {}, status: 'completed', result: 'a.ts' }, owner: SESSION });

    expect(posted).toEqual([]);
    expect(wrapper.find('[data-testid="tool-result-images"]').exists()).toBe(false);
  });

  it('ignores a reply to a request it no longer waits on', async () => {
    const wrapper = mountImages({ tool: tool(), owner: SESSION });
    const first = posted[0]!.requestId;
    await wrapper.setProps({ tool: tool({ id: id('-2') }) });
    expect(posted).toHaveLength(2);

    await reply(first, [PNG]);
    expect(wrapper.findAll('img')).toHaveLength(0);
    expect(wrapper.findAll('[data-testid="tool-result-image-placeholder"]')).toHaveLength(1);

    await reply(posted[1]!.requestId, [JPEG]);
    expect(sources(wrapper)).toEqual([expect.stringMatching(/^blob:/)]);
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
    const wrapper = mountImages({ tool: { id: id(), name: 'Read', input: {}, status: 'running' }, owner: SESSION });
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
    expect(posted[1]).toEqual({ type: 'requestToolResultImages', requestId: expect.any(String), toolUseId: id(), owner: subagentOwner });
    expect(posted[1]!.requestId).not.toBe(first);

    await reply(first, [PNG]);
    expect(wrapper.findAll('img')).toHaveLength(0);

    await reply(posted[1]!.requestId, [JPEG]);
    expect(sources(wrapper)).toEqual([expect.stringMatching(/^blob:/)]);
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

  it('emits the URL of a clicked thumbnail', async () => {
    const wrapper = mountImages({ tool: tool(), owner: SESSION });
    await reply(posted[0]!.requestId, [PNG]);

    await wrapper.get('button').trigger('click');

    expect(wrapper.emitted('open')).toEqual([[sources(wrapper)[0]]]);
  });

  it('labels each image by its caption, in image order, while loading and once loaded', async () => {
    const wrapper = mountImages({ tool: tool({ imageCount: 2 }), owner: SESSION, captions: ['base · 390 px', 'sm · 640 px'] });

    expect(wrapper.findAll('[data-testid="tool-result-image-placeholder"]')).toHaveLength(2);
    expect(wrapper.text()).toContain('sm · 640 px');

    await reply(posted[0]!.requestId, [PNG, JPEG]);

    expect(wrapper.findAll('[data-testid="tool-result-image-caption"]').map((caption) => caption.text())).toEqual(['base · 390 px', 'sm · 640 px']);
    expect(wrapper.findAll('button').map((b) => b.attributes('aria-label'))).toEqual(['Open image: base · 390 px', 'Open image: sm · 640 px']);
  });
});
