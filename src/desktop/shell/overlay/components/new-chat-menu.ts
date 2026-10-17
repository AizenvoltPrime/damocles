// Pure parts of NewChatMenu.vue: where a picker opens and the menu's type-ahead.

export interface PickerPlacement {
  // below: the picker's top, from the menu's top edge; above: its bottom, from the menu's bottom edge (CSS px)
  readonly above: boolean;
  readonly offset: number;
  // CSS px the picker's list may take under its filter box
  readonly listHeight: number;
}

interface Box {
  readonly top: number;
  readonly bottom: number;
}

// rem of the picker's parts: its list's tallest (the prototype's 220px), the filter box with its border, the gap to the
// trigger and the margin kept from the window's edge.
const LIST_REM = 13.75;
const FILTER_REM = 2.0625;
const GAP_REM = 0.25;
const EDGE_REM = 0.5;

/**
 * The picker opens under its trigger, or above it when the room below is short of a full list and the room above is
 * larger; its list then takes the room it has.
 */
export function pickerPlacement(trigger: Box, menu: Box, viewportHeight: number, remPx: (rem: number) => number): PickerPlacement {
  const gap = remPx(GAP_REM);
  const chrome = remPx(FILTER_REM) + gap + remPx(EDGE_REM);
  const below = viewportHeight - trigger.bottom - chrome;
  const above = trigger.top - chrome;
  const full = remPx(LIST_REM);
  const flip = below < full && above > below;
  const room = Math.max(0, flip ? above : below);
  return flip
    ? { above: true, offset: menu.bottom - trigger.top + gap, listHeight: Math.min(full, room) }
    : { above: false, offset: trigger.bottom - menu.top + gap, listHeight: Math.min(full, room) };
}

/** The row type-ahead lands on: the first after `from` (wrapping) whose label starts with `typed`, or -1. */
export function typeAheadMatch(labels: readonly string[], from: number, typed: string): number {
  const needle = typed.toLocaleLowerCase();
  // a repeated single letter cycles through the rows with that letter, as in any menu
  const start = typed.length === 1 ? from + 1 : Math.max(from, 0);
  for (let step = 0; step < labels.length; step++) {
    const index = (start + step) % labels.length;
    if (labels[index]?.trim().toLocaleLowerCase().startsWith(needle)) return index;
  }
  return -1;
}
