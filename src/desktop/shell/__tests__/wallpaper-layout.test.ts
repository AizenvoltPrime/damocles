import { describe, expect, it } from 'vitest';
import type { Panel } from '@shared/themes/schema';
import type { ShellWallpaper } from '@shared/themes/wallpapers';
import { intersect, placeImage, playsNow, regionLayouts, union, videoOwners, type Rect, type RegionLayout } from '../themes/wallpaper-layout';

// A spanning wallpaper keeps one placement in window pixels: every region shows its part of the same picture, however the panes
// are sized (WallpaperLayer.vue measures them in the frame they change).

const ALL: readonly Panel[] = ['titlebar', 'sidebar', 'chat', 'editor', 'terminal'];
const span = (blur = 0): ShellWallpaper[] => ALL.map((panel) => ({ panel, asset: 'a'.repeat(64), fit: 'fill', dim: 0.5, blur, span: ALL, url: 'app://damocles/theme-blob/x', width: 2400, height: 1600 }));

// A window of `width` x `height` laid out as the shell lays it: a 40 px title bar, the sidebar, the chat, and the editor over the
// terminal in the side slot.
function window(width: number, height: number, sidebar: number, side: number, bottom: number): Partial<Record<Panel, Rect>> {
  const body = height - 40;
  const chat = width - sidebar - side;
  return {
    titlebar: { x: 0, y: 0, width, height: 40 },
    sidebar: { x: 0, y: 40, width: sidebar, height: body },
    chat: { x: sidebar, y: 40, width: chat, height: body },
    editor: { x: sidebar + chat, y: 40, width: side, height: body - bottom },
    terminal: { x: sidebar + chat, y: 40 + body - bottom, width: side, height: bottom },
  };
}

// The regions of a window whose wallpaper layer fills it.
const laidOut = (wallpapers: readonly ShellWallpaper[], rects: Partial<Record<Panel, Rect>>, width = 1280, height = 800): RegionLayout[] => regionLayouts(wallpapers, rects, { x: 0, y: 0, width, height });

const px = (value: string): number[] => value.split(' ').map((part) => Number.parseFloat(part));

// Where a region's image sits in window pixels: the region's corner less the blur margin, plus the background position.
function placement(layout: RegionLayout): { x: number; y: number; width: number; height: number } {
  const [x, y] = px(layout.position);
  const [width, height] = px(layout.size);
  return { x: layout.rect.x - layout.margin + x!, y: layout.rect.y - layout.margin + y!, width: width!, height: height! };
}

function expectLinedUp(layouts: readonly RegionLayout[]): void {
  const first = placement(layouts[0]!);
  for (const layout of layouts) {
    const at = placement(layout);
    expect(at.x).toBeCloseTo(first.x, 1);
    expect(at.y).toBeCloseTo(first.y, 1);
    expect(at.width).toBeCloseTo(first.width, 1);
    expect(at.height).toBeCloseTo(first.height, 1);
  }
}

describe('regionLayouts', () => {
  it('lines a spanning image up across the title bar, sidebar, chat, editor and terminal', () => {
    const rects = window(1280, 800, 240, 420, 260);
    const layouts = laidOut(span(), rects);
    expect(layouts.map((layout) => layout.panel)).toEqual(ALL);
    for (const layout of layouts) expect(layout.rect).toEqual(rects[layout.panel]);
    expectLinedUp(layouts);
    // fill covers the whole window, the box every spanned panel makes
    expect(placement(layouts[0]!)).toMatchObject({ x: 0, width: 1280 });
  });

  it('keeps it lined up and in place while a divider drags, and moves each region with its pane', () => {
    const before = laidOut(span(8), window(1280, 800, 240, 420, 260));
    for (const [sidebar, side, bottom] of [[300, 420, 260], [300, 520, 260], [300, 520, 400], [180, 300, 120]] as const) {
      const rects = window(1280, 800, sidebar, side, bottom);
      const after = laidOut(span(8), rects);
      for (const layout of after) expect(layout.rect).toEqual(rects[layout.panel]);
      expectLinedUp(after);
      // the window is the same size, so the picture stays where it was; only the regions' edges moved
      expect(placement(after[0]!)).toEqual(placement(before[0]!));
    }
  });

  it('fits the picture to the new window as the window resizes, still lined up', () => {
    for (const [width, height] of [[900, 600], [1920, 1080], [3440, 1440]] as const) {
      const layouts = laidOut(span(4), window(width, height, 240, 360, 200), width, height);
      expectLinedUp(layouts);
      const image = placement(layouts[0]!);
      // cover: the picture reaches every edge of the window and keeps its 3:2 shape
      expect(image.width).toBeGreaterThanOrEqual(width - 0.01);
      expect(image.height).toBeGreaterThanOrEqual(height - 0.01);
      expect(image.width / image.height).toBeCloseTo(1.5, 3);
    }
  });

  it('draws no region for a hidden pane and fits a span to the panes that show', () => {
    const rects = { ...window(1280, 800, 240, 420, 260), terminal: { x: 0, y: 0, width: 0, height: 0 } };
    delete (rects as Partial<Record<Panel, Rect>>).editor;
    const layouts = laidOut(span(), rects);
    expect(layouts.map((layout) => layout.panel)).toEqual(['titlebar', 'sidebar', 'chat']);
    expectLinedUp(layouts);
  });

  // A hidden sidebar keeps its width and slides out past the window's left edge.
  it('draws no region for a sidebar slid out of the window, and fits a span to what is left', () => {
    const shown = window(1280, 800, 240, 420, 260);
    const rects = { ...shown, sidebar: { x: -240, y: 40, width: 240, height: 760 }, chat: { x: 0, y: 40, width: 860, height: 760 } };
    const layouts = laidOut(span(), rects);
    expect(layouts.map((layout) => layout.panel)).toEqual(['titlebar', 'chat', 'editor', 'terminal']);
    expectLinedUp(layouts);
    // the picture is fitted to the window, never to the window plus the sidebar that left it
    expect(placement(layouts[0]!)).toMatchObject({ x: 0, width: 1280 });
  });

  it('counts only the part of a half slid sidebar that is inside the window towards a span', () => {
    const rects = { ...window(1280, 800, 240, 420, 260), sidebar: { x: -120, y: 40, width: 240, height: 760 }, chat: { x: 120, y: 40, width: 740, height: 760 } };
    const layouts = laidOut(span(), rects);
    expect(layouts.map((layout) => layout.panel)).toEqual(ALL);
    expect(layouts[1]!.rect).toEqual(rects.sidebar);
    expectLinedUp(layouts);
    expect(placement(layouts[0]!)).toMatchObject({ x: 0, width: 1280 });
  });

  it("keeps a sliding panel's own image the size of its whole rectangle", () => {
    const own: ShellWallpaper = { panel: 'sidebar', asset: 'b'.repeat(64), fit: 'fill', dim: 0.3, blur: 0, url: 'u', width: 240, height: 760 };
    const [layout] = laidOut([own], { sidebar: { x: -120, y: 40, width: 240, height: 760 } });
    expect(placement(layout!)).toEqual({ x: -120, y: 40, width: 240, height: 760 });
  });

  it("fits a panel's own image to its own rectangle", () => {
    const rects = window(1280, 800, 240, 420, 260);
    const own: ShellWallpaper = { panel: 'sidebar', asset: 'b'.repeat(64), fit: 'fit', dim: 0.3, blur: 0, url: 'u', width: 1000, height: 1000 };
    const [layout] = laidOut([own], rects);
    expect(placement(layout!)).toEqual({ x: 0, y: 40 + (760 - 240) / 2, width: 240, height: 240 });
    expect(layout!.repeat).toBe('no-repeat');
  });

  it('reaches past the region by twice its blur, so the blur has pixels at the edges', () => {
    const [layout] = laidOut(span(12).slice(0, 1), window(1280, 800, 240, 420, 260));
    expect(layout!.margin).toBe(24);
  });
});

describe('placeImage', () => {
  const box = { x: 100, y: 50, width: 400, height: 200 };
  it.each([
    ['fill', { x: 100, y: -50, width: 400, height: 400 }],
    ['fit', { x: 200, y: 50, width: 200, height: 200 }],
    ['center', { x: 250, y: 100, width: 100, height: 100 }],
    ['tile', { x: 100, y: 50, width: 100, height: 100 }],
  ] as const)('places a square image for %s', (fit, expected) => {
    expect(placeImage(fit, box, { width: 100, height: 100 })).toEqual(expected);
  });
});

describe('intersect and union', () => {
  it('answers the shared part of two rectangles, and none when they only touch or lie apart', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    expect(intersect({ x: -20, y: 10, width: 50, height: 200 }, bounds)).toEqual({ x: 0, y: 10, width: 30, height: 90 });
    expect(intersect({ x: -50, y: 0, width: 50, height: 100 }, bounds)).toBeUndefined();
    expect(intersect({ x: 200, y: 200, width: 10, height: 10 }, bounds)).toBeUndefined();
  });

  it('holds every rectangle it is given', () => {
    expect(union([{ x: 10, y: 20, width: 30, height: 40 }, { x: 0, y: 50, width: 100, height: 5 }])).toEqual({ x: 0, y: 20, width: 100, height: 40 });
  });
});

describe('videoOwners and playsNow', () => {
  const video = { kind: 'video', still: 's', playable: true } as const;
  const VIDEO: ShellWallpaper[] = (['sidebar', 'chat', 'editor'] as const).map((panel) => ({ panel, asset: 'v'.repeat(64), fit: 'fill', dim: 0, blur: 0, span: ['sidebar', 'chat', 'editor'], url: 'u', width: 1920, height: 1080, moving: video }));

  it('gives each video to the first region that shows it, and a still image to none', () => {
    const layouts = laidOut([...VIDEO, { panel: 'terminal', asset: 'i'.repeat(64), fit: 'fill', dim: 0, blur: 0, url: 'u', width: 10, height: 10 }], window(1280, 800, 240, 420, 260));
    expect([...videoOwners(layouts)]).toEqual([['v'.repeat(64), 'sidebar']]);
  });

  it('never gives a video to a sidebar slid out of the window', () => {
    const rects = { ...window(1280, 800, 240, 420, 260), sidebar: { x: -240, y: 40, width: 240, height: 760 } };
    expect(videoOwners(laidOut(VIDEO, rects)).get('v'.repeat(64))).toBe('chat');
  });

  it('plays a moving wallpaper only while nothing pauses it and its flash check allows it', () => {
    expect(playsNow({ moving: video }, false)).toBe(true);
    expect(playsNow({ moving: video }, true)).toBe(false);
    expect(playsNow({ moving: { ...video, playable: false } }, false)).toBe(false);
    expect(playsNow({}, false)).toBe(false);
  });
});
