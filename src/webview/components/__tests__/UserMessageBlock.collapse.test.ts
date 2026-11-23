// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import UserMessageBlock from '../UserMessageBlock.vue';
import { i18n } from '@/i18n';

// The page has no layout here, so the density a theme sets is the mocked size of a spacing rem.
const density = vi.hoisted(() => ({ value: undefined as unknown as { value: number } }));
vi.mock('@/composables/useRemPx', async (original) => {
  density.value = ref(1);
  return { ...(await original<typeof import('@/composables/useRemPx')>()), spacedRemPx: (rem: number) => rem * 16 * density.value.value };
});

let wrapper: VueWrapper | undefined;

function bubble(contentPx: number): VueWrapper {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(contentPx);
  wrapper = mount(UserMessageBlock, {
    props: { message: { id: 'u1', role: 'user', content: 'a long prompt', timestamp: 1 }, messageIndex: 0, canRewind: false, promptIndex: 0 },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
  });
  return wrapper;
}

const collapsed = (w: VueWrapper): boolean => w.get('[data-testid="user-message-body"]').classes().includes('max-h-40');

beforeEach(() => {
  setActivePinia(createPinia());
  density.value.value = 1;
});

afterEach(() => {
  wrapper?.unmount();
  vi.restoreAllMocks();
});

// `max-h-40` is 10rem times the theme's density, so the height that counts as too long is too.
describe('the collapsed user bubble', () => {
  it.each([
    [1.15, 170, false],
    [1.15, 190, true],
    [0.85, 150, true],
    [0.85, 130, false],
  ])('at density %s, a prompt %spx high is clamped: %s', async (scale, contentPx, clamped) => {
    density.value.value = scale;
    const w = bubble(contentPx);
    await nextTick();
    expect(collapsed(w)).toBe(clamped);
    expect(w.find('[data-testid="user-message-expand"]').exists()).toBe(clamped);
  });

  it('follows a density that changes under it', async () => {
    const w = bubble(170);
    await nextTick();
    expect(collapsed(w)).toBe(true);

    density.value.value = 1.15;
    await nextTick();
    expect(collapsed(w)).toBe(false);
  });

  // The bubble is translucent over a wallpaper: a color laid over the last lines would neither hide them nor match it.
  it('fades its last lines with a mask, never with a color laid over them', async () => {
    const w = bubble(400);
    await nextTick();
    const body = w.get('[data-testid="user-message-body"]');
    expect(body.classes().some((name) => name.startsWith('mask-b-from-'))).toBe(true);
    expect(body.findAll('[aria-hidden="true"]').filter((el) => el.classes().some((name) => name.startsWith('bg-linear') || name.startsWith('from-')))).toEqual([]);
  });
});
