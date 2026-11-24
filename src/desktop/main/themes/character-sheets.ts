// What a character sheet draws of a theme's set (docs/invariants.md "Desktop themes", the theme renderer): each character's
// views as the drawn preview builds them, each state's frame size and count for the layout, and what the sheet could not show.
// Pure: no electron, no files.
import type { CharacterSheetFacts, RenderAppearance } from '../../../shared/themes/agent';
import { SIDEBAR_AVATAR_PX, type CharacterSheetLayout, type SheetCharacterInput, type SheetStateInput } from '../../../shared/themes/character-sheet';
import { CHARACTER_STATES, frameAsset, MAX_SPRITE_SIDE, type CharacterState, type CharacterView } from '../../../shared/themes/characters';
import type { CharacterSelection, ThemeFile } from '../../../shared/themes/schema';
import { styleTokens } from '../../../shared/themes/style';

export interface SheetPlan {
  readonly inputs: readonly SheetCharacterInput[];
  // by the character's index in the set
  readonly views: ReadonlyMap<number, CharacterView>;
  readonly undrawn: readonly number[];
  // an image of theirs declares no size, or a side over MAX_SPRITE_SIDE
  readonly unfit: readonly number[];
  readonly stills: readonly { readonly character: number; readonly state: CharacterState }[];
  readonly wallpaper: boolean;
  readonly selection: CharacterSelection;
  // the sidebar avatar's side in px at the default text size, which the theme's density scales
  readonly sidebarAvatar: number;
}

/**
 * The characters of `theme`'s set a sheet draws, by index (`only`, else every one), with the views `appearance` built for them.
 * A view is found by name, which is unique in a set; a character the appearance could not draw is undrawn, and one with an
 * image of no usable size is unfit.
 */
export function sheetPlan(theme: ThemeFile, appearance: RenderAppearance, only?: readonly number[]): SheetPlan {
  const set = theme.characters?.characters ?? [];
  const shown = new Map((appearance.characters?.characters ?? []).map((view) => [view.name, view]));
  const indexes = only ? [...new Set(only)].filter((index) => index >= 0 && index < set.length) : set.map((_, index) => index);
  const inputs: SheetCharacterInput[] = [];
  const views = new Map<number, CharacterView>();
  const undrawn: number[] = [];
  const unfit: number[] = [];
  const stills: Array<{ readonly character: number; readonly state: CharacterState }> = [];
  for (const index of indexes) {
    const character = set[index]!;
    const view = shown.get(character.name);
    if (!view) {
      undrawn.push(index);
      continue;
    }
    const states: SheetStateInput[] = [];
    const held: CharacterState[] = [];
    let usable = true;
    for (const state of CHARACTER_STATES) {
      const frame = view.states[state];
      const declared = character.states[state];
      if (!frame || !declared) continue;
      if (frame.strip) {
        states.push({ state, frameWidth: frame.strip.frameWidth, frameHeight: frame.strip.frameHeight, frames: frame.strip.frames });
        continue;
      }
      const asset = theme.assets?.[frameAsset(declared)];
      if (!asset?.width || !asset.height || asset.width > MAX_SPRITE_SIDE || asset.height > MAX_SPRITE_SIDE) usable = false;
      else {
        // an image that moves is an animated one, which the sheet holds on its still frame
        if (frame.moves) held.push(state);
        states.push({ state, frameWidth: asset.width, frameHeight: asset.height, frames: 1 });
      }
    }
    if (!usable) {
      unfit.push(index);
      continue;
    }
    views.set(index, view);
    stills.push(...held.map((state) => ({ character: index, state })));
    inputs.push({ index, states });
  }
  const density = Number(styleTokens(theme.style)['--d-density']);
  return {
    inputs,
    views,
    undrawn,
    unfit,
    stills,
    wallpaper: appearance.wallpapers?.some((wallpaper) => wallpaper.panel === 'sidebar') === true,
    selection: theme.characters?.selection ?? 'outline',
    sidebarAvatar: Math.round(SIDEBAR_AVATAR_PX * density * 100) / 100,
  };
}

/** What the sheet's pages show and leave out, as core words it. */
export function sheetFacts(plan: SheetPlan, layout: CharacterSheetLayout): CharacterSheetFacts {
  const clipped = layout.sheets.flatMap((sheet) => sheet.rows.flatMap((row) => row.lines.flatMap((line) =>
    (line.frameCells.length < line.frameCount ? [{ character: row.character, state: line.state, shown: line.frameCells.length, frames: line.frameCount }] : []))));
  return {
    sheets: layout.sheets.map((sheet) => [...new Set(sheet.rows.map((row) => row.character))]),
    omitted: layout.omitted,
    unfit: [...plan.unfit, ...layout.unfit],
    undrawn: plan.undrawn,
    stills: plan.stills,
    clipped,
    selection: plan.selection,
    wallpaper: plan.wallpaper,
  };
}
