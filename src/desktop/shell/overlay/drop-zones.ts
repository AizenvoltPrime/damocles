import type { GridSlot } from '../../preload/shell-channels';
import type { OverlayPoint, OverlayRect } from '../../preload/overlay-channels';

// The reference's drop zones, as percentages of the layout grid: main 62%x64%, side 38%x64%, bottom 100%x36%.
export const DROP_ZONES: ReadonlyArray<{ readonly slot: GridSlot; readonly left: number; readonly top: number; readonly width: number; readonly height: number }> = [
  { slot: 'main', left: 0, top: 0, width: 62, height: 64 },
  { slot: 'side', left: 62, top: 0, width: 38, height: 64 },
  { slot: 'bottom', left: 0, top: 64, width: 100, height: 36 },
];

/** The zone under the pointer, or null outside the grid. */
export function dropZoneAt(grid: OverlayRect, pointer: OverlayPoint): GridSlot | null {
  if (grid.width <= 0 || grid.height <= 0) return null;
  const x = ((pointer.x - grid.x) / grid.width) * 100;
  const y = ((pointer.y - grid.y) / grid.height) * 100;
  const zone = DROP_ZONES.find((candidate) => x >= candidate.left && x < candidate.left + candidate.width && y >= candidate.top && y < candidate.top + candidate.height);
  return zone?.slot ?? null;
}
