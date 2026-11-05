import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFolderProbe } from '../folder-probe';

describe('createFolderProbe', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers false for a check still running after the timeout, then the settled answer from the cache', async () => {
    // setImmediate stays real: the timeout answers only after one poll turn
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let settle!: () => void;
    const access = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    const exists = createFolderProbe(1000, 60_000, { access, now: () => Date.now() });

    const first = exists('Z:\\');
    const concurrent = exists('Z:\\');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBe(false);
    expect(await concurrent).toBe(false);

    // a caller after the timeout waits on nothing, no timer included
    const timers = vi.getTimerCount();
    expect(await exists('Z:\\')).toBe(false);
    expect(vi.getTimerCount()).toBe(timers);

    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(await exists('Z:\\')).toBe(true);
    expect(access).toHaveBeenCalledTimes(1);
  });

  it('checks a folder again once its answer is older than the TTL', async () => {
    let now = 0;
    const access = vi.fn(async (folder: string) => {
      if (folder === 'gone') throw new Error('ENOENT');
    });
    const exists = createFolderProbe(1000, 60_000, { access, now: () => now });

    expect(await exists('here')).toBe(true);
    expect(await exists('gone')).toBe(false);
    now = 59_999;
    await exists('here');
    expect(access).toHaveBeenCalledTimes(2);
    now = 60_000;
    expect(await exists('here')).toBe(true);
    expect(access).toHaveBeenCalledTimes(3);
  });

  it('starts no check for another folder while maxHung checks hang, caches nothing for it, and checks it once one settles', async () => {
    let now = 0;
    const settles = new Map<string, () => void>();
    const access = vi.fn((folder: string) => (folder === 'P:\\' || folder === 'Q:\\' ? new Promise<void>((resolve) => settles.set(folder, resolve)) : Promise.resolve()));
    const exists = createFolderProbe(1000, 60_000, { access, now: () => now, maxHung: 2 });

    void exists('P:\\');
    void exists('Q:\\');
    // still within the timeout, so neither counts as hung yet
    expect(await exists('Y:\\')).toBe(true);
    now = 1000;
    expect(await exists('R:\\')).toBe(false);
    expect(access.mock.calls.map(([folder]) => folder)).toEqual(['P:\\', 'Q:\\', 'Y:\\']);
    // a folder already being checked still answers from its own check
    expect(await exists('P:\\')).toBe(false);

    settles.get('P:\\')!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await exists('R:\\')).toBe(true);
    expect(access.mock.calls.map(([folder]) => folder)).toEqual(['P:\\', 'Q:\\', 'Y:\\', 'R:\\']);
  });
});
