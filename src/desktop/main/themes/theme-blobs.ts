// A theme blob as app://damocles/theme-blob/<sha256> serves it (docs/invariants.md "Desktop host"): only one a theme, draft or
// pin main read names, only when its bytes hash to its name and sniff as the type that theme declared, and only up to its
// kind's size cap. A built-in example's wallpaper or sprite is packed with the app rather than stored under blobs/, and a copy
// of that theme names it too.
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { log } from '../../../core/logger';
import { readFile as readResource, stat as statResource } from '../../../core/resource-fs';
import type { ConfigNotices } from '../../../core/config/local-config-path';
import { createThemePathRule, type ThemePathRule } from '../../../core/themes/network-rule';
import { ImageHeaderError, isWebp, readImageHeader } from '../../../shared/themes/image-header';
import { readVideoHeader, videoCodec, VideoHeaderError } from '../../../shared/themes/video-header';
import { isDeclaredSprite, SpriteHeaderError } from '../../../core/themes/sprite-header';
import { MAX_SPRITE_BYTES } from '../../../shared/themes/characters';
import { FONT_MIME, MAX_FONT_BYTES, sniffFont } from '../../../shared/themes/fonts';
import {
  CACHE_FOLDER, FLASH_FILE, isImageStats, isStoredFlashRecord, isWallpaperPalette, MAX_ANIMATION_FRAMES, MAX_MOVING_BYTES, MAX_STILL_BYTES, MAX_THUMB_BYTES, MAX_VIDEO_MS, MAX_VIDEO_SIZE,
  MAX_WALLPAPER_BYTES, MAX_WALLPAPER_PIXELS, MAX_WALLPAPER_SIDE, PALETTE_FILE, STATS_FILE, STILL_FILE, THUMB_FILE, WALLPAPER_MIME,
  type FlashRecord, type ImageStats, type WallpaperPalette,
} from '../../../shared/themes/wallpapers';
import type { ServedBlob } from '../protocol';

// Must match BLOBS_FOLDER in src/core/themes/blobs.ts.
const BLOBS_FOLDER = 'blobs';
const SHA256 = /^[0-9a-f]{64}$/;

export interface ThemeBlob {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

// What a theme main read declares a blob to be.
export interface NamedBlob {
  readonly kind: 'font' | 'image' | 'animated' | 'video' | 'sprite';
  readonly mime: string;
}

// The files whose bytes hashed to the sha256 they were asked for as, as they were then: a file is hashed once per size and time.
const hashed = new Map<string, { readonly sha256: string; readonly size: number; readonly mtimeMs: number }>();
const MAX_HASHED = 256;

/**
 * A file within `max`; with `sha256`, only while its bytes hash to it. A packed file is the app's own, read through
 * resource-fs and never judged by the store's rule.
 */
async function readCapped(file: string, max: number, rule: ThemePathRule | 'packed', sha256?: string): Promise<Uint8Array | undefined> {
  const packed = rule === 'packed';
  try {
    if (!packed) await rule.readable(file);
    const stat = packed ? await statResource(file) : await fs.stat(file);
    if (!stat.isFile() || stat.size > max) return undefined;
    const bytes = packed ? await readResource(file) : await fs.readFile(file);
    if (sha256 === undefined) return bytes;
    const known = hashed.get(file);
    if (known?.sha256 === sha256 && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return bytes;
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      log(`[themes] the blob ${sha256} is not served: its bytes are not the ones its name is the hash of`);
      return undefined;
    }
    if (hashed.size >= MAX_HASHED) hashed.delete(hashed.keys().next().value!);
    hashed.set(file, { sha256, size: stat.size, mtimeMs: stat.mtimeMs });
    return bytes;
  } catch {
    return undefined;
  }
}

// A guard of what main serves has two answers: a header check that throws is a blob that is not the declared type, and one
// that throws anything but its own refusal is logged.
function declared(kind: string, check: () => boolean): boolean {
  try {
    return check();
  } catch (err) {
    if (!(err instanceof ImageHeaderError || err instanceof VideoHeaderError || err instanceof SpriteHeaderError)) {
      log(`[themes] a blob is not served: the header check of ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }
}

const withinSides = (width: number, height: number): boolean => width <= MAX_WALLPAPER_SIDE && height <= MAX_WALLPAPER_SIDE && width * height <= MAX_WALLPAPER_PIXELS;

/** Whether `bytes` are the still image `mime` declares, within the wallpaper caps, by their header alone. */
export function isDeclaredImage(bytes: Uint8Array, mime: string): boolean {
  return declared('a still image', () => {
    const header = readImageHeader(bytes);
    return header.format !== 'gif' && WALLPAPER_MIME[header.format] === mime && !header.animated && bytes.length <= MAX_WALLPAPER_BYTES && withinSides(header.width, header.height);
  });
}

const ANIMATED_FORMAT_MIME: Readonly<Record<string, string>> = { gif: 'image/gif', png: 'image/png', webp: 'image/webp' };

/** Whether `bytes` are the animated image `mime` declares, within the moving caps, by their header alone. */
export function isDeclaredAnimation(bytes: Uint8Array, mime: string): boolean {
  return declared('an animated image', () => {
    const header = readImageHeader(bytes);
    const moving = header.animated || header.format === 'gif';
    return moving && ANIMATED_FORMAT_MIME[header.format] === mime && (header.frames ?? 1) <= MAX_ANIMATION_FRAMES && withinSides(header.width, header.height);
  });
}

/** Whether `bytes` are the video `mime` declares, in an allowed codec and within the video caps, by their header alone. */
export function isDeclaredVideo(bytes: Uint8Array, mime: string): boolean {
  return declared('a video', () => {
    const header = readVideoHeader(bytes);
    return `video/${header.container}` === mime && header.codecs.every((codec) => videoCodec(codec) !== undefined)
      && header.width <= MAX_VIDEO_SIZE.width && header.height <= MAX_VIDEO_SIZE.height && header.durationMs <= MAX_VIDEO_MS;
  });
}

/**
 * The bytes of `sha256`, when `named` says a theme main read names it, from `<root>/blobs`, else from the built-in example
 * file `packed` names; undefined unless they hash to `sha256` and sniff as the declared type. A video read here is whole,
 * for the theme renderer's flash check; the app:// route serves one by ranges, through `openThemeBlob`.
 */
export async function readThemeBlob(root: string, sha256: string, named: (sha256: string) => NamedBlob | undefined, packed: (sha256: string) => string | undefined = () => undefined, notices?: ConfigNotices): Promise<ThemeBlob | undefined> {
  if (!SHA256.test(sha256)) return undefined;
  const theme = named(sha256);
  if (theme === undefined) return undefined;
  const { kind, mime } = theme;
  const max = kind === 'font' ? MAX_FONT_BYTES : kind === 'animated' || kind === 'video' ? MAX_MOVING_BYTES : kind === 'sprite' ? MAX_SPRITE_BYTES : MAX_WALLPAPER_BYTES;
  const stored = await readCapped(path.join(root, BLOBS_FOLDER, sha256), max, createThemePathRule(root, notices), sha256);
  const packedFile = stored === undefined ? packed(sha256) : undefined;
  const bytes = packedFile !== undefined ? await readCapped(packedFile, max, 'packed', sha256) : stored;
  if (bytes === undefined) return undefined;
  if (kind === 'image') return isDeclaredImage(bytes, mime) ? { bytes, mime } : undefined;
  if (kind === 'animated') return isDeclaredAnimation(bytes, mime) ? { bytes, mime } : undefined;
  if (kind === 'video') return isDeclaredVideo(bytes, mime) ? { bytes, mime } : undefined;
  if (kind === 'sprite') return declared('a sprite', () => isDeclaredSprite(bytes, mime)) ? { bytes, mime } : undefined;
  const font = sniffFont(bytes);
  if (font === undefined || font === 'collection' || FONT_MIME[font] !== mime) return undefined;
  return { bytes, mime };
}

const inMemory = (blob: ThemeBlob): ServedBlob => ({
  mime: blob.mime,
  size: blob.bytes.length,
  body: (start, end) => new Blob([blob.bytes.slice(start, end + 1)]).stream(),
});

// A video whose bytes and header passed, by file state: a media element reads it in many ranges, and it is read whole only once.
const checkedVideos = new Map<string, { readonly mime: string; readonly size: number; readonly mtimeMs: number }>();
const MAX_CHECKED_VIDEOS = 64;

async function openVideo(file: string, sha256: string, mime: string, rule: ThemePathRule): Promise<ServedBlob | undefined> {
  let stat;
  try {
    await rule.readable(file);
    stat = await fs.stat(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_MOVING_BYTES) return undefined;
  const known = checkedVideos.get(sha256);
  if (known?.mime !== mime || known.size !== stat.size || known.mtimeMs !== stat.mtimeMs) {
    const bytes = await readCapped(file, MAX_MOVING_BYTES, rule, sha256);
    if (!bytes || !isDeclaredVideo(bytes, mime)) return undefined;
    if (checkedVideos.size >= MAX_CHECKED_VIDEOS) checkedVideos.delete(checkedVideos.keys().next().value!);
    checkedVideos.set(sha256, { mime, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return {
    mime,
    size: stat.size,
    body: (start, end) => Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>,
  };
}

/** The blob as the app:// route serves it: a font or an image from memory, a video by byte ranges from its file. */
export async function openThemeBlob(root: string, sha256: string, named: (sha256: string) => NamedBlob | undefined, packed: (sha256: string) => string | undefined = () => undefined, notices?: ConfigNotices): Promise<ServedBlob | undefined> {
  if (!SHA256.test(sha256)) return undefined;
  const blobNamed = named(sha256);
  if (blobNamed?.kind === 'video') return openVideo(path.join(root, BLOBS_FOLDER, sha256), sha256, blobNamed.mime, createThemePathRule(root, notices));
  const blob = await readThemeBlob(root, sha256, () => blobNamed, packed, notices);
  return blob ? inMemory(blob) : undefined;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A wallpaper's thumbnail (a WebP) or a moving one's still frame (a PNG) core wrote under cache/<sha256>/, within its size cap. */
export async function readThemeThumb(root: string, sha256: string, file: string, notices?: ConfigNotices): Promise<Uint8Array | undefined> {
  if (!SHA256.test(sha256) || (file !== THUMB_FILE && file !== STILL_FILE)) return undefined;
  const bytes = await readCapped(path.join(root, CACHE_FOLDER, sha256, file), file === THUMB_FILE ? MAX_THUMB_BYTES : MAX_STILL_BYTES, createThemePathRule(root, notices));
  if (!bytes || bytes.length < 12) return undefined;
  if (file === STILL_FILE) return PNG_SIGNATURE.every((byte, at) => bytes[at] === byte) ? bytes : undefined;
  return isWebp(bytes) ? bytes : undefined;
}

// Must match STORE_FOLDER and the thumbs folder in src/core/themes/store/list.ts, and its MAX_THUMB_BYTES.
const STORE_THUMBS = ['store', 'thumbs'] as const;
const MAX_STORE_THUMB_BYTES = 512 * 1024;

/** A community store thumbnail core kept under store/thumbs/<sha256>: served only while it is a WebP whose bytes hash to its name. */
export async function readStoreThumb(root: string, sha256: string, notices?: ConfigNotices): Promise<Uint8Array | undefined> {
  if (!SHA256.test(sha256)) return undefined;
  const bytes = await readCapped(path.join(root, ...STORE_THUMBS, sha256), MAX_STORE_THUMB_BYTES, createThemePathRule(root, notices));
  if (!bytes) return undefined;
  return isWebp(bytes) && createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : undefined;
}

// The three JSON files core writes under cache/<sha256>/ hold a few numbers or 16 colors: far below this.
const MAX_CACHE_JSON_BYTES: number = 64 * 1024;

async function readCacheJson<T>(root: string, sha256: string, file: string, valid: (value: unknown) => value is T, notices: ConfigNotices | undefined): Promise<T | undefined> {
  if (!SHA256.test(sha256)) return undefined;
  const bytes = await readCapped(path.join(root, CACHE_FOLDER, sha256, file), MAX_CACHE_JSON_BYTES, createThemePathRule(root, notices));
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return valid(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A wallpaper's luminance percentiles core wrote under cache/<sha256>/; undefined before its analysis. */
export const readWallpaperStats = (root: string, sha256: string, notices?: ConfigNotices): Promise<ImageStats | undefined> => readCacheJson(root, sha256, STATS_FILE, isImageStats, notices);

/** The palette the theme renderer proposed from a wallpaper; undefined before its analysis. */
export const readWallpaperPalette = (root: string, sha256: string, notices?: ConfigNotices): Promise<WallpaperPalette | undefined> => readCacheJson(root, sha256, PALETTE_FILE, isWallpaperPalette, notices);

/** A moving wallpaper's flash check with this computer's allowance; undefined before its analysis under today's flash rule. */
export const readWallpaperFlash = (root: string, sha256: string, notices?: ConfigNotices): Promise<FlashRecord | undefined> => readCacheJson(root, sha256, FLASH_FILE, isStoredFlashRecord, notices);
