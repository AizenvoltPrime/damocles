import { BUILTIN_THEME_ID, SYSTEM_THEME_ID } from './builtin';
import type { ThemeFile } from './schema';
import { LOOK_KINDS } from './tokens';

/**
 * What a copy or an export of the built-in `theme` carries: Damocles' colors without its pinned token overrides, which would
 * ignore the copy's own colors, and System colors' looks of this moment without the description that says it follows the
 * computer. Undefined for any other theme, which is copied whole.
 */
export function portableBuiltinTheme(theme: ThemeFile): Pick<ThemeFile, 'schemaVersion' | 'name' | 'looks'> | undefined {
  if (theme.id !== BUILTIN_THEME_ID && theme.id !== SYSTEM_THEME_ID) return undefined;
  const keepTokens = theme.id === SYSTEM_THEME_ID;
  const looks = Object.fromEntries(LOOK_KINDS.flatMap((kind) => {
    const look = theme.looks[kind];
    return look ? [[kind, { colors: { ...look.colors }, ...(keepTokens && look.tokens ? { tokens: { ...look.tokens } } : {}) }]] : [];
  }));
  return { schemaVersion: 1, name: theme.name, looks };
}
