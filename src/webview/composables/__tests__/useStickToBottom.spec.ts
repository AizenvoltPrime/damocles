// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue';
import { useStickToBottom, type StickToBottomOptions } from '../useStickToBottom';

const SETTLE_MS = 150;

type Geometry = { content: number; viewport: number; top: number };

/**
 * happy-dom computes no layout, so each view carries its own geometry. `scrollTop` clamps to the
 * scrollable range as a browser's does, which is what makes content shrinking move the view.
 */
function fakeView(content: number, viewport = 100) {
  const el = document.createElement('div');
  document.body.append(el);
  const geometry: Geometry = { content, viewport, top: 0 };
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => geometry.content },
    clientHeight: { configurable: true, get: () => geometry.viewport },
    scrollTop: {
      configurable: true,
      get: () => geometry.top,
      set: (value: number) => { geometry.top = Math.max(0, Math.min(value, geometry.content - geometry.viewport)); },
    },
  });
  return { el, geometry };
}

const scopes: EffectScope[] = [];

async function followRef(target: Ref<HTMLElement | null>, options?: StickToBottomOptions) {
  const scope = effectScope();
  scopes.push(scope);
  const view = scope.run(() => useStickToBottom(target, options));
  if (!view) throw new Error('useStickToBottom returned nothing');
  await nextTick();
  return view;
}

const follow = (el: HTMLElement, options?: StickToBottomOptions) => followRef(ref(el), options);

/** Content grows the way Vue grows it: a DOM mutation, observed a microtask later. */
async function grow(el: HTMLElement, geometry: Geometry, by: number): Promise<void> {
  geometry.content += by;
  el.append(document.createElement('p'));
  await nextTick();
}

/** Content shrinks: the browser clamps the view into the smaller range and fires `scroll`. */
function shrink(el: HTMLElement, geometry: Geometry, to: number): void {
  geometry.content = to;
  geometry.top = Math.min(geometry.top, to - geometry.viewport);
  el.dispatchEvent(new Event('scroll'));
}

/** The browser moves the view and fires `scroll`. */
function scrollBy(el: HTMLElement, delta: number): void {
  el.scrollTop += delta;
  el.dispatchEvent(new Event('scroll'));
}

function wheel(target: Element, deltaY: number): void {
  target.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }));
}

/** A reader's wheel scroll: the gesture event, then the view moving under it. */
function wheelScroll(el: HTMLElement, deltaY: number): void {
  wheel(el, deltaY);
  scrollBy(el, deltaY);
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const settle = () => vi.advanceTimersByTime(SETTLE_MS);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  while (scopes.length) scopes.pop()?.stop();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useStickToBottom following', () => {
  it('starts at the bottom and follows content as it grows', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);

    expect(el.scrollTop).toBe(900);
    await grow(el, geometry, 250);

    expect(el.scrollTop).toBe(1150);
    expect(view.isFollowing.value).toBe(true);
  });

  it('opens where it is when told not to start following, as a finished thinking block does', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el, { startFollowing: () => false });
    await grow(el, geometry, 100);

    expect(el.scrollTop).toBe(0);
    expect(view.isFollowing.value).toBe(false);
  });

  it('starts at the bottom again when the reset key changes', async () => {
    const { el, geometry } = fakeView(1000);
    const key = ref('agent-a');
    const view = await follow(el, { resetKey: () => key.value });
    wheelScroll(el, -500);

    geometry.content = 2000;
    key.value = 'agent-b';
    await nextTick();

    expect(el.scrollTop).toBe(1900);
    expect(view.isFollowing.value).toBe(true);
  });
});

describe('useStickToBottom reading the view position', () => {
  it('stops following when the view moves up under a wheel, even by a pixel, and growth never moves it after', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);

    wheelScroll(el, -1);
    expect(view.isFollowing.value).toBe(false);
    await grow(el, geometry, 250);
    settle();
    await grow(el, geometry, 50);

    expect(el.scrollTop).toBe(899);
    expect(view.isFollowing.value).toBe(false);
  });

  it('keeps following when a nested scroller takes the gesture and the view does not move', async () => {
    const { el, geometry } = fakeView(1000);
    const nested = document.createElement('div');
    el.append(nested);
    const view = await follow(el);

    wheel(nested, -40);
    await grow(el, geometry, 100);
    settle();

    expect(view.isFollowing.value).toBe(true);
    expect(el.scrollTop).toBe(1000);
  });

  it('stops following when a script moves the view up out of the bottom band', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);

    // The prompt navigator's jump writes scrollTop directly; its scroll event comes a frame later.
    el.scrollTop = 200;
    await grow(el, geometry, 100);

    expect(el.scrollTop).toBe(200);
    expect(view.isFollowing.value).toBe(false);
  });

  it('keeps following when the view moves up within the bottom band with no gesture, as a clamp does', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);

    scrollBy(el, -1);
    expect(view.isFollowing.value).toBe(true);
    await grow(el, geometry, 100);

    expect(el.scrollTop).toBe(1000);
  });

  it('keeps following when content shrinks under the view and clamps it upward', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);

    shrink(el, geometry, 600);
    await grow(el, geometry, 100);

    expect(view.isFollowing.value).toBe(true);
    expect(el.scrollTop).toBe(600);
  });

  it('follows again when content shrinks until the view is at the bottom', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);
    wheelScroll(el, -300);
    settle();

    shrink(el, geometry, 500);

    expect(view.isFollowing.value).toBe(true);
  });

  it('follows again when the reader scrolls back down to the bottom', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);
    wheelScroll(el, -300);
    await grow(el, geometry, 100);

    wheelScroll(el, 200);
    expect(view.isFollowing.value).toBe(false);
    wheelScroll(el, 200);
    expect(view.isFollowing.value).toBe(true);
    settle();
    await grow(el, geometry, 100);

    expect(el.scrollTop).toBe(1100);
  });

  it.each([
    ['a downward wheel', (el: HTMLElement) => wheel(el, 40)],
    ['the End key', () => press(document.body, 'End')],
  ])('follows again on %s at the bottom, where the view cannot move', async (_name, gesture) => {
    const { el } = fakeView(1000);
    const view = await follow(el);
    wheelScroll(el, -1);
    expect(view.isFollowing.value).toBe(false);

    gesture(el);

    expect(view.isFollowing.value).toBe(true);
  });
});

describe('useStickToBottom holding for a user gesture', () => {
  it('holds pinning on a wheel event, then pins to the new bottom once the view has settled', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);

    wheel(el, -40);
    await grow(el, geometry, 250);
    expect(el.scrollTop).toBe(900);
    expect(view.isFollowing.value).toBe(true);

    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(el.scrollTop).toBe(900);
    vi.advanceTimersByTime(1);

    expect(el.scrollTop).toBe(1150);
  });

  it.each([
    ['Ctrl+Home', 'Home', { ctrlKey: true }],
    ['Cmd+ArrowUp', 'ArrowUp', { metaKey: true }],
    ['Shift+Space', ' ', { shiftKey: true }],
    ['PageUp', 'PageUp', {}],
  ])('holds pinning on %s pressed anywhere in the document', async (_name, key, init) => {
    const { el, geometry } = fakeView(1000);
    await follow(el);

    press(document.body, key, init);
    await grow(el, geometry, 100);
    expect(el.scrollTop).toBe(900);
    settle();

    expect(el.scrollTop).toBe(1000);
  });

  it.each([
    ['ArrowUp typed into a text field', () => {
      const field = document.createElement('textarea');
      document.body.append(field);
      press(field, 'ArrowUp');
    }],
    ['a key another handler already handled', () => {
      const target = document.createElement('div');
      document.body.append(target);
      target.addEventListener('keydown', (e) => e.preventDefault());
      press(target, 'PageUp');
    }],
    ['Alt+ArrowUp', () => press(document.body, 'ArrowUp', { altKey: true })],
    ['Space on a button', () => {
      const button = document.createElement('button');
      document.body.append(button);
      press(button, ' ');
    }],
  ])('does not hold on %s', async (_name, pressKey) => {
    const { el, geometry } = fakeView(1000);
    await follow(el);

    pressKey();
    await grow(el, geometry, 100);

    expect(el.scrollTop).toBe(1000);
  });

  it('holds while a pointer is down and until the view settles after it is released', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);

    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await grow(el, geometry, 100);
    vi.advanceTimersByTime(SETTLE_MS * 4);
    expect(el.scrollTop).toBe(900);

    window.dispatchEvent(new PointerEvent('pointerup'));
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(el.scrollTop).toBe(900);
    vi.advanceTimersByTime(1);

    expect(el.scrollTop).toBe(1000);
    expect(view.isFollowing.value).toBe(true);
  });

  it('stops following when the view moves up while a pointer is down, as a scrollbar drag moves it', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);

    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    scrollBy(el, -1);
    window.dispatchEvent(new PointerEvent('pointercancel'));
    settle();
    await grow(el, geometry, 100);

    expect(view.isFollowing.value).toBe(false);
    expect(el.scrollTop).toBe(899);
  });

  it('ends the hold and pins through scrollToBottom', async () => {
    const { el, geometry } = fakeView(1000);
    const view = await follow(el);
    wheelScroll(el, -500);

    view.scrollToBottom();
    expect(el.scrollTop).toBe(900);
    await grow(el, geometry, 100);

    expect(el.scrollTop).toBe(1000);
    expect(view.isFollowing.value).toBe(true);
  });

  it('moves focus into the view through jumpToLatest', async () => {
    const { el } = fakeView(1000);
    el.tabIndex = -1;
    const view = await follow(el);
    wheelScroll(el, -500);

    view.jumpToLatest();

    expect(document.activeElement).toBe(el);
    expect(el.scrollTop).toBe(900);
    expect(view.isFollowing.value).toBe(true);
  });
});

describe('useStickToBottom attaching and detaching', () => {
  it('leaves the old element alone once the ref moves to a new one, which it follows', async () => {
    const old = fakeView(1000);
    const next = fakeView(500);
    const target = ref<HTMLElement | null>(old.el);
    const view = await followRef(target);

    target.value = next.el;
    await nextTick();
    expect(next.el.scrollTop).toBe(400);

    // Growth the old element's listeners would pin, were they still attached.
    next.geometry.content += 100;
    old.el.dispatchEvent(new Event('scroll'));
    await grow(old.el, old.geometry, 100);
    expect(next.el.scrollTop).toBe(400);
    expect(old.el.scrollTop).toBe(900);

    // A wheel on the old element would hold the new one.
    wheel(old.el, -40);
    await grow(next.el, next.geometry, 0);

    expect(next.el.scrollTop).toBe(500);
    expect(view.isFollowing.value).toBe(true);
  });

  it('removes every listener and observer when its scope ends', async () => {
    const addToWindow = vi.spyOn(window, 'addEventListener');
    const removeFromWindow = vi.spyOn(window, 'removeEventListener');
    const { el, geometry } = fakeView(1000);
    await follow(el);
    scopes.pop()?.stop();

    await grow(el, geometry, 100);
    press(document.body, 'PageDown');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup'));
    wheel(el, -40);
    settle();
    el.dispatchEvent(new Event('scroll'));

    expect(el.scrollTop).toBe(900);
    const added = addToWindow.mock.calls.filter(([type]) => type === 'pointerup' || type === 'pointercancel');
    expect(added).toHaveLength(2);
    for (const [type, listener] of added) expect(removeFromWindow).toHaveBeenCalledWith(type, listener);
  });
});
