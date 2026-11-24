// The character sheet (docs/tools.md, ThemeRead and ThemeSet preview characters): every state and frame of a character set,
// enlarged, on pages no model provider resamples. Laid out here, so main sizes each page's job and the page places each cell
// where this says. Pure: core, main and the theme render page import it.
import type { CharacterState } from './characters';

// A page fits both providers untouched: Claude downscales past 1568 px on the long side, OpenAI to 768 px on the short side.
export const SHEET_MAX_WIDTH = 1280;
export const SHEET_MAX_HEIGHT = 768;
export const MAX_SHEETS = 4;
// A sprite is enlarged by a whole number, aiming at cells this many px on their longer side.
export const SHEET_CELL_AIM = 96;
export const MAX_SHEET_SCALE = 8;
export const SHEET_FRAMES_PER_LINE = 12;
export const MAX_SHEET_FRAMES = 48;
// ProjectRow's avatar, size-5.5 at the default text size and density 1; a theme's density scales it.
export const SIDEBAR_AVATAR_PX = 22;

const PAD = 16;
const LEGEND = 28;
// the label column and its gap: the widest label line, "×1 · 256 frames", is 78 px in the pinned font
const LABEL = 92;
const CELL_PAD = 6;
const GAP = 10;
const FRAME_GAP = 4;
const FRAMES_PAD = 6;
const LINE_GAP = 6;
const ROW_GAP = 14;
// the label's three lines of text, CharacterSheet.vue's 1rem, 0.875rem and 0.875rem at the sheet's pinned 16 px root
const MIN_LINE = 44;
// the legend's sentence in its pinned font: 515 px, 622 px with the wallpaper's clause
const MIN_WIDTH = { plain: 560, wallpaper: 680 } as const;
const TOP = PAD + LEGEND;
const BOTTOM = SHEET_MAX_HEIGHT - PAD;
const RIGHT = SHEET_MAX_WIDTH - PAD;

/** One state of a character as the sheet draws it: one frame's size in sprite px, and how many frames its image holds. */
export interface SheetStateInput {
  readonly state: CharacterState;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frames: number;
}

/** A character of the set, by its index there, with the states it draws. */
export interface SheetCharacterInput {
  readonly index: number;
  readonly states: readonly SheetStateInput[];
}

export interface SheetRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One state of one character: its label, its enlarged cells, its 1x cell and its frames. Every rect is in the page's px. */
export interface SheetLine {
  readonly state: CharacterState;
  readonly label: SheetRect;
  // the sprite on the sidebar pane color, over the sidebar wallpaper (only when the look has one), and as the selected project
  readonly pane: SheetRect;
  readonly wallpaper?: SheetRect;
  readonly selected: SheetRect;
  // at the sidebar's own size
  readonly sidebar: SheetRect;
  // the sprite's box inside each enlarged cell, centred: one frame at the row's scale
  readonly sprite: { readonly width: number; readonly height: number };
  readonly frames: SheetRect;
  // each frame shown, in order; fewer than frameCount when they did not all fit or passed MAX_SHEET_FRAMES
  readonly frameCells: readonly SheetRect[];
  readonly frameCount: number;
}

export interface SheetRow {
  readonly character: number;
  readonly scale: number;
  // the character began on an earlier page
  readonly continued: boolean;
  // the line between this character and the one above it
  readonly rule?: SheetRect;
  readonly lines: readonly SheetLine[];
}

export interface CharacterSheetPage {
  readonly width: number;
  readonly height: number;
  // the side of the avatar the 1x cell draws, in px
  readonly sidebarAvatar: number;
  readonly legend: SheetRect;
  readonly rows: readonly SheetRow[];
}

export interface CharacterSheetLayout {
  readonly sheets: readonly CharacterSheetPage[];
  // the characters, by index, that would need a page past MAX_SHEETS
  readonly omitted: readonly number[];
  // the characters, by index, no page can draw: no state, or a frame taller than a page or too wide to fit across at 1x
  readonly unfit: readonly number[];
}

export interface SheetOptions {
  // the look has a sidebar wallpaper, so each line has its cell
  readonly wallpaper: boolean;
  // the sidebar avatar's side in px, which the 1x cell draws
  readonly sidebarAvatar: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const centred = (top: number, room: number, size: number): number => top + Math.floor((room - size) / 2);

/** The scale a character aims at: its largest frame side enlarged to about SHEET_CELL_AIM px, 1x to MAX_SHEET_SCALE. */
export function aimedScale(character: SheetCharacterInput): number {
  const side = Math.max(1, ...character.states.map((state) => Math.max(state.frameWidth, state.frameHeight)));
  return clamp(Math.floor(SHEET_CELL_AIM / side), 1, MAX_SHEET_SCALE);
}

interface Measured {
  readonly height: number;
  readonly perLine: number;
  readonly shown: number;
}

const sidebarCell = (options: SheetOptions): number => Math.ceil(options.sidebarAvatar) + 2 * CELL_PAD;

// A state's line at scale k: undefined when one frame does not fit beside its cells or its cell is taller than a page.
// maxHeight clips its frames to fit.
function measure(state: SheetStateInput, k: number, options: SheetOptions, maxHeight = Infinity): Measured | undefined {
  const width = state.frameWidth * k;
  const height = state.frameHeight * k;
  if (height + 2 * CELL_PAD > BOTTOM - TOP) return undefined;
  const cells = options.wallpaper ? 3 : 2;
  const left = PAD + LABEL + cells * (width + 2 * CELL_PAD + GAP) + sidebarCell(options) + GAP;
  const room = RIGHT - left - 2 * FRAMES_PAD;
  const fit = Math.floor((room + FRAME_GAP) / (width + FRAME_GAP));
  let shown = Math.min(state.frames, MAX_SHEET_FRAMES);
  const perLine = Math.min(SHEET_FRAMES_PER_LINE, shown, fit);
  if (perLine < 1) return undefined;
  const fitLines = Math.floor((maxHeight - 2 * FRAMES_PAD + FRAME_GAP) / (height + FRAME_GAP));
  shown = Math.min(shown, Math.max(1, fitLines) * perLine);
  const lines = Math.ceil(shown / perLine);
  const block = 2 * FRAMES_PAD + lines * height + (lines - 1) * FRAME_GAP;
  return { height: Math.max(MIN_LINE, height + 2 * CELL_PAD, sidebarCell(options), block), perLine, shown };
}

function placeLine(state: SheetStateInput, k: number, options: SheetOptions, y: number, measured: Measured): SheetLine {
  const { height: lineHeight, perLine, shown } = measured;
  const sprite = { width: state.frameWidth * k, height: state.frameHeight * k };
  const cell = { width: sprite.width + 2 * CELL_PAD, height: sprite.height + 2 * CELL_PAD };
  let x = PAD + LABEL;
  const next = (width: number, height: number): SheetRect => {
    const rect = { x, y: centred(y, lineHeight, height), width, height };
    x += width + GAP;
    return rect;
  };
  const pane = next(cell.width, cell.height);
  const wallpaperCell = options.wallpaper ? next(cell.width, cell.height) : undefined;
  const selected = next(cell.width, cell.height);
  const sidebar = next(sidebarCell(options), sidebarCell(options));
  const lines = Math.ceil(shown / perLine);
  const frames = next(2 * FRAMES_PAD + perLine * sprite.width + (perLine - 1) * FRAME_GAP, 2 * FRAMES_PAD + lines * sprite.height + (lines - 1) * FRAME_GAP);
  const frameCells = Array.from({ length: shown }, (_, at) => ({
    x: frames.x + FRAMES_PAD + (at % perLine) * (sprite.width + FRAME_GAP),
    y: frames.y + FRAMES_PAD + Math.floor(at / perLine) * (sprite.height + FRAME_GAP),
    ...sprite,
  }));
  return {
    state: state.state,
    label: { x: PAD, y, width: LABEL - GAP, height: lineHeight },
    pane,
    ...(wallpaperCell ? { wallpaper: wallpaperCell } : {}),
    selected,
    sidebar,
    sprite,
    frames,
    frameCells,
    frameCount: state.frames,
  };
}

// A character's whole row at scale k, or undefined when a line does not measure.
function rowHeight(character: SheetCharacterInput, k: number, options: SheetOptions): number | undefined {
  let total = 0;
  for (const [at, state] of character.states.entries()) {
    const measured = measure(state, k, options);
    if (!measured) return undefined;
    total += measured.height + (at > 0 ? LINE_GAP : 0);
  }
  return total;
}

interface Page {
  readonly rows: Array<{ character: number; scale: number; continued: boolean; top: number; lines: SheetLine[] }>;
  y: number;
}

const emptyPage = (): Page => ({ rows: [], y: TOP });
const clonePages = (pages: readonly Page[]): Page[] => pages.map((page) => ({ rows: page.rows.map((row) => ({ ...row, lines: [...row.lines] })), y: page.y }));

// The character's lines flowed onto `pages` from the last one, a new page whenever a line does not fit; false when that
// would take more than MAX_SHEETS pages. `whole`: the row fits one page, so it starts a page rather than split.
function flow(pages: Page[], character: SheetCharacterInput, k: number, options: SheetOptions, whole: number | undefined): boolean {
  let page = pages.at(-1)!;
  const gapAbove = (target: Page): number => (target.rows.length > 0 ? ROW_GAP : 0);
  if (whole !== undefined && page.y + gapAbove(page) + whole > BOTTOM) {
    if (pages.length >= MAX_SHEETS) return false;
    page = emptyPage();
    pages.push(page);
  }
  let row: Page['rows'][number] | undefined;
  for (const state of character.states) {
    const gap = row ? LINE_GAP : gapAbove(page);
    let measured = measure(state, k, options)!;
    if (page.y + gap + measured.height > BOTTOM) {
      if (page.rows.length > 0 || row) {
        if (pages.length >= MAX_SHEETS) return false;
        page = emptyPage();
        pages.push(page);
        row = undefined;
      }
      measured = measure(state, k, options, BOTTOM - TOP)!;
    }
    if (!row) {
      const top = page.y + gapAbove(page);
      row = { character: character.index, scale: k, continued: pages.some((other) => other !== page && other.rows.some((r) => r.character === character.index)), top, lines: [] };
      page.rows.push(row);
      page.y = top;
    } else {
      page.y += LINE_GAP;
    }
    row.lines.push(placeLine(state, k, options, page.y, measured));
    page.y += measured.height;
  }
  return true;
}

/**
 * The pages of a character sheet: one row per character, in order, each state a line. A character takes the largest scale up
 * to its aim at which its row fits one page, never below 1x; only a row too tall for a page at 1x splits across pages, and a
 * line whose frames wrap taller than a page shows the frames that fit. A character with no state, or with a frame taller than
 * a page or too wide to fit across at 1x, is unfit; one that would need a page past MAX_SHEETS is omitted.
 */
export function characterSheetLayout(views: readonly SheetCharacterInput[], options: SheetOptions): CharacterSheetLayout {
  let pages: Page[] = [emptyPage()];
  const omitted: number[] = [];
  const unfit: number[] = [];
  for (const character of views) {
    if (character.states.length === 0 || rowHeight(character, 1, options) === undefined) {
      unfit.push(character.index);
      continue;
    }
    let scale: number | undefined;
    let whole: number | undefined;
    for (let k = aimedScale(character); k >= 1; k--) {
      const height = rowHeight(character, k, options);
      if (height !== undefined && height <= BOTTOM - TOP) {
        scale = k;
        whole = height;
        break;
      }
    }
    const k = scale ?? 1;
    const trial = clonePages(pages);
    if (flow(trial, character, k, options, whole)) pages = trial;
    else omitted.push(character.index);
  }
  const sheets = pages.filter((page) => page.rows.length > 0).map((page): CharacterSheetPage => {
    const right = Math.max(...page.rows.flatMap((row) => row.lines.map((line) => line.frames.x + line.frames.width)));
    const width = Math.max(options.wallpaper ? MIN_WIDTH.wallpaper : MIN_WIDTH.plain, right + PAD);
    return {
      width,
      height: page.y + PAD,
      sidebarAvatar: options.sidebarAvatar,
      legend: { x: PAD, y: PAD, width: width - 2 * PAD, height: LEGEND - 8 },
      rows: page.rows.map((row, at) => ({
        character: row.character,
        scale: row.scale,
        continued: row.continued,
        ...(at > 0 ? { rule: { x: PAD, y: row.top - ROW_GAP / 2, width: width - 2 * PAD, height: 1 } } : {}),
        lines: row.lines,
      })),
    };
  });
  return { sheets, omitted, unfit };
}
