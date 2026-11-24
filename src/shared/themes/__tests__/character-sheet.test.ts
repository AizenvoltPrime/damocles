import { describe, expect, it } from 'vitest';
import {
  aimedScale, characterSheetLayout as layoutAt, MAX_SHEET_FRAMES, MAX_SHEET_SCALE, MAX_SHEETS, SHEET_FRAMES_PER_LINE, SHEET_MAX_HEIGHT, SHEET_MAX_WIDTH,
  SIDEBAR_AVATAR_PX, type CharacterSheetLayout, type SheetCharacterInput, type SheetRect, type SheetStateInput,
} from '../character-sheet';

// The character sheet's pages: within 1280x768 whatever the sprites, a character the sheet cannot draw named apart as unfit,
// the scale stepping down before a character splits, at most four pages, and every character left out named.

const characterSheetLayout = (views: readonly SheetCharacterInput[], options: { readonly wallpaper: boolean }): CharacterSheetLayout =>
  layoutAt(views, { ...options, sidebarAvatar: SIDEBAR_AVATAR_PX });

const state = (name: SheetStateInput['state'], side: number, frames = 1, height = side): SheetStateInput => ({ state: name, frameWidth: side, frameHeight: height, frames });
const character = (index: number, side: number, frames = 1): SheetCharacterInput => ({
  index,
  states: [state('idle', side, frames), state('running', side, frames), state('waiting', side, frames)],
});

const inside = (rect: SheetRect, width: number, height: number): boolean =>
  rect.x >= 0 && rect.y >= 0 && rect.width >= 1 && rect.height >= 1 && rect.x + rect.width <= width && rect.y + rect.height <= height;

function expectBounded(layout: CharacterSheetLayout): void {
  expect(layout.sheets.length).toBeLessThanOrEqual(MAX_SHEETS);
  for (const sheet of layout.sheets) {
    expect(sheet.width).toBeLessThanOrEqual(SHEET_MAX_WIDTH);
    expect(sheet.height).toBeLessThanOrEqual(SHEET_MAX_HEIGHT);
    for (const line of sheet.rows.flatMap((row) => row.lines)) {
      for (const rect of [line.label, line.pane, line.selected, line.sidebar, line.frames, ...line.frameCells, ...(line.wallpaper ? [line.wallpaper] : [])]) {
        expect(inside(rect, sheet.width, sheet.height)).toBe(true);
      }
    }
  }
}

const shownCharacters = (layout: CharacterSheetLayout): number[] => [...new Set(layout.sheets.flatMap((sheet) => sheet.rows.map((row) => row.character)))];

describe('characterSheetLayout', () => {
  it('keeps every page within 1280x768, from tiny sprites to the largest a strip may hold, with and without the wallpaper cell', () => {
    const views = [
      character(0, 1),
      character(1, 10, 4),
      character(2, 32, 12),
      { index: 3, states: [state('idle', 256, 4), state('running', 256, 16)] },
      { index: 4, states: [state('idle', 256, 1, 8), state('waiting', 8, 1, 256)] },
      character(5, 4, 60),
    ];
    // 25.3: the sidebar avatar at the densest theme
    for (const sidebarAvatar of [SIDEBAR_AVATAR_PX, 25.3]) {
      for (const wallpaper of [true, false]) {
        const layout = layoutAt(views, { wallpaper, sidebarAvatar });
        expectBounded(layout);
        expect(layout.unfit).toEqual([]);
      }
    }
  });

  it('enlarges toward 96 px cells by a whole number, 1x to 8x', () => {
    expect(aimedScale(character(0, 10))).toBe(MAX_SHEET_SCALE);
    expect(aimedScale(character(0, 32))).toBe(3);
    expect(aimedScale(character(0, 16))).toBe(6);
    expect(aimedScale(character(0, 200))).toBe(1);
    const [sheet] = characterSheetLayout([character(0, 32)], { wallpaper: true }).sheets;
    expect(sheet!.rows[0]!.scale).toBe(3);
    expect(sheet!.rows[0]!.lines[0]!.sprite).toEqual({ width: 96, height: 96 });
  });

  it('steps the scale down until a character fits one page before it would split', () => {
    // three states of 24 frames of 24 px wrap into lines too tall for one page at the aimed 4x
    const tall = character(0, 24, 24);
    expect(aimedScale(tall)).toBe(4);
    const layout = characterSheetLayout([tall], { wallpaper: true });
    expect(layout.sheets).toHaveLength(1);
    const row = layout.sheets[0]!.rows[0]!;
    expect(row.scale).toBeLessThan(4);
    expect(row.scale).toBeGreaterThanOrEqual(1);
    expect(row.lines.map((line) => line.state)).toEqual(['idle', 'running', 'waiting']);
    expect(row.continued).toBe(false);
  });

  it('starts a new page for a character that fits a page but not what is left of this one', () => {
    const layout = characterSheetLayout([character(0, 10, 4), character(1, 10, 4), character(2, 10, 4)], { wallpaper: false });
    expect(layout.sheets.map((sheet) => sheet.rows.map((row) => row.character))).toEqual([[0, 1], [2]]);
    expect(layout.sheets.flatMap((sheet) => sheet.rows).every((row) => !row.continued && row.scale === MAX_SHEET_SCALE)).toBe(true);
    expect(layout.sheets[0]!.rows[1]!.rule).toBeDefined();
    expect(layout.sheets[0]!.rows[0]!.rule).toBeUndefined();
  });

  it('splits only a character too tall for a page at 1x, and shows the frames of a line that fit', () => {
    const huge = { index: 7, states: [state('idle', 256, 16), state('running', 256, 16), state('waiting', 256, 16)] };
    const layout = characterSheetLayout([huge], { wallpaper: true });
    expectBounded(layout);
    const rows = layout.sheets.flatMap((sheet) => sheet.rows);
    expect(rows.every((row) => row.character === 7 && row.scale === 1)).toBe(true);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(1).every((row) => row.continued)).toBe(true);
    const lines = rows.flatMap((row) => row.lines);
    expect(lines.map((line) => line.state)).toEqual(['idle', 'running', 'waiting']);
    for (const line of lines) {
      expect(line.frameCount).toBe(16);
      expect(line.frameCells.length).toBeGreaterThanOrEqual(1);
      expect(line.frameCells.length).toBeLessThan(16);
    }
  });

  it('wraps frames at 12 a line and shows at most 48 of a state', () => {
    const [sheet] = characterSheetLayout([{ index: 0, states: [state('idle', 4, 60)] }], { wallpaper: false }).sheets;
    const line = sheet!.rows[0]!.lines[0]!;
    expect(line.frameCount).toBe(60);
    expect(line.frameCells).toHaveLength(MAX_SHEET_FRAMES);
    const firstLine = line.frameCells.filter((cell) => cell.y === line.frameCells[0]!.y);
    expect(firstLine).toHaveLength(SHEET_FRAMES_PER_LINE);
    // in order: left to right, then down
    expect(line.frameCells[1]!.x).toBeGreaterThan(line.frameCells[0]!.x);
    expect(line.frameCells[SHEET_FRAMES_PER_LINE]!.y).toBeGreaterThan(line.frameCells[0]!.y);
  });

  it('draws the wallpaper cell only when the look has a sidebar wallpaper', () => {
    const lineOf = (wallpaper: boolean) => characterSheetLayout([character(0, 16)], { wallpaper }).sheets[0]!.rows[0]!.lines[0]!;
    expect(lineOf(true).wallpaper).toBeDefined();
    expect(lineOf(false).wallpaper).toBeUndefined();
    expect(lineOf(true).frames.x).toBeGreaterThan(lineOf(false).frames.x);
  });

  it('holds to four pages and names every character left out, in order', () => {
    const views = Array.from({ length: 30 }, (_, index) => character(index, 10, 4));
    const layout = characterSheetLayout(views, { wallpaper: true });
    expect(layout.sheets).toHaveLength(MAX_SHEETS);
    expectBounded(layout);
    const shown = shownCharacters(layout);
    expect(shown).toEqual(views.slice(0, shown.length).map((view) => view.index));
    expect(layout.omitted).toEqual(views.slice(shown.length).map((view) => view.index));
    expect(layout.omitted.length).toBeGreaterThan(0);
  });

  it('still fits a smaller character on the last page after a larger one was left out', () => {
    const filler = Array.from({ length: 7 }, (_, index) => character(index, 10, 4));
    const huge = { index: 7, states: [state('idle', 256, 16), state('running', 256, 16), state('waiting', 256, 16)] };
    const small = { index: 8, states: [state('idle', 8)] };
    const layout = characterSheetLayout([...filler, huge, small], { wallpaper: false });
    expect(layout.omitted).toEqual([7]);
    expect(shownCharacters(layout)).toContain(8);
  });

  it('draws nothing for no characters, and names a character with no state to draw unfit', () => {
    expect(characterSheetLayout([], { wallpaper: true })).toEqual({ sheets: [], omitted: [], unfit: [] });
    expect(characterSheetLayout([{ index: 3, states: [] }], { wallpaper: true })).toEqual({ sheets: [], omitted: [], unfit: [3] });
  });

  it('names unfit a character with a frame taller than a page at 1x, and still draws the rest within 768 px', () => {
    for (const wallpaper of [true, false]) {
      const layout = characterSheetLayout([character(0, 10), { index: 1, states: [state('idle', 16, 1, 697)] }, character(2, 10)], { wallpaper });
      expect(layout.unfit).toEqual([1]);
      expect(layout.omitted).toEqual([]);
      expect(shownCharacters(layout)).toEqual([0, 2]);
      expectBounded(layout);
    }
    // the tallest frame a page holds: one line of the whole page
    const tallest = characterSheetLayout([{ index: 0, states: [state('idle', 16, 1, 696)] }], { wallpaper: true });
    expect(tallest.unfit).toEqual([]);
    expect(tallest.sheets[0]!.height).toBe(SHEET_MAX_HEIGHT);
  });

  it('names unfit a character whose frame is too wide to fit across at 1x', () => {
    const layout = characterSheetLayout([{ index: 4, states: [state('idle', 16), state('running', 700, 1, 16)] }, character(5, 10)], { wallpaper: true });
    expect(layout.unfit).toEqual([4]);
    expect(shownCharacters(layout)).toEqual([5]);
    expectBounded(layout);
  });

  it("draws the 1x cell at the sidebar avatar's size it is given, with whole-pixel cells", () => {
    const lineOf = (sidebarAvatar: number) => {
      const [sheet] = layoutAt([character(0, 16)], { wallpaper: false, sidebarAvatar }).sheets;
      return { sheet: sheet!, line: sheet!.rows[0]!.lines[0]! };
    };
    expect(lineOf(SIDEBAR_AVATAR_PX).sheet.sidebarAvatar).toBe(22);
    expect(lineOf(SIDEBAR_AVATAR_PX).line.sidebar).toMatchObject({ width: 34, height: 34 });
    // density 1.15: the avatar is 25.3 px, its cell the next whole px plus the padding
    const dense = lineOf(25.3);
    expect(dense.sheet.sidebarAvatar).toBe(25.3);
    expect(dense.line.sidebar).toMatchObject({ width: 38, height: 38 });
    expect(Number.isInteger(dense.line.frames.x)).toBe(true);
  });

  it("gives the legend room for its sentence on the narrowest sheet, with and without the wallpaper's clause", () => {
    // CharacterSheet.vue's legend in Geist at 12 px, measured in Chromium: 515 px, and 622 px with the wallpaper's clause
    const narrowest = (wallpaper: boolean) => characterSheetLayout([{ index: 0, states: [state('idle', 1)] }], { wallpaper }).sheets[0]!;
    expect(narrowest(false).legend.width).toBeGreaterThanOrEqual(515);
    expect(narrowest(true).legend.width).toBeGreaterThanOrEqual(622);
    expect(narrowest(true).width).toBeLessThanOrEqual(SHEET_MAX_WIDTH);
  });
});
