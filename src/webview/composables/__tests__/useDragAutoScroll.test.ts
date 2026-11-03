// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, type EffectScope } from 'vue';
import { useDragAutoScroll } from '../useDragAutoScroll';

// At the 16px root happy-dom reports: a 35px zone and 14px steps. The view spans y 100-300 and scrolls 0-800.
const OPTIONS = { edgeRem: 35 / 16, maxStepRem: 14 / 16 };

// happy-dom computes no layout; this scrollTop keeps whatever it is given, so the composable's own clamp is what holds.
function fakeScroller(scrollTop: number, height = 200) {
  const element = document.createElement('div');
  const state = { scrollTop, rects: 0 };
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => state.scrollTop, set: (value: number) => { state.scrollTop = value; } },
  });
  element.getBoundingClientRect = () => {
    state.rects++;
    return { top: 100, bottom: 100 + height, left: 0, right: 100, width: 100, height, x: 0, y: 100, toJSON: () => ({}) };
  };
  return { element, state };
}

const over = (clientY: number) => ({ clientY }) as DragEvent;

let scope: EffectScope;

function autoScroll(element: HTMLElement) {
  return scope.run(() => useDragAutoScroll(ref(element), OPTIONS))!;
}

// The scroll each of `frames` frames made.
function stepsOver(state: { scrollTop: number }, frames: number): number[] {
  const steps: number[] = [];
  for (let i = 0; i < frames; i++) {
    const before = state.scrollTop;
    vi.advanceTimersToNextFrame();
    steps.push(state.scrollTop - before);
  }
  return steps;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  scope = effectScope();
});

afterEach(() => {
  scope.stop();
  vi.useRealTimers();
});

describe('useDragAutoScroll', () => {
  it('scrolls in steps proportional to how far the pointer is into an edge zone, and not between the zones', () => {
    const { element, state } = fakeScroller(400);
    const { onDragOver } = autoScroll(element);
    for (const [y, step] of [[300, 14], [282.5, 7], [272, 3], [265, 0], [200, 0], [135, 0], [117.5, -7], [100, -14], [90, -14]] as const) {
      onDragOver(over(y));
      expect(stepsOver(state, 2), `y ${y}`).toEqual([step, step]);
    }
  });

  it('stops at either end of the scroll range', () => {
    const { element, state } = fakeScroller(795);
    const { onDragOver } = autoScroll(element);
    onDragOver(over(300));
    stepsOver(state, 3);
    expect(state.scrollTop).toBe(800);
    // At the end the loop ends too; only the idle stop is left
    expect(vi.getTimerCount()).toBe(1);
    state.scrollTop = 5;
    onDragOver(over(100));
    stepsOver(state, 3);
    expect(state.scrollTop).toBe(0);
  });

  it('keeps scrolling while dragover repeats, and stops a second after the last one', () => {
    const { element, state } = fakeScroller(0);
    const { onDragOver } = autoScroll(element);
    // 1px into the zone: one pixel a frame, so the range does not run out first
    for (let i = 0; i < 3; i++) {
      onDragOver(over(266));
      vi.advanceTimersByTime(900);
    }
    const reached = state.scrollTop;
    expect(reached).toBeGreaterThan(100);
    vi.advanceTimersByTime(200);
    const stopped = state.scrollTop;
    expect(stopped).toBeGreaterThan(reached);
    expect(stepsOver(state, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on stop(), and a later dragover starts it again', () => {
    const { element, state } = fakeScroller(0);
    const { onDragOver, stop } = autoScroll(element);
    onDragOver(over(300));
    stop();
    expect(stepsOver(state, 3)).toEqual([0, 0, 0]);
    expect(vi.getTimerCount()).toBe(0);
    onDragOver(over(300));
    expect(stepsOver(state, 1)).toEqual([14]);
  });

  it('holds only while the drag is in an edge zone of a scroller that overflows, until the drag stops or goes idle', () => {
    const { element } = fakeScroller(0);
    const { onDragOver, stop, holding } = autoScroll(element);
    expect(holding.value).toBe(false);
    for (const [y, held] of [[200, false], [266, true], [265, false], [134, true], [135, false], [310, true], [90, true]] as const) {
      onDragOver(over(y));
      expect(holding.value, `y ${y}`).toBe(held);
    }
    stop();
    expect(holding.value).toBe(false);
    onDragOver(over(299));
    vi.advanceTimersByTime(1000);
    expect(holding.value).toBe(false);
    Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => 200 });
    onDragOver(over(300));
    expect(holding.value).toBe(false);
  });

  it('runs no frame and no timer while the drag is between the zones, and starts on the dragover that enters one', () => {
    const { element, state } = fakeScroller(400);
    const { onDragOver } = autoScroll(element);
    onDragOver(over(200));
    expect(vi.getTimerCount()).toBe(0);
    const rects = state.rects;
    expect(stepsOver(state, 3)).toEqual([0, 0, 0]);
    expect(state.rects).toBe(rects);
    onDragOver(over(299));
    expect(stepsOver(state, 1)).toEqual([14]);
    onDragOver(over(200));
    expect(stepsOver(state, 1)).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('scrolls toward the nearer edge of a short scroller, whose zones are each a third of it', () => {
    // 60px tall: 20px zones, so the middle third does not scroll
    const { element, state } = fakeScroller(400, 60);
    const { onDragOver, holding } = autoScroll(element);
    for (const [y, step] of [[100, -14], [110, -7], [120, 0], [130, 0], [140, 0], [150, 7], [160, 14]] as const) {
      onDragOver(over(y));
      expect(stepsOver(state, 2), `y ${y}`).toEqual([step, step]);
      // Its 35px hold band reaches across it, so Chromium's own belt never scrolls it
      expect(holding.value, `y ${y}`).toBe(true);
    }
  });

  it('scrolls down in the lower half of a scroller shorter than one zone', () => {
    const { element, state } = fakeScroller(400, 30);
    const { onDragOver } = autoScroll(element);
    onDragOver(over(128));
    expect(stepsOver(state, 1)[0]).toBeGreaterThan(0);
    onDragOver(over(102));
    expect(stepsOver(state, 1)[0]).toBeLessThan(0);
  });

  it('cancels the loop when its owner unmounts', () => {
    const { element, state } = fakeScroller(0);
    const { onDragOver } = autoScroll(element);
    onDragOver(over(300));
    stepsOver(state, 1);
    scope.stop();
    expect(stepsOver(state, 3)).toEqual([0, 0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
