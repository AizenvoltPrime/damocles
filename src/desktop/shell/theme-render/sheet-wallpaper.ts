// The sidebar wallpaper behind a character sheet's cell: the sidebar's region as the drawn preview's window places it, from
// the same arrangement and the same layout (layout-model.ts, wallpaper-layout.ts) at the default text size, cropped to the cell
// around the spot its first project's avatar sits on, so a sprite's colors meet the wallpaper the sidebar shows there. Pure:
// numbers in, styles out.
import { THEME_RENDER_SIZE } from '@shared/themes/agent';
import { SIDEBAR_AVATAR_PX } from '@shared/themes/character-sheet';
import type { Arrangement, Panel } from '@shared/themes/schema';
import type { ShellWallpaper } from '@shared/themes/wallpapers';
import { GRID_SLOTS, type GridSlot, type ShellGridLayout } from '../../preload/shell-channels';
import { GRID_SASH_REM, SECTION_HEADER_REM } from '../layout';
import { COLUMN_MIN_PX, gridAreas, ROW_MIN_PX, slotSizes } from '../layout/layout-model';
import { px, regionLayouts, type Rect } from '../themes/wallpaper-layout';

// The sample window's sidebar at the sheet's pinned 16 px root, where Tailwind spacing is these px times the theme's density
// and a rem is not. TitleBar.vue's h-10:
const TITLE_BAR = 40;
// the projects list's (px-1.5) and the row's (px-2) left padding, and the list's top padding (pt-0.5) plus half the row (h-8.5)
const ROW_LEFT = 6 + 8;
const ROW_TOP = 2 + 17;
const ROOT_PX = 16;
const HEADER_PX = SECTION_HEADER_REM * ROOT_PX;
const SASH_PX = GRID_SASH_REM * ROOT_PX;

export interface CropStyles {
  // the window-sized box, placed in the cell
  readonly window: Readonly<Record<string, string>>;
  // the sidebar region inside it, which clips the image
  readonly region: Readonly<Record<string, string>>;
  // the image in the region, as an <img>; absent for a tiled one
  readonly image?: Readonly<Record<string, string>>;
  // a tiled image's box in the region, which paints it as its background and reaches past the region as WallpaperLayer's does
  readonly tile?: Readonly<Record<string, string>>;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/**
 * Each pane's rectangle in the drawn window, `titleBar` px under its top, as SampleWindow.vue lays `arrangement` out with
 * gridTemplate's tracks; a pane the grid hides has none.
 */
export function sampleWindowRects(arrangement: Required<Arrangement>, titleBar: number): Partial<Record<Panel, Rect>> {
  const { width, height } = THEME_RENDER_SIZE;
  const sidebar = arrangement.sidebarWidth;
  const grid: ShellGridLayout = { ...arrangement.grid, maximized: null };
  const areas = gridAreas(grid);
  const gridWidth = width - sidebar;
  const gridHeight = height - titleBar;
  const slots = slotSizes(grid, gridWidth, gridHeight, SASH_PX, COLUMN_MIN_PX, ROW_MIN_PX);
  const columns = areas.main && areas.side ? { main: gridWidth - SASH_PX - slots.sideWidth, side: slots.sideWidth } : areas.side ? { main: 0, side: gridWidth } : { main: gridWidth, side: 0 };
  const top = areas.main || areas.side;
  const rows = top && areas.bottom ? { top: gridHeight - SASH_PX - slots.bottomHeight, bottom: slots.bottomHeight } : areas.bottom ? { top: 0, bottom: gridHeight } : { top: gridHeight, bottom: 0 };
  const slotRects: Record<GridSlot, Rect> = {
    main: { x: sidebar, y: titleBar, width: columns.main, height: rows.top },
    side: { x: width - columns.side, y: titleBar, width: columns.side, height: rows.top },
    bottom: { x: sidebar, y: height - rows.bottom, width: gridWidth, height: rows.bottom },
  };
  return {
    titlebar: { x: 0, y: 0, width, height: titleBar },
    sidebar: { x: 0, y: titleBar, width: sidebar, height: gridHeight },
    ...Object.fromEntries(GRID_SLOTS.filter((slot) => areas[slot]).map((slot) => [grid.slots[slot], slotRects[slot]])),
  };
}

/**
 * Where the sidebar's wallpaper goes in a cell of `cell` px: the sidebar's own pixels around the first avatar, kept inside it,
 * the image placed as the window of `arrangement` places it. `sidebarAvatar` is the layout's avatar side, SIDEBAR_AVATAR_PX
 * times the theme's density.
 */
export function wallpaperCrop(wallpaper: ShellWallpaper, arrangement: Required<Arrangement>, cell: { readonly width: number; readonly height: number }, sidebarAvatar: number): CropStyles {
  const density = sidebarAvatar / SIDEBAR_AVATAR_PX;
  const titleBar = TITLE_BAR * density;
  const [layout] = regionLayouts([wallpaper], sampleWindowRects(arrangement, titleBar), { x: 0, y: 0, ...THEME_RENDER_SIZE });
  if (!layout) throw new Error(`The sample window shows no region for the ${wallpaper.panel} wallpaper`);
  const { rect: region, image, margin } = layout;
  // the first project avatar's centre: below the title bar and the section's header
  const spot = { x: ROW_LEFT * density + sidebarAvatar / 2, y: titleBar + HEADER_PX + ROW_TOP * density };
  const centre = {
    x: clamp(spot.x, region.x + cell.width / 2, region.x + region.width - cell.width / 2),
    y: clamp(spot.y, region.y + cell.height / 2, region.y + region.height - cell.height / 2),
  };
  const filter = layout.blur > 0 ? `blur(${px(layout.blur)})` : '';
  return {
    window: { left: px(cell.width / 2 - centre.x), top: px(cell.height / 2 - centre.y), width: px(THEME_RENDER_SIZE.width), height: px(THEME_RENDER_SIZE.height) },
    region: { left: px(region.x), top: px(region.y), width: px(region.width), height: px(region.height) },
    // layout.image is relative to the box that reaches `margin` past the region
    ...(layout.fit === 'tile'
      ? { tile: { inset: px(-margin), backgroundImage: `url("${layout.url}")`, backgroundSize: layout.size, backgroundPosition: layout.position, backgroundRepeat: layout.repeat, filter } }
      : { image: { left: px(image.x - margin), top: px(image.y - margin), width: px(image.width), height: px(image.height), filter } }),
  };
}
