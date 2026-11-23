import type { ThemeKind } from './preload/panel-channels';
import { BUILTIN_PALETTES } from '../shared/themes/builtin';
import type { ThemePalette } from '../shared/themes/tokens';

// No electron or Node import: main's theme.ts injects these and the overlay reads a host tone's value from them.
// The values live in src/shared/themes/builtin.ts. See docs/invariants.md "Design tokens".
export type { ThemePalette } from '../shared/themes/tokens';

export const DARK_THEME: ThemePalette = BUILTIN_PALETTES.dark;
export const LIGHT_THEME: ThemePalette = BUILTIN_PALETTES.light;

export const THEME_PALETTES: Readonly<Record<ThemeKind, ThemePalette>> = BUILTIN_PALETTES;
