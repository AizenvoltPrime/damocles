import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeImage } from 'electron';
import { COUNTER_FRAME_MS, TaskbarCounter, type TaskbarCounterDeps } from '../taskbar-counter';

let overlays: Array<[string | null, string]>;
let badges: number[];
let drawnLabels: string[];
let lines: string[];

const image = (label: string): NativeImage => ({ label }) as unknown as NativeImage;

function counter(platform: NodeJS.Platform, overrides: Partial<TaskbarCounterDeps> = {}): TaskbarCounter {
  return new TaskbarCounter({
    platform,
    window: () => ({
      isDestroyed: () => false,
      setOverlayIcon: (overlay, description) => overlays.push([overlay ? (overlay as unknown as { label: string }).label : null, description]),
    }),
    badge: async (label) => {
      drawnLabels.push(label);
      return image(label);
    },
    setBadgeCount: (count) => {
      badges.push(count);
      return true;
    },
    describe: (count) => `${count} unread notifications`,
    log: (line) => lines.push(line),
    ...overrides,
  });
}

async function frame(): Promise<void> {
  await vi.advanceTimersByTimeAsync(COUNTER_FRAME_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  overlays = [];
  badges = [];
  drawnLabels = [];
  lines = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('taskbar counter', () => {
  it('draws the count on the Windows taskbar button, 9+ past nine, with its description, and clears it at 0', async () => {
    const taskbar = counter('win32');
    taskbar.update(1);
    await frame();
    taskbar.update(4);
    await frame();
    taskbar.update(12);
    await frame();
    taskbar.update(0);
    await frame();
    expect(overlays).toEqual([['1', '1 unread notifications'], ['4', '4 unread notifications'], ['9+', '12 unread notifications'], [null, '']]);
    expect(badges).toEqual([]);
  });

  it('applies the counts of one frame once, and never sets one already shown', async () => {
    const taskbar = counter('win32');
    taskbar.update(1);
    taskbar.update(2);
    taskbar.update(3);
    await frame();
    taskbar.update(3);
    await frame();
    expect(overlays).toEqual([['3', '3 unread notifications']]);
    expect(drawnLabels).toEqual(['3']);
  });

  it('drops a badge drawn for a count that changed while it was drawn', async () => {
    let finish!: () => void;
    const taskbar = counter('win32', {
      badge: (label) => (label === '1' ? new Promise((resolve) => { finish = () => resolve(image(label)); }) : Promise.resolve(image(label))),
    });
    taskbar.update(1);
    await frame();
    taskbar.update(2);
    await frame();
    finish();
    await frame();
    expect(overlays).toEqual([['2', '2 unread notifications']]);
  });

  it('uses the app badge count on macOS and Linux', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      badges = [];
      const taskbar = counter(platform);
      taskbar.update(4);
      await frame();
      taskbar.update(0);
      await frame();
      expect(badges).toEqual([4, 0]);
    }
    expect(overlays).toEqual([]);
  });

  it('logs once when the OS does not take the app badge count', async () => {
    const taskbar = counter('darwin', { setBadgeCount: () => false });
    taskbar.update(3);
    await frame();
    taskbar.update(4);
    await frame();
    expect(lines).toEqual(['[notifications] the OS did not take the app badge count, so only the bell shows it']);
  });

  it('logs a badge that fails to draw instead of rejecting, and does not retry that count until it changes', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const taskbar = counter('win32', {
        badge: async (label) => {
          drawnLabels.push(label);
          throw new Error('no canvas');
        },
      });
      taskbar.update(2);
      await frame();
      taskbar.update(2);
      await frame();
      expect(drawnLabels).toEqual(['2']);
      taskbar.update(3);
      await frame();
      expect(drawnLabels).toEqual(['2', '3']);
      // Node reports an unhandled rejection once the macrotask that left it ends.
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(lines).toEqual([
        '[notifications] could not show the unread count on the taskbar: no canvas',
        '[notifications] could not show the unread count on the taskbar: no canvas',
      ]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('sets the count again in the current language', async () => {
    let language = 'en';
    const taskbar = counter('win32', { describe: (count) => (language === 'en' ? `${count} unread notifications` : `${count} μη αναγνωσμένες`) });
    taskbar.update(2);
    await frame();
    language = 'el';
    taskbar.reapply();
    await frame();
    expect(overlays).toEqual([['2', '2 unread notifications'], ['2', '2 μη αναγνωσμένες']]);
  });

  it('sets the count again on a new window', async () => {
    const taskbar = counter('win32');
    taskbar.update(2);
    await frame();
    taskbar.reapply();
    await frame();
    expect(overlays).toEqual([['2', '2 unread notifications'], ['2', '2 unread notifications']]);
  });
});
