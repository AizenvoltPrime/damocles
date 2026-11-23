// Font names, stacks and file types of a theme's fonts (docs/themes.md "Fonts"). Pure: core, main and the renderers import it.
import type { AssetMeta, FontChoice, ThemeFile } from './schema.ts';

// Must match the families of DESKTOP_FONT_FILES in src/desktop/main/desktop-fonts.ts (theme-css.test.ts).
export const BUILTIN_FONT_FAMILIES = ['Geist Variable', 'Geist Mono Variable', 'Inter Variable'] as const;
export const BUILTIN_UI_STACK = "'Geist Variable', 'Inter Variable', system-ui, sans-serif";
export const BUILTIN_MONO_STACK = "'Geist Mono Variable', ui-monospace, Menlo, monospace";

export const FONT_NAME: RegExp = /^[\p{L}\p{N} ._'&-]{1,64}$/u;
// A bundled font's family is renamed so a theme can never name or shadow a built-in family or another theme's font.
const BUNDLED_PREFIX = 'dt-';
export const MAX_FONT_BYTES: number = 10 * 1024 * 1024;
export const MAX_THEME_FONTS = 8;

export type FontRole = 'ui' | 'mono';

// A font file core stored as a blob: the theme names it as { asset: sha256, family } with `asset` in its assets.
// embedding: the file's OS/2 fsType rights; a restricted font is never stored.
export interface FontImport {
  readonly sha256: string;
  readonly family: string;
  readonly asset: AssetMeta;
  readonly embedding: 'installable' | 'previewPrint' | 'editable';
}

/** A font's declared name reduced to the characters a theme may name; undefined when nothing is left. */
export function fontNameOf(raw: string | undefined): string | undefined {
  const name = [...(raw ?? '')].filter((char) => /[\p{L}\p{N} ._'&-]/u.test(char)).join('').replace(/\s+/g, ' ').trim();
  const bounded = [...name].slice(0, 64).join('').trim();
  return bounded === '' ? undefined : bounded;
}

/** The family a bundled font is declared and used under: `dt-<first 8 hex of its sha256>-<name>`. */
export const bundledFamily = (sha256: string, name: string): string => `${BUNDLED_PREFIX}${sha256.slice(0, 8)}-${name}`;

/** A family name as a CSS string: the backslash and the apostrophe are the two characters a single-quoted string escapes. */
export const quoteFamily = (name: string): string => `'${name.replace(/[\\']/g, '\\$&')}'`;

const BLOB_KEY = /^[0-9a-f]{64}$/;
// A bundled font's family and URL are built from its asset key, so a choice counts only when the key is a blob's SHA-256.
const namesFont = (choice: FontChoice): boolean => FONT_NAME.test('installed' in choice ? choice.installed : choice.family) && ('installed' in choice || BLOB_KEY.test(choice.asset));

/** A name a theme may not give an installed font: a built-in family, or one of the bundled fonts' renamed families. */
export function reservedFontName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower.startsWith(BUNDLED_PREFIX) || BUILTIN_FONT_FAMILIES.some((family) => family.toLowerCase() === lower);
}

/** The --d-font or --d-mono stack of a theme's font choice; Damocles' own stack follows it for the glyphs it lacks. */
export function fontStack(choice: FontChoice | undefined, role: FontRole): string {
  const builtin = role === 'ui' ? BUILTIN_UI_STACK : BUILTIN_MONO_STACK;
  if (choice === undefined) return builtin;
  const family = 'installed' in choice ? choice.installed : bundledFamily(choice.asset, choice.family);
  return namesFont(choice) ? `${quoteFamily(family)}, ${builtin}` : builtin;
}

export type FontFileKind = 'woff2' | 'woff' | 'ttf' | 'otf' | 'collection';

export const FONT_MIME: Readonly<Record<Exclude<FontFileKind, 'collection'>, string>> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
};
const CSS_FORMAT: Readonly<Record<string, string>> = { 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'truetype', 'font/otf': 'opentype' };

const tag = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));

/** A font file's type from its first bytes; a WOFF or WOFF2 wrapping a collection is a collection. */
export function sniffFont(bytes: Uint8Array): FontFileKind | undefined {
  if (bytes.length < 12) return undefined;
  const signature = tag(bytes, 0);
  if (signature === 'wOF2' || signature === 'wOFF') {
    if (tag(bytes, 4) === 'ttcf') return 'collection';
    return signature === 'wOF2' ? 'woff2' : 'woff';
  }
  if (signature === 'ttcf') return 'collection';
  if (signature === 'OTTO') return 'otf';
  if (signature === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'ttf';
  return undefined;
}

export interface BundledFont {
  readonly sha256: string;
  readonly family: string;
  readonly mime: string;
}

/** The bundled fonts a theme's style uses, each once. */
export function bundledFonts(theme: Pick<ThemeFile, 'style' | 'assets'>): BundledFont[] {
  const found = new Map<string, BundledFont>();
  for (const choice of Object.values(theme.style?.fonts ?? {})) {
    if (!choice || !('asset' in choice)) continue;
    const mime = theme.assets?.[choice.asset]?.mime;
    if (mime === undefined || CSS_FORMAT[mime] === undefined || !namesFont(choice)) continue;
    const family = bundledFamily(choice.asset, choice.family);
    found.set(family, { sha256: choice.asset, family, mime });
  }
  return [...found.values()];
}

/** The @font-face rules of a theme's bundled fonts, each served from `<origin>/theme-blob/<sha256>`. */
export function fontFaceCss(theme: Pick<ThemeFile, 'style' | 'assets'>, origin: string): string {
  return bundledFonts(theme).map((font) =>
    `@font-face { font-family: ${quoteFamily(font.family)}; font-style: normal; font-display: swap; src: url(${origin}/theme-blob/${font.sha256}) format('${CSS_FORMAT[font.mime]}'); }`,
  ).join('\n');
}
