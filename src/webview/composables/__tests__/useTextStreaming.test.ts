// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { useTextStreaming } from '../useTextStreaming';

const FRAME_MS = 16;
const BASE_CHARS_PER_SECOND = 200;
const CATCH_UP_SECONDS = 0.5;

let frames = new Map<number, (time: number) => void>();
let nextFrameId = 1;
let now = 0;
let scope: EffectScope | null = null;
// prefersReducedMotion keeps the first MediaQueryList it gets, so every test shares this one.
const osQuery = { matches: false };

/** Runs one animation frame FRAME_MS after the last. */
function frame(): void {
  now += FRAME_MS;
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(now);
}

/** Runs FRAME_MS frames for `ms` of simulated time. */
function advance(ms: number): void {
  const end = now + ms;
  while (now < end) frame();
}

function stream(initial: string) {
  const content = ref(initial);
  const active = ref(true);
  scope = effectScope();
  const result = scope.run(() => useTextStreaming(content, active));
  if (!result) throw new Error('useTextStreaming returned nothing');
  return { content, active, displayed: result.displayedContent };
}

beforeEach(() => {
  frames = new Map();
  now = 0;
  osQuery.matches = false;
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('matchMedia', () => osQuery);
});

afterEach(() => {
  scope?.stop();
  scope = null;
  document.documentElement.removeAttribute('data-reduced-motion');
  vi.unstubAllGlobals();
});

describe('useTextStreaming', () => {
  it('types a short reply at the base rate rather than all at once', async () => {
    const { content, displayed } = stream('');
    content.value = 'x'.repeat(100);
    await nextTick();
    advance(250);
    expect(displayed.value.length).toBeGreaterThan(30);
    expect(displayed.value.length).toBeLessThan(70);
  });

  it("shows a large chunk within a few seconds, not at the base rate's ten", async () => {
    const { content, displayed } = stream('');
    content.value = 'x'.repeat(2000);
    await nextTick();
    advance(2500);
    expect(displayed.value.length).toBe(2000);
  });

  it('keeps up with a stream faster than the base rate instead of falling further behind', async () => {
    const { content, displayed } = stream('');
    for (let second = 0; second < 10; second++) {
      content.value += 'x'.repeat(1000);
      await nextTick();
      advance(1000);
    }
    expect(content.value.length - displayed.value.length).toBeLessThan(1000);
  });

  it('reveals text that arrives after a stall at the reveal rate, not in one frame', async () => {
    const { content, displayed } = stream('');
    content.value = 'x'.repeat(100);
    await nextTick();
    advance(1000);
    expect(displayed.value.length).toBe(100);
    advance(3000);

    content.value += 'x'.repeat(300);
    await nextTick();
    while (displayed.value.length < content.value.length) {
      const waiting = content.value.length - displayed.value.length;
      const before = displayed.value.length;
      frame();
      const limit = Math.ceil((FRAME_MS / 1000) * Math.max(BASE_CHARS_PER_SECOND, waiting / CATCH_UP_SECONDS));
      expect(displayed.value.length - before).toBeLessThanOrEqual(limit);
    }
  });

  it('runs no frames once the display has caught up', async () => {
    const { content } = stream('');
    content.value = 'x'.repeat(50);
    await nextTick();
    advance(1000);
    expect(frames.size).toBe(0);
  });

  it('shows the content present at mount at once and types only what arrives later', async () => {
    const { content, displayed } = stream('x'.repeat(500));
    expect(displayed.value.length).toBe(500);
    content.value += 'x'.repeat(100);
    await nextTick();
    frame();
    frame();
    expect(displayed.value.length).toBeGreaterThan(500);
    expect(displayed.value.length).toBeLessThan(600);
  });

  it('cancels its pending frame when its scope is disposed', async () => {
    const { content } = stream('');
    content.value = 'x'.repeat(500);
    await nextTick();
    frame();
    expect(frames.size).toBe(1);
    scope?.stop();
    scope = null;
    expect(frames.size).toBe(0);
  });

  it('shows text at once when the host reduce-motion setting is on', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    const { content, displayed } = stream('');
    content.value = 'x'.repeat(500);
    await nextTick();
    expect(displayed.value.length).toBe(500);
  });

  it('shows text at once when the OS asks for reduced motion', async () => {
    osQuery.matches = true;
    const { content, displayed } = stream('');
    content.value = 'x'.repeat(500);
    await nextTick();
    expect(displayed.value.length).toBe(500);
  });

  it('shows the whole text once streaming ends', async () => {
    const { content, active, displayed } = stream('');
    content.value = 'x'.repeat(2000);
    await nextTick();
    advance(100);
    active.value = false;
    await nextTick();
    expect(displayed.value.length).toBe(2000);
  });
});
