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
