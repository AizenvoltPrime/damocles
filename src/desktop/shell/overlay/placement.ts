import type { OverlayRect } from '../../preload/overlay-channels';

// CSS px kept between a popup and the viewport edge.
const EDGE = 8;

/**
 * Top-left of a popup of the given size: below the anchor, or above it when it would overflow the bottom,
 * then clamped into the viewport. A point anchor (zero size) places the popup at the pointer.
 */
export function placePopup(anchor: OverlayRect, size: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number } {
  const below = anchor.y + anchor.height;
  const fitsBelow = below + size.height <= viewport.height - EDGE;
  const top = fitsBelow ? below : anchor.y - size.height;
  return {
    left: Math.max(EDGE, Math.min(anchor.x, viewport.width - size.width - EDGE)),
    top: Math.max(EDGE, Math.min(top, viewport.height - size.height - EDGE)),
  };
}
