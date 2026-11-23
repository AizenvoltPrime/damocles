// The Characters section's edits of a draft. Pure: each takes the draft it changes, so an import that answers late can be
// placed in the draft as it is then.
import { characterAssets, spriteFrame, type Character, type CharacterState, type SpriteImport } from '@shared/themes/characters';
import type { AssetMeta, CharacterSet, ThemeFile } from '@shared/themes/schema';

/** The draft with `next` as its character set and only the sprites a set names among its assets. */
export function withCharacterSet(draft: ThemeFile, next: CharacterSet | undefined, extra: Readonly<Record<string, AssetMeta>> = {}): ThemeFile {
  const named = new Set(next ? characterAssets({ characters: next }) : []);
  const assets = Object.fromEntries(Object.entries({ ...draft.assets, ...extra }).filter(([sha, asset]) => asset.kind !== 'sprite' || named.has(sha)));
  const theme: Record<string, unknown> = { ...draft };
  if (next && next.characters.length > 0) theme['characters'] = next;
  else delete theme['characters'];
  if (Object.keys(assets).length > 0) theme['assets'] = assets;
  else delete theme['assets'];
  return theme as unknown as ThemeFile;
}

/** A character set and the sprite assets it names, as a draft held them: what Undo puts back. */
export interface HeldSet {
  readonly set: CharacterSet;
  readonly assets: Readonly<Record<string, AssetMeta>>;
}

export function heldSet(draft: ThemeFile): HeldSet | undefined {
  const set = draft.characters;
  if (!set) return undefined;
  return { set, assets: Object.fromEntries(characterAssets({ characters: set }).flatMap((sha) => (draft.assets?.[sha] ? [[sha, draft.assets[sha]]] : []))) };
}

/** The draft with a new character whose idle image is `sprite`; undefined when the set took that name meanwhile. */
export function withNewCharacter(draft: ThemeFile, name: string, sprite: SpriteImport): ThemeFile | undefined {
  const set = draft.characters;
  if (set?.characters.some((character) => character.name === name)) return undefined;
  const character: Character = { name, states: { idle: spriteFrame(sprite) } };
  return withCharacterSet(draft, { name: set?.name ?? draft.name, characters: [...(set?.characters ?? []), character] }, { [sprite.sha256]: sprite.asset });
}

/** The draft with `sprite` as the `state` image of the character named `name`; undefined when that character is gone. */
export function withStateImage(draft: ThemeFile, name: string, state: CharacterState, sprite: SpriteImport): ThemeFile | undefined {
  const set = draft.characters;
  if (!set?.characters.some((character) => character.name === name)) return undefined;
  const characters = set.characters.map((character) => (character.name === name ? { ...character, states: { ...character.states, [state]: spriteFrame(sprite) } } : character));
  return withCharacterSet(draft, { ...set, characters }, { [sprite.sha256]: sprite.asset });
}
