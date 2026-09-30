import type { Rectangle } from 'electron';
import { PANE_CHROME_HEIGHT, PANE_DIVIDER_WIDTH, type PaneMode } from '../preload/pane-channels';

// Window DIPs, which equal the pane view's CSS px (it renders at zoom factor 1).
export const CHAT_MIN_WIDTH = 360;
// Divider included, as PaneState.width is.
export const PANE_MIN_WIDTH = 320;
export const DEFAULT_PANE_WIDTH = 480;
// In overlay the pane leaves this much of the chat uncovered, so the scrim stays visible and clickable.
export const OVERLAY_SCRIM_MIN_WIDTH = 48;

export interface PaneLayoutInput {
  // the chat tab's content area in window DIPs
  readonly area: Rectangle;
  readonly open: boolean;
  readonly maximized: boolean;
  // the persisted or requested width; clamped here, never rewritten by a clamp
  readonly width: number;
}

export interface PaneLayout {
  readonly mode: PaneMode;
  // undefined: the view is hidden
  readonly chat: Rectangle | undefined;
  readonly pane: Rectangle | undefined;
  readonly page: Rectangle | undefined;
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max));
}

// The page view fills the pane below its chrome, right of the divider when one is drawn.
function pageRect(pane: Rectangle, divider: number): Rectangle {
  return {
    x: pane.x + divider,
    y: pane.y + PANE_CHROME_HEIGHT,
    width: Math.max(0, pane.width - divider),
    height: Math.max(0, pane.height - PANE_CHROME_HEIGHT),
  };
}

/** The bounds of the chat, pane and page views for one chat tab area; see PaneMode for the modes. */
export function paneLayout({ area, open, maximized, width }: PaneLayoutInput): PaneLayout {
  const split = area.width >= CHAT_MIN_WIDTH + PANE_MIN_WIDTH;
  const maxWidth = split ? area.width - CHAT_MIN_WIDTH : Math.max(0, area.width - OVERLAY_SCRIM_MIN_WIDTH);
  const minWidth = Math.min(PANE_MIN_WIDTH, maxWidth);
  const clamped = clamp(width, minWidth, maxWidth);
  if (!open) return { mode: 'collapsed', chat: area, pane: undefined, page: undefined, width: clamped, minWidth, maxWidth };
  if (maximized) {
    return { mode: 'maximized', chat: undefined, pane: area, page: pageRect(area, 0), width: area.width, minWidth: area.width, maxWidth: area.width };
  }
  const pane: Rectangle = { x: area.x + area.width - clamped, y: area.y, width: clamped, height: area.height };
  if (!split) return { mode: 'overlay', chat: area, pane: area, page: pageRect(pane, PANE_DIVIDER_WIDTH), width: clamped, minWidth, maxWidth };
  return {
    mode: 'split',
    chat: { x: area.x, y: area.y, width: area.width - clamped, height: area.height },
    pane,
    page: pageRect(pane, PANE_DIVIDER_WIDTH),
    width: clamped,
    minWidth,
    maxWidth,
  };
}
