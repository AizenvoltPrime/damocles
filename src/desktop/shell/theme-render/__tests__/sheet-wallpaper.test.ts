import { describe, expect, it } from 'vitest';
import { SIDEBAR_AVATAR_PX } from '@shared/themes/character-sheet';
import type { Arrangement, Panel } from '@shared/themes/schema';
import type { ShellWallpaper } from '@shared/themes/wallpapers';
import { sampleWindowRects, wallpaperCrop } from '../sheet-wallpaper';

// The sheet's wallpaper cell shows the sidebar's own pixels: the image placed as the drawn window places it, whatever panes the
// arrangement shows, and the cell cut from the sidebar around its first avatar.

const arrangement = (visible: { editor: boolean; terminal: boolean }, sidebarWidth = 280): Required<Arrangement> => ({
  grid: { slots: { main: 'chat', side: 'editor', bottom: 'terminal' }, visible, sideWidth: 420, bottomHeight: 200 },
  sidebarWidth,
  sectionOrder: ['projects', 'chats', 'files', 'scm', 'graph', 'repos', 'search'],
  sections: { projects: { collapsed: false, size: 180 }, chats: { collapsed: false }, files: { collapsed: true, size: 200 }, scm: { collapsed: true, size: 200 }, graph: { collapsed: true, size: 200 }, repos: { collapsed: true, size: 200 }, search: { collapsed: true, size: 200 } },
});
const EDITOR_SHOWN = arrangement({ editor: true, terminal: false });
const EDITOR_HIDDEN = arrangement({ editor: false, terminal: false });
const wallpaper = (overrides: Partial<ShellWallpaper> = {}): ShellWallpaper =>
  ({ panel: 'sidebar', asset: 'd'.repeat(64), fit: 'fill', dim: 0.4, blur: 0, url: 'app://damocles/theme-cache/d/still.png', width: 1920, height: 1080, ...overrides });
const CELL = { width: 108, height: 108 };
// the sidebar's own image, 1920 x 1080 filling 280 x 760
const OWN = { left: '-535.56px', top: '0px', width: '1351.11px', height: '760px', filter: '' };

describe("the sample window's pane rectangles", () => {
  it('lays the grid out right of the sidebar and under the title bar, as the arrangement sizes it', () => {
    expect(sampleWindowRects(arrangement({ editor: true, terminal: true }), 40)).toEqual({
      titlebar: { x: 0, y: 0, width: 1280, height: 40 },
      sidebar: { x: 0, y: 40, width: 280, height: 760 },
      chat: { x: 280, y: 40, width: 575, height: 555 },
      editor: { x: 860, y: 40, width: 420, height: 555 },
      terminal: { x: 280, y: 600, width: 1000, height: 200 },
    });
  });

  it('gives a hidden pane no rectangle, and its room to its neighbour', () => {
    const rects = sampleWindowRects(EDITOR_HIDDEN, 40);
    expect(Object.keys(rects).sort()).toEqual(['chat', 'sidebar', 'titlebar']);
    expect(rects.chat).toEqual({ x: 280, y: 40, width: 1000, height: 760 });
  });
});

describe("the sheet's wallpaper crop", () => {
  it("clips to the sidebar's region and places its own image there, blurred as the wallpaper says", () => {
    const crop = wallpaperCrop(wallpaper({ blur: 2 }), EDITOR_SHOWN, CELL, SIDEBAR_AVATAR_PX);
    expect(crop.region).toEqual({ left: '0px', top: '40px', width: '280px', height: '760px' });
    expect(crop.image).toEqual({ ...OWN, filter: 'blur(2px)' });
    expect(crop.tile).toBeUndefined();
  });

  it('paints a tiled image in a box that reaches past the region by twice its blur, so the clip cuts the faded edge off', () => {
    const crop = wallpaperCrop(wallpaper({ fit: 'tile', blur: 6, width: 64, height: 64 }), EDITOR_SHOWN, CELL, SIDEBAR_AVATAR_PX);
    expect(crop.image).toBeUndefined();
    expect(crop.tile).toEqual({
      inset: '-12px',
      backgroundImage: 'url("app://damocles/theme-cache/d/still.png")',
      backgroundSize: '64px 64px',
      // the first tile starts at the region's corner
      backgroundPosition: '12px 12px',
      backgroundRepeat: 'repeat',
      filter: 'blur(6px)',
    });
    // the region only clips: a filter on it would fade its own edges
    expect(crop.region).toEqual({ left: '0px', top: '40px', width: '280px', height: '760px' });
    expect(wallpaperCrop(wallpaper({ fit: 'tile', width: 64, height: 64 }), EDITOR_SHOWN, CELL, SIDEBAR_AVATAR_PX).tile).toMatchObject({ inset: '0px', backgroundPosition: '0px 0px', filter: '' });
  });

  it('fits a spanning image to the spanned panes the window shows', () => {
    const span = (panels: readonly Panel[]): ShellWallpaper => wallpaper({ span: panels });
    // sidebar and chat: 855 px wide beside the editor
    expect(wallpaperCrop(span(['sidebar', 'chat']), EDITOR_SHOWN, CELL, SIDEBAR_AVATAR_PX).image).toEqual({ ...OWN, left: '-248.06px' });
    // the chat takes the hidden editor's room
    expect(wallpaperCrop(span(['sidebar', 'chat']), EDITOR_HIDDEN, CELL, SIDEBAR_AVATAR_PX).image).toEqual({ ...OWN, left: '-35.56px' });
    // a hidden pane adds nothing to the box
    expect(wallpaperCrop(span(['sidebar', 'editor']), EDITOR_HIDDEN, CELL, SIDEBAR_AVATAR_PX).image).toEqual(OWN);
    expect(wallpaperCrop(span(['sidebar', 'terminal']), EDITOR_SHOWN, CELL, SIDEBAR_AVATAR_PX).image).toEqual(OWN);
  });

  it("centres the cell on the first avatar, and keeps it inside the sidebar's region", () => {
    const window = (cell: { width: number; height: number }, sidebarWidth = 280) => wallpaperCrop(wallpaper(), arrangement({ editor: true, terminal: false }, sidebarWidth), cell, SIDEBAR_AVATAR_PX).window;
    // the avatar's centre: 25 px in, 89 px down
    expect(window({ width: 30, height: 30 })).toEqual({ left: '-10px', top: '-74px', width: '1280px', height: '800px' });
    // a cell wider and taller than the room around the avatar stops at the region's left and top edges
    expect(window(CELL)).toMatchObject({ left: '0px', top: '-40px' });
    // and at its right edge in a sidebar narrower than the avatar's row
    expect(window({ width: 20, height: 20 }, 30)).toMatchObject({ left: '-10px' });
  });

  it("scales the title bar and the avatar's place by the theme's density", () => {
    const crop = wallpaperCrop(wallpaper(), EDITOR_SHOWN, { width: 30, height: 30 }, SIDEBAR_AVATAR_PX * 2);
    expect(crop.region).toEqual({ left: '0px', top: '80px', width: '280px', height: '720px' });
    // 28 + 22 px in; 80 + 30 + 38 px down
    expect(crop.window).toMatchObject({ left: '-35px', top: '-133px' });
  });
});
