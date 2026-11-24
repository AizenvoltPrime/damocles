import { describe, expect, it } from 'vitest';
import type { RenderAppearance } from '../../../../shared/themes/agent';
import { characterSheetLayout, SHEET_MAX_HEIGHT, SIDEBAR_AVATAR_PX } from '../../../../shared/themes/character-sheet';
import type { CharacterView } from '../../../../shared/themes/characters';
import type { ThemeFile } from '../../../../shared/themes/schema';
import { sheetFacts, sheetPlan } from '../character-sheets';

// What a character sheet draws of a set: each character by its index with the view the drawn preview built for it, each state's
// frame size, and what it could not show.

const STRIP = 'a'.repeat(64);
const GIF = 'b'.repeat(64);
const SVG = 'c'.repeat(64);
const COLORS = { background: '#000000', panel: '#111111', text: '#ffffff', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const THEME: ThemeFile = {
  schemaVersion: 1,
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'Pals',
  looks: { dark: { colors: COLORS } },
  characters: {
    name: 'Pals',
    selection: 'none',
    characters: [
      { name: 'Pip', states: { idle: { strip: { asset: STRIP, frameWidth: 10, frameHeight: 12, frames: 4, fps: 4 } }, running: { asset: GIF } } },
      { name: 'Bo', states: { idle: { asset: SVG } } },
      { name: 'Ghost', states: { idle: { asset: GIF } } },
    ],
  },
  assets: {
    [STRIP]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 40, height: 12, frames: 4, durationMs: 1000, license: {} },
    [GIF]: { kind: 'sprite', mime: 'image/gif', bytes: 10, width: 24, height: 20, frames: 6, durationMs: 600, license: {} },
    [SVG]: { kind: 'sprite', mime: 'image/svg+xml', bytes: 10, width: 16, height: 16, license: {} },
  },
};
const view = (name: string, states: CharacterView['states']): CharacterView => ({ name, states });
const blob = (sha: string): string => `app://damocles/theme-blob/${sha}`;
// the drawn preview could draw Pip and Bo; Ghost's animated image has no still frame yet
const APPEARANCE: RenderAppearance = {
  kind: 'dark', css: '', trustedCss: '', platform: 'linux',
  arrangement: { grid: { slots: { main: 'chat', side: 'editor', bottom: 'terminal' }, visible: { editor: false, terminal: false }, sideWidth: 400, bottomHeight: 200 }, sidebarWidth: 280, sectionOrder: [], sections: {} },
  characters: {
    characters: [
      view('Pip', { idle: { url: blob(STRIP), strip: { frameWidth: 10, frameHeight: 12, frames: 4, fps: 4 }, moves: true, playable: true }, running: { url: blob(GIF), still: 'app://damocles/theme-cache/b/still.png', moves: true, playable: true } }),
      view('Bo', { idle: { url: blob(SVG), still: 'app://damocles/theme-cache/c/still.png', moves: false, playable: false } }),
    ],
    pins: {},
    motion: 'still',
    selection: 'none',
  },
};

describe('sheetPlan', () => {
  it("takes each character's view by name and each state's frame size: a strip's cut, an image's own size", () => {
    const plan = sheetPlan(THEME, APPEARANCE);
    expect(plan.inputs).toEqual([
      { index: 0, states: [{ state: 'idle', frameWidth: 10, frameHeight: 12, frames: 4 }, { state: 'running', frameWidth: 24, frameHeight: 20, frames: 1 }] },
      { index: 1, states: [{ state: 'idle', frameWidth: 16, frameHeight: 16, frames: 1 }] },
    ]);
    expect(plan.views.get(0)?.name).toBe('Pip');
    expect(plan.views.get(1)?.name).toBe('Bo');
    expect(plan.undrawn).toEqual([2]);
    // the animated GIF shows its still frame, and an SVG is no animation
    expect(plan.stills).toEqual([{ character: 0, state: 'running' }]);
    expect(plan.selection).toBe('none');
    expect(plan.wallpaper).toBe(false);
  });

  it('draws only the characters asked for, in that order, each once and within the set', () => {
    expect(sheetPlan(THEME, APPEARANCE, [1, 0, 1, 7]).inputs.map((input) => input.index)).toEqual([1, 0]);
  });

  it('names unfit a character with an image of no declared size or one over 256 px, and draws the rest within 768 px', () => {
    const sized = (width: number | undefined, height: number | undefined): ThemeFile => {
      const { width: _width, height: _height, ...asset } = THEME.assets![SVG]!;
      return { ...THEME, assets: { ...THEME.assets, [SVG]: { ...asset, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) } } };
    };
    for (const theme of [sized(undefined, undefined), sized(16, 300), sized(300, 16)]) {
      const plan = sheetPlan(theme, APPEARANCE);
      expect(plan.unfit).toEqual([1]);
      expect(plan.inputs.map((input) => input.index)).toEqual([0]);
      const facts = sheetFacts(plan, characterSheetLayout(plan.inputs, { wallpaper: plan.wallpaper, sidebarAvatar: plan.sidebarAvatar }));
      expect(facts).toMatchObject({ sheets: [[0]], omitted: [], unfit: [1] });
    }
    const plan = sheetPlan(sized(16, 300), APPEARANCE);
    const layout = characterSheetLayout(plan.inputs, { wallpaper: plan.wallpaper, sidebarAvatar: plan.sidebarAvatar });
    expect(layout.sheets.every((sheet) => sheet.height <= SHEET_MAX_HEIGHT)).toBe(true);
  });

  it("sizes the 1x cell's avatar by the theme's density alone, whatever the text size and line spacing", () => {
    expect(sheetPlan(THEME, APPEARANCE).sidebarAvatar).toBe(SIDEBAR_AVATAR_PX);
    expect(sheetPlan({ ...THEME, style: { density: 1.15 } }, APPEARANCE).sidebarAvatar).toBe(25.3);
    // the user's text size 20 and the theme's line scale 1.4 reach the page's CSS only, which the sheet pins (drawSheet)
    const roomy = sheetPlan({ ...THEME, style: { lineHeight: 1.4 } }, { ...APPEARANCE, css: ':root { --d-font-size: 20px; --d-line-scale: 1.4; }' });
    const plain = sheetPlan(THEME, APPEARANCE);
    const labels = (plan: typeof plain) => characterSheetLayout(plan.inputs, { wallpaper: plan.wallpaper, sidebarAvatar: plan.sidebarAvatar })
      .sheets.flatMap((sheet) => sheet.rows.flatMap((row) => row.lines.map((line) => line.label)));
    expect(labels(roomy)).toEqual(labels(plain));
  });

  it('draws the wallpaper cell only for a look whose sidebar shows a wallpaper', () => {
    const wallpaper = { panel: 'sidebar' as const, asset: 'd'.repeat(64), fit: 'fill' as const, dim: 0.3, blur: 0, url: 'app://damocles/theme-blob/d', width: 100, height: 100 };
    expect(sheetPlan(THEME, { ...APPEARANCE, wallpapers: [wallpaper] }).wallpaper).toBe(true);
    expect(sheetPlan(THEME, { ...APPEARANCE, wallpapers: [{ ...wallpaper, panel: 'chat' }] }).wallpaper).toBe(false);
  });
});

describe('sheetFacts', () => {
  it('lists each page\'s characters, the ones left out and the states that showed only some frames', () => {
    const plan = sheetPlan(THEME, APPEARANCE);
    const many = { index: 0, states: [{ state: 'idle' as const, frameWidth: 4, frameHeight: 4, frames: 60 }] };
    const layout = characterSheetLayout([...plan.inputs, many], { wallpaper: false, sidebarAvatar: plan.sidebarAvatar });
    expect(sheetFacts(plan, layout)).toEqual({
      sheets: [[0, 1]],
      omitted: [],
      unfit: [],
      undrawn: [2],
      stills: [{ character: 0, state: 'running' }],
      clipped: [{ character: 0, state: 'idle', shown: 48, frames: 60 }],
      selection: 'none',
      wallpaper: false,
    });
  });
});
