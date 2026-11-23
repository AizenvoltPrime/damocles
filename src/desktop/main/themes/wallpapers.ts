// Which wallpapers the window draws and how (docs/invariants.md "Desktop themes"). Pure: main runs it on every input change.
import {
  blurFor, contrastOverImage, flashPlayable, isMoving, isWallpaperAsset, panelWallpapers, readableDim, shownSet, stillUrl, surfaceOpacityOf, trustedSurfaceAlpha, wallpaperTokens,
  type FlashRecord, type ImageStats, type ShellWallpaper,
} from '../../../shared/themes/wallpapers';
import { AA } from '../../../shared/themes/contrast';
import { PANE_SURFACES, type ThemePalette, type TokenName } from '../../../shared/themes/tokens';
import type { Panel } from '../../../shared/themes/schema';
import type { ShownTheme } from './appearance';

// damocles.desktop.themes.wallpaperContrast: raise the dim until muted text reads at AA, or keep it and say so
export type WallpaperContrast = 'raiseDim' | 'warn';

export interface WallpaperFlags {
  // damocles.desktop.themes.showWallpapers
  readonly enabled: boolean;
  // app.getGPUFeatureStatus().gpu_compositing is enabled: blur and see-through views cost too much without it
  readonly gpuCompositing: boolean;
  // nativeTheme.prefersReducedTransparency: surfaces stay opaque over a wallpaper
  readonly reducedTransparency: boolean;
  readonly contrast: WallpaperContrast;
}

// Why no wallpaper shows though the look has one.
export type WallpapersOff = 'setting' | 'forcedColors' | 'gpu' | 'safeStart';

export interface ShownWallpapers {
  readonly regions: readonly ShellWallpaper[];
  // the page palette's pane tokens and surface alpha while the regions show
  readonly tokens: ThemePalette;
  // trusted cards' surface alpha
  readonly trustedAlpha: string;
  // a panel whose muted text stays below AA over its image under `warn`, with its contrast
  readonly lowContrast: ReadonlyArray<{ readonly panel: Panel; readonly ratio: number }>;
}

/** Why the shown look's wallpapers do not show, or undefined when they do (or it has none). */
export function wallpapersOff(shown: Pick<ShownTheme, 'decidedBy'>, flags: Pick<WallpaperFlags, 'enabled' | 'gpuCompositing'>): WallpapersOff | undefined {
  if (shown.decidedBy === 'forcedColors') return 'forcedColors';
  if (shown.decidedBy === 'safeStart') return 'safeStart';
  if (!flags.enabled) return 'setting';
  return flags.gpuCompositing ? undefined : 'gpu';
}

/**
 * The regions and tokens of the shown look's wallpapers, from its set `setIndex` (wrapped); undefined when none shows. `url` is
 * the blob's app:// URL; a region whose asset names no size is left out, a moving one blurs at most MAX_MOVING_BLUR_PX and plays
 * only once its flash check passed or this computer's user allowed it, and its dim is raised until muted text reaches AA when
 * `contrast` is raiseDim and the image's luminance is known.
 */
export function shownWallpapers(
  shown: Pick<ShownTheme, 'look' | 'assets' | 'decidedBy'>,
  palette: ThemePalette,
  flags: WallpaperFlags,
  stats: (sha256: string) => ImageStats | undefined,
  url: (sha256: string) => string,
  setIndex = 0,
  flash: (sha256: string) => FlashRecord | undefined = () => undefined,
): ShownWallpapers | undefined {
  if (wallpapersOff(shown, flags) !== undefined) return undefined;
  const lowContrast: { panel: Panel; ratio: number }[] = [];
  const muted = palette['--d-muted'];
  const regions = panelWallpapers(shownSet(shown.look, setIndex)).flatMap((wallpaper): ShellWallpaper[] => {
    const asset = shown.assets?.[wallpaper.asset];
    if (!isWallpaperAsset(asset) || asset?.width === undefined || asset.height === undefined) return [];
    const moving = isMoving(asset.kind) ? { kind: asset.kind, still: stillUrl(wallpaper.asset), playable: flashPlayable(flash(wallpaper.asset)) } : undefined;
    const image = stats(wallpaper.asset);
    const paneColor = palette[PANE_SURFACES[wallpaper.panel]]?.slice(0, 7);
    let dim = wallpaper.dim;
    if (image && muted && paneColor) {
      if (flags.contrast === 'raiseDim') dim = readableDim(muted, paneColor, dim, image);
      else {
        const ratio = contrastOverImage(muted, paneColor, dim, image);
        if (ratio < AA) lowContrast.push({ panel: wallpaper.panel, ratio });
      }
    }
    return [{ ...wallpaper, dim, blur: blurFor(asset.kind, wallpaper.blur), url: url(wallpaper.asset), width: asset.width, height: asset.height, ...(moving ? { moving } : {}) }];
  });
  if (regions.length === 0) return undefined;
  const alpha = flags.reducedTransparency ? 1 : surfaceOpacityOf(shown.look);
  const tokens: Record<TokenName, string> = wallpaperTokens(palette, regions.map((region) => region.panel), alpha);
  return { regions, tokens, trustedAlpha: trustedSurfaceAlpha(alpha), lowContrast };
}
