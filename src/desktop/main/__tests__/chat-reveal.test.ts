import { describe, expect, it, vi } from 'vitest';
import { parkedBounds, revealAfterPaint, type RevealSteps } from '../chat-reveal';

// A see-through chat view swaps in only after its page painted, so a chat switch over a wallpaper never shows the wallpaper
// alone where the chat was.

function steps(painted: Promise<unknown>, current = (): boolean => true): RevealSteps & { readonly log: string[] } {
  const log: string[] = [];
  return {
    log,
    park: () => log.push('park'),
    painted: () => {
      log.push('wait');
      return painted.then(() => log.push('painted'));
    },
    current,
    swap: () => log.push('swap'),
  };
}

describe('revealAfterPaint', () => {
  it('parks the new view first and swaps only once its page painted', async () => {
    let paint!: () => void;
    const s = steps(new Promise<void>((resolve) => {
      paint = resolve;
    }));
    const done = revealAfterPaint(s, 10_000);
    await Promise.resolve();
    expect(s.log).toEqual(['park', 'wait']);
    paint();
    expect(await done).toBe(true);
    expect(s.log).toEqual(['park', 'wait', 'painted', 'swap']);
  });

  it('does not swap when a newer switch took over meanwhile', async () => {
    const s = steps(Promise.resolve(), () => false);
    expect(await revealAfterPaint(s)).toBe(false);
    expect(s.log).not.toContain('swap');
  });

  it('swaps after the timeout when the page never paints, and when the wait fails', async () => {
    vi.useFakeTimers();
    try {
      const never = steps(new Promise(() => undefined));
      const done = revealAfterPaint(never, 500);
      await vi.advanceTimersByTimeAsync(499);
      expect(never.log).not.toContain('swap');
      await vi.advanceTimersByTimeAsync(1);
      expect(await done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    const failed = steps(Promise.reject(new Error('gone')));
    expect(await revealAfterPaint(failed)).toBe(true);
  });
});

describe('parkedBounds', () => {
  it('keeps the slot size, so the painted frame is the one shown, with only one pixel inside the window', () => {
    expect(parkedBounds({ width: 700, height: 500 }, { width: 1280, height: 800 })).toEqual({ x: 1279, y: 799, width: 700, height: 500 });
  });
});
