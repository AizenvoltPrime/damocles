// What a look paints (docs/invariants.md "Desktop themes"): the one builder of the window's appearance and the drawn preview's.
// Pure: no electron, no files.
import type { RenderAppearance } from '../../../shared/themes/agent';
import { shownCharacters, type ProjectsFile, type ShownCharacterMotion, type ShownCharacters } from '../../../shared/themes/characters';
import { bundledFonts } from '../../../shared/themes/fonts';
import type { CssRegion } from '../../../shared/themes/schema';
import { SURFACE_ALPHA_TOKEN, type ThemePalette } from '../../../shared/themes/tokens';
import { stillUrl, themeBlobUrl, type FlashRecord, type ImageStats, type ShellWallpaper } from '../../../shared/themes/wallpapers';
import { APP_ORIGIN } from '../../app-urls';
import { fontFaceCss } from '../desktop-fonts';
import { characterSetOf, type ShownTheme } from './appearance';
import { opaqueBackground, pageCss, pageCustomCss, scopedThemeCss, shownPalette, trustedCss, trustedPalette, type TrustedScope } from './theme-css';
import type { NamedBlob } from './theme-blobs';
import type { RenderServed } from './theme-renderer';
import { shownWallpapers, type ShownWallpapers, type WallpaperFlags } from './wallpapers';

export const FONT_FACE_CSS: string = fontFaceCss(APP_ORIGIN);

export interface AppearanceEnv {
  // damocles.desktop.textSize in px
  readonly textSize: number;
  readonly wallpapers: WallpaperFlags;
  // the wallpaper set of the look that shows
  readonly setIndex: number;
  readonly stats: (sha256: string) => ImageStats | undefined;
  readonly flash: (sha256: string) => FlashRecord | undefined;
  // the look trusted UI takes its palette from; the shown look itself when absent
  readonly trusted?: ShownTheme;
  // the look whose character set shows and how it moves; absent: every project shows its letter
  readonly characters?: { readonly source: ShownTheme; readonly projects: ProjectsFile; readonly motion: ShownCharacterMotion };
}

export interface ShownAppearance {
  readonly palette: ThemePalette;
  // FONT_FACE_CSS and the page CSS, for the host theme style
  readonly css: string;
  readonly trusted: Readonly<Record<TrustedScope, string>>;
  // the trusted palette's --d-bg, which a trusted view paints before its page does
  readonly trustedBackground: string;
  // the custom CSS per region, sanitized here
  readonly custom: Partial<Record<CssRegion, string>>;
  readonly wallpapers?: ShownWallpapers;
  readonly characters?: ShownCharacters;
}

/** Everything `theme` paints in `env`: its palette, page and trusted CSS, custom CSS, wallpapers and characters. */
export function shownAppearance(theme: ShownTheme, env: AppearanceEnv): ShownAppearance {
  const palette = shownPalette(theme);
  const trustedLook = env.trusted ?? theme;
  const trustedLookPalette = trustedLook === theme ? palette : shownPalette(trustedLook);
  const wallpapers = shownWallpapers(theme, palette, env.wallpapers, env.stats, themeBlobUrl, env.setIndex, env.flash);
  const pagePalette = wallpapers ? { ...palette, ...wallpapers.tokens } : palette;
  const regionExtra = wallpapers ? { [SURFACE_ALPHA_TOKEN]: wallpapers.trustedAlpha } : {};
  const source = env.characters?.source;
  const characters = source && env.characters ? shownCharacters(characterSetOf(source), env.characters.projects, { url: themeBlobUrl, flash: env.flash }, env.characters.motion) : undefined;
  return {
    palette,
    css: `${FONT_FACE_CSS}\n${pageCss(theme, pagePalette, env.textSize)}`,
    trusted: {
      region: trustedCss(trustedLookPalette, trustedLook.kind, 'region', trustedLook.style, env.textSize, regionExtra),
      root: trustedCss(trustedLookPalette, trustedLook.kind, 'root', trustedLook.style, env.textSize),
    },
    trustedBackground: opaqueBackground(trustedPalette(trustedLookPalette, trustedLook.kind)),
    // forced colors and safe start show a built-in look, which has no custom CSS
    custom: theme.builtin ? {} : scopedThemeCss(theme),
    ...(wallpapers ? { wallpapers } : {}),
    ...(characters ? { characters } : {}),
  };
}

/** A wallpaper as a paused window shows it: a moving one becomes its still frame, at the size its regions place it. */
export function stillWallpaper(wallpaper: ShellWallpaper): ShellWallpaper {
  const { moving, ...rest } = wallpaper;
  return moving ? { ...rest, url: moving.still } : wallpaper;
}

/**
 * What the drawn preview of `theme` gets from its appearance `look`: the page's CSS, the trusted palette, each page's custom CSS,
 * the wallpapers as their stills and the characters; and every file it draws, which alone the render session serves.
 */
export function renderedAppearance(
  theme: ShownTheme,
  look: ShownAppearance,
  arrangement: RenderAppearance['arrangement'],
  platform: RenderAppearance['platform'],
): { readonly appearance: RenderAppearance; readonly served: RenderServed } {
  const wallpapers = look.wallpapers?.regions.map(stillWallpaper);
  const shellCss = pageCustomCss(look.custom, 'shell');
  const chatCss = pageCustomCss(look.custom, 'chat');
  const appearance: RenderAppearance = {
    kind: theme.kind,
    css: look.css,
    trustedCss: look.trusted.region,
    ...(shellCss !== undefined ? { shellCss } : {}),
    ...(chatCss !== undefined ? { chatCss } : {}),
    ...(wallpapers && wallpapers.length > 0 ? { wallpapers } : {}),
    ...(look.characters ? { characters: look.characters } : {}),
    arrangement,
    platform,
  };
  return { appearance, served: servedBy(theme, appearance) };
}

// The blobs and stills an appearance's URLs name, each with the kind and type the theme declares; a URL of any other file is
// a builder fault, so it throws.
function servedBy(theme: Pick<ShownTheme, 'style' | 'assets'>, appearance: RenderAppearance): RenderServed {
  const blobs = new Map<string, NamedBlob>(bundledFonts(theme).map((font) => [font.sha256, { kind: 'font', mime: font.mime }]));
  const stills = new Set<string>();
  const blobPrefix = themeBlobUrl('');
  const stillPrefix = `${APP_ORIGIN}/theme-cache/`;
  const add = (url: string): void => {
    const sha = url.startsWith(blobPrefix) ? url.slice(blobPrefix.length) : undefined;
    const asset = sha === undefined ? undefined : theme.assets?.[sha];
    if (sha !== undefined && (asset?.kind === 'image' || asset?.kind === 'sprite')) {
      blobs.set(sha, { kind: asset.kind, mime: asset.mime });
      return;
    }
    const still = url.startsWith(stillPrefix) ? url.slice(stillPrefix.length, stillPrefix.length + 64) : undefined;
    if (still === undefined || url !== stillUrl(still) || theme.assets?.[still] === undefined) throw new Error(`The drawn preview names a file its theme does not: ${url}`);
    stills.add(still);
  };
  for (const wallpaper of appearance.wallpapers ?? []) add(wallpaper.url);
  // the preview draws no project's pin, so the set's own characters are all it shows
  for (const view of appearance.characters?.characters ?? []) {
    // held still, a frame with a still frame draws only that (CharacterImage), never its animated image
    for (const frame of Object.values(view.states)) add(frame.strip || frame.still === undefined ? frame.url : frame.still);
  }
  return { blobs, stills };
}
