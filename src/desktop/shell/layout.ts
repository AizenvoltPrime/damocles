import { spacedRemPx } from '@/composables/useRemPx';

// rem of a grid sash track; the reference's 5px at the default font.
export const GRID_SASH_REM = 0.3125;
// rem of a sidebar section's header row.
export const SECTION_HEADER_REM = 1.875;
// rem: the row sash's hit area, which overlaps each neighbouring section by ROW_SASH_OVERLAP_REM.
export const ROW_SASH_REM = 0.3125;
export const ROW_SASH_OVERLAP_REM = 0.125;
// rem: seven section headers plus the six row sashes between them.
export const SIDEBAR_SECTION_CHROME_REM = 7 * SECTION_HEADER_REM + 6 * (ROW_SASH_REM - 2 * ROW_SASH_OVERLAP_REM);
// rem a sash moves per arrow key.
export const SASH_KEY_STEP_REM = 0.625;

/**
 * A px size given at the default font (1rem = 16px) and density, such as main's layout minimums, in px at the current root
 * font and the theme's density; main's minimumScale (main/themes/arrangement.ts) scales them the same way.
 */
export function atRootScale(px: number): number {
  return spacedRemPx(px / 16);
}

/**
 * A minimum of a size main stores (MIN_SIDEBAR_WIDTH, MIN_SECTION_SIZE) at the root font and density, never below the stored
 * one: main's layout reader refuses a smaller size, dropping the whole report. withArrangement floors it the same way.
 */
export function storedMinimum(px: number): number {
  return Math.max(px, atRootScale(px));
}
