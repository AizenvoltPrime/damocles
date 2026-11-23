// The Wallpapers section's edits of a draft. Pure: each takes the draft it changes, so an import that answers late can be
// placed in the draft as it is then.
import { PANELS, type Fit, type Look, type Panel, type ThemeFile, type WallpaperSet } from '@shared/themes/schema';
import type { LookKind } from '@shared/themes/tokens';
import { DEFAULT_PANEL_LOOK, isMoving, MAX_BLUR_PX, MAX_MOVING_BLUR_PX, withoutUnusedWallpapers, type WallpaperImport } from '@shared/themes/wallpapers';

type PanelLook = { readonly dim: number; readonly blur: number };

/** The draft with `next` as its look of `kind`, and the wallpaper assets no look names dropped. */
export function withLook(draft: ThemeFile, kind: LookKind, next: Look): ThemeFile {
  const looks = { ...draft.looks, [kind]: next };
  const assets = withoutUnusedWallpapers(draft.assets ?? {}, looks);
  const theme: Record<string, unknown> = { ...draft, looks };
  if (Object.keys(assets).length > 0) theme['assets'] = assets;
  else delete theme['assets'];
  return theme as unknown as ThemeFile;
}

/** The look's sets replaced: without sets when it holds none, without a cycle below two. Undefined when the draft lacks the look. */
export function withSets(draft: ThemeFile, kind: LookKind, next: readonly WallpaperSet[], extraAssets: NonNullable<ThemeFile['assets']> = {}): ThemeFile | undefined {
  const current = draft.looks[kind];
  if (!current) return undefined;
  const rest: Record<string, unknown> = { ...current };
  delete rest['wallpapers'];
  if (next.length < 2) delete rest['cycle'];
  // the new assets go in before the unused ones are dropped, so one this change names is kept
  const withAssets = Object.keys(extraAssets).length > 0 ? { ...draft, assets: { ...draft.assets, ...extraAssets } } : draft;
  return withLook(withAssets, kind, (next.length > 0 ? { ...rest, wallpapers: [...next] } : rest) as unknown as Look);
}

/** The set at `index` replaced; one left with no image keeps only its name among other sets, and goes when it is the only set. */
export function withSet(draft: ThemeFile, kind: LookKind, index: number, next: WallpaperSet | undefined, extraAssets: NonNullable<ThemeFile['assets']> = {}): ThemeFile | undefined {
  const all = [...(draft.looks[kind]?.wallpapers ?? [])];
  const name = all[index]?.name;
  if (next) all[index] = next;
  else if (all.length > 1) all[index] = name !== undefined ? { name } : {};
  else all.splice(0, 1);
  return withSets(draft, kind, all, extraAssets);
}

/** Each of `panels` with the dim and blur it had, `change` over them; a panel new to the span starts at `fallback`. */
export function spanLookFor(panels: readonly Panel[], before: WallpaperSet['spanLook'], fallback: PanelLook, change: Partial<PanelLook> = {}): NonNullable<WallpaperSet['spanLook']> {
  return Object.fromEntries(panels.map((panel) => [panel, { ...(before?.[panel] ?? fallback), ...change }]));
}

/** Where Choose image puts its image: captured before the dialog opens, since the selection can move while it is open. */
export interface ImageDestination {
  readonly kind: LookKind;
  readonly index: number;
  // the panel that takes its own image, or the panels one image spans
  readonly at: { readonly panel: Panel } | { readonly span: readonly Panel[] };
  readonly fit: Fit;
  readonly dim: number;
  readonly blur: number;
}

/** The draft with `image` at `to`; undefined when the look or the set it was chosen for is no longer there. */
export function placeImage(draft: ThemeFile, to: ImageDestination, image: WallpaperImport): ThemeFile | undefined {
  const sets = draft.looks[to.kind]?.wallpapers ?? [];
  if (!draft.looks[to.kind] || to.index > Math.max(0, sets.length - 1)) return undefined;
  const set = sets[to.index];
  const blur = Math.min(to.blur, isMoving(image.asset.kind) ? MAX_MOVING_BLUR_PX : MAX_BLUR_PX);
  // a set that already spans an image keeps its panels' own images; a set switched from one image per panel gives them up
  const kept = { ...(set?.name !== undefined ? { name: set.name } : {}), ...(set?.span && set.panels ? { panels: set.panels } : {}) };
  const assets = { [image.sha256]: image.asset };
  if ('span' in to.at) {
    const panels = to.at.span.length > 0 ? to.at.span : PANELS;
    return withSet(draft, to.kind, to.index, { ...kept, span: { asset: image.sha256, panels: [...panels], fit: to.fit }, spanLook: spanLookFor(panels, undefined, { dim: to.dim, blur }) }, assets);
  }
  return withSet(draft, to.kind, to.index, { ...set, panels: { ...set?.panels, [to.at.panel]: { asset: image.sha256, fit: to.fit, dim: to.dim, blur } } }, assets);
}

/** The spanning image gone, the panels' own images kept. */
export function withoutSpan(set: WallpaperSet): WallpaperSet | undefined {
  const rest: Record<string, unknown> = { ...set };
  delete rest['span'];
  delete rest['spanLook'];
  return Object.keys(set.panels ?? {}).length > 0 ? (rest as WallpaperSet) : undefined;
}

export const DEFAULT_TARGET: { readonly fit: Fit } & PanelLook = { fit: 'fill', ...DEFAULT_PANEL_LOOK };
