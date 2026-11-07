import type { DesignBreakpoint } from '../../../shared/types/design';
import { MAX_DESIGN_WIDTH, MIN_DESIGN_WIDTH } from '../../preload/shell-channels';

// Width math of the design preview tab (PD-8). Widths are the design's CSS px; zoom is shell CSS px per design px.

// The base preset: a narrow phone width inside the band below the app's smallest breakpoint.
const BASE_WIDTH = 390;
export const BASE_BAND = 'base';

export function clampWidth(width: number): number {
  return Math.min(MAX_DESIGN_WIDTH, Math.max(MIN_DESIGN_WIDTH, Math.round(width)));
}

/** The app's breakpoints ascending, plus base below the smallest; never a device size, and only widths the preview can show. */
export function presetsOf(breakpoints: readonly DesignBreakpoint[]): DesignBreakpoint[] {
  const ascending = [...breakpoints].sort((a, b) => a.width - b.width);
  const smallest = ascending[0]?.width ?? Number.POSITIVE_INFINITY;
  const base = Math.min(BASE_WIDTH, smallest - 1);
  return [
    ...(base >= MIN_DESIGN_WIDTH ? [{ name: BASE_BAND, width: base }] : []),
    ...ascending.filter((breakpoint) => breakpoint.width >= MIN_DESIGN_WIDTH && breakpoint.width <= MAX_DESIGN_WIDTH),
  ];
}

/** The band a width sits in: the widest breakpoint at or below it, else base. */
export function bandOf(width: number, breakpoints: readonly DesignBreakpoint[]): string {
  let band = BASE_BAND;
  let reached = Number.NEGATIVE_INFINITY;
  for (const breakpoint of breakpoints) {
    if (breakpoint.width <= width && breakpoint.width > reached) {
      band = breakpoint.name;
      reached = breakpoint.width;
    }
  }
  return band;
}

/** The zoom that fits a frame of `width` into `available` shell px; never above 1, so a narrow design shows at its own size. */
export function zoomFor(width: number, available: number): number {
  if (available <= 0) return 1;
  return Math.min(1, available / width);
}

/** Fit: the width the pane has room for at 100%. */
export function fitWidth(available: number): number {
  return clampWidth(Math.floor(available));
}

/** A drag of the frame's right edge by `move` shell px: the frame is centered, so its width changes by twice the move. */
export function dragDelta(move: number, zoom: number): number {
  return (2 * move) / zoom;
}

/** The width an arrow, Home or End key on the handle asks for, or undefined for any other key. */
export function keyWidth(width: number, key: string, shift: boolean): number | undefined {
  const step = shift ? 10 : 1;
  if (key === 'ArrowRight') return clampWidth(width + step);
  if (key === 'ArrowLeft') return clampWidth(width - step);
  if (key === 'Home') return MIN_DESIGN_WIDTH;
  if (key === 'End') return MAX_DESIGN_WIDTH;
  return undefined;
}

export function readout(width: number, zoom: number, breakpoints: readonly DesignBreakpoint[]): string {
  return `${bandOf(width, breakpoints)} · ${width} px · ${Math.round(zoom * 100)}%`;
}
