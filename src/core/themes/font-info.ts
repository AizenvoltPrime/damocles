// What a font file says about itself: its type, OS/2 fsType (embedding rights) and the names it declares (docs/themes.md
// "Fonts"). Reads sfnt (TrueType and OpenType), WOFF (zlib) and WOFF2 (brotli; the name and OS/2 tables are never
// transformed). A collection is refused: one file must be one face.
import { promisify } from 'node:util';
import { brotliDecompress as brotliDecompressCallback, inflate as inflateCallback } from 'node:zlib';
import { englishText, type LocalizedText } from '../../shared/localized-text';
import { FONT_MIME, MAX_FONT_BYTES, sniffFont, type FontFileKind } from '../../shared/themes/fonts';
import { l } from '../l10n';

export type FontKind = Exclude<FontFileKind, 'collection'>;

export interface FontNames {
  // name IDs 1, 2, 4, 6, 13 and 14
  readonly family?: string;
  readonly subfamily?: string;
  readonly fullName?: string;
  readonly postscriptName?: string;
  readonly license?: string;
  readonly licenseUrl?: string;
}

// fsType bits 1 to 3 (OpenType OS/2): restricted forbids embedding; the other values allow it at some level.
export type Embedding = 'installable' | 'restricted' | 'previewPrint' | 'editable';

export interface FontInfo {
  readonly kind: FontKind;
  readonly mime: string;
  readonly fsType: number;
  readonly embedding: Embedding;
  readonly names: FontNames;
}

export type FontRefusal = 'unknown' | 'collection' | 'malformed' | 'tooLarge';

export class FontInfoError extends Error {
  readonly reason: FontRefusal;
  readonly text: LocalizedText;
  constructor(reason: FontRefusal, text: LocalizedText) {
    super(englishText(text));
    this.reason = reason;
    this.text = text;
  }
}

// A font that unpacks to more than this is refused rather than unpacked.
export const MAX_SFNT_BYTES: number = 64 * 1024 * 1024;
const NAME_IDS: ReadonlyArray<readonly [number, keyof FontNames]> = [[1, 'family'], [2, 'subfamily'], [4, 'fullName'], [6, 'postscriptName'], [13, 'license'], [14, 'licenseUrl']];
const MAX_NAME_CHARS = 20_000;
// The only tables read, so the only ones sliced or unpacked.
const READ_TABLES: ReadonlySet<string> = new Set(['name', 'OS/2']);

const malformed = (): FontInfoError => new FontInfoError('malformed', l('The font\'s tables are not valid.'));
const tooLarge = (): FontInfoError => new FontInfoError('tooLarge', l('The font unpacks to more than {0} MB.', String(MAX_SFNT_BYTES / 1024 / 1024)));
const inflate = promisify(inflateCallback);
const brotliDecompress = promisify(brotliDecompressCallback);

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u16(data: DataView, at: number): number {
  if (at < 0 || at + 2 > data.byteLength) throw malformed();
  return data.getUint16(at);
}

function u32(data: DataView, at: number): number {
  if (at < 0 || at + 4 > data.byteLength) throw malformed();
  return data.getUint32(at);
}

const tagAt = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
const pad4 = (length: number): number => length + ((4 - (length % 4)) % 4);

function slice(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  if (offset < 0 || length < 0 || offset + length > bytes.length) throw malformed();
  return bytes.subarray(offset, offset + length);
}

type Tables = ReadonlyMap<string, Uint8Array>;

function sfntTables(bytes: Uint8Array): Tables {
  const data = view(bytes);
  const count = u16(data, 4);
  if (12 + count * 16 > bytes.length) throw malformed();
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const tag = tagAt(bytes, record);
    if (READ_TABLES.has(tag)) tables.set(tag, slice(bytes, u32(data, record + 8), u32(data, record + 12)));
  }
  return tables;
}

// The directory is held to WOFF 1.0 section 5 before anything unpacks: entries in ascending tag order (so no tag repeats), no
// two tables' data overlapping, and the padded table lengths with the sfnt header and directory equal to totalSfntSize.
async function woffTables(bytes: Uint8Array): Promise<Tables> {
  const data = view(bytes);
  const count = u16(data, 12);
  const total = u32(data, 16);
  if (total > MAX_SFNT_BYTES) throw tooLarge();
  const directoryEnd = 44 + count * 20;
  if (directoryEnd > bytes.length) throw malformed();
  const entries: Array<{ readonly tag: string; readonly offset: number; readonly stored: number; readonly length: number }> = [];
  let previous = -1;
  let sum = 12 + count * 16;
  for (let i = 0; i < count; i++) {
    const entry = 44 + i * 20;
    const order = u32(data, entry);
    if (order <= previous) throw malformed();
    previous = order;
    const [offset, stored, length] = [u32(data, entry + 4), u32(data, entry + 8), u32(data, entry + 12)];
    if (stored > length || offset < directoryEnd || offset + stored > bytes.length) throw malformed();
    sum += pad4(length);
    entries.push({ tag: tagAt(bytes, entry), offset, stored, length });
  }
  if (sum !== total) throw malformed();
  let end = directoryEnd;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset < end) throw malformed();
    end = entry.offset + entry.stored;
  }
  const tables = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (!READ_TABLES.has(entry.tag)) continue;
    const stored = bytes.subarray(entry.offset, entry.offset + entry.stored);
    const table = entry.stored === entry.length ? stored : new Uint8Array(await inflate(stored, { maxOutputLength: entry.length }));
    if (table.length !== entry.length) throw malformed();
    tables.set(entry.tag, table);
  }
  return tables;
}

// WOFF2's known table tags, by the index its directory flags carry (W3C WOFF2 5.1).
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

function base128(bytes: Uint8Array, at: { offset: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = bytes[at.offset++];
    if (byte === undefined || (i === 0 && byte === 0x80)) throw malformed();
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw malformed();
}

// The tables are one brotli stream in directory order, as long as the directory's lengths add up to; it is unpacked only
// when it holds a table that is read, and never past that length.
async function woff2Tables(bytes: Uint8Array): Promise<Tables> {
  const data = view(bytes);
  const count = u16(data, 12);
  if (u32(data, 16) > MAX_SFNT_BYTES) throw tooLarge();
  const compressed = u32(data, 20);
  const at = { offset: 48 };
  const entries: Array<{ tag: string; offset: number; length: number }> = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const flags = bytes[at.offset++];
    if (flags === undefined) throw malformed();
    const index = flags & 0x3f;
    let tag = WOFF2_TAGS[index];
    if (index === 63) {
      tag = tagAt(bytes, at.offset);
      at.offset += 4;
    }
    if (tag === undefined) throw malformed();
    const origLength = base128(bytes, at);
    const version = flags >> 6;
    // glyf and loca are transformed at version 0; every other table at any version but 0
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? base128(bytes, at) : origLength;
    entries.push({ tag, offset: total, length });
    total += length;
    if (total > MAX_SFNT_BYTES) throw tooLarge();
  }
  const packed = slice(bytes, at.offset, compressed);
  const tables = new Map<string, Uint8Array>();
  if (!entries.some((entry) => READ_TABLES.has(entry.tag))) return tables;
  const stream = new Uint8Array(await brotliDecompress(packed, { maxOutputLength: Math.max(total, 1) }));
  for (const entry of entries) if (READ_TABLES.has(entry.tag)) tables.set(entry.tag, slice(stream, entry.offset, entry.length));
  return tables;
}

// A name record's text: UTF-16BE for the Unicode and Windows platforms, one byte per character for Macintosh Roman. `raw` is
// already cut to the bytes MAX_NAME_CHARS characters take.
function decodeName(platform: number, encoding: number, raw: Uint8Array): string | undefined {
  const utf16 = platform === 0 || (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10));
  if (utf16) return Buffer.from(raw.subarray(0, raw.length - (raw.length % 2))).swap16().toString('utf16le');
  if (platform === 1 && encoding === 0) return Buffer.from(raw).toString('latin1');
  return undefined;
}

// A name record's rank: Windows English first, then any Windows, then Unicode, then Macintosh Roman.
function rank(platform: number, language: number): number {
  if (platform === 3) return language === 0x409 ? 0 : 1;
  return platform === 0 ? 2 : 3;
}

// A record is decoded only when it outranks the one already held for its name, so at most four are per name, however many
// records the table lists.
function readNames(table: Uint8Array | undefined): FontNames {
  if (!table) return {};
  const data = view(table);
  const count = u16(data, 2);
  const storage = u16(data, 4);
  if (6 + count * 12 > table.length) throw malformed();
  const best = new Map<keyof FontNames, { rank: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    const nameId = data.getUint16(record + 6);
    const key = NAME_IDS.find(([idOf]) => idOf === nameId)?.[1];
    if (!key) continue;
    const platform = data.getUint16(record);
    const r = rank(platform, data.getUint16(record + 4));
    const known = best.get(key);
    if (known && r >= known.rank) continue;
    const length = Math.min(data.getUint16(record + 8), 2 * MAX_NAME_CHARS);
    const value = decodeName(platform, data.getUint16(record + 2), slice(table, storage + data.getUint16(record + 10), length));
    if (value !== undefined) best.set(key, { rank: r, value: value.slice(0, MAX_NAME_CHARS).replace(/\0/g, '').trim() });
  }
  return Object.fromEntries([...best].filter(([, entry]) => entry.value !== '').map(([key, entry]) => [key, entry.value]));
}

// The licenses sharing packs after one confirm, by what name ID 13 (license) or 14 (license URL) says.
const SHAREABLE_LICENSES: ReadonlyArray<readonly [RegExp, string]> = [
  [/open font licen[cs]e|\bSIL OFL\b|scripts\.sil\.org\/OFL|openfontlicense\.org/i, 'OFL-1.1'],
  [/apache licen[cs]e|apache\.org\/licenses/i, 'Apache-2.0'],
  [/ubuntu font licen[cs]e|ubuntu\.com\/legal\/font/i, 'LicenseRef-Ubuntu-Font-1.0'],
];

/** The SPDX id of an OFL, Apache or Ubuntu Font Licence font, from its license text or URL; undefined for any other. */
export function shareableLicense(names: Pick<FontNames, 'license' | 'licenseUrl'>): string | undefined {
  const said = `${names.license ?? ''}\n${names.licenseUrl ?? ''}`;
  return SHAREABLE_LICENSES.find(([pattern]) => pattern.test(said))?.[1];
}

// refused: Restricted License embedding; confirm: a license that allows sharing; warn: anything else, the user's responsibility
export type FontShareVerdict = 'refused' | 'confirm' | 'warn';

/** Whether a font may go into a shared theme: Restricted License embedding never does; OFL, Apache and Ubuntu after a confirm. */
export function fontShareVerdict(info: Pick<FontInfo, 'embedding' | 'names'>): { readonly verdict: FontShareVerdict; readonly spdx?: string } {
  if (info.embedding === 'restricted') return { verdict: 'refused' };
  const spdx = shareableLicense(info.names);
  return spdx !== undefined ? { verdict: 'confirm', spdx } : { verdict: 'warn' };
}

export function embeddingOf(fsType: number): Embedding {
  if (fsType & 0x8) return 'editable';
  if (fsType & 0x4) return 'previewPrint';
  return fsType & 0x2 ? 'restricted' : 'installable';
}

/**
 * The type, embedding rights and names of one font file. Total: any bytes give the info or a FontInfoError, for a file
 * Damocles does not bundle, and nothing else is thrown.
 */
export async function readFontInfo(bytes: Uint8Array): Promise<FontInfo> {
  if (bytes.length > MAX_FONT_BYTES) throw new FontInfoError('tooLarge', l('The font file is larger than {0} MB.', String(MAX_FONT_BYTES / 1024 / 1024)));
  const kind = sniffFont(bytes);
  if (kind === undefined) throw new FontInfoError('unknown', l('The file is not a WOFF2, WOFF, TrueType or OpenType font.'));
  if (kind === 'collection') throw new FontInfoError('collection', l('The file is a font collection; a theme font is one face.'));
  try {
    const tables = kind === 'woff2' ? await woff2Tables(bytes) : kind === 'woff' ? await woffTables(bytes) : sfntTables(bytes);
    const os2 = tables.get('OS/2');
    const fsType = os2 ? u16(view(os2), 8) : 0;
    return { kind, mime: FONT_MIME[kind], fsType, embedding: embeddingOf(fsType), names: readNames(tables.get('name')) };
  } catch (err) {
    if (err instanceof FontInfoError) throw err;
    throw malformed();
  }
}
