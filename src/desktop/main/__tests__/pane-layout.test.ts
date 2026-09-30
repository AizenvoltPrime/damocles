import { describe, expect, it } from 'vitest';

import { PANE_CHROME_HEIGHT, PANE_DIVIDER_WIDTH } from '../../preload/pane-channels';
import { CHAT_MIN_WIDTH, OVERLAY_SCRIM_MIN_WIDTH, PANE_MIN_WIDTH, paneLayout } from '../pane-layout';

const area = (width: number, height = 700) => ({ x: 0, y: 40, width, height });

describe('paneLayout', () => {
  it('gives the chat the whole area and hides the pane when collapsed', () => {
    const layout = paneLayout({ area: area(1200), open: false, maximized: false, width: 480 });
    expect(layout).toMatchObject({ mode: 'collapsed', chat: area(1200), pane: undefined, page: undefined, width: 480 });
  });

  it('splits chat | divider | pane, with the page below the chrome and right of the divider', () => {
    const layout = paneLayout({ area: area(1200), open: true, maximized: false, width: 480 });
    expect(layout.mode).toBe('split');
    expect(layout.chat).toEqual({ x: 0, y: 40, width: 720, height: 700 });
    expect(layout.pane).toEqual({ x: 720, y: 40, width: 480, height: 700 });
    expect(layout.page).toEqual({ x: 720 + PANE_DIVIDER_WIDTH, y: 40 + PANE_CHROME_HEIGHT, width: 480 - PANE_DIVIDER_WIDTH, height: 700 - PANE_CHROME_HEIGHT });
    expect(layout.minWidth).toBe(PANE_MIN_WIDTH);
    expect(layout.maxWidth).toBe(1200 - CHAT_MIN_WIDTH);
  });

  it('clamps a width to both minimum widths and rounds it', () => {
    expect(paneLayout({ area: area(1200), open: true, maximized: false, width: 10 }).width).toBe(PANE_MIN_WIDTH);
    expect(paneLayout({ area: area(1200), open: true, maximized: false, width: 5000 }).width).toBe(1200 - CHAT_MIN_WIDTH);
    expect(paneLayout({ area: area(1200), open: true, maximized: false, width: 500.6 }).width).toBe(501);
  });

  it('clamps a persisted width to a smaller window without changing the input', () => {
    const input = { area: area(800), open: true, maximized: false, width: 700 };
    const layout = paneLayout(input);
    expect(layout.width).toBe(800 - CHAT_MIN_WIDTH);
    expect(layout.chat?.width).toBe(CHAT_MIN_WIDTH);
    expect(input.width).toBe(700);
    expect(paneLayout({ ...input, area: area(1400) }).width).toBe(700);
  });

  it('overlays the chat below the threshold, leaving a scrim strip the pane never covers', () => {
    const width = CHAT_MIN_WIDTH + PANE_MIN_WIDTH - 1;
    expect(paneLayout({ area: area(width + 1), open: true, maximized: false, width: 400 }).mode).toBe('split');
    const layout = paneLayout({ area: area(width), open: true, maximized: false, width: 5000 });
    expect(layout.mode).toBe('overlay');
    expect(layout.chat).toEqual(area(width));
    expect(layout.pane).toEqual(area(width));
    expect(layout.maxWidth).toBe(width - OVERLAY_SCRIM_MIN_WIDTH);
    expect(layout.width).toBe(width - OVERLAY_SCRIM_MIN_WIDTH);
    expect(layout.page?.x).toBe(OVERLAY_SCRIM_MIN_WIDTH + PANE_DIVIDER_WIDTH);
  });

  it('shrinks the minimum on a window narrower than the pane minimum', () => {
    const layout = paneLayout({ area: area(300), open: true, maximized: false, width: 480 });
    expect(layout.mode).toBe('overlay');
    expect(layout.maxWidth).toBe(300 - OVERLAY_SCRIM_MIN_WIDTH);
    expect(layout.minWidth).toBe(layout.maxWidth);
  });

  it('fills the area with no divider and no chat when maximized, and restores the split width after', () => {
    const layout = paneLayout({ area: area(1200), open: true, maximized: true, width: 480 });
    expect(layout).toMatchObject({ mode: 'maximized', chat: undefined, pane: area(1200), width: 1200, minWidth: 1200, maxWidth: 1200 });
    expect(layout.page).toEqual({ x: 0, y: 40 + PANE_CHROME_HEIGHT, width: 1200, height: 700 - PANE_CHROME_HEIGHT });
    expect(paneLayout({ area: area(1200), open: true, maximized: false, width: 480 }).width).toBe(480);
  });

  it('never reports a negative page size', () => {
    const layout = paneLayout({ area: area(1200, 20), open: true, maximized: false, width: 480 });
    expect(layout.page?.height).toBe(0);
  });
});
