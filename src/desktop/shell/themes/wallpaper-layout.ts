// Where each wallpaper region sits and how its image is laid out (WallpaperLayer.vue). Pure: rectangles in, styles out, so a
// spanning image keeps one placement in window pixels whatever the panes' sizes, and every region shows its part of it.
import type { Fit, Panel } from '@shared/themes/schema';
import type { ShellWallpaper } from '@shared/themes/wallpapers';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RegionLayout {
  readonly panel: Panel;
  // the panel's rectangle in window pixels, which the region clips to
  readonly rect: Rect;
  // how far the image box reaches past the region on each side, so a blur has pixels to sample at the region's edges
  readonly margin: number;
  // the image box's background, relative to that box
  readonly size: string;
  readonly position: string;
  readonly repeat: 'repeat' | 'no-repeat';
  // the same placement as numbers, relative to the image box: where a video or its copy is drawn
  readonly image: Rect;
  readonly url: string;
  readonly dim: number;
  readonly blur: number;
  readonly fit: Fit;
  readonly moving?: ShellWallpaper['moving'];
  readonly asset: string;
}

const visible = (rect: Rect | undefined): rect is Rect => rect !== undefined && rect.width > 0 && rect.height > 0;

/** The part of `rect` inside `bounds`; undefined when they share no area. */
export function intersect(rect: Rect, bounds: Rect): Rect | undefined {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const part = { x, y, width: Math.min(rect.x + rect.width, bounds.x + bounds.width) - x, height: Math.min(rect.y + rect.height, bounds.y + bounds.height) - y };
  return visible(part) ? part : undefined;
}

/** The smallest rectangle holding every one of `rects`. */
export function union(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The image's size and top-left corner in window pixels when it is fitted to `box` as `fit` says. */
export function placeImage(fit: Fit, box: Rect, image: { readonly width: number; readonly height: number }): Rect {
  const scale = fit === 'fill'
    ? Math.max(box.width / image.width, box.height / image.height)
    : fit === 'fit' ? Math.min(box.width / image.width, box.height / image.height) : 1;
  const width = image.width * scale;
  const height = image.height * scale;
  // a tile starts at the box's corner; the other fits are centred in it
  if (fit === 'tile') return { x: box.x, y: box.y, width, height };
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

/** `n` CSS px, to a hundredth. */
export const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/** Whether a region plays its moving wallpaper now: never a still one, and never one its flash check blocks. */
export const playsNow = (layout: Pick<RegionLayout, 'moving'>, paused: boolean): boolean => layout.moving !== undefined && layout.moving.playable && !paused;

/**
 * The region that holds each video's one element: the first region showing it, in the order regions come. Every other region
 * showing the same video draws a copy of each frame it presents, so the video decodes once however many panels it spans.
 */
export function videoOwners(layouts: readonly Pick<RegionLayout, 'panel' | 'asset' | 'moving'>[]): Map<string, Panel> {
  const owners = new Map<string, Panel>();
  for (const layout of layouts) if (layout.moving?.kind === 'video' && !owners.has(layout.asset)) owners.set(layout.asset, layout.panel);
  return owners;
}

/**
 * Each shown panel's region: a panel's own image fits its own rectangle; a spanning image fits the rectangle holding the part
 * inside `bounds` of every spanned panel shown now, so its regions line up. A hidden panel (no rectangle, or none of it inside
 * `bounds`, as a sidebar slid out of the window) gets none. A panel's own image fits its whole rectangle, so it keeps its size
 * while the panel slides.
 */
export function regionLayouts(wallpapers: readonly ShellWallpaper[], rects: Partial<Record<Panel, Rect>>, bounds: Rect): RegionLayout[] {
  const shown = (panel: Panel): Rect | undefined => {
    const rect = rects[panel];
    return rect ? intersect(rect, bounds) : undefined;
  };
  return wallpapers.flatMap((wallpaper): RegionLayout[] => {
    const rect = rects[wallpaper.panel];
    if (!rect || !shown(wallpaper.panel)) return [];
    const spanned = (wallpaper.span ?? []).map(shown).filter(visible);
    const box = spanned.length > 0 ? union(spanned) : rect;
    const image = placeImage(wallpaper.fit, box, wallpaper);
    const margin = Math.ceil(wallpaper.blur * 2);
    const origin = { x: rect.x - margin, y: rect.y - margin };
    return [{
      panel: wallpaper.panel,
      rect,
      margin,
      size: `${px(image.width)} ${px(image.height)}`,
      position: `${px(image.x - origin.x)} ${px(image.y - origin.y)}`,
      repeat: wallpaper.fit === 'tile' ? 'repeat' : 'no-repeat',
      image: { x: image.x - origin.x, y: image.y - origin.y, width: image.width, height: image.height },
      url: wallpaper.url,
      dim: wallpaper.dim,
      blur: wallpaper.blur,
      fit: wallpaper.fit,
      asset: wallpaper.asset,
      ...(wallpaper.moving ? { moving: wallpaper.moving } : {}),
    }];
  });
}
