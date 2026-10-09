// The editor grid's geometry. The swap and toggle rules live in shell-channels.ts, which main applies; the shell renders the result.
// Pure: sizes are CSS px, and callers pass px minimums already scaled to the root font.

import { GRID_SLOTS, type GridPane, type GridSlot, type ShellGridLayout } from '../../preload/shell-channels';

export { GRID_SLOTS, moveGridPane, toggleGridMaximize, toggleGridPane } from '../../preload/shell-channels';

// px at the default font (AD7): every column is at least COLUMN_MIN_PX wide and every row at least ROW_MIN_PX high, whichever
// pane it holds, and a sash moves until the slot on either side of it reaches its minimum.
export const COLUMN_MIN_PX = 300;
export const ROW_MIN_PX = 120;

export function slotOf(grid: Pick<ShellGridLayout, 'slots'>, pane: GridPane): GridSlot {
  const slot = GRID_SLOTS.find((candidate) => grid.slots[candidate] === pane);
  if (slot === undefined) throw new Error(`grid layout has no slot for ${pane}`);
  return slot;
}

/** Whether the pane shows; the chat always does. */
export function paneShown(grid: Pick<ShellGridLayout, 'visible'>, pane: GridPane): boolean {
  return pane === 'chat' || grid.visible[pane];
}

/**
 * The most the side or bottom slot may take of `roomPx` (the grid's extent less the sash): what leaves the slot across the
 * sash its minimum, never below the minimum. An unmeasured grid has no room yet, so the slot keeps `sizePx` until it is.
 */
export function slotMax(roomPx: number, minPx: number, sizePx: number): number {
  return Math.round(roomPx > 0 ? Math.max(minPx, roomPx - minPx) : Math.max(minPx, sizePx));
}

/** The side slot's width or the bottom slot's height: at least `minPx`, at most slotMax. */
export function clampSlotSize(sizePx: number, roomPx: number, minPx: number): number {
  return Math.round(Math.min(Math.max(sizePx, minPx), slotMax(roomPx, minPx, sizePx)));
}

/** The grid's minimum width: one column's minimum, or both columns' and the sash between them when both show. */
export function gridMinWidth(areas: GridAreas, columnMinPx: number, sashPx: number): number {
  return areas.main && areas.side ? 2 * columnMinPx + sashPx : columnMinPx;
}

export interface GridAreas {
  // which slots show; a hidden pane's slot collapses and its neighbour takes the room
  readonly main: boolean;
  readonly side: boolean;
  readonly bottom: boolean;
  // a sash shows only between two shown slots
  readonly sideSash: boolean;
  readonly bottomSash: boolean;
}

/** The slots that show: a maximized pane alone, else every slot whose pane shows. */
export function gridAreas(grid: ShellGridLayout): GridAreas {
  const maximized = grid.maximized !== null && paneShown(grid, grid.maximized) ? slotOf(grid, grid.maximized) : null;
  const shown = (slot: GridSlot): boolean => (maximized === null ? paneShown(grid, grid.slots[slot]) : maximized === slot);
  const main = shown('main');
  const side = shown('side');
  const bottom = shown('bottom');
  return { main, side, bottom, sideSash: main && side, bottomSash: (main || side) && bottom };
}
