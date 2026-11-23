// The .damocles-theme file (docs/themes.md "Sharing"): a zip holding theme.json, assets/<sha256>.<ext> and LICENSES/<name>.txt and
// nothing else. Reading is pure: nothing here writes a file, so no name inside an archive ever reaches the disk.
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { promisify } from 'node:util';
import { crc32, inflateRaw as inflateRawCallback } from 'node:zlib';
import { Deflate, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import { MAX_FONT_BYTES, sniffFont } from '../../shared/themes/fonts';
import { MAX_THEME_ASSETS } from '../../shared/themes/limits';
import { MAX_MOVING_BYTES } from '../../shared/themes/wallpapers';
import { l, verbatim } from '../l10n';
import { sniffAsset } from '../design/assets';
import { checkWallpaper } from './assets';
import { sniffVideo } from '../../shared/themes/video-header';
import { sha256Of } from './blobs';
import { FontInfoError, readFontInfo } from './font-info';
import { readSpriteHeader, SpriteHeaderError } from './sprite-header';
import { MAX_THEME_FILE_BYTES } from './store';

export const MAX_ARCHIVE_BYTES: number = 100 * 1024 * 1024;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES: number = 256 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES: number = MAX_THEME_ASSETS;
// an entry inflating to more than this many times its stored size is refused while it inflates
export const MAX_ENTRY_RATIO = 100;
export const MAX_LICENSE_BYTES: number = 256 * 1024;

export interface ArchiveLimits {
  readonly archiveBytes: number;
  readonly uncompressedBytes: number;
  readonly entries: number;
  readonly ratio: number;
}

export const ARCHIVE_LIMITS: ArchiveLimits = {
  archiveBytes: MAX_ARCHIVE_BYTES,
  uncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  entries: MAX_ARCHIVE_ENTRIES,
  ratio: MAX_ENTRY_RATIO,
};

export const THEME_ENTRY = 'theme.json';
// The asset extensions an archive may carry; each must match what its bytes sniff as.
export const ASSET_EXTENSIONS: readonly string[] = ['png', 'apng', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'mp4', 'm4v', 'webm', 'woff2', 'woff', 'ttf', 'otf', 'svg'];
const FONT_EXTENSIONS: Readonly<Record<string, string>> = { woff2: 'woff2', woff: 'woff', ttf: 'ttf', otf: 'otf' };
const ASSET_ENTRY = /^assets\/([0-9a-f]{64})\.([a-z0-9]{2,5})$/;
const LICENSE_ENTRY = /^LICENSES\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}\.txt$/;
// An entry name longer than this is refused before it is decoded; a theme file's longest name is 78 bytes.
export const MAX_ENTRY_NAME_BYTES = 1024;
const inflateRaw = promisify(inflateRawCallback);

export type ArchiveRefusal =
  | 'tooLarge' | 'notZip' | 'tooManyEntries' | 'uncompressedTooLarge' | 'ratio' | 'symlink' | 'duplicate' | 'badName'
  | 'unexpectedEntry' | 'encrypted' | 'method' | 'corrupt' | 'noTheme' | 'badTheme' | 'hashMismatch' | 'typeMismatch' | 'asset';

export class ArchiveRefusedError extends LocalizedError {
  readonly reason: ArchiveRefusal;

  constructor(reason: ArchiveRefusal, text: LocalizedText, options?: ErrorOptions) {
    super(text, options);
    this.name = 'ArchiveRefusedError';
    this.reason = reason;
  }
}

export interface ArchiveAsset {
  readonly ext: string;
  readonly bytes: Uint8Array;
}

export interface ThemeArchive {
  // theme.json parsed, not yet validated
  readonly themeJson: unknown;
  readonly assets: ReadonlyMap<string, ArchiveAsset>;
  // LICENSES/<name>.txt by name, as UTF-8 text
  readonly licenses: ReadonlyMap<string, string>;
  readonly uncompressedBytes: number;
}

const refused = (reason: ArchiveRefusal, text: LocalizedText, cause?: unknown): ArchiveRefusedError =>
  new ArchiveRefusedError(reason, text, cause === undefined ? undefined : { cause });
const megabytes = (bytes: number): string => String(Math.round(bytes / 1024 / 1024));
// A size with its unit, so a cap under 1 MB is never worded as 0 MB.
const sizeText = (bytes: number): LocalizedText => (bytes < 1024 * 1024 ? l('{0} KB', String(Math.round(bytes / 1024))) : l('{0} MB', megabytes(bytes)));
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const corrupt = (): ArchiveRefusedError => refused('corrupt', l('This file is damaged: its zip structure cannot be read.'));
const notZip = (): ArchiveRefusedError => refused('notZip', l('This file is not a zip archive.'));
// One character per byte.
const entryName = (bytes: Uint8Array, at: number, length: number): string => Buffer.from(bytes.buffer, bytes.byteOffset + at, length).toString('latin1');

interface CentralEntry {
  readonly name: string;
  readonly madeBy: number;
  readonly external: number;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

// The end of central directory record: its 22 bytes plus a comment of at most 65535 bytes end the file.
function endOfDirectory(data: DataView): number {
  const lowest = Math.max(0, data.byteLength - 22 - 0xffff);
  for (let at = data.byteLength - 22; at >= lowest; at--) {
    if (data.getUint32(at, true) === 0x06054b50) return at;
  }
  throw notZip();
}

/** Why an entry name is refused before its shape is checked: a path that could leave a folder, or a character no shape allows. */
function unsafeName(name: string): boolean {
  return name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((part) => part === '..' || part === '.')
    || /[^\x21-\x7e]/.test(name);
}

/** The central directory's entries, names as their bytes read one character per byte; sizes are bounds, never trusted. */
function directoryEntries(bytes: Uint8Array, maxEntries: number): CentralEntry[] {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) throw notZip();
  const end = endOfDirectory(data);
  const total = data.getUint16(end + 10, true);
  const directorySize = data.getUint32(end + 12, true);
  const directoryOffset = data.getUint32(end + 16, true);
  if (total === 0xffff || directoryOffset === 0xffffffff) throw refused('corrupt', l('This file uses ZIP64, which Damocles does not read.'));
  if (total > maxEntries) throw refused('tooManyEntries', l('This file holds {0} entries; Damocles reads at most {1}.', String(total), String(maxEntries)));
  if (directoryOffset + directorySize > end) throw corrupt();
  const entries: CentralEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < total; i++) {
    if (at + 46 > end || data.getUint32(at, true) !== 0x02014b50) throw corrupt();
    const nameLength = data.getUint16(at + 28, true);
    if (at + 46 + nameLength > end) throw corrupt();
    if (nameLength > MAX_ENTRY_NAME_BYTES) throw refused('badName', l('This file holds an entry whose name is longer than {0} bytes.', String(MAX_ENTRY_NAME_BYTES)));
    entries.push({
      name: entryName(bytes, at + 46, nameLength),
      madeBy: data.getUint16(at + 4, true),
      flags: data.getUint16(at + 8, true),
      method: data.getUint16(at + 10, true),
      crc: data.getUint32(at + 16, true),
      compressedSize: data.getUint32(at + 20, true),
      size: data.getUint32(at + 24, true),
      external: data.getUint32(at + 38, true),
      localOffset: data.getUint32(at + 42, true),
    });
    at += 46 + nameLength + data.getUint16(at + 30, true) + data.getUint16(at + 32, true);
  }
  return entries;
}

/** Refuses a link, a folder or another non-file entry, an encrypted one and a compression method other than stored or deflate. */
function checkEntryKind(entry: CentralEntry): void {
  const type = (entry.external >>> 16) & 0o170000;
  // a unix mode's file type sits in the upper 16 bits of the external attributes; any maker may set it
  if (type === 0o120000) throw refused('symlink', l('This file holds a symbolic link ({0}), which Damocles refuses.', verbatim(entry.name)));
  if ((entry.madeBy >> 8 === 3 && type !== 0 && type !== 0o100000) || entry.name.endsWith('/')) {
    throw refused('unexpectedEntry', l('This file holds {0}, which is not a file.', verbatim(entry.name)));
  }
  if ((entry.flags & 0x1) !== 0) throw refused('encrypted', l('This file is encrypted, which Damocles does not read.'));
  if (entry.method !== 0 && entry.method !== 8) throw refused('method', l('This file is compressed in a way Damocles does not read.'));
}

/** The entries of a theme file: each name safe, a file, one of the three shapes, and named once whatever its case. */
function checkedEntries(entries: readonly CentralEntry[]): readonly CentralEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const { name } = entry;
    if (unsafeName(name)) throw refused('badName', l('This theme file holds an entry named {0}, which could reach outside it.', verbatim(name.replace(/[^\x20-\x7e]/g, '?'))));
    checkEntryKind(entry);
    if (name !== THEME_ENTRY && !ASSET_ENTRY.test(name) && !LICENSE_ENTRY.test(name)) {
      throw refused('unexpectedEntry', l('This theme file holds {0}; a theme file holds only theme.json, assets/ and LICENSES/.', verbatim(name)));
    }
    const folded = name.toLowerCase();
    if (seen.has(folded)) throw refused('duplicate', l('This file names {0} twice.', verbatim(name)));
    seen.add(folded);
  }
  return entries;
}

/** A zip read entry by entry on demand (a VS Code .vsix): the same bounds as a theme file, its names any shape. */
export interface ZipReader {
  readonly names: readonly string[];
  // the entry's bytes, inflated within `cap`; undefined for a name the zip lacks
  read(name: string, cap: number): Promise<Uint8Array | undefined>;
  // the zip read whole as a .damocles-theme, from the directory already parsed
  themeArchive(limits?: ArchiveLimits): Promise<ThemeArchive>;
}

export function openZip(bytes: Uint8Array, limits: ArchiveLimits): ZipReader {
  if (bytes.length > limits.archiveBytes) throw refused('tooLarge', l('This file is larger than {0} MB, the most Damocles reads.', megabytes(limits.archiveBytes)));
  const entries = directoryEntries(bytes, limits.entries);
  const byName = new Map<string, CentralEntry>();
  for (const entry of entries) {
    if (byName.has(entry.name)) throw refused('duplicate', l('This file names {0} twice.', verbatim(entry.name)));
    byName.set(entry.name, entry);
  }
  let total = 0;
  return {
    names: [...byName.keys()],
    async read(name, cap) {
      const entry = byName.get(name);
      if (!entry) return undefined;
      checkEntryKind(entry);
      const content = await inflateEntry(storedBytes(bytes, entry), entry, limits, total, cap);
      total += content.length;
      return content;
    },
    themeArchive(themeLimits = ARCHIVE_LIMITS) {
      if (entries.length > themeLimits.entries) throw refused('tooManyEntries', l('This file holds {0} entries; Damocles reads at most {1}.', String(entries.length), String(themeLimits.entries)));
      return archiveOf(bytes, entries, themeLimits);
    },
  };
}

/** The entry's stored bytes, from its local header; the central directory's sizes bound the slice and nothing else. */
function storedBytes(bytes: Uint8Array, entry: CentralEntry): Uint8Array {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + 30 > bytes.length || data.getUint32(at, true) !== 0x04034b50) throw corrupt();
  const nameLength = data.getUint16(at + 26, true);
  const extraLength = data.getUint16(at + 28, true);
  const start = at + 30 + nameLength + extraLength;
  if (nameLength > MAX_ENTRY_NAME_BYTES || start > bytes.length || entryName(bytes, at + 30, nameLength) !== entry.name) throw corrupt();
  if (start + entry.compressedSize > bytes.length) throw corrupt();
  return bytes.subarray(start, start + entry.compressedSize);
}

/** The cap on one entry's inflated size by its kind: theme.json, a license, an asset (a moving wallpaper is the largest). */
function entryCap(name: string): number {
  if (name === THEME_ENTRY) return MAX_THEME_FILE_BYTES;
  if (LICENSE_ENTRY.test(name)) return MAX_LICENSE_BYTES;
  return MAX_MOVING_BYTES;
}

/**
 * Inflates one entry off the event loop, with the smallest of its kind's cap, the ratio and the archive's remaining total as
 * the inflater's hard output bound, and refuses with the bound that was passed. The declared size and the central
 * directory's CRC-32 are checked against what came out.
 */
async function inflateEntry(stored: Uint8Array, entry: CentralEntry, limits: ArchiveLimits, totalBefore: number, cap: number): Promise<Uint8Array> {
  const check = (produced: number): void => {
    if (produced > cap) throw refused('asset', l('{0} in this file is larger than {1}.', verbatim(entry.name), sizeText(cap)));
    if (produced > limits.ratio * stored.length) throw refused('ratio', l('{0} in this file inflates more than {1} times its size, which Damocles refuses.', verbatim(entry.name), String(limits.ratio)));
    if (totalBefore + produced > limits.uncompressedBytes) throw refused('uncompressedTooLarge', l('This file holds more than {0} MB once unpacked, the most Damocles reads.', megabytes(limits.uncompressedBytes)));
  };
  let content: Uint8Array;
  if (entry.method === 0) {
    check(stored.length);
    // a copy, so a kept entry does not hold the whole archive in memory
    content = stored.slice();
  } else {
    const bound = Math.min(cap, limits.ratio * stored.length, limits.uncompressedBytes - totalBefore);
    let inflated: Buffer;
    try {
      inflated = await inflateRaw(stored, { maxOutputLength: Math.max(bound, 1) });
    } catch (err) {
      // the output passed the bound: one byte more is what the three refusals are told from
      if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') check(bound + 1);
      throw refused('corrupt', l('{0} in this file cannot be unpacked.', verbatim(entry.name)), err);
    }
    check(inflated.length);
    // its own buffer: a small result may be a view of the allocation pool
    content = inflated.byteOffset === 0 && inflated.buffer.byteLength === inflated.length ? new Uint8Array(inflated.buffer) : new Uint8Array(inflated);
  }
  if (content.length !== entry.size) throw corrupt();
  if (crc32(content) !== entry.crc) throw refused('corrupt', l('{0} in this file does not match its checksum.', verbatim(entry.name)));
  return content;
}

// What sniffed bytes are called in a refusal: the format's own name, which no language translates.
const FORMAT_NAMES: Readonly<Record<string, string>> = { sfnt: 'TrueType or OpenType', ttf: 'TrueType', otf: 'OpenType', collection: 'TrueType Collection', jpeg: 'JPEG', webp: 'WebP', webm: 'WebM' };
const heldType = (sniffed: string | undefined): LocalizedText => (sniffed === undefined ? l('a file of another type') : l('a {0} file', FORMAT_NAMES[sniffed] ?? sniffed.toUpperCase()));

/** Refuses an asset whose bytes are not the type its extension names, or that fail that type's header checks and caps. */
async function checkAsset(sha256: string, ext: string, bytes: Uint8Array): Promise<void> {
  const name = `assets/${sha256}.${ext}`;
  const fontKind = FONT_EXTENSIONS[ext];
  if (fontKind !== undefined) {
    const sniffed = sniffFont(bytes);
    if (sniffed !== fontKind) throw refused('typeMismatch', l('{0} is named .{1} but holds {2}.', verbatim(name), ext, heldType(sniffed)));
    if (bytes.length > MAX_FONT_BYTES) throw refused('asset', l('{0} is larger than {1} MB, the most a theme bundles.', verbatim(name), megabytes(MAX_FONT_BYTES)));
    try {
      await readFontInfo(bytes);
    } catch (err) {
      if (err instanceof FontInfoError) throw refused('asset', l('{0} is not a font Damocles reads: {1}', verbatim(name), err.text), err);
      throw err;
    }
    return;
  }
  const sniffed = sniffVideo(bytes) ?? sniffAsset(bytes);
  if (sniffed !== SNIFFED_BY_EXTENSION[ext]) throw refused('typeMismatch', l('{0} is named .{1} but holds {2}.', verbatim(name), ext, heldType(sniffed)));
  try {
    if (ext === 'svg') readSpriteHeader(bytes);
    else checkWallpaper(bytes, name);
  } catch (err) {
    if (err instanceof SpriteHeaderError) throw refused('asset', l('{0} was refused: {1}', verbatim(name), err.text), err);
    if (err instanceof LocalizedError) throw refused('asset', l('{0} was refused: {1}', verbatim(name), err.text), err);
    throw err;
  }
}

// What the bytes of each image, video and SVG extension sniff as.
const SNIFFED_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'png', apng: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', avif: 'avif', gif: 'gif', mp4: 'mp4', m4v: 'mp4', webm: 'webm', svg: 'svg',
};

/** Every entry of a .damocles-theme file, checked whole before anything uses it; throws ArchiveRefusedError naming the first refusal. */
export async function readThemeArchive(bytes: Uint8Array, limits: ArchiveLimits = ARCHIVE_LIMITS): Promise<ThemeArchive> {
  if (bytes.length > limits.archiveBytes) throw refused('tooLarge', l('This theme file is larger than {0} MB, the most Damocles reads.', megabytes(limits.archiveBytes)));
  return archiveOf(bytes, directoryEntries(bytes, limits.entries), limits);
}

async function archiveOf(bytes: Uint8Array, listed: readonly CentralEntry[], limits: ArchiveLimits): Promise<ThemeArchive> {
  const entries = checkedEntries(listed);
  let total = 0;
  let themeJson: unknown;
  let hasTheme = false;
  const assets = new Map<string, ArchiveAsset>();
  const licenses = new Map<string, string>();
  for (const entry of entries) {
    // between entries the event loop runs: one entry's copy, hash and checksum is the longest stretch
    await tick();
    const content = await inflateEntry(storedBytes(bytes, entry), entry, limits, total, entryCap(entry.name));
    total += content.length;
    if (entry.name === THEME_ENTRY) {
      try {
        themeJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
      } catch (err) {
        throw refused('badTheme', l('theme.json in this theme file is not JSON.'), err);
      }
      hasTheme = true;
      continue;
    }
    const asset = ASSET_ENTRY.exec(entry.name);
    if (asset) {
      const [, sha256, ext] = asset as unknown as [string, string, string];
      if (!ASSET_EXTENSIONS.includes(ext)) throw refused('unexpectedEntry', l('This theme file holds {0}; .{1} is not an asset type a theme carries.', verbatim(entry.name), ext));
      if (assets.has(sha256)) throw refused('duplicate', l('This theme file holds the asset {0} twice.', sha256));
      if (sha256Of(content) !== sha256) throw refused('hashMismatch', l('{0} in this theme file does not match its SHA-256.', verbatim(entry.name)));
      await checkAsset(sha256, ext, content);
      assets.set(sha256, { ext, bytes: content });
      continue;
    }
    try {
      licenses.set(entry.name.slice('LICENSES/'.length), new TextDecoder('utf-8', { fatal: true }).decode(content));
    } catch (err) {
      throw refused('asset', l('{0} in this theme file is not UTF-8 text.', verbatim(entry.name)), err);
    }
  }
  if (!hasTheme) throw refused('noTheme', l('This theme file holds no theme.json.'));
  return { themeJson, assets, licenses, uncompressedBytes: total };
}

/** A picked file read as a .damocles-theme: its size is checked before a byte of it is read. */
export async function readThemeArchiveFile(file: string, limits: ArchiveLimits = ARCHIVE_LIMITS): Promise<ThemeArchive> {
  return readThemeArchive(await readCappedFile(file, limits.archiveBytes), limits);
}

/** A regular file's bytes, refused past `max` from its size before it is read. */
export async function readCappedFile(file: string, max: number): Promise<Uint8Array> {
  const handle = await fs.open(file, 'r');
  try {
    return await readCappedHandle(handle, file, max);
  } finally {
    await handle.close();
  }
}

/** The open file's bytes: read until its size is reached, since one read may return fewer bytes than asked. */
export async function readCappedHandle(handle: Pick<FileHandle, 'stat' | 'read'>, file: string, max: number): Promise<Uint8Array> {
  const stat = await handle.stat();
  if (!stat.isFile()) throw refused('notZip', l('{0} is not a file.', verbatim(file)));
  if (stat.size > max) throw refused('tooLarge', l('This file is larger than {0} MB, the most Damocles reads.', megabytes(max)));
  const bytes = new Uint8Array(stat.size);
  let total = 0;
  while (total < stat.size) {
    const { bytesRead } = await handle.read(bytes, total, stat.size - total, total);
    if (bytesRead === 0) throw refused('corrupt', l('{0} changed while Damocles read it.', verbatim(file)));
    total += bytesRead;
  }
  return bytes;
}

// Types already compressed are stored as they are.
const STORED_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'apng', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'mp4', 'm4v', 'webm', 'woff2', 'woff']);
// A fixed time keeps an export of the same theme byte for byte the same.
const ENTRY_TIME = new Date(Date.UTC(2020, 0, 1));

// Bytes compressed between yields to the event loop, so a large export never holds up core's other work.
const WRITE_CHUNK = 256 * 1024;

/** The size `bytes` deflate to at the level the archive uses, compressed a chunk at a time. */
async function deflatedSize(bytes: Uint8Array): Promise<number> {
  let size = 0;
  const deflater = new Deflate({ level: 9 }, (chunk) => {
    size += chunk.length;
  });
  for (let at = 0; at < bytes.length; at += WRITE_CHUNK) {
    deflater.push(bytes.subarray(at, at + WRITE_CHUNK), at + WRITE_CHUNK >= bytes.length);
    await tick();
  }
  if (bytes.length === 0) deflater.push(bytes, true);
  return size;
}

/** A .damocles-theme file of `themeText`, the assets by sha256 with their extensions, and license texts by name. */
export async function writeThemeArchive(themeText: string, assets: ReadonlyMap<string, ArchiveAsset>, licenses: ReadonlyMap<string, string> = new Map()): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const entries: Array<readonly [string, Uint8Array, boolean]> = [[THEME_ENTRY, encoder.encode(themeText), false]];
  for (const [sha256, asset] of assets) {
    if (!/^[0-9a-f]{64}$/.test(sha256) || !ASSET_EXTENSIONS.includes(asset.ext)) throw new Error(`${sha256}.${asset.ext} is not an asset entry`);
    entries.push([`assets/${sha256}.${asset.ext}`, asset.bytes, STORED_EXTENSIONS.has(asset.ext)]);
  }
  for (const [name, text] of licenses) {
    if (!LICENSE_ENTRY.test(`LICENSES/${name}`)) throw new Error(`${name} is not a license entry name`);
    entries.push([`LICENSES/${name}`, encoder.encode(text), false]);
  }
  const out: Uint8Array[] = [];
  let failed: Error | undefined;
  let ended = false;
  const zip = new Zip((err, chunk, final) => {
    if (err) failed = err;
    else out.push(chunk);
    if (final) ended = true;
  });
  for (const [name, bytes, compressed] of entries) {
    // an entry that would deflate past the import's ratio is stored instead
    const stored = compressed || (await deflatedSize(bytes)) * MAX_ENTRY_RATIO < bytes.length;
    const file = stored ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 9 });
    file.mtime = ENTRY_TIME;
    zip.add(file);
    for (let at = 0; at < bytes.length; at += WRITE_CHUNK) {
      file.push(bytes.subarray(at, at + WRITE_CHUNK), at + WRITE_CHUNK >= bytes.length);
      await tick();
    }
    if (bytes.length === 0) file.push(bytes, true);
  }
  zip.end();
  if (failed) throw failed;
  if (!ended) throw new Error('The theme file did not finish');
  const total = out.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of out) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
}
