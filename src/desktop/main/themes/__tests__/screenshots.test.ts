import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCREENSHOTS, SCREENSHOT_TTL_MS, ScreenshotStore, SHOT_ID } from '../screenshots';

// Screenshots live in main's memory only, under unguessable random ids that are read more than once (the card's image and
// core's read after Allow), until their card drops them or SCREENSHOT_TTL_MS pass.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ScreenshotStore', () => {
  it('keeps a screenshot under a random 32-hex id until it is dropped', () => {
    const store = new ScreenshotStore();
    const png = new Uint8Array([1, 2, 3]);
    const id = store.put(png);
    const other = store.put(png);
    expect(id).toMatch(SHOT_ID);
    expect(other).not.toBe(id);
    expect(store.get(id)).toBe(png);
    store.drop(id);
    expect(store.get(id)).toBeUndefined();
    expect(store.get(other)).toBe(png);
  });

  it('drops a screenshot ten minutes after it was taken', () => {
    const store = new ScreenshotStore();
    const id = store.put(new Uint8Array([1]));
    vi.advanceTimersByTime(SCREENSHOT_TTL_MS - 1);
    expect(store.get(id)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(store.get(id)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('keeps at most MAX_SCREENSHOTS, the oldest going first, and answers nothing for an id of another shape', () => {
    const store = new ScreenshotStore();
    const ids = Array.from({ length: MAX_SCREENSHOTS + 1 }, (_, at) => store.put(new Uint8Array([at])));
    expect(store.size()).toBe(MAX_SCREENSHOTS);
    expect(store.get(ids[0]!)).toBeUndefined();
    expect(store.get(ids.at(-1)!)).toBeDefined();
    expect(store.get('../../etc/passwd')).toBeUndefined();
    store.dispose();
    expect(store.size()).toBe(0);
  });

  // a card still shows a screenshot that left to make room, so its core is told; a drop or an expiry has no card left open
  it('tells which screenshot left to make room for a newer one, and nothing for one dropped or expired', () => {
    const evicted: string[] = [];
    const store = new ScreenshotStore({ evicted: (id) => evicted.push(id) });
    const ids = Array.from({ length: MAX_SCREENSHOTS }, (_, at) => store.put(new Uint8Array([at])));
    store.drop(ids[1]!);
    store.put(new Uint8Array([1]));
    expect(evicted).toEqual([]);
    store.put(new Uint8Array([2]));
    expect(evicted).toEqual([ids[0]]);
    vi.advanceTimersByTime(SCREENSHOT_TTL_MS);
    store.dispose();
    expect(evicted).toEqual([ids[0]]);
  });
});
