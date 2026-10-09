import { remPx } from '@/composables/useRemPx';

// rem of a grid sash track; the reference's 5px at the default font.
export const GRID_SASH_REM = 0.3125;
// rem of a sidebar section's header row.
export const SECTION_HEADER_REM = 1.875;
// rem: the row sash's hit area, which overlaps each neighbouring section by ROW_SASH_OVERLAP_REM.
export const ROW_SASH_REM = 0.3125;
export const ROW_SASH_OVERLAP_REM = 0.125;
// rem a sash moves per arrow key.
export const SASH_KEY_STEP_REM = 0.625;

/** A px size given at the default font (1rem = 16px), such as main's layout minimums, in px at the current root font. */
export function atRootFont(px: number): number {
  return remPx(px / 16);
}
