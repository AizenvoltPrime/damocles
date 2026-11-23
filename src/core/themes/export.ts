// One .damocles-theme file of a theme (docs/themes.md "Sharing"): its looks, style, CSS, characters, arrangement and every asset it
// names, with installed fonts packed by their license. Never its origin, pins, project looks, history or flash allowances.
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import { FONT_NAME, MAX_FONT_BYTES, reservedFontName } from '../../shared/themes/fonts';
import { portableBuiltinTheme } from '../../shared/themes/portable-builtin';
import { EXPORT_LICENSE_TEXT_CHARS, THEME_ARCHIVE_EXTENSION, type ThemeExportFont, type ThemeExportFontBytes, type ThemeExportPlan } from '../../shared/themes/install';
import type { AssetMeta, FontChoice, ThemeFile } from '../../shared/themes/schema';
import { l, verbatim } from '../l10n';
import { writeThemeArchive, type ArchiveAsset } from './archive';
import { sha256Of } from './blobs';
import { FontInfoError, fontShareVerdict, readFontInfo, type FontInfo } from './font-info';
import { readImport } from './import';

// Device names Windows reserves, with or without an extension; COM and LPT take superscript digits too.
const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])$/i;
// What Windows refuses in a file name, and the bidi controls that could disguise the extension; control characters go too.
const REFUSED_CHARS = /[<>:"/\\|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const isControl = (char: string): boolean => {
  const code = char.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};
const MAX_FILE_STEM_CHARS = 100;
const THEME_LICENSE = 'theme.txt';
export const FALLBACK_FILE_STEM = 'theme';

/** The export's file name: the theme name without what Windows refuses, its trailing dots and spaces, or a reserved device name. */
export function exportFileName(name: string): string {
  let stem = [...name.replace(REFUSED_CHARS, '')].filter((char) => !isControl(char)).join('').trim();
  stem = [...stem].slice(0, MAX_FILE_STEM_CHARS).join('').replace(/[. ]+$/, '').trim();
  const first = stem.split('.')[0]!.trim();
  if (RESERVED_NAME.test(first)) stem = stem.slice(stem.indexOf('.') === -1 ? stem.length : stem.indexOf('.') + 1).replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  if (RESERVED_NAME.test(stem.split('.')[0]!.trim())) stem = '';
  return `${stem === '' ? FALLBACK_FILE_STEM : stem}.${THEME_ARCHIVE_EXTENSION}`;
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
};

export interface ExportSource {
  // the theme as its file holds it, validated
  readonly theme: ThemeFile;
  readonly builtin: boolean;
  // the bytes of an asset the theme names, from blobs or packed with a built-in example
  readAsset(sha256: string, asset: AssetMeta): Promise<Uint8Array>;
  // a built-in example's LICENSE text
  readonly licenseText?: string;
}

interface ClassifiedFont {
  readonly font: ThemeExportFont;
  // an installed font's bytes and what they say, packed when it is not refused
  readonly packed?: { readonly bytes: Uint8Array; readonly info: FontInfo };
}

const fontRefusal = (family: string, err: unknown): LocalizedText => {
  if (err instanceof FontInfoError) {
    if (err.reason === 'collection') return l('{0} is a font collection, which a theme cannot bundle.', family);
    if (err.reason === 'tooLarge') return l('{0} is larger than {1} MB, the most a theme bundles.', family, String(MAX_FONT_BYTES / 1024 / 1024));
    return l('{0} could not be read as a font: {1}', family, err.text);
  }
  throw err;
};

async function classify(family: string, role: 'ui' | 'mono', source: 'bundled' | 'installed', bytes: Uint8Array): Promise<ClassifiedFont> {
  let info: FontInfo;
  try {
    info = await readFontInfo(bytes);
  } catch (err) {
    return { font: { family, role, source, verdict: 'refused', refusal: fontRefusal(family, err) } };
  }
  const { verdict, spdx } = fontShareVerdict(info);
  const licenseText = info.names.license?.slice(0, EXPORT_LICENSE_TEXT_CHARS);
  const font: ThemeExportFont = {
    family,
    role,
    source,
    verdict,
    ...(spdx !== undefined ? { spdx } : {}),
    ...(info.names.licenseUrl !== undefined ? { licenseUrl: info.names.licenseUrl.slice(0, 2048) } : {}),
    ...(licenseText !== undefined ? { licenseText } : {}),
    ...(verdict === 'refused' ? { refusal: l('{0} is marked Restricted License embedding, so it cannot be shared in a theme file.', family) } : {}),
  };
  return { font, packed: { bytes, info } };
}

/** The theme's fonts with their sharing verdicts; an installed font is classified from the bytes the overlay read, if any. */
async function classifyFonts(source: ExportSource, installed: readonly ThemeExportFontBytes[]): Promise<ClassifiedFont[]> {
  const out: ClassifiedFont[] = [];
  for (const role of ['ui', 'mono'] as const) {
    const choice: FontChoice | undefined = source.theme.style?.fonts?.[role];
    if (!choice) continue;
    if ('asset' in choice) {
      const asset = source.theme.assets?.[choice.asset];
      if (!asset) continue;
      out.push(await classify(choice.family, role, 'bundled', await source.readAsset(choice.asset, asset)));
      continue;
    }
    const given = installed.find((font) => font.family.toLowerCase() === choice.installed.toLowerCase());
    out.push(given ? await classify(choice.installed, role, 'installed', given.bytes) : { font: { family: choice.installed, role, source: 'installed', verdict: 'nameOnly' } });
  }
  return out;
}

export async function planExport(source: ExportSource, installed: readonly ThemeExportFontBytes[]): Promise<ThemeExportPlan> {
  const fonts = await classifyFonts(source, installed);
  return { themeId: source.theme.id, name: source.theme.name, fileName: exportFileName(source.theme.name), fonts: fonts.map((font) => font.font) };
}

const licenseName = (family: string, taken: ReadonlySet<string>): string => {
  const stem = family.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'font';
  let name = `${stem}.txt`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}.txt`;
  return name;
};

/**
 * The file's bytes: the theme without its origin, every asset it names without a flash check, and each installed font that may be
 * shared packed as a bundled one; a Restricted font refuses the whole export.
 */
export async function buildExport(source: ExportSource, installed: readonly ThemeExportFontBytes[]): Promise<Uint8Array> {
  const fonts = await classifyFonts(source, installed);
  const refused = fonts.find((font) => font.font.verdict === 'refused');
  if (refused) throw new LocalizedError(refused.font.refusal ?? l('{0} cannot be shared in a theme file.', refused.font.family));
  const { origin: _origin, ...rest } = source.theme;
  const portable = portableBuiltinTheme(source.theme);
  const theme: Record<string, unknown> = portable ? { ...portable, id: source.theme.id } : JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
  const metas: Record<string, AssetMeta> = {};
  const assets = new Map<string, ArchiveAsset>();
  for (const [sha256, asset] of Object.entries(source.theme.assets ?? {})) {
    const ext = EXTENSION_BY_MIME[asset.mime];
    if (ext === undefined) throw new LocalizedError(l('The asset {0} has the type {1}, which a theme file does not carry.', sha256, verbatim(asset.mime)));
    const bytes = await source.readAsset(sha256, asset);
    if (sha256Of(bytes) !== sha256) throw new LocalizedError(l('The asset {0} changed on disk, so the theme was not exported.', sha256));
    const { flash: _flash, ...meta } = asset;
    metas[sha256] = meta;
    assets.set(sha256, { ext, bytes });
  }
  const licenses = new Map<string, string>();
  // the theme's own license takes its name first, so a font family named Theme gets a numbered one
  const takenLicenses = new Set<string>(source.licenseText !== undefined ? [THEME_LICENSE.toLowerCase()] : []);
  const style = (theme['style'] ?? {}) as Record<string, unknown>;
  const fontsOut = { ...((style['fonts'] ?? {}) as Record<string, unknown>) };
  for (const { font, packed } of fonts) {
    if (font.source === 'installed' && packed) {
      if (!FONT_NAME.test(font.family) || reservedFontName(font.family)) throw new LocalizedError(l('{0} cannot be a theme font name.', font.family));
      const sha256 = sha256Of(packed.bytes);
      const ext = EXTENSION_BY_MIME[packed.info.mime]!;
      metas[sha256] = {
        kind: 'font', mime: packed.info.mime, bytes: packed.bytes.length, family: font.family,
        license: { ...(font.spdx !== undefined ? { spdx: font.spdx } : {}), ...(font.licenseText !== undefined ? { text: font.licenseText } : {}), ...(font.licenseUrl !== undefined ? { source: font.licenseUrl } : {}) },
      };
      assets.set(sha256, { ext, bytes: packed.bytes });
      fontsOut[font.role] = { asset: sha256, family: font.family };
    }
    const text = packed?.info.names.license;
    if (text !== undefined && font.source === 'installed') {
      const name = licenseName(font.family, takenLicenses);
      takenLicenses.add(name.toLowerCase());
      licenses.set(name, text);
    }
  }
  if (Object.keys(fontsOut).length > 0) theme['style'] = { ...style, fonts: fontsOut };
  if (Object.keys(metas).length > 0) theme['assets'] = metas;
  if (source.licenseText !== undefined) licenses.set(THEME_LICENSE, source.licenseText);
  const bytes = await writeThemeArchive(`${JSON.stringify(theme, null, 2)}\n`, assets, licenses);
  // a file the import would refuse is never written: it is read back as an import reads it
  try {
    await readImport(bytes, exportFileName(source.theme.name), randomUUID());
  } catch (err) {
    if (err instanceof LocalizedError) throw new LocalizedError(l('The theme was not exported, since Damocles would not be able to import the file: {0}', err.text), { cause: err });
    throw err;
  }
  return bytes;
}

/** Refuses a save path that is not absolute; main's save dialog gives one. */
export function checkExportPath(file: string): void {
  if (!path.isAbsolute(file)) throw new LocalizedError(l('The theme was not exported: {0} is not a full path.', verbatim(file)));
}
