// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchPageMotion } from '../themes/page-motion';

// The shell page's half of the covered-window pause: Chromium sets document.visibilityState hidden while another window covers
// the window (native occlusion tracking) or it is minimized, and the page reports each change, with the OS's reduced motion,
// for main to pause moving wallpapers. Playwright keeps a page visible whatever covers it, so this path is tested here.

function fakeQuery(matches: boolean): { query: MediaQueryList; change(next: boolean): void } {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  } as unknown as MediaQueryList & { matches: boolean };
  return {
    query,
    change(next) {
      (query as { matches: boolean }).matches = next;
      for (const listener of listeners) listener();
    },
  };
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.restoreAllMocks();
});

describe('watchPageMotion', () => {
  it('reports on load, when the window is covered and uncovered, and when the OS reduces motion', () => {
    const media = fakeQuery(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(media.query);
    const reports: Array<{ visible: boolean; reducedMotion: boolean }> = [];
    const stop = watchPageMotion((motion) => reports.push({ ...motion }));
    setVisibility('hidden');
    setVisibility('visible');
    media.change(true);
    expect(reports).toEqual([
      { visible: true, reducedMotion: false },
      { visible: false, reducedMotion: false },
      { visible: true, reducedMotion: false },
      { visible: true, reducedMotion: true },
    ]);
    stop();
    setVisibility('hidden');
    media.change(false);
    expect(reports).toHaveLength(4);
  });
});
