import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPtyResize, PTY_RESIZE_SETTLE_MS, type PtySize } from '../terminal/pty-resize';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pty resize', () => {
  it('sends a size once it has held for the settle time, so a pane gliding open resizes the pty once', () => {
    const sent: PtySize[] = [];
    const resize = createPtyResize((size) => sent.push(size));
    for (let rows = 1; rows <= 8; rows++) {
      resize.request({ cols: 125, rows });
      vi.advanceTimersByTime(16);
    }
    expect(sent).toEqual([]);
    resize.request({ cols: 125, rows: 8 });
    vi.advanceTimersByTime(PTY_RESIZE_SETTLE_MS - 16);
    expect(sent).toEqual([{ cols: 125, rows: 8 }]);
  });

  it('sends nothing for the size the pty already has, and drops one that returned to it before it was sent', () => {
    const sent: PtySize[] = [];
    const resize = createPtyResize((size) => sent.push(size));
    resize.request({ cols: 80, rows: 24 });
    vi.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    resize.request({ cols: 80, rows: 24 });
    resize.request({ cols: 90, rows: 24 });
    resize.request({ cols: 80, rows: 24 });
    vi.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    expect(sent).toEqual([{ cols: 80, rows: 24 }]);
  });

  it('sends a waiting size on flush, sends the size again after a reset, and sends nothing once disposed', () => {
    const sent: PtySize[] = [];
    const resize = createPtyResize((size) => sent.push(size));
    resize.request({ cols: 80, rows: 24 });
    resize.flush();
    expect(sent).toEqual([{ cols: 80, rows: 24 }]);
    resize.reset();
    resize.request({ cols: 80, rows: 24 });
    vi.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    expect(sent).toHaveLength(2);
    resize.request({ cols: 100, rows: 30 });
    resize.dispose();
    vi.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    resize.flush();
    expect(sent).toHaveLength(2);
  });
});
