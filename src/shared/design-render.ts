// The limits of a design render (PD-41, docs/invariants.md "Design mode"), which core asks for and desktop main runs.

/** The exact refusal of `design.capture` and `design.probe` while no client that renders designs is attached. */
export const DESIGN_RENDER_CLIENT_ABSENT = 'No Damocles app is attached to render this design.';

export const MIN_RENDER_WIDTH = 320;
export const MAX_RENDER_WIDTH = 2560;
/** A run's window is as tall as the content, up to this many CSS px. */
export const MAX_RENDER_HEIGHT = 4000;
/** An image sent to the model shows W × min(this, content height) CSS px. */
export const RENDER_FRAME_HEIGHT = 900;
// equals SDK_SAFE_MAX_DIMENSION (core/browser/page-controller.ts); core/design/__tests__/design-render.test.ts holds them equal
export const MAX_RENDER_IMAGE_SIDE = 1950;
export const MAX_RENDER_SCALE = 2;
export const MAX_PROBE_WIDTHS = 16;
export const SWEEP_FROM: number = MIN_RENDER_WIDTH;
export const SWEEP_STEP = 8;

// What main's runner answers and core's parser bounds alike (core-protocol/messages.ts), so no answer ends core.
/** A probe's coordinates and sizes, clamped to ±this many CSS px. */
export const MAX_PROBE_PX = 1_000_000;
export const MAX_PROBE_ELEMENTS = 400;
export const MAX_OVERFLOWING = 8;
export const MAX_CONSOLE_ERRORS = 20;
/** A console error's characters, and an overflowing element's description's. */
export const MAX_PROBE_LINE_CHARS = 500;
/** The paths one design.changed names; more edits in one debounce send the first ones. */
export const MAX_CHANGED_PATHS = 64;

/** The largest scale up to `upper` (and MAX_RENDER_SCALE) that keeps the frame's longest side at or below MAX_RENDER_IMAGE_SIDE device px. */
export function renderScale(cssWidth: number, cssHeight: number, upper: number): number {
  const fit = Math.floor((MAX_RENDER_IMAGE_SIDE / Math.max(cssWidth, cssHeight, 1)) * 1000) / 1000;
  return Math.min(upper, MAX_RENDER_SCALE, fit);
}

/** A PNG's width and height from its IHDR chunk, which must come first and hold 13 bytes; throws for anything else. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
  if (png.length < 24 || header.some((byte, index) => png[index] !== byte)) throw new Error('The capture is not a PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
