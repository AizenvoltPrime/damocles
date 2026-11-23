// A project's own look on this computer (docs/invariants.md "Desktop themes"): projects.json's looks, and how touches change
// a look. Pure: core, main and the renderers import it.
import { characterAssets } from './characters';
import { deriveLookDetails } from './derive';
import { THEME_ID } from './limits';
import { validateTheme, type AssetMeta, type Look, type ThemeFile, type WallpaperSet } from './schema';
import { fillToken, onToken, toneTextToken, toneToken, type LookKind, type TokenName } from './tokens';
import { wallpaperAssets } from './wallpapers';

export const PROJECT_LOOK_KINDS = ['dark', 'light', 'auto'] as const;
export type ProjectLookKind = (typeof PROJECT_LOOK_KINDS)[number];
export const MAX_PROJECT_LOOKS = 1000;
// A project key is a folder key or a remote project's key; the longest path Windows takes. The core protocol carries no longer one.
export const MAX_PROJECT_KEY_CHARS = 32_767;

/** Touches on top of whatever theme shows: an accent, one wallpaper set with the assets it names, another theme's characters. */
export interface ProjectTouches {
  readonly mode: 'touches';
  // #rrggbb, the accent's fill; its text color is derived per look to AA
  readonly accent?: string;
  readonly wallpaper?: WallpaperSet;
  readonly assets?: Readonly<Record<string, AssetMeta>>;
  // the theme whose character set the project shows
  readonly characterSet?: string;
}

/** A whole theme for the project, which beats the schedule and the mode; auto takes the computer's light or dark mode. */
export interface ProjectFullTheme {
  readonly mode: 'full';
  readonly themeId: string;
  readonly look: ProjectLookKind;
}

export type ProjectLook = ProjectTouches | ProjectFullTheme;

export type ProjectTouch = 'accent' | 'wallpaper' | 'characters';

/** The touches a look sets, in the order the window words them. */
export function touchesOf(look: ProjectTouches): ProjectTouch[] {
  return [
    ...(look.accent !== undefined ? ['accent' as const] : []),
    ...(look.wallpaper !== undefined ? ['wallpaper' as const] : []),
    ...(look.characterSet !== undefined ? ['characters' as const] : []),
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const HEX = /^#[0-9a-f]{6}$/;
// A fixed id and colors the wallpaper's own check validates under; they name no installed theme.
const CHECK_ID = '00000000-0000-4000-8000-000000000000';
const CHECK_COLORS = { background: '#000000', panel: '#000000', text: '#ffffff', accent: '#ffffff', success: '#ffffff', warning: '#ffffff', danger: '#ffffff', info: '#ffffff' };

/** A wallpaper set checked as a one-set look of a theme would be, with the asset entries it names; undefined when it does not check. */
function checkWallpaper(set: unknown, assets: unknown): { readonly wallpaper: WallpaperSet; readonly assets: Record<string, AssetMeta> } | undefined {
  if (!isRecord(set)) return undefined;
  const result = validateTheme({ schemaVersion: 1, id: CHECK_ID, name: 'look', looks: { dark: { colors: CHECK_COLORS, wallpapers: [set] } }, ...(isRecord(assets) ? { assets } : {}) });
  if (!result.ok) return undefined;
  const look = result.theme.looks.dark!;
  const named = new Set(wallpaperAssets(look));
  if (named.size === 0) return undefined;
  return { wallpaper: look.wallpapers![0]!, assets: Object.fromEntries(Object.entries(result.theme.assets ?? {}).filter(([sha]) => named.has(sha))) };
}

/** A project look as read or received; undefined when it does not check or sets nothing. */
export function checkProjectLook(value: unknown): ProjectLook | undefined {
  if (!isRecord(value)) return undefined;
  if (value['mode'] === 'full') {
    const { themeId, look } = value;
    if (typeof themeId !== 'string' || !THEME_ID.test(themeId) || !PROJECT_LOOK_KINDS.includes(look as ProjectLookKind)) return undefined;
    return { mode: 'full', themeId, look: look as ProjectLookKind };
  }
  if (value['mode'] !== 'touches') return undefined;
  if (value['accent'] !== undefined && typeof value['accent'] !== 'string') return undefined;
  const accent = value['accent']?.toLowerCase();
  if (accent !== undefined && !HEX.test(accent)) return undefined;
  const characterSet = value['characterSet'];
  if (characterSet !== undefined && (typeof characterSet !== 'string' || !THEME_ID.test(characterSet))) return undefined;
  const wall = value['wallpaper'] === undefined ? undefined : checkWallpaper(value['wallpaper'], value['assets']);
  if (value['wallpaper'] !== undefined && wall === undefined) return undefined;
  const look: ProjectTouches = {
    mode: 'touches',
    ...(accent !== undefined ? { accent } : {}),
    ...(wall ? { wallpaper: wall.wallpaper, assets: wall.assets } : {}),
    ...(typeof characterSet === 'string' ? { characterSet } : {}),
  };
  return touchesOf(look).length > 0 ? look : undefined;
}

/** projects.json's looks by project key; an entry that does not check is dropped, never thrown. */
export function parseProjectLooks(json: unknown): Record<string, ProjectLook> {
  if (!isRecord(json) || json['version'] !== 1 || !isRecord(json['looks'])) return {};
  const looks: Record<string, ProjectLook> = {};
  for (const [key, raw] of Object.entries(json['looks']).slice(0, MAX_PROJECT_LOOKS)) {
    // __proto__ as a key would set the record's prototype
    const look = key === '' || key === '__proto__' || key.length > MAX_PROJECT_KEY_CHARS ? undefined : checkProjectLook(raw);
    if (look) looks[key] = look;
  }
  return looks;
}

// The accent's own tokens; an accent touch drops a look's overrides of them, so every one is derived from the new accent.
export const ACCENT_TOKENS: readonly TokenName[] = [toneToken('accent'), fillToken('accent'), onToken('accent'), toneTextToken('accent'), '--d-accent-soft'];

/** `look` with `accent` as its accent seed and no override of an accent token, so the derivation keeps its text at AA. */
export function withAccent(look: Look, accent: string): Look {
  const { tokens: given, ...rest } = look;
  const tokens = Object.fromEntries(Object.entries(given ?? {}).filter(([token]) => !ACCENT_TOKENS.includes(token as TokenName)));
  return { ...rest, colors: { ...look.colors, accent }, ...(Object.keys(tokens).length > 0 ? { tokens } : {}) };
}

/** What `touches` make of a look: its accent derived again, and the touch's wallpaper set in place of the look's own sets. */
export function touchedLook(look: Look, touches: ProjectTouches): Look {
  const accented = touches.accent !== undefined ? withAccent(look, touches.accent) : look;
  if (!touches.wallpaper) return accented;
  const { cycle: _cycle, ...rest } = accented;
  return { ...rest, wallpapers: [touches.wallpaper] };
}

/**
 * `theme` with `touches` on each of its looks, the touch's wallpaper assets and `characters`' set and sprites (another theme's,
 * undefined when that theme cannot show) in place of its own.
 */
export function touchedTheme(theme: ThemeFile, touches: ProjectTouches, characters?: Pick<ThemeFile, 'characters' | 'assets'>): ThemeFile {
  const looks = Object.fromEntries(Object.entries(theme.looks).map(([kind, look]) => [kind, look ? touchedLook(look, touches) : look]));
  const sprites = characters?.characters ? Object.fromEntries(characterAssets(characters).flatMap((sha) => (characters.assets?.[sha] ? [[sha, characters.assets[sha]!]] : []))) : {};
  const assets = { ...theme.assets, ...(touches.wallpaper ? touches.assets : {}), ...sprites };
  const { characters: own, assets: _assets, ...rest } = theme;
  const set = characters?.characters ?? own;
  return { ...rest, looks, ...(set ? { characters: set } : {}), ...(Object.keys(assets).length > 0 ? { assets } : {}) };
}

/** Where the derivation moved an accent in a look of `kind` to keep 4.5:1: its text color, its fill, or neither. */
export function shownAccent(look: Look, kind: LookKind, accent: string): { readonly text?: string; readonly fill?: string } {
  const accented = withAccent(look, accent);
  const moves = deriveLookDetails(accented.colors, kind, accented.tokens).moved.filter((move) => move.tone === 'accent');
  const shown = (role: 'fill' | 'text'): string | undefined => moves.find((move) => move.role === role)?.shown;
  const text = shown('text');
  const fill = shown('fill');
  return { ...(text === undefined ? {} : { text }), ...(fill === undefined ? {} : { fill }) };
}

/** The kind a full theme's look shows: auto takes the OS kind when the theme has it, else the look it has. */
export function fullThemeKind(look: ProjectLookKind, has: (kind: LookKind) => boolean, osKind: LookKind): { readonly kind: LookKind; readonly byOs: boolean } {
  if (look !== 'auto') return { kind: look, byOs: false };
  if (has(osKind)) return { kind: osKind, byOs: true };
  const other: LookKind = osKind === 'dark' ? 'light' : 'dark';
  return has(other) ? { kind: other, byOs: false } : { kind: osKind, byOs: true };
}
