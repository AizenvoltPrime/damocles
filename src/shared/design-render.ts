// The limits of a design render (PD-41, docs/invariants.md "Design mode"), which core asks for and desktop main runs.
import type { DesignRenderMedia } from './types/design';

/** The exact refusal of `design.capture` and `design.probe` while no client that renders designs is attached. */
export const DESIGN_RENDER_CLIENT_ABSENT = 'No Damocles app is attached to render this design.';
/** The exact refusal of `design.render` while the attached apps that render designs all predate it; core then asks `design.capture`. */
export const DESIGN_RENDER_PREDATES = 'The Damocles app attached to render this design predates design.render.';
/** A render that asked for media, a region or steps found only attached apps that predate `design.render`. */
export const DESIGN_RENDER_UPDATE_NEEDED = 'The Damocles app attached to render this design predates design.render and renders only the plain top frame; update the Damocles app that shows this chat to use media, fullPage, selector or steps.';
/** A journey with a scroll step or an `exact: false` target found only attached apps without `design.journeyScroll`. */
export const DESIGN_JOURNEY_UPDATE_NEEDED = 'The Damocles app attached to render this design predates design.journeyScroll, which scroll steps and exact: false targets need; update the Damocles app that shows this chat, or use exact targets and no scroll step.';
/** The exact refusal of `design.openPreview` while no app that may open the tab shows the design chat. */
export const DESIGN_PREVIEW_CLIENT_ABSENT = 'No Damocles app that may open this preview shows the design chat.';

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

/** An app's design runner refuses one authority's run past this many queued (D85), so core asks at most this many at once. */
export const MAX_QUEUED_RUNS_PER_AUTHORITY = 16;
/** A full-page or selector render returns at most this many RENDER_FRAME_HEIGHT frames. */
export const MAX_FULL_PAGE_FRAMES = 4;
/** Fonts, images and Web Animations settle within this bound, Playwright's `animations: 'disabled'`. */
export const SETTLE_TIMEOUT_MS = 2000;
/** Frames are taken until two consecutive ones are identical, within this bound, as Playwright's `toHaveScreenshot` waits. */
export const STABLE_FRAME_TIMEOUT_MS = 5000;
/** The image size and JPEG quality for a model whose catalog entry publishes no `inputLimits.images.resize`. */
export const DEFAULT_RENDER_IMAGE_TARGET = { maxSide: 1568, jpegQuality: 80 } as const;
/** The normal look, as Playwright and Chromatic capture by default; every render pins it unless the call asks otherwise. */
export const DEFAULT_RENDER_MEDIA: DesignRenderMedia = {
  colorScheme: 'light',
  reducedMotion: 'no-preference',
  forcedColors: 'none',
  contrast: 'no-preference',
  reducedTransparency: 'no-preference',
};
/** A selector region's CSS selector, at most this many characters. */
export const MAX_RENDER_SELECTOR_CHARS = 200;

/** The part of a pi model the image target reads. */
export interface RenderImageLimits {
  readonly inputLimits?: { readonly images?: { readonly resize?: { readonly maxWidth?: number; readonly maxHeight?: number; readonly maxBytes?: number; readonly jpegQuality?: number } } };
}

/** How a model-facing render is sized and encoded for `model`: its published resize profile, else the default target. */
export function renderImageTarget(model: RenderImageLimits | undefined): { readonly maxSide: number; readonly quality: number; readonly maxBytes?: number } {
  const resize = model?.inputLimits?.images?.resize;
  if (!resize) return { maxSide: DEFAULT_RENDER_IMAGE_TARGET.maxSide, quality: DEFAULT_RENDER_IMAGE_TARGET.jpegQuality };
  // a bound of 0 or less is no bound, as an absent one
  const bound = (value: number | undefined): number => (value !== undefined && value > 0 ? value : Infinity);
  const side = Math.min(MAX_RENDER_IMAGE_SIDE, bound(resize.maxWidth), bound(resize.maxHeight));
  return {
    maxSide: Math.max(1, Math.floor(side)),
    quality: Math.min(100, Math.max(1, Math.round(resize.jpegQuality ?? DEFAULT_RENDER_IMAGE_TARGET.jpegQuality))),
    ...(resize.maxBytes !== undefined && resize.maxBytes > 0 ? { maxBytes: resize.maxBytes } : {}),
  };
}

/** The largest scale up to `upper` (and MAX_RENDER_SCALE) that keeps the frame's longest side at or below `maxSide` device px. */
export function renderScale(cssWidth: number, cssHeight: number, upper: number, maxSide: number = MAX_RENDER_IMAGE_SIDE): number {
  const fit = Math.floor((Math.min(maxSide, MAX_RENDER_IMAGE_SIDE) / Math.max(cssWidth, cssHeight, 1)) * 1000) / 1000;
  return Math.min(upper, MAX_RENDER_SCALE, fit);
}

/** A PNG's width and height from its IHDR chunk, which must come first and hold 13 bytes; throws for anything else. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
  if (png.length < 24 || header.some((byte, index) => png[index] !== byte)) throw new Error('The capture is not a PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// SOF0 to SOF15 but DHT (C4), JPG (C8) and DAC (CC): their segment holds the precision, the height, then the width.
const JPEG_SOF: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** A JPEG's width and height from its first start-of-frame segment; throws for anything else. */
function jpegSize(jpeg: Uint8Array): { width: number; height: number } {
  const refuse = (): never => {
    throw new Error('The capture is not a JPEG');
  };
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) refuse();
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  let at = 2;
  while (at + 4 <= jpeg.length) {
    if (jpeg[at] !== 0xff) refuse();
    const marker = jpeg[at + 1]!;
    // a fill byte, or a marker with no length
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    const length = view.getUint16(at + 2);
    if (length < 2) refuse();
    if (JPEG_SOF.has(marker)) {
      if (at + 9 > jpeg.length) refuse();
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    at += 2 + length;
  }
  return refuse();
}

/** A capture's width and height in device px, from its own header: a PNG's IHDR or a JPEG's start of frame. */
export function imageSize(bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg'): { width: number; height: number } {
  return mimeType === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
}
