import { remPx } from '@/composables/useRemPx';
import type { OverlayRect } from '../../preload/overlay-channels';

// rem kept between a popup and the viewport edge.
const EDGE_REM = 0.5;

/**
 * Top-left of a popup of the given size: below the anchor, or above it when it would overflow the bottom,
 * then clamped into the viewport. A point anchor (zero size) places the popup at the pointer.
 */
export function placePopup(anchor: OverlayRect, size: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number } {
  const edge = remPx(EDGE_REM);
  const below = anchor.y + anchor.height;
  const fitsBelow = below + size.height <= viewport.height - edge;
  const top = fitsBelow ? below : anchor.y - size.height;
  return {
    left: Math.max(edge, Math.min(anchor.x, viewport.width - size.width - edge)),
    top: Math.max(edge, Math.min(top, viewport.height - size.height - edge)),
  };
}

// rem between a panel and the chip it hangs from.
const PANEL_GAP_REM = 0.375;

/**
 * A panel of the given width hung from its anchor: below it, or above it when there is more room there, its height capped to
 * that room so it scrolls rather than leave the viewport; its start (or with align 'end' its end) lined up with the anchor's,
 * clamped into the viewport.
 */
export function placePanel(anchor: OverlayRect, width: number, viewport: { width: number; height: number }, align: 'start' | 'end' = 'start'): { left: number; maxHeight: number } & ({ top: number } | { bottom: number }) {
  const edge = remPx(EDGE_REM);
  const gap = remPx(PANEL_GAP_REM);
  const start = align === 'end' ? anchor.x + anchor.width - width : anchor.x;
  const left = Math.max(edge, Math.min(start, viewport.width - width - edge));
  const below = anchor.y + anchor.height + gap;
  // a zoomed, short viewport leaves no room, and CSS drops a negative max-height
  const roomBelow = Math.max(0, viewport.height - below - edge);
  const roomAbove = Math.max(0, anchor.y - gap - edge);
  if (roomBelow >= roomAbove) return { left, top: below, maxHeight: roomBelow };
  return { left, bottom: viewport.height - anchor.y + gap, maxHeight: roomAbove };
}
