// A character sprite's type, size and frame count from its header alone (docs/themes.md "Characters"), held to the sprite caps
// before anything decodes it. Pure: main reads it too, to check a blob again before it serves one.
import { englishText, l, type LocalizedText } from '../../shared/localized-text';
import { MAX_SPRITE_BYTES, MAX_SPRITE_FPS, MAX_SPRITE_PIXELS, MAX_SPRITE_SIDE, SVG_MIME, svgHeader } from '../../shared/themes/characters';
import { MAX_ANIMATION_FRAMES } from '../../shared/themes/wallpapers';
import { ImageHeaderError, readImageHeader } from '../../shared/themes/image-header';

export type SpriteFormat = 'png' | 'gif' | 'webp' | 'svg';
export const SPRITE_FORMAT_MIME: Readonly<Record<SpriteFormat, string>> = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: SVG_MIME };

export interface SpriteHeader {
  readonly format: SpriteFormat;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  // an animated PNG, GIF or WebP's frame count; absent for a still image
  readonly frames?: number;
}

export type SpriteRefusal =
  | { readonly reason: 'unknown' }
  | { readonly reason: 'malformed'; readonly detail: LocalizedText }
  | { readonly reason: 'tooLarge' }
  | { readonly reason: 'tooWide'; readonly width: number; readonly height: number }
  | { readonly reason: 'tooManyFrames'; readonly frames: number }
  | { readonly reason: 'animatedStrip' }
  | { readonly reason: 'uneven'; readonly width: number; readonly frames: number };

function refusalText(why: SpriteRefusal): LocalizedText {
  switch (why.reason) {
    case 'unknown': return l('A character sprite is a PNG, GIF, WebP or SVG image.');
    case 'tooLarge': return l('This image is larger than {0} KB, the most a character sprite may be.', String(MAX_SPRITE_BYTES / 1024));
    case 'tooWide': return l('This sprite is {0} by {1} pixels; a character frame may be at most {2} pixels on a side.', String(why.width), String(why.height), String(MAX_SPRITE_SIDE));
    case 'tooManyFrames': return l('This image has {0} frames; a character sprite may have at most {1}.', String(why.frames), String(MAX_ANIMATION_FRAMES));
    case 'animatedStrip': return l('A sprite strip is one still image; this one is animated already.');
    case 'uneven': return l('This image is {0} pixels wide, which does not cut into {1} equal frames.', String(why.width), String(why.frames));
    case 'malformed': return l('This sprite could not be read: {0}', why.detail);
  }
}

export class SpriteHeaderError extends Error {
  readonly refusal: SpriteRefusal;
  readonly text: LocalizedText;
  constructor(refusal: SpriteRefusal) {
    const text = refusalText(refusal);
    super(englishText(text));
    this.refusal = refusal;
    this.text = text;
  }
}

const looksLikeText = (bytes: Uint8Array): boolean => {
  const first = bytes.findIndex((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0xef && byte !== 0xbb && byte !== 0xbf);
  return first >= 0 && bytes[first] === 0x3c;
};

/** The header of a PNG, GIF, WebP or SVG sprite; throws SpriteHeaderError for anything else or a header that does not hold up. */
export function readSpriteHeader(bytes: Uint8Array): SpriteHeader {
  if (bytes.length > MAX_SPRITE_BYTES) throw new SpriteHeaderError({ reason: 'tooLarge' });
  if (looksLikeText(bytes)) {
    const svg = svgHeader(bytes);
    if ('refused' in svg) throw new SpriteHeaderError({ reason: 'malformed', detail: svg.refused });
    return { format: 'svg', mime: SVG_MIME, width: svg.width, height: svg.height };
  }
  let header;
  try {
    header = readImageHeader(bytes);
  } catch (err) {
    if (!(err instanceof ImageHeaderError)) throw err;
    throw new SpriteHeaderError(err.reason === 'unknown' ? { reason: 'unknown' } : { reason: 'malformed', detail: err.text });
  }
  if (header.format !== 'png' && header.format !== 'gif' && header.format !== 'webp') throw new SpriteHeaderError({ reason: 'unknown' });
  const moving = header.animated || header.format === 'gif';
  const frames = moving ? header.frames ?? 1 : undefined;
  return { format: header.format, mime: SPRITE_FORMAT_MIME[header.format], width: header.width, height: header.height, ...(frames !== undefined && frames > 1 ? { frames } : {}) };
}

/** A strip's geometry from the frame count the image is cut into. */
export interface StripCut {
  readonly frames: number;
  readonly fps: number;
}

/**
 * Throws SpriteHeaderError when `header` passes a cap: as one image, or cut into `strip`'s frames side by side. A strip of any
 * cut, one frame included, is a still image.
 */
export function checkSpriteCaps(header: SpriteHeader, strip?: StripCut): void {
  if ((header.frames ?? 1) > MAX_ANIMATION_FRAMES) throw new SpriteHeaderError({ reason: 'tooManyFrames', frames: header.frames ?? 1 });
  if (strip !== undefined && header.frames !== undefined) throw new SpriteHeaderError({ reason: 'animatedStrip' });
  if (strip === undefined || strip.frames === 1) {
    if (header.width > MAX_SPRITE_SIDE || header.height > MAX_SPRITE_SIDE) throw new SpriteHeaderError({ reason: 'tooWide', width: header.width, height: header.height });
    return;
  }
  if (!Number.isInteger(strip.frames) || strip.frames < 1 || header.width % strip.frames !== 0) throw new SpriteHeaderError({ reason: 'uneven', width: header.width, frames: strip.frames });
  if (!Number.isFinite(strip.fps) || strip.fps < 1 || strip.fps > MAX_SPRITE_FPS) throw new SpriteHeaderError({ reason: 'malformed', detail: l('A strip steps 1 to {0} times a second.', String(MAX_SPRITE_FPS)) });
  const frameWidth = header.width / strip.frames;
  if (frameWidth > MAX_SPRITE_SIDE || header.height > MAX_SPRITE_SIDE || header.width * header.height > MAX_SPRITE_PIXELS) {
    throw new SpriteHeaderError({ reason: 'tooWide', width: frameWidth, height: header.height });
  }
}

/** Whether `bytes` are the sprite `mime` declares, within the caps a still image or a strip of any cut keeps, by their header alone. */
export function isDeclaredSprite(bytes: Uint8Array, mime: string): boolean {
  try {
    const header = readSpriteHeader(bytes);
    const fits = header.height <= MAX_SPRITE_SIDE && header.width * header.height <= MAX_SPRITE_PIXELS && (header.frames ?? 1) <= MAX_ANIMATION_FRAMES;
    return fits && header.mime === mime;
  } catch (err) {
    if (err instanceof SpriteHeaderError) return false;
    throw err;
  }
}
