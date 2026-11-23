// Wallpapers a theme bundles (docs/themes.md "Wallpapers"): the type is sniffed from the bytes and the size, frames, codec and
// duration read from the header and held to the caps before anything decodes the file; decoding happens only in the theme
// renderer's sandboxed page.
import * as path from 'node:path';
import type { AssetMeta } from '../../shared/themes/schema';
import {
  MAX_ANIMATION_FRAMES, MAX_MOVING_BYTES, MAX_VIDEO_MS, MAX_VIDEO_SIZE, MAX_WALLPAPER_BYTES, MAX_WALLPAPER_PIXELS, MAX_WALLPAPER_SIDE, VIDEO_CODECS, WALLPAPER_MIME, type WallpaperKind,
} from '../../shared/themes/wallpapers';
import { LocalizedError } from '../../shared/localized-text';
import { readAssetSource, AssetRefusedError } from '../design/assets';
import { l, verbatim } from '../l10n';
import { ImageHeaderError, readImageHeader, type ImageFormat, type ImageHeader } from '../../shared/themes/image-header';
import { readVideoHeader, sniffVideo, videoCodec, VideoHeaderError, type VideoContainer } from '../../shared/themes/video-header';

// The extensions each format may carry; a file named otherwise is refused, as ImportAsset refuses one.
const EXTENSIONS: Readonly<Record<ImageFormat | VideoContainer, readonly string[]>> = {
  png: ['png', 'apng'], jpeg: ['jpg', 'jpeg'], webp: ['webp'], avif: ['avif'], gif: ['gif'], mp4: ['mp4', 'm4v'], webm: ['webm'],
};
const VIDEO_MIME: Readonly<Record<VideoContainer, string>> = { mp4: 'video/mp4', webm: 'video/webm' };
const ANIMATED_MIME: Readonly<Record<'png' | 'webp' | 'gif', string>> = { png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** A wallpaper's header as checked: its kind, the type it is served as, and what its header declares. */
export interface CheckedWallpaper {
  readonly kind: WallpaperKind;
  readonly mime: string;
  readonly format: ImageFormat | VideoContainer;
  readonly width: number;
  readonly height: number;
  readonly frames?: number;
  readonly durationMs?: number;
}

const megabytes = (bytes: number): string => String(bytes / 1024 / 1024);

function checkName(name: string | undefined, format: ImageFormat | VideoContainer): void {
  const extension = name === undefined ? '' : path.extname(name).slice(1).toLowerCase();
  if (extension !== '' && !EXTENSIONS[format].includes(extension)) throw new LocalizedError(l('This file is named .{0} but holds a {1} file.', extension, format.toUpperCase()));
}

function checkVideo(bytes: Uint8Array, name: string | undefined): CheckedWallpaper {
  let header;
  try {
    header = readVideoHeader(bytes);
  } catch (err) {
    if (!(err instanceof VideoHeaderError)) throw err;
    if (err.reason === 'unknown') throw new LocalizedError(l('This video is not an MP4 or WebM file.'));
    throw new LocalizedError(l('This video could not be read: {0}', err.text));
  }
  checkName(name, header.container);
  const unsupported = header.codecs.find((codec) => videoCodec(codec) === undefined);
  if (unsupported !== undefined) throw new LocalizedError(l('This video uses the {0} codec; a video wallpaper may use only {1}.', verbatim(unsupported || '?'), VIDEO_CODECS.join(', ')));
  if (header.width > MAX_VIDEO_SIZE.width || header.height > MAX_VIDEO_SIZE.height) {
    throw new LocalizedError(l('This video is {0} by {1} pixels; a video wallpaper may be at most {2} by {3}.', String(header.width), String(header.height), String(MAX_VIDEO_SIZE.width), String(MAX_VIDEO_SIZE.height)));
  }
  if (header.durationMs > MAX_VIDEO_MS) throw new LocalizedError(l('This video lasts {0} seconds; a video wallpaper may last at most {1}.', String(Math.round(header.durationMs / 100) / 10), String(MAX_VIDEO_MS / 1000)));
  return { kind: 'video', mime: VIDEO_MIME[header.container], format: header.container, width: header.width, height: header.height, durationMs: header.durationMs };
}

function checkImage(bytes: Uint8Array, name: string | undefined): CheckedWallpaper {
  let header: ImageHeader;
  try {
    header = readImageHeader(bytes);
  } catch (err) {
    if (!(err instanceof ImageHeaderError)) throw err;
    if (err.reason === 'unknown') throw new LocalizedError(l('This file is not a PNG, JPEG, WebP, AVIF or GIF image, or an MP4 or WebM video.'));
    throw new LocalizedError(l('This image could not be read: {0}', err.text));
  }
  checkName(name, header.format);
  const moving = header.animated || header.format === 'gif';
  if (moving && header.format === 'avif') throw new LocalizedError(l('This AVIF is an image sequence; a moving wallpaper is a GIF, an animated WebP or PNG, or an MP4 or WebM video.'));
  if (moving && (header.frames ?? 0) > MAX_ANIMATION_FRAMES) throw new LocalizedError(l('This image has {0} frames; a moving wallpaper may have at most {1}.', String(header.frames), String(MAX_ANIMATION_FRAMES)));
  if (!moving && bytes.length > MAX_WALLPAPER_BYTES) throw new LocalizedError(l('This image is larger than {0} MB, the most a wallpaper may be.', megabytes(MAX_WALLPAPER_BYTES)));
  if (header.width > MAX_WALLPAPER_SIDE || header.height > MAX_WALLPAPER_SIDE) {
    throw new LocalizedError(l('This image is {0} by {1} pixels; a wallpaper may be at most {2} pixels on a side.', String(header.width), String(header.height), String(MAX_WALLPAPER_SIDE)));
  }
  if (header.width * header.height > MAX_WALLPAPER_PIXELS) {
    throw new LocalizedError(l('This image has {0} megapixels; a wallpaper may have at most {1}.', String(Math.round((header.width * header.height) / 100_000) / 10), String(MAX_WALLPAPER_PIXELS / 1_000_000)));
  }
  if (moving) {
    const format = header.format as 'png' | 'webp' | 'gif';
    return { kind: 'animated', mime: ANIMATED_MIME[format], format, width: header.width, height: header.height, frames: header.frames ?? 1 };
  }
  return { kind: 'image', mime: WALLPAPER_MIME[header.format as keyof typeof WALLPAPER_MIME], format: header.format, width: header.width, height: header.height };
}

/** A wallpaper's header checked against its kind's caps; throws a LocalizedError naming what is refused. */
export function checkWallpaper(bytes: Uint8Array, name?: string): CheckedWallpaper {
  if (bytes.length > MAX_MOVING_BYTES) throw new LocalizedError(l('This file is larger than {0} MB, the most a moving wallpaper may be.', megabytes(MAX_MOVING_BYTES)));
  return sniffVideo(bytes) !== undefined ? checkVideo(bytes, name) : checkImage(bytes, name);
}

/** The asset entry of a checked wallpaper; its license is the user's to fill in. */
export function wallpaperAsset(bytes: Uint8Array, header: CheckedWallpaper): AssetMeta {
  return {
    kind: header.kind,
    mime: header.mime,
    bytes: bytes.length,
    width: header.width,
    height: header.height,
    ...(header.frames !== undefined ? { frames: header.frames } : {}),
    ...(header.durationMs !== undefined ? { durationMs: header.durationMs } : {}),
    license: {},
  };
}

/** The bytes of a file the user picked, read as ImportAsset reads one: a regular file with one link, within the moving size cap. */
export async function readWallpaperFile(file: string): Promise<Buffer> {
  try {
    return await readAssetSource(file, path.basename(file), MAX_MOVING_BYTES);
  } catch (err) {
    if (err instanceof AssetRefusedError) throw new LocalizedError(l('This file could not be read: {0}', verbatim(err.message)));
    throw err;
  }
}
