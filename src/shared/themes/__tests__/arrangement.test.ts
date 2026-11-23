import { describe, expect, it } from 'vitest';
import { DEFAULT_GRID_LAYOUT, GRID_PANES, GRID_SLOTS, MAX_SHELL_COORDINATE, MIN_SECTION_SIZE, SIDEBAR_SECTIONS, type ShellLayout } from '../../../desktop/preload/shell-channels';
import { arrangementOf, minimumScale, withArrangement } from '../../../desktop/main/themes/arrangement';
import { ARRANGEMENT_PANES, ARRANGEMENT_SECTIONS } from '../schema';
import { ARRANGEMENT_SLOTS, MAX_ARRANGEMENT_COORDINATE, MIN_ARRANGEMENT_SECTION, parseArrangement, parseGridLayout, parseGridSizes, parseSectionOrder } from '../arrangement';

// The shape of window-layout.json's default layout (DEFAULT_SHELL_LAYOUT in src/desktop/main/window-layout-store.ts).
const DEFAULT_SHELL_LAYOUT: ShellLayout = {
  sidebarVisible: true,
  sidebarWidth: 264,
  sections: { projects: { collapsed: false, size: 180 }, files: { collapsed: false, size: 230 }, search: { collapsed: true, size: 260 }, repos: { collapsed: true, size: 220 }, scm: { collapsed: false, size: 300 }, graph: { collapsed: false, size: 190 }, chats: { collapsed: false } },
  sectionOrder: SIDEBAR_SECTIONS,
  grid: DEFAULT_GRID_LAYOUT,
  search: {},
  scm: { viewMode: 'list', sortKey: 'path' },
  repositories: {},
  graph: {},
};

describe('window arrangement', () => {
  it('names the same panes, slots, sections and bounds as the shell, in the same order', () => {
    expect(ARRANGEMENT_PANES).toEqual(GRID_PANES);
    expect(ARRANGEMENT_SLOTS).toEqual(GRID_SLOTS);
    expect(ARRANGEMENT_SECTIONS).toEqual(SIDEBAR_SECTIONS);
    expect(MAX_ARRANGEMENT_COORDINATE).toBe(MAX_SHELL_COORDINATE);
    expect(MIN_ARRANGEMENT_SECTION).toBe(MIN_SECTION_SIZE);
  });

  it('reads a grid only when its slots are a permutation and its sizes are in range', () => {
    expect(parseGridLayout(DEFAULT_GRID_LAYOUT)).toEqual(DEFAULT_GRID_LAYOUT);
    expect(parseGridLayout({ ...DEFAULT_GRID_LAYOUT, slots: { main: 'chat', side: 'chat', bottom: 'terminal' } })).toBeUndefined();
    expect(parseGridLayout({ ...DEFAULT_GRID_LAYOUT, maximized: 'sidebar' })).toBeUndefined();
    expect(parseGridSizes({ sideWidth: 400, bottomHeight: MAX_ARRANGEMENT_COORDINATE + 1 })).toBeUndefined();
  });

  it('puts the Graph back after Source control in an order saved without it', () => {
    const without = SIDEBAR_SECTIONS.filter((id) => id !== 'graph');
    expect(parseSectionOrder(without)).toEqual(SIDEBAR_SECTIONS);
    expect(parseSectionOrder([...SIDEBAR_SECTIONS, 'files'])).toBeUndefined();
  });

  it('reads a theme arrangement field by field and refuses any malformed field', () => {
    const arrangement = arrangementOf(DEFAULT_SHELL_LAYOUT);
    expect(parseArrangement(arrangement)).toEqual(arrangement);
    expect(parseArrangement({})).toEqual({});
    expect(parseArrangement({ ...arrangement, sidebarWidth: -1 })).toBeUndefined();
    expect(parseArrangement({ ...arrangement, sections: { chats: { collapsed: 'yes' } } })).toBeUndefined();
    expect(parseArrangement({ ...arrangement, sections: { sidebar: { collapsed: true } } })).toBeUndefined();
    expect(parseArrangement('grid')).toBeUndefined();
  });

  it('applies an arrangement clamped to the window and the minimums, leaving no pane maximized', () => {
    const saved = { ...arrangementOf(DEFAULT_SHELL_LAYOUT), sidebarWidth: 2000, grid: { ...arrangementOf(DEFAULT_SHELL_LAYOUT).grid!, sideWidth: 5000, bottomHeight: 10 } };
    const current = { ...DEFAULT_SHELL_LAYOUT, grid: { ...DEFAULT_SHELL_LAYOUT.grid, maximized: 'editor' as const } };
    const applied = withArrangement(current, saved, { width: 1280, height: 820 });
    expect(applied.sidebarWidth).toBe(1280 - 600);
    expect(applied.grid.sideWidth).toBe(300);
    expect(applied.grid.bottomHeight).toBe(120);
    expect(applied.grid.maximized).toBeNull();
    expect(applied.search).toBe(current.search);
  });

  it.each([
    { textSize: 13, density: 0.85, column: 255, row: 102, sidebar: 220, section: 60 },
    { textSize: 13, density: 1.15, column: 345, row: 138, sidebar: 253, section: 69 },
    { textSize: 20, density: 1.15, column: 531, row: 212, sidebar: 389, section: 106 },
  ])('clamps to the minimums at text size $textSize and density $density, never below the stored ones', ({ textSize, density, column, row, sidebar, section }) => {
    expect(minimumScale(textSize, density)).toBeCloseTo((textSize / 13) * density, 9);
    const saved = arrangementOf(DEFAULT_SHELL_LAYOUT);
    const tiny = { ...saved, sidebarWidth: 1, grid: { ...saved.grid!, sideWidth: 1, bottomHeight: 1 }, sections: { ...saved.sections!, projects: { collapsed: false, size: 1 } } };
    const applied = withArrangement(DEFAULT_SHELL_LAYOUT, tiny, { width: 1600, height: 1000 }, minimumScale(textSize, density));
    expect(applied.sidebarWidth).toBe(sidebar);
    expect(applied.grid.sideWidth).toBe(column);
    expect(applied.grid.bottomHeight).toBe(row);
    expect(applied.sections.projects).toEqual({ collapsed: false, size: section });
  });

  it('keeps what an arrangement leaves out', () => {
    const applied = withArrangement(DEFAULT_SHELL_LAYOUT, { sectionOrder: [...SIDEBAR_SECTIONS].reverse() }, { width: 1280, height: 820 });
    expect(applied.sectionOrder).toEqual([...SIDEBAR_SECTIONS].reverse());
    expect(applied.grid.slots).toEqual(DEFAULT_SHELL_LAYOUT.grid.slots);
    expect(applied.sections).toEqual(DEFAULT_SHELL_LAYOUT.sections);
  });
});
