// A theme's window arrangement against the window's layout (docs/invariants.md "Desktop themes"). Pure: no electron, no files.
import type { Arrangement } from '../../../shared/themes/schema';
import { MIN_SECTION_SIZE, MIN_SIDEBAR_WIDTH, type ShellLayout } from '../../preload/shell-channels';

// Must match COLUMN_MIN_PX and ROW_MIN_PX in src/desktop/shell/layout/layout-model.ts; the shell clamps again at the root
// font and density (atRootScale).
const COLUMN_MIN_PX = 300;
const ROW_MIN_PX = 120;
// CSS px the title bar and a banner take above the grid, at the default font.
const ABOVE_GRID_PX = 80;

type SizedSection = Exclude<keyof ShellLayout['sections'], 'chats'>;
const SIZED_SECTIONS: readonly SizedSection[] = ['projects', 'files', 'search', 'repos', 'scm', 'graph'];

/** The part of the window's layout a theme saves: the grid's slots, visibility and sizes, the sidebar's width and its sections. */
export function arrangementOf(layout: ShellLayout): Required<Arrangement> {
  const { slots, visible, sideWidth, bottomHeight } = layout.grid;
  const sections = Object.fromEntries([
    ...SIZED_SECTIONS.map((id) => [id, { collapsed: layout.sections[id].collapsed, size: Math.round(layout.sections[id].size) }]),
    ['chats', { collapsed: layout.sections.chats.collapsed }],
  ]) as NonNullable<Arrangement['sections']>;
  return {
    grid: { slots: { ...slots }, visible: { ...visible }, sideWidth: Math.round(sideWidth), bottomHeight: Math.round(bottomHeight) },
    sidebarWidth: Math.round(layout.sidebarWidth),
    sectionOrder: [...layout.sectionOrder],
    sections,
  };
}

const clamp = (value: number, min: number, max: number): number => Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

/** What the default-font px minimums are multiplied by: the root font (text size over 13 px) and the theme's density, as the shell's remPx does. */
export function minimumScale(textSizePx: number, density: number): number {
  return (textSizePx / 13) * density;
}

/**
 * `layout` with `arrangement` applied, its sizes clamped to a window of `room` CSS px and the minimums at `scale`
 * (minimumScale); nothing else of the layout (Search states, Source control options, the Graph) changes, and no pane is left
 * maximized.
 */
export function withArrangement(layout: ShellLayout, arrangement: Arrangement, room: { readonly width: number; readonly height: number }, scale = 1): ShellLayout {
  // the stored sidebar and section sizes never go below their stored minimums, which the layout file's reader checks
  const [columnMin, rowMin] = [COLUMN_MIN_PX * scale, ROW_MIN_PX * scale];
  const [sidebarMin, sectionMin] = [Math.max(MIN_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH * scale), Math.max(MIN_SECTION_SIZE, MIN_SECTION_SIZE * scale)];
  const sidebarWidth = clamp(arrangement.sidebarWidth ?? layout.sidebarWidth, sidebarMin, room.width - 2 * columnMin);
  const gridWidth = room.width - (layout.sidebarVisible ? sidebarWidth : 0);
  const gridHeight = room.height - ABOVE_GRID_PX * scale;
  const grid = arrangement.grid
    ? {
        slots: { ...arrangement.grid.slots },
        visible: { ...arrangement.grid.visible },
        sideWidth: clamp(arrangement.grid.sideWidth, columnMin, gridWidth - columnMin),
        bottomHeight: clamp(arrangement.grid.bottomHeight, rowMin, gridHeight - rowMin),
        maximized: null,
      }
    : { ...layout.grid, maximized: null };
  const saved = arrangement.sections ?? {};
  const sized = Object.fromEntries(SIZED_SECTIONS.map((id) => {
    const section = saved[id];
    const current = layout.sections[id];
    return [id, section ? { collapsed: section.collapsed, size: clamp(section.size ?? current.size, sectionMin, room.height) } : current];
  })) as Pick<ShellLayout['sections'], SizedSection>;
  const sections: ShellLayout['sections'] = { ...sized, chats: saved.chats ? { collapsed: saved.chats.collapsed } : layout.sections.chats };
  return { ...layout, sidebarWidth, grid, sections, sectionOrder: arrangement.sectionOrder ? [...arrangement.sectionOrder] : layout.sectionOrder };
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * The room, in CSS px, an arrangement is clamped to: the window's content at its zoom; before the window exists the size its
 * saved placement opens it at; the default size only when nothing was saved.
 */
export function arrangementRoom(window: (Size & { readonly zoom: number }) | undefined, saved: Size | undefined, fallback: Size): Size {
  if (window) return { width: window.width / window.zoom, height: window.height / window.zoom };
  return saved ? { width: saved.width, height: saved.height } : { width: fallback.width, height: fallback.height };
}
