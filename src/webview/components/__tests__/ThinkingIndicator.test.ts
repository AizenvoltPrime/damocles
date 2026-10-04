// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ThinkingIndicator from '../ThinkingIndicator.vue';
import { i18n } from '@/i18n';

/** The thinking block follows its reasoning while it streams and opens a finished one at its start. */

const mounted: VueWrapper[] = [];

// The typewriter reveal runs a frame loop that is not under test, and happy-dom's frames are immediates
// that fail when cancelled at teardown.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function expanded(isStreaming: boolean): Promise<HTMLElement> {
  const wrapper = mount(ThinkingIndicator, {
    props: { thinking: 'reasoning', isStreaming, defaultExpanded: true },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await nextTick();
  const box = wrapper.get('.thinking-content').element as HTMLElement;
  // happy-dom computes no layout: 1000px of reasoning in the 256px box.
  let top = 0;
  Object.defineProperties(box, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 256 },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, 744)); } },
  });
  return box;
}

/** More reasoning renders into the box, as the markdown renderer's DOM grows. */
async function moreReasoning(box: HTMLElement): Promise<void> {
  box.append(document.createElement('p'));
  await nextTick();
}

describe('ThinkingIndicator scrolling', () => {
  it('keeps the newest reasoning in view while it streams', async () => {
    const box = await expanded(true);

    await moreReasoning(box);

    expect(box.scrollTop).toBe(744);
  });

  it('opens a finished block at its start', async () => {
    const box = await expanded(false);

    await moreReasoning(box);

    expect(box.scrollTop).toBe(0);
  });
});
