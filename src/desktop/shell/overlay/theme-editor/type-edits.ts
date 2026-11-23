// The Type section's edits of a draft. Pure: each takes the draft it changes, so a font that arrives late can be placed in
// the draft as it is then.
import type { FontImport, FontRole } from '@shared/themes/fonts';
import type { FontChoice, ThemeFile } from '@shared/themes/schema';
import type { ThemeStyle } from '@shared/themes/style';

/** The draft with `next` as its style, or without one when it sets nothing. */
export function withStyle(draft: ThemeFile, next: ThemeStyle): ThemeFile {
  const theme: Record<string, unknown> = { ...draft };
  if (Object.keys(next).length > 0) theme['style'] = next;
  else delete theme['style'];
  return theme as unknown as ThemeFile;
}

/**
 * The draft with `choice` as the font of `role` (none: Damocles' own), `added` among its assets, and every font asset no
 * role names dropped: an unused font would be saved, exported and counted against the theme's fonts for nothing.
 */
export function withFont(draft: ThemeFile, role: FontRole, choice: FontChoice | undefined, added?: FontImport): ThemeFile {
  const fonts: Partial<Record<FontRole, FontChoice>> = { ...draft.style?.fonts };
  if (choice) fonts[role] = choice;
  else delete fonts[role];
  const style: Record<string, unknown> = { ...draft.style };
  if (Object.keys(fonts).length > 0) style['fonts'] = fonts;
  else delete style['fonts'];
  const named = new Set(Object.values(fonts).flatMap((font) => (font && 'asset' in font ? [font.asset] : [])));
  const assets = Object.fromEntries(Object.entries({ ...draft.assets, ...(added ? { [added.sha256]: added.asset } : {}) }).filter(([sha, asset]) => asset.kind !== 'font' || named.has(sha)));
  const theme: Record<string, unknown> = { ...withStyle(draft, style as ThemeStyle) };
  if (Object.keys(assets).length > 0) theme['assets'] = assets;
  else delete theme['assets'];
  return theme as unknown as ThemeFile;
}
