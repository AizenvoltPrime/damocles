// A look's wallpapers (docs/themes.md "Wallpapers"): which panel shows which image, the pane tokens that let it through, and
// the readability of text over a dimmed image. Pure: core, main and the renderers import it.
import { colorMix, fromLinear, over, parseHex, withAlpha, type Rgba } from './color';
import { AA, contrast } from './contrast';
import { LOOK_SEEDS, PANELS, type AssetKind, type AssetMeta, type Fit, type Look, type LookColors, type Panel, type WallpaperSet } from './schema';
import { MAX_BLUR_PX, MAX_VIDEO_MS, SURFACE_OPACITY_RANGE } from './limits';
import { PANE_TOKENS, SURFACE_ALPHA_TOKEN, type TokenName } from './tokens';

export { DIM_RANGE, MAX_ANIMATION_FRAMES, MAX_BLUR_PX, MAX_MOVING_BYTES, MAX_VIDEO_MS, MAX_WALLPAPER_SETS, SURFACE_OPACITY_RANGE } from './limits';

// A still wallpaper's caps, checked from its header before anything decodes it.
export const MAX_WALLPAPER_BYTES: number = 20 * 1024 * 1024;
export const MAX_WALLPAPER_SIDE = 8192;
export const MAX_WALLPAPER_PIXELS = 40_000_000;
// Trusted cards keep at least this background alpha over a wallpaper.
export const TRUSTED_SURFACE_FLOOR = 0.92;
// What a panel the editor or the agent gives an image starts at.
export const DEFAULT_PANEL_LOOK = { dim: 0.55, blur: 4 } as const;
// The side of the thumbnail the theme renderer writes, in px.
export const THUMB_SIDE = 480;
// The WebP quality of that thumbnail, and of the store validator's smaller one.
export const THUMB_QUALITY = 0.86;

// A video wallpaper's size cap, checked with the moving caps of limits.ts from its header before anything decodes it.
export const MAX_VIDEO_SIZE = { width: 3840, height: 2160 } as const;
// The codecs a video wallpaper may use, as MP4's sample entry or WebM's codec ID names them.
export const VIDEO_CODECS = ['avc1', 'av01', 'vp08', 'vp09'] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];
// A container and a decoder round a duration differently, by less than this.
export const VIDEO_DURATION_TOLERANCE_MS = 500;

/**
 * Whether a video's decoded duration is refused: the header's caps bound what a file declares, so the decode holds the real
 * length to the cap and to the declared one again.
 */
export function decodedDurationRefused(decodedMs: number, declaredMs: number | undefined): boolean {
  return decodedMs > MAX_VIDEO_MS + VIDEO_DURATION_TOLERANCE_MS || (declaredMs !== undefined && decodedMs > declaredMs + VIDEO_DURATION_TOLERANCE_MS);
}

// Blurring every frame costs battery, so a moving wallpaper blurs at most this much, in px.
export const MAX_MOVING_BLUR_PX = 8;

export type WallpaperFormat = 'png' | 'jpeg' | 'webp' | 'avif';
export const WALLPAPER_MIME: Readonly<Record<WallpaperFormat, string>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };
export const isWallpaperMime = (mime: string): boolean => Object.values(WALLPAPER_MIME).includes(mime);
// An animated image keeps its format's type (an APNG is image/png); a video is its container's.
export const ANIMATED_MIME = ['image/gif', 'image/png', 'image/webp'] as const;
export const VIDEO_MIME = ['video/mp4', 'video/webm'] as const;

export type WallpaperKind = Extract<AssetKind, 'image' | 'animated' | 'video'>;
export const isMoving = (kind: AssetKind | undefined): kind is 'animated' | 'video' => kind === 'animated' || kind === 'video';

/** Whether `asset` is a wallpaper of a type this version draws. */
export function isWallpaperAsset(asset: Pick<AssetMeta, 'kind' | 'mime'> | undefined): boolean {
  if (asset?.kind === 'image') return isWallpaperMime(asset.mime);
  if (asset?.kind === 'animated') return (ANIMATED_MIME as readonly string[]).includes(asset.mime);
  if (asset?.kind === 'video') return (VIDEO_MIME as readonly string[]).includes(asset.mime);
  return false;
}

/** The blur a wallpaper of `kind` draws at: a moving one's is capped at MAX_MOVING_BLUR_PX. */
export const blurFor = (kind: AssetKind | undefined, blur: number): number => Math.min(blur, isMoving(kind) ? MAX_MOVING_BLUR_PX : MAX_BLUR_PX);

/** One panel's wallpaper as the window draws it; `span` lists every panel one spanning image covers, this one included. */
export interface PanelWallpaper {
  readonly panel: Panel;
  readonly asset: string;
  readonly fit: Fit;
  readonly dim: number;
  readonly blur: number;
  readonly span?: readonly Panel[];
}

/**
 * A panel's wallpaper as the shell draws it: the image's URL and natural size, and the dim it shows at (raised for readability).
 * A moving one carries its still frame, shown while it may not play, and whether its flash check lets it play at all.
 */
export interface ShellWallpaper extends PanelWallpaper {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly moving?: { readonly kind: 'animated' | 'video'; readonly still: string; readonly playable: boolean };
}

/** The set the window shows: the cycle's `index`, wrapped to the sets the look has. */
export const shownSet = (look: Pick<Look, 'wallpapers'> | undefined, index = 0): WallpaperSet | undefined => {
  const sets = look?.wallpapers ?? [];
  return sets.length === 0 ? undefined : sets[((index % sets.length) + sets.length) % sets.length];
};

/** Each panel's wallpaper in a set: a panel's own image wins over the spanning one. */
export function panelWallpapers(set: WallpaperSet | undefined): PanelWallpaper[] {
  if (!set) return [];
  return PANELS.flatMap((panel): PanelWallpaper[] => {
    const own = set.panels?.[panel];
    if (own) return [{ panel, asset: own.asset, fit: own.fit, dim: own.dim, blur: own.blur }];
    const span = set.span;
    if (!span?.panels.includes(panel)) return [];
    const look = set.spanLook?.[panel] ?? DEFAULT_PANEL_LOOK;
    const panels = span.panels.filter((candidate) => !set.panels?.[candidate]);
    return [{ panel, asset: span.asset, fit: span.fit, dim: look.dim, blur: look.blur, span: panels }];
  });
}

/** Every image a look's sets name, each once. */
export function wallpaperAssets(look: Pick<Look, 'wallpapers'> | undefined): string[] {
  return [...new Set((look?.wallpapers ?? []).flatMap((set) => [...(set.span ? [set.span.asset] : []), ...Object.values(set.panels ?? {}).map((p) => p!.asset)]))];
}

/** `assets` without the wallpaper images that no set of `looks` names; every other asset stays. */
export function withoutUnusedWallpapers<A extends Pick<AssetMeta, 'kind' | 'mime'>>(assets: Readonly<Record<string, A>>, looks: Readonly<Record<string, Pick<Look, 'wallpapers'> | undefined>>): Record<string, A> {
  const named = new Set(Object.values(looks).flatMap((look) => wallpaperAssets(look)));
  return Object.fromEntries(Object.entries(assets).filter(([sha, asset]) => !isWallpaperAsset(asset) || named.has(sha)));
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const decimal = (value: number): string => String(Math.round(value * 1000) / 1000);

/** The look's surface opacity in range; 1 when it sets none. */
export const surfaceOpacityOf = (look: Pick<Look, 'surfaceOpacity'> | undefined): number => clamp(look?.surfaceOpacity ?? 1, SURFACE_OPACITY_RANGE.min, SURFACE_OPACITY_RANGE.max);

/**
 * The tokens a page paints while wallpapers show: each wallpapered panel's pane token at alpha 00 of its own color, and the
 * surface alpha. `palette` holds the opaque pane tokens deriveLook gives.
 */
export function wallpaperTokens(palette: Readonly<Record<TokenName, string>>, panels: Iterable<Panel>, surfaceAlpha: number): Record<TokenName, string> {
  const out: Record<TokenName, string> = { [SURFACE_ALPHA_TOKEN]: decimal(clamp(surfaceAlpha, SURFACE_OPACITY_RANGE.min, 1)) };
  for (const panel of panels) {
    const token = PANE_TOKENS[panel];
    const color = palette[token];
    if (color !== undefined) out[token] = `${color.slice(0, 7)}00`;
  }
  return out;
}

/** Trusted cards' surface alpha: the look's, never below TRUSTED_SURFACE_FLOOR. */
export const trustedSurfaceAlpha = (surfaceAlpha: number): string => decimal(Math.max(TRUSTED_SURFACE_FLOOR, Math.min(1, surfaceAlpha)));

// What the theme renderer derives from a wallpaper, under ~/.damocles/themes/cache/<sha256>/: core writes these files and main
// reads them; app://damocles/theme-cache/<sha256>/<THUMB_FILE> serves the thumbnail.
export const CACHE_FOLDER = 'cache';
export const THUMB_FILE = 'thumb-480.webp';
export const STATS_FILE = 'stats.json';
export const PALETTE_FILE = 'palette.json';
// A moving wallpaper's first frame, shown while it is paused or blocked, and its flash check with this computer's allowance.
export const STILL_FILE = 'still.png';
export const FLASH_FILE = 'flash.json';
// A thumbnail past this is refused: 480 px WebP stays far below it.
export const MAX_THUMB_BYTES: number = 1024 * 1024;
// The still frame's longest side and its size cap: the window scales it to the moving image's placement.
export const STILL_SIDE = 1920;
export const MAX_STILL_BYTES: number = 16 * 1024 * 1024;
// Must match APP_ORIGIN in src/desktop/app-urls.ts.
const APP_ORIGIN = 'app://damocles';
/** Where a desktop page loads a wallpaper's 480 px thumbnail. */
export const thumbUrl = (sha256: string): string => `${APP_ORIGIN}/theme-cache/${sha256}/${THUMB_FILE}`;
/** Where a desktop page loads a moving wallpaper's or a character sprite's still frame. */
export const stillUrl = (sha256: string): string => `${APP_ORIGIN}/theme-cache/${sha256}/${STILL_FILE}`;
/** Where a desktop page loads a theme blob main serves. */
export const themeBlobUrl = (sha256: string): string => `${APP_ORIGIN}/theme-blob/${sha256}`;
// A screenshot main holds for ThemeRead's card is served at THEME_SHOT_URL_PREFIX plus its id.
export const THEME_SHOT_PATH = '/theme-shot/';
export const THEME_SHOT_URL_PREFIX: string = `${APP_ORIGIN}${THEME_SHOT_PATH}`;
export const THEME_SHOT_ID: RegExp = /^[0-9a-f]{32}$/;
/** Whether `url` is where a desktop page loads a screenshot main holds, and nothing else. */
export const isThemeShotUrl = (url: string): boolean => url.startsWith(THEME_SHOT_URL_PREFIX) && THEME_SHOT_ID.test(url.slice(THEME_SHOT_URL_PREFIX.length));

/**
 * A moving wallpaper's flash check, as cache/<sha256>/flash.json holds it. `allowed` is this computer's user's "Allow flashing
 * for this file", which only core writes, on the theme editor's request; no theme file or archive carries it.
 */
export interface FlashRecord {
  readonly flagged: boolean;
  readonly atMs?: number;
  readonly kind?: 'general' | 'red';
  readonly allowed?: boolean;
}

export const isFlashRecord = (value: unknown): value is FlashRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const { flagged, atMs, kind, allowed } = value as Record<string, unknown>;
  return typeof flagged === 'boolean'
    // an animated image has a frame cap and no duration cap, so no length bounds the time
    && (atMs === undefined || (typeof atMs === 'number' && Number.isSafeInteger(atMs) && atMs >= 0))
    && (kind === undefined || kind === 'general' || kind === 'red')
    && (allowed === undefined || typeof allowed === 'boolean');
};

// The flash rule a stored check ran under. A flash.json of another version is read as no check: its image stays still and is
// analysed again, and the allowance it holds is kept.
export const FLASH_CHECK_VERSION = 2;

/** A flash check as cache/<sha256>/flash.json holds it under today's rule. */
export const isStoredFlashRecord = (value: unknown): value is FlashRecord => isFlashRecord(value) && (value as { version?: unknown }).version === FLASH_CHECK_VERSION;

/** Whether a moving wallpaper may play: checked, and either not flagged or allowed on this computer. */
export const flashPlayable = (record: FlashRecord | undefined): boolean => record !== undefined && (!record.flagged || record.allowed === true);

/** The 8 colors of each look the theme renderer proposes from a wallpaper. */
export interface WallpaperPalette {
  readonly dark: LookColors;
  readonly light: LookColors;
}

const HEX6 = /^#[0-9a-f]{6}$/;
export const isWallpaperPalette = (value: unknown): value is WallpaperPalette =>
  typeof value === 'object' && value !== null
  && (['dark', 'light'] as const).every((kind) => {
    const colors = (value as Record<string, unknown>)[kind];
    return typeof colors === 'object' && colors !== null && LOOK_SEEDS.every((seed) => typeof (colors as Record<string, unknown>)[seed] === 'string' && HEX6.test((colors as Record<string, string>)[seed]!));
  });

/** A wallpaper core stored for a theme to name: its blob, its asset entry and what the renderer derived from it. */
export interface WallpaperImport {
  readonly sha256: string;
  readonly asset: AssetMeta;
  readonly stats: ImageStats;
  readonly palette: WallpaperPalette;
  // a moving wallpaper's flash check, with this computer's allowance
  readonly flash?: FlashRecord;
}

// Readability

/** An image's relative luminance (WCAG) at its 10th and 90th percentiles and its mean, from a 64x64 sample. */
export interface ImageStats {
  readonly p10: number;
  readonly p90: number;
  readonly mean: number;
}

export const isImageStats = (value: unknown): value is ImageStats =>
  typeof value === 'object' && value !== null
  && (['p10', 'p90', 'mean'] as const).every((key) => {
    const n = (value as Record<string, unknown>)[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  });

// A pixel of relative luminance `y` as the gray sRGB color of that luminance.
const grayOf = (y: number): Rgba => {
  const v = fromLinear(clamp(y, 0, 1));
  return [v, v, v, 1];
};

/** The color text sits on: the dim overlay in `dimColor` at `dim` over an image pixel of luminance `y`, composited as CSS does. */
export function dimmedBackdrop(dimColor: string, dim: number, y: number): Rgba {
  const base = parseHex(dimColor) ?? [0, 0, 0, 1];
  return over(colorMix(withAlpha(base, 1), clamp(dim, 0, 1), [0, 0, 0, 0]), grayOf(y));
}

/** The lowest contrast of `text` over the dimmed image, at its darker and its lighter percentile. */
export function contrastOverImage(text: string, dimColor: string, dim: number, stats: ImageStats): number {
  return Math.min(contrast(text, dimmedBackdrop(dimColor, dim, stats.p10)), contrast(text, dimmedBackdrop(dimColor, dim, stats.p90)));
}

// The step the raised dim searches in.
const DIM_STEP = 0.01;

/**
 * The least dim from `dim` up that keeps `text` at `min` over the image; at 1 the overlay is the pane's own color, which
 * the text reaches by derivation, so the search always ends.
 */
export function readableDim(text: string, dimColor: string, dim: number, stats: ImageStats, min: number = AA): number {
  for (let step = Math.round(clamp(dim, 0, 1) / DIM_STEP); step * DIM_STEP <= 1 + 1e-9; step++) {
    const candidate = Math.round(step * DIM_STEP * 100) / 100;
    if (contrastOverImage(text, dimColor, candidate, stats) >= min) return candidate;
  }
  return 1;
}
