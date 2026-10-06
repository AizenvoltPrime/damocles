// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue';
import SlidingIndicator from '../SlidingIndicator.vue';
import { useSlidingIndicator, type IndicatorBox } from '@/composables/useSlidingIndicator';

const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.unstubAllGlobals();
});

function pieces(box: IndicatorBox, radius: number, variant: 'solid' | 'ring' = 'solid') {
  const wrapper = mount(SlidingIndicator, { props: { box, radius, animate: false, variant } });
  mounted.push(wrapper);
  return wrapper.findAll('[data-testid="sliding-indicator"] > span').map((piece) => (piece.element as HTMLElement).style);
}

describe('SlidingIndicator', () => {
  it('draws a pill from two fixed caps and a 100px middle scaled on X, overlapping each cap by 1px', () => {
    const [start, middle, end] = pieces({ x: 10, y: 4, width: 60, height: 20 }, 5);

    expect(start!.transform).toBe('translate(10px, 4px)');
    expect(start!.width).toBe('5px');
    expect(middle!.width).toBe('100px');
    expect(middle!.transform).toBe('translate(14px, 4px) scaleX(0.52)');
    expect(end!.transform).toBe('translate(65px, 4px)');
    expect(end!.height).toBe('20px');
  });

  it('clamps the cap to half the width of a box narrower than two radii', () => {
    const [start, middle, end] = pieces({ x: 0, y: 0, width: 6, height: 20 }, 5);

    expect(start!.width).toBe('3px');
    expect(middle!.transform).toBe('translate(2px, 0px) scaleX(0.02)');
    expect(end!.transform).toBe('translate(3px, 0px)');
  });

  it('draws a ring from top and bottom caps and a middle scaled on Y that spans exactly the gap between them', () => {
    const [top, middle, bottom] = pieces({ x: 2, y: 30, width: 200, height: 50 }, 11, 'ring');

    expect(top!.transform).toBe('translate(2px, 30px)');
    expect(top!.height).toBe('11px');
    expect(middle!.transform).toBe('translate(2px, 41px) scaleY(0.28)');
    expect(bottom!.transform).toBe('translate(2px, 69px)');
  });

  it('clamps the ring cap to half the height of a short row and never scales below zero', () => {
    const [top, middle, bottom] = pieces({ x: 0, y: 0, width: 100, height: 10 }, 11, 'ring');

    expect(top!.height).toBe('5px');
    expect(middle!.transform).toBe('translate(0px, 5px) scaleY(0)');
    expect(bottom!.transform).toBe('translate(0px, 5px)');
  });

  it('scales a radius with the root font size, so its corners match the rem radii of the items it marks', () => {
    document.documentElement.style.fontSize = '20px';
    try {
      const [start, middle] = pieces({ x: 0, y: 0, width: 60, height: 20 }, 8);
      expect(start!.width).toBe('10px');
      expect(middle!.transform).toBe('translate(9px, 0px) scaleX(0.42)');
    } finally {
      document.documentElement.style.fontSize = '';
    }
  });

  it('takes half the box height for a pill', () => {
    const wrapper = mount(SlidingIndicator, { props: { box: { x: 0, y: 0, width: 80, height: 26 }, radius: 'pill', animate: false } });
    mounted.push(wrapper);
    const [start] = wrapper.findAll('[data-testid="sliding-indicator"] > span').map((piece) => (piece.element as HTMLElement).style);
    expect(start!.width).toBe('13px');
  });

  it('animates its transform only once told to', async () => {
    const wrapper = mount(SlidingIndicator, { props: { box: { x: 0, y: 0, width: 40, height: 20 }, radius: 5, animate: false } });
    mounted.push(wrapper);
    expect(wrapper.find('[data-testid="sliding-indicator"] > span').classes()).not.toContain('transition-transform');

    await wrapper.setProps({ animate: true });
    expect(wrapper.find('[data-testid="sliding-indicator"] > span').classes()).toContain('transition-transform');
  });
});

describe('useSlidingIndicator', () => {
  /** Queues animation frames so a test runs them when it chooses; happy-dom computes no layout, so offsets are given. */
  async function setup() {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++next, callback);
      return next;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const runFrames = () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    };

    const selected = ref(0);
    let state!: ReturnType<typeof useSlidingIndicator>;
    const Group = defineComponent({
      setup() {
        const root = shallowRef<HTMLElement | null>(null);
        state = useSlidingIndicator(root, '[data-item]', selected);
        return () => h('div', { ref: root }, [0, 1, 2].map((i) => h('button', {
          'data-item': '',
          ref: (el) => {
            if (el) Object.defineProperties(el, { offsetLeft: { value: i * 50 }, offsetTop: { value: 0 }, offsetWidth: { value: 40 + i }, offsetHeight: { value: 20 } });
          },
        })));
      },
    });
    const wrapper = mount(Group, { attachTo: document.body });
    mounted.push(wrapper);
    // The mount's post-flush watchers run before the browser's next frame.
    await nextTick();
    return { wrapper, selected, state: () => state, frames, runFrames };
  }

  it('places the indicator on mount without animating, and animates from the next frame on', async () => {
    const { state, runFrames } = await setup();

    expect(state().box.value).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    expect(state().animate.value).toBe(false);

    runFrames();
    expect(state().animate.value).toBe(true);
  });

  it('measures the newly selected item when the selection changes', async () => {
    const { selected, state, runFrames } = await setup();
    runFrames();

    selected.value = 2;
    await nextTick();
    await nextTick();

    expect(state().box.value).toEqual({ x: 100, y: 0, width: 42, height: 20 });
    expect(state().animate.value).toBe(true);
  });

  it('cancels its pending frame when the group unmounts', async () => {
    const { wrapper, frames } = await setup();
    expect(frames.size).toBe(1);

    wrapper.unmount();
    mounted.length = 0;

    expect(frames.size).toBe(0);
  });
});
