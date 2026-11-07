// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useOverflowStrip } from '../useOverflowStrip';
import OverflowSlider from '@/components/OverflowSlider.vue';

// A strip with its row and slider, wired as EditorTabs and DesignHeader wire theirs.
const Harness = defineComponent({
  setup() {
    const strip = ref<HTMLElement | null>(null);
    const row = ref<HTMLElement | null>(null);
    const overflow = useOverflowStrip(strip, row);
    return () => h('div', { 'data-testid': 'wrapper', onPointerenter: overflow.onPointerEnter, onPointerleave: overflow.onPointerLeave }, [
      h('div', { ref: strip, 'data-testid': 'strip', class: ['d-overflow-strip', overflow.fadeClass.value], onScroll: overflow.onScroll, onWheel: overflow.onWheel }, [h('div', { ref: row })]),
      h(OverflowSlider, { strip: overflow, 'data-testid': 'scrollbar' }),
    ]);
  },
});

const mounted: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});

// happy-dom lays nothing out: the strip is `clientWidth` px wide over `scrollWidth` px of content, and keeps any scrollLeft given.
async function stripOf(clientWidth: number, scrollWidth: number) {
  const wrapper = mount(Harness, { attachTo: document.body });
  mounted.push(wrapper);
  const strip = wrapper.get('[data-testid="strip"]');
  const state = { scrollLeft: 0 };
  Object.defineProperties(strip.element, {
    clientWidth: { configurable: true, get: () => clientWidth },
    scrollWidth: { configurable: true, get: () => scrollWidth },
    scrollLeft: { configurable: true, get: () => state.scrollLeft, set: (value: number) => { state.scrollLeft = value; } },
  });
  const scrollTo = async (left: number): Promise<void> => {
    state.scrollLeft = left;
    await strip.trigger('scroll');
  };
  await scrollTo(0);
  return { wrapper, strip, state, scrollTo };
}

describe('an overflowing strip', () => {
  it('fades only the edges with more content beyond them, and sizes and places the slider by the share in view', async () => {
    const { wrapper, strip, scrollTo } = await stripOf(100, 400);
    const slider = () => wrapper.get<HTMLElement>('.d-overflow-slider').element.style;
    expect(strip.classes()).toEqual(expect.arrayContaining(['d-overflow-fade-end']));
    expect(strip.classes()).not.toContain('d-overflow-fade-start');
    expect([slider().width, slider().transform]).toEqual(['25px', 'translateX(0px)']);

    await scrollTo(150);
    expect(strip.classes()).toEqual(expect.arrayContaining(['d-overflow-fade-start', 'd-overflow-fade-end']));

    await scrollTo(300);
    expect(strip.classes()).toContain('d-overflow-fade-start');
    expect(strip.classes()).not.toContain('d-overflow-fade-end');
    expect(slider().transform).toBe('translateX(75px)');
  });

  it('keeps the slider at least 1.25rem long', async () => {
    const { wrapper } = await stripOf(100, 4000);
    expect(wrapper.get<HTMLElement>('.d-overflow-slider').element.style.width).toBe('20px');
  });

  it('draws no slider and no fade while its content fits', async () => {
    const { wrapper, strip } = await stripOf(100, 100);
    expect(wrapper.find('[data-testid="scrollbar"]').exists()).toBe(false);
    expect(strip.classes()).not.toContain('d-overflow-fade-start');
    expect(strip.classes()).not.toContain('d-overflow-fade-end');
  });

  it('shows the slider while hovered or scrolling, and hides it 500 ms after either ends', async () => {
    vi.useFakeTimers();
    const { wrapper, scrollTo } = await stripOf(100, 400);
    const scrollbar = () => wrapper.get('[data-testid="scrollbar"]');
    vi.advanceTimersByTime(500);
    await wrapper.vm.$nextTick();
    expect(scrollbar().classes()).not.toContain('d-overflow-scrollbar-shown');

    await scrollTo(50);
    expect(scrollbar().classes()).toContain('d-overflow-scrollbar-shown');
    vi.advanceTimersByTime(499);
    await wrapper.vm.$nextTick();
    expect(scrollbar().classes()).toContain('d-overflow-scrollbar-shown');
    vi.advanceTimersByTime(1);
    await wrapper.vm.$nextTick();
    expect(scrollbar().classes()).not.toContain('d-overflow-scrollbar-shown');

    await wrapper.get('[data-testid="wrapper"]').trigger('pointerenter');
    vi.advanceTimersByTime(2000);
    await wrapper.vm.$nextTick();
    expect(scrollbar().classes()).toContain('d-overflow-scrollbar-shown');
    await wrapper.get('[data-testid="wrapper"]').trigger('pointerleave');
    vi.advanceTimersByTime(500);
    await wrapper.vm.$nextTick();
    expect(scrollbar().classes()).not.toContain('d-overflow-scrollbar-shown');
  });

  it('turns a vertical wheel into a sideways scroll and leaves a sideways one to the browser', async () => {
    const { strip, state } = await stripOf(100, 400);
    const vertical = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
    strip.element.dispatchEvent(vertical);
    expect([state.scrollLeft, vertical.defaultPrevented]).toEqual([120, true]);

    const sideways = new WheelEvent('wheel', { deltaX: 40, deltaY: 10, cancelable: true });
    strip.element.dispatchEvent(sideways);
    expect([state.scrollLeft, sideways.defaultPrevented]).toEqual([120, false]);
  });

  it('scrolls the strip by the same share of its scroll width as the slider is dragged', async () => {
    const { wrapper, state } = await stripOf(100, 400);
    const slider = wrapper.get('.d-overflow-slider');
    (slider.element as HTMLElement).setPointerCapture = vi.fn();
    await slider.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 10 });
    expect(slider.attributes('data-active')).toBe('true');
    // 300 px of scroll over the 75 px the 25 px slider can travel
    await slider.trigger('pointermove', { pointerId: 1, clientX: 40 });
    expect(state.scrollLeft).toBe(120);
    await slider.trigger('pointermove', { pointerId: 2, clientX: 90 });
    expect(state.scrollLeft).toBe(120);
    await slider.trigger('pointerup', { pointerId: 1 });
    expect(wrapper.get('.d-overflow-slider').attributes('data-active')).toBeUndefined();
  });

  it('ends a drag that loses its pointer capture with no pointerup', async () => {
    const { wrapper } = await stripOf(100, 400);
    const slider = wrapper.get('.d-overflow-slider');
    (slider.element as HTMLElement).setPointerCapture = vi.fn();
    await slider.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 10 });
    await slider.trigger('lostpointercapture', { pointerId: 1 });
    expect(wrapper.get('.d-overflow-slider').attributes('data-active')).toBeUndefined();
  });

  it('ends a drag when the strip stops overflowing and the slider goes, so it never comes back stuck active', async () => {
    vi.useFakeTimers();
    const { wrapper, strip } = await stripOf(100, 400);
    const slider = wrapper.get('.d-overflow-slider');
    (slider.element as HTMLElement).setPointerCapture = vi.fn();
    await slider.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 10 });

    let scrollWidth = 100;
    Object.defineProperty(strip.element, 'scrollWidth', { configurable: true, get: () => scrollWidth });
    await strip.trigger('scroll');
    expect(wrapper.find('[data-testid="scrollbar"]').exists()).toBe(false);

    scrollWidth = 400;
    await strip.trigger('scroll');
    vi.advanceTimersByTime(500);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('.d-overflow-slider').attributes('data-active')).toBeUndefined();
    expect(wrapper.get('[data-testid="scrollbar"]').classes()).not.toContain('d-overflow-scrollbar-shown');
  });
});
