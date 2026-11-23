// A theme file from outside this computer read into a theme Damocles can stage (docs/themes.md "Sharing"): a .damocles-theme, a
// bare theme.json, or a VS Code color theme. The file's id, origin and any flash allowance are never kept: the caller gives the
// theme a new id and core writes its origin. Pure: nothing here writes a file.
import * as path from 'node:path';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import { sanitizeThemeCss, themeCssFamilies, type CssDroppedPart } from '../../shared/themes/css-sanitizer';
import { reservedFontName } from '../../shared/themes/fonts';
import { checkSchemaVersion, themeErrorText, validateTheme, type AssetMeta, type ThemeFile } from '../../shared/themes/schema';
import type { ThemeInstallFormat } from '../../shared/themes/install';
import { l, verbatim } from '../l10n';
import { openZip, readThemeArchive, type ArchiveAsset, type ThemeArchive } from './archive';
import { oneLine } from '../pi-session/untrusted-text';
import { checkWallpaper, wallpaperAsset } from './assets';
import { checkSprite, spriteAsset } from './characters';
import { FontInfoError, readFontInfo } from './font-info';
import { MAX_THEME_FILE_BYTES } from './store';
import { importVscodeThemeText, importVsix, VSIX_LIMITS } from './vscode-import';

export interface ImportedTheme {
  readonly format: ThemeInstallFormat;
  // validated under the caller's new id, no origin, custom CSS as the sanitizer keeps it
  readonly theme: ThemeFile;
  // the bytes of every asset the theme names, each checked as its kind
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly droppedCss: readonly CssDroppedPart[];
  // how many more parts the sanitizer dropped than droppedCss lists
  readonly droppedCssMore: number;
  // the custom CSS as the file held it, so a region the sanitizer dropped whole is still listed
  readonly originalCss: ThemeFile['css'];
  readonly warnings: readonly LocalizedText[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isZip = (bytes: Uint8Array): boolean => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
const MAX_UNKNOWN_LISTED = 10;

/** An asset the file declares that its bytes do not bear out; the text names the asset and why. */
class AssetRefusedError extends LocalizedError {}

const refusedAsset = (sha256: string, why: LocalizedText): AssetRefusedError => new AssetRefusedError(l('The asset {0} was refused: {1}', sha256, why));

/**
 * The one cut the character set's strips give `sha256`: every strip naming it must cut it into the same number of frames,
 * and the fastest of their rates is the one its flash check runs at.
 */
function stripOf(theme: ThemeFile, sha256: string): { readonly frames: number; readonly fps: number } | undefined {
  const strips = (theme.characters?.characters ?? []).flatMap((character) => Object.values(character.states))
    .flatMap((frame) => (frame && 'strip' in frame && frame.strip.asset === sha256 ? [frame.strip] : []));
  const [first] = strips;
  if (!first) return undefined;
  if (strips.some((strip) => strip.frames !== first.frames)) throw refusedAsset(sha256, l('the characters cut it into strips of different frame counts.'));
  return { frames: first.frames, fps: Math.max(...strips.map((strip) => strip.fps)) };
}

const KIND_NOUNS: Readonly<Record<string, LocalizedText>> = { image: l('a still image'), animated: l('an animated image'), video: l('a video') };

/** An asset entry rebuilt from its bytes as its declared kind; only its license and a font's family come from the file. */
async function checkedAsset(theme: ThemeFile, sha256: string, declared: AssetMeta, archived: ArchiveAsset): Promise<AssetMeta> {
  const { bytes, ext } = archived;
  const name = `${sha256}.${ext}`;
  const license = { license: declared.license };
  try {
    if (declared.kind === 'font') {
      const info = await readFontInfo(bytes);
      if (info.embedding === 'restricted') throw refusedAsset(sha256, l('the font forbids embedding.'));
      const family = declared.family;
      if (family !== undefined && reservedFontName(family)) throw refusedAsset(sha256, l('{0} is a name Damocles keeps for its own fonts.', family));
      return { kind: 'font', mime: info.mime, bytes: bytes.length, ...(family !== undefined ? { family } : {}), ...license };
    }
    if (declared.kind === 'sprite') {
      const strip = stripOf(theme, sha256);
      return { ...spriteAsset(bytes, checkSprite(bytes, name, strip)), ...license };
    }
    const header = checkWallpaper(bytes, name);
    if (header.kind !== declared.kind) throw refusedAsset(sha256, l('it is declared {0} but holds {1}.', KIND_NOUNS[declared.kind] ?? declared.kind, KIND_NOUNS[header.kind] ?? header.kind));
    return { ...wallpaperAsset(bytes, header), ...license };
  } catch (err) {
    if (err instanceof FontInfoError) throw refusedAsset(sha256, err.text);
    if (err instanceof LocalizedError && !(err instanceof AssetRefusedError)) throw refusedAsset(sha256, err.text);
    throw err;
  }
}

// A name as the card shows it: one line, no control or bidi characters. One that leaves nothing stays, for the format to refuse.
const cleanNameOf = (holder: Record<string, unknown>): Record<string, unknown> => {
  const name = typeof holder['name'] === 'string' ? oneLine(holder['name'], 64) : undefined;
  return name === undefined ? holder : { ...holder, name };
};

/** `json` with each one-line name the format has made one line: the theme's, its wallpaper sets', its character set's and characters'. */
function withCleanNames(json: Record<string, unknown>): Record<string, unknown> {
  const { looks, characters } = json;
  const cleanLook = (look: unknown): unknown => (isRecord(look) && Array.isArray(look['wallpapers'])
    ? { ...look, wallpapers: look['wallpapers'].map((set: unknown) => (isRecord(set) ? cleanNameOf(set) : set)) }
    : look);
  return {
    ...cleanNameOf(json),
    ...(isRecord(looks) ? { looks: Object.fromEntries(Object.entries(looks).map(([kind, look]) => [kind, cleanLook(look)])) } : {}),
    ...(isRecord(characters) ? {
      characters: {
        ...cleanNameOf(characters),
        ...(Array.isArray(characters['characters']) ? { characters: characters['characters'].map((character: unknown) => (isRecord(character) ? cleanNameOf(character) : character)) } : {}),
      },
    } : {}),
  };
}

/** theme.json from a file as a theme under `id`: its id and origin dropped before it is checked, unknown keys listed. */
function themeUnder(json: unknown, id: string, warnings: LocalizedText[]): ThemeFile {
  if (!isRecord(json)) throw new LocalizedError(l('theme.json is not a theme.'));
  const version = checkSchemaVersion(json);
  if (version.kind === 'needsNewer') throw new LocalizedError(l('This theme needs a newer Damocles (format version {0}).', String(version.version)));
  const { id: _id, origin: _origin, ...rest } = json;
  // installed under the names the card shows
  const result = validateTheme({ ...withCleanNames(rest), id });
  if (!result.ok) throw new LocalizedError(l('This theme is not valid: {0}', themeErrorText(result.errors)));
  // a flash allowance is never read from a file, and validateTheme already left it out
  const unknown = result.unknownKeys.filter((key) => !/\/flash\/allowed$/.test(key));
  if (unknown.length > 0) {
    const listed = unknown.slice(0, MAX_UNKNOWN_LISTED).join(', ') + (unknown.length > MAX_UNKNOWN_LISTED ? ', ...' : '');
    warnings.push(l('This theme has settings this version of Damocles does not know, which were left out: {0}', verbatim(listed)));
  }
  return result.theme;
}

/** The theme with its custom CSS as the sanitizer keeps it, and what it dropped. */
function sanitized(theme: ThemeFile): { readonly theme: ThemeFile; readonly dropped: readonly CssDroppedPart[]; readonly droppedMore: number } {
  if (theme.css === undefined) return { theme, dropped: [], droppedMore: 0 };
  const { kept, dropped, droppedMore } = sanitizeThemeCss(theme.css, { families: themeCssFamilies(theme) });
  const { css: _css, ...rest } = theme;
  return { theme: Object.keys(kept).length > 0 ? { ...rest, css: kept } : rest, dropped, droppedMore };
}

async function damoclesArchive(archive: ThemeArchive, id: string): Promise<ImportedTheme> {
  const warnings: LocalizedText[] = [];
  const theme = themeUnder(archive.themeJson, id, warnings);
  const assets = new Map<string, Uint8Array>();
  const metas: Record<string, AssetMeta> = {};
  for (const [sha256, declared] of Object.entries(theme.assets ?? {})) {
    const archived = archive.assets.get(sha256);
    if (!archived) throw new LocalizedError(l('This theme file names the asset {0} but does not hold it.', sha256));
    metas[sha256] = await checkedAsset(theme, sha256, declared, archived);
    assets.set(sha256, archived.bytes);
  }
  const rebuilt = validateTheme({ ...theme, ...(Object.keys(metas).length > 0 ? { assets: metas } : {}) });
  if (!rebuilt.ok) throw new LocalizedError(l('This theme is not valid: {0}', themeErrorText(rebuilt.errors)));
  const { theme: clean, dropped, droppedMore } = sanitized(rebuilt.theme);
  return { format: 'damocles', theme: clean, assets, droppedCss: dropped, droppedCssMore: droppedMore, originalCss: rebuilt.theme.css, warnings };
}

function vscodeTheme(imported: { readonly theme: Readonly<Record<string, unknown>>; readonly warnings: readonly LocalizedText[] }, id: string): ImportedTheme {
  // installed under the name the card shows, whatever the conversion took it from
  const name = typeof imported.theme['name'] === 'string' ? oneLine(imported.theme['name'], 64) : undefined;
  if (name === undefined) throw new LocalizedError(l('This VS Code theme has no name.'));
  const result = validateTheme({ ...imported.theme, name, id });
  if (!result.ok) throw new LocalizedError(l('This VS Code theme did not convert: {0}', themeErrorText(result.errors)));
  return { format: 'vscode', theme: result.theme, assets: new Map(), droppedCss: [], droppedCssMore: 0, originalCss: undefined, warnings: imported.warnings };
}

/**
 * A theme file's bytes as a theme under `id`: a zip is a .vsix when it is named so or holds extension/package.json, else a
 * .damocles-theme; text is a Damocles theme.json when it names schemaVersion, else a VS Code color theme (JSON or JSONC).
 */
export async function readImport(bytes: Uint8Array, fileName: string, id: string): Promise<ImportedTheme> {
  // a file named as a theme file is read as one, so one that is no zip is refused as such
  if (/\.damocles-theme$/i.test(fileName)) return damoclesArchive(await readThemeArchive(bytes), id);
  if (isZip(bytes)) {
    // opened once: the directory that tells a .vsix from a theme file is the one either is read from
    const zip = openZip(bytes, VSIX_LIMITS);
    const vsix = /\.vsix$/i.test(fileName) || zip.names.includes('extension/package.json');
    return vsix ? vscodeTheme(await importVsix(zip), id) : damoclesArchive(await zip.themeArchive(), id);
  }
  if (bytes.length > MAX_THEME_FILE_BYTES) throw new LocalizedError(l('This file is larger than {0} MB and is not a theme file.', String(MAX_THEME_FILE_BYTES / 1024 / 1024)));
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new LocalizedError(l('{0} is not a theme file Damocles reads: a .damocles-theme, a VS Code theme (.json) or a .vsix.', verbatim(path.basename(fileName))));
  }
  const damocles = /^\s*\{[\s\S]*"schemaVersion"\s*:/.test(text) && !/"tokenColors"\s*:/.test(text);
  if (damocles) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LocalizedError(l('{0} is not JSON.', verbatim(path.basename(fileName))));
    }
    const warnings: LocalizedText[] = [];
    const theme = themeUnder(json, id, warnings);
    if (Object.keys(theme.assets ?? {}).length > 0) throw new LocalizedError(l('This theme.json names images or fonts, which only a .damocles-theme file carries.'));
    const { theme: clean, dropped, droppedMore } = sanitized(theme);
    return { format: 'damocles', theme: clean, assets: new Map(), droppedCss: dropped, droppedCssMore: droppedMore, originalCss: theme.css, warnings };
  }
  return vscodeTheme(importVscodeThemeText(text, path.basename(fileName)), id);
}
