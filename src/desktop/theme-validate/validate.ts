// The community store's theme validator (docs/themes.md "Submitting a theme"): the same checks an install makes, then the theme
// renderer's jobs (flash checks, thumbnails), which host.ts runs with main's own renderer under Electron. Built for the store
// repository's CI only and never packaged with the app.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { englishText, LocalizedError } from '../../shared/localized-text';
import { characterAssets, spriteNeedsAnalysis } from '../../shared/themes/characters';
import { PANELS, type AssetMeta, type LookColors, type Panel, type ThemeFile } from '../../shared/themes/schema';
import { LOOK_KINDS, type LookKind } from '../../shared/themes/tokens';
import { isMoving, isWallpaperAsset } from '../../shared/themes/wallpapers';
import { readImport, type ImportedTheme } from '../../core/themes/import';
import { oneLine } from '../../core/pi-session/untrusted-text';
import { MAX_ENTRY_LICENSES, STORE_TEXT_LIMITS as STORE_TEXT } from '../../core/themes/store/verify';

// The store's wallpaper thumbnails are this many pixels wide; ThemeMiniature draws them in its 320 unit wide view.
export const STORE_THUMB_WIDTH = 320;
// A bundled font without an SPDX id shows its own license text in the app; the list names it so.
const CUSTOM_LICENSE = 'LicenseRef-custom';
// An installed font is named, not bundled, so it carries no license of the theme's.
const INSTALLED_FONT = 'not bundled';

export interface StoreThumbOut { readonly panel: Panel; readonly file: string; readonly sha256: string }

/** What the store's CI writes into community.json for an accepted theme, beside the submission's own fields. */
export interface StoreEntryOut {
  readonly name: string;
  readonly description?: string;
  readonly author?: string;
  readonly version?: string;
  readonly kinds: readonly LookKind[];
  readonly colors: Partial<Record<LookKind, LookColors>>;
  readonly fonts: readonly { readonly family: string; readonly license: string }[];
  readonly licenses: readonly string[];
  readonly hasCss: boolean;
  readonly hasLayout: boolean;
  readonly hasCharacters: boolean;
  readonly hasMoving: boolean;
  readonly thumbnails: Partial<Record<LookKind, readonly StoreThumbOut[]>>;
}

// A file past the archive's size cap is refused unread, so its refusal has its size and no sha256.
export type Verdict =
  | { readonly ok: true; readonly sha256: string; readonly bytes: number; readonly entry: StoreEntryOut }
  | { readonly ok: false; readonly sha256?: string; readonly bytes: number; readonly errors: readonly string[] };

/** The renderer jobs, run by the app's render page; each answer is the page's JSON text. */
export interface RenderJobs {
  analyze(sha256: string, asset: AssetMeta, bytes: Uint8Array): Promise<{ readonly flagged: boolean; readonly atMs?: number; readonly thumb: Uint8Array }>;
  sprite(sha256: string, asset: AssetMeta, bytes: Uint8Array): Promise<{ readonly flagged: boolean; readonly atMs?: number }>;
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const messageOf = (err: unknown): string => (err instanceof LocalizedError ? englishText(err.text) : err instanceof Error ? err.message : String(err));

// The id a read theme takes; the store never keeps a file's id or origin.
const READ_ID = '00000000-0000-4000-8000-000000000000';

/** The format, archive limits, every asset's hash and type, and the sanitizer, as an install reads the file. */
export async function readTheme(bytes: Uint8Array, fileName: string): Promise<{ readonly imported?: ImportedTheme; readonly errors: readonly string[] }> {
  if (!/\.damocles-theme$/i.test(fileName)) return { errors: [`${fileName} is not a .damocles-theme file`] };
  let imported: ImportedTheme;
  try {
    imported = await readImport(bytes, fileName, READ_ID);
  } catch (err) {
    return { errors: [messageOf(err)] };
  }
  const errors = imported.droppedCss.map((part) => `custom CSS in ${part.region} that the sanitizer removes (${part.reason}): ${part.text}`);
  if (imported.droppedCssMore > 0) errors.push(`${imported.droppedCssMore} more parts of custom CSS that the sanitizer removes`);
  return { imported, errors };
}

/** Licenses: the theme's own, and one for every bundled image, sprite and font. */
export function licenseErrors(theme: ThemeFile): string[] {
  const errors: string[] = [];
  if (theme.license === undefined) errors.push('the theme declares no license (Details › License)');
  for (const [sha256, asset] of Object.entries(theme.assets ?? {})) {
    const { spdx, text } = asset.license;
    if (spdx !== undefined && oneLine(spdx, STORE_TEXT.license) === undefined) errors.push(`the ${asset.kind} ${sha256} names a license that is empty once control and bidi characters are removed`);
    else if (spdx === undefined && (text === undefined || text.trim() === '')) errors.push(`the ${asset.kind} ${sha256} declares no license (an SPDX id or its license text)`);
  }
  const licenses = licensesOf(theme);
  if (licenses.length > MAX_ENTRY_LICENSES) errors.push(`the theme names ${licenses.length} licenses, more than the ${MAX_ENTRY_LICENSES} a store entry lists`);
  return errors;
}

// The theme's own license and each asset's; licenseErrors has refused any that cleans to nothing.
const licensesOf = (theme: ThemeFile): string[] =>
  [...new Set([theme.license, ...Object.values(theme.assets ?? {}).map((asset) => asset.license.spdx ?? CUSTOM_LICENSE)].flatMap((license) => {
    const clean = license === undefined ? undefined : oneLine(license, STORE_TEXT.license);
    return clean === undefined ? [] : [clean];
  }))];

/** The fonts the theme names, each with the license the list shows. */
function fontsOf(theme: ThemeFile): Array<{ family: string; license: string }> {
  return (['ui', 'mono'] as const).flatMap((role) => {
    const choice = theme.style?.fonts?.[role];
    if (!choice) return [];
    if ('installed' in choice) return [{ family: choice.installed, license: INSTALLED_FONT }];
    const spdx = theme.assets?.[choice.asset]?.license.spdx;
    return [{ family: choice.family, license: spdx ?? CUSTOM_LICENSE }];
  });
}

/** The entry's texts as the app's list parser cleans them; a text that cleans to nothing would make the app refuse the whole list. */
export function textErrors(theme: ThemeFile): string[] {
  const errors: string[] = [];
  if (oneLine(theme.name, STORE_TEXT.name) === undefined) errors.push('the name is empty once control and bidi characters are removed');
  if (theme.description !== undefined && oneLine(theme.description, STORE_TEXT.description) === undefined) errors.push('the description is empty once control and bidi characters are removed');
  if (theme.license !== undefined && oneLine(theme.license, STORE_TEXT.license) === undefined) errors.push('the license is empty once control and bidi characters are removed');
  for (const font of fontsOf(theme)) if (oneLine(font.family, STORE_TEXT.name) === undefined) errors.push('a font name is empty once control and bidi characters are removed');
  return errors;
}

/** The wallpapers of each look's first set, the one that shows, by the first panel each covers. */
export function thumbnailPlan(theme: ThemeFile): Array<{ readonly look: LookKind; readonly panel: Panel; readonly sha256: string }> {
  return LOOK_KINDS.flatMap((look) => {
    const set = theme.looks[look]?.wallpapers?.[0];
    if (!set) return [];
    const placed: Array<{ look: LookKind; panel: Panel; sha256: string }> = [];
    if (set.span) placed.push({ look, panel: set.span.panels[0]!, sha256: set.span.asset });
    for (const panel of PANELS) {
      const own = set.panels?.[panel];
      if (own) placed.push({ look, panel, sha256: own.asset });
    }
    // one set covers at most the five panels, well within the list's thumbnails per look
    return placed.filter((item, i) => placed.findIndex((other) => other.sha256 === item.sha256) === i);
  });
}

/** The whole verdict on one file: the Node checks, then the renderer jobs; thumbnails go to `writeThumb`. */
export async function validateStoreTheme(
  bytes: Uint8Array,
  fileName: string,
  render: () => Promise<RenderJobs>,
  writeThumb: (file: string, bytes: Uint8Array) => Promise<void>,
): Promise<Verdict> {
  const file = { sha256: sha256Of(bytes), bytes: bytes.length };
  const { imported, errors } = await readTheme(bytes, path.basename(fileName));
  return imported ? checkImported(imported, errors, file, render, writeThumb) : { ok: false, ...file, errors };
}

/** The verdict on a file as an install read it: its licenses and texts, then the renderer jobs of everything it shows. */
export async function checkImported(
  { theme, assets }: Pick<ImportedTheme, 'theme' | 'assets'>,
  readErrors: readonly string[],
  { sha256, bytes }: { readonly sha256: string; readonly bytes: number },
  render: () => Promise<RenderJobs>,
  writeThumb: (file: string, bytes: Uint8Array) => Promise<void>,
): Promise<Verdict> {
  const fail = (errors: readonly string[]): Verdict => ({ ok: false, sha256, bytes, errors });
  const nodeErrors = [...readErrors, ...licenseErrors(theme), ...textErrors(theme)];
  if (nodeErrors.length > 0) return fail(nodeErrors);

  const jobs = await render();
  const errors: string[] = [];
  const thumbs = new Map<string, Uint8Array>();
  const wallpapers = new Set(LOOK_KINDS.flatMap((look) => (theme.looks[look]?.wallpapers ?? []).flatMap((set) => [...(set.span ? [set.span.asset] : []), ...Object.values(set.panels ?? {}).map((own) => own!.asset)])));
  for (const sha of wallpapers) {
    const asset = theme.assets?.[sha];
    const held = assets.get(sha);
    // an install refuses a file that lacks either, so neither is skipped here: a wallpaper nobody checked is not accepted
    if (!asset || !held || !isWallpaperAsset(asset)) {
      errors.push(`the wallpaper ${sha} is not an image or video the file holds, so it could not be analyzed`);
      continue;
    }
    try {
      const analysis = await jobs.analyze(sha, asset, held);
      if (analysis.flagged) errors.push(`the ${asset.kind} wallpaper ${sha} flashes more than 3 times in a second${analysis.atMs !== undefined ? ` from ${analysis.atMs} ms` : ''}, which the store refuses`);
      thumbs.set(sha, analysis.thumb);
    } catch (err) {
      errors.push(`the wallpaper ${sha} could not be analyzed: ${messageOf(err)}`);
    }
  }
  for (const sha of characterAssets(theme)) {
    const asset = theme.assets?.[sha];
    const held = assets.get(sha);
    if (!asset || !held) {
      errors.push(`the character sprite ${sha} is not a sprite the file holds, so it could not be checked`);
      continue;
    }
    if (!spriteNeedsAnalysis(asset)) continue;
    try {
      const checked = await jobs.sprite(sha, asset, held);
      if (checked.flagged) errors.push(`the character sprite ${sha} flashes more than 3 times in a second${checked.atMs !== undefined ? ` from ${checked.atMs} ms` : ''}, which the store refuses`);
    } catch (err) {
      errors.push(`the character sprite ${sha} could not be checked: ${messageOf(err)}`);
    }
  }
  if (errors.length > 0) return fail(errors);

  const thumbnails: Partial<Record<LookKind, StoreThumbOut[]>> = {};
  for (const { look, panel, sha256: wallpaper } of thumbnailPlan(theme)) {
    const thumb = thumbs.get(wallpaper);
    if (!thumb) continue;
    const thumbSha = sha256Of(thumb);
    const file = `${thumbSha}.webp`;
    await writeThumb(file, thumb);
    (thumbnails[look] ??= []).push({ panel, file, sha256: thumbSha });
  }
  const kinds = LOOK_KINDS.filter((look) => theme.looks[look] !== undefined);
  // textErrors and licenseErrors refused a family or a license that cleans to nothing
  const fonts = fontsOf(theme).map((font) => ({ family: oneLine(font.family, STORE_TEXT.name)!, license: oneLine(font.license, STORE_TEXT.license)! }));
  const licenses = licensesOf(theme);
  const description = theme.description !== undefined ? oneLine(theme.description, STORE_TEXT.description) : undefined;
  const author = theme.author !== undefined ? oneLine(theme.author, STORE_TEXT.author) : undefined;
  const version = theme.version !== undefined ? oneLine(theme.version, STORE_TEXT.version) : undefined;
  const entry: StoreEntryOut = {
    name: oneLine(theme.name, STORE_TEXT.name)!,
    ...(description !== undefined ? { description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(version !== undefined ? { version } : {}),
    kinds,
    colors: Object.fromEntries(kinds.map((look) => [look, theme.looks[look]!.colors])),
    fonts,
    licenses,
    hasCss: Object.keys(theme.css ?? {}).length > 0,
    hasLayout: theme.layout !== undefined,
    hasCharacters: (theme.characters?.characters.length ?? 0) > 0,
    hasMoving: [...wallpapers].some((sha) => isMoving(theme.assets?.[sha]?.kind)),
    thumbnails,
  };
  return { ok: true, sha256, bytes, entry };
}
