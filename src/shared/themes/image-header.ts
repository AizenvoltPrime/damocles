// An image's format, size, whether it moves and how many frames it has, read from its header alone (docs/themes.md
// "Wallpapers"): nothing here decodes pixels, so a file whose header declares more than the caps is refused before any decoder
// sees it. The caps bound what a file declares; the theme renderer's sandboxed decode checks the decoded size and frame count
// again. Pure: core checks a wallpaper with it, main a blob before it serves one, the CSS sanitizer a data: image.
import { l, englishText, type LocalizedText } from '../localized-text';
import type { WallpaperFormat } from './wallpapers';

export type ImageFormat = WallpaperFormat | 'gif';

export interface ImageHeader {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
  // APNG, animated WebP, a GIF of more than one frame and an AVIF image sequence
  readonly animated: boolean;
  // an animated PNG, WebP or GIF's frame count, as its header declares it (acTL) or its frames are listed (ANMF, GIF images)
  readonly frames?: number;
}

/** A header this module refuses: `unknown` is no PNG, JPEG, WebP, AVIF or GIF; `malformed` one whose header does not hold up. */
export class ImageHeaderError extends Error {
  readonly reason: 'unknown' | 'malformed';
  readonly text: LocalizedText;
  constructor(reason: 'unknown' | 'malformed', text: LocalizedText) {
    super(englishText(text));
    this.reason = reason;
    this.text = text;
  }
}

const malformed = (text: LocalizedText): ImageHeaderError => new ImageHeaderError('malformed', text);
const cutShort = (format: string): ImageHeaderError => malformed(l('The {0} file ends before its header does.', format));
const fourcc = (name: string): number => ((name.charCodeAt(0) << 24) | (name.charCodeAt(1) << 16) | (name.charCodeAt(2) << 8) | name.charCodeAt(3)) >>> 0;

// The chunks a PNG may hold before its first IDAT (libpng's default chunk cache), the chunks of a WebP and the boxes of one
// AVIF box: a walk stops there, whatever the file's size.
export const MAX_PNG_CHUNKS = 1000;
export const MAX_RIFF_CHUNKS = 4096;
export const MAX_AVIF_BOXES = 4096;
// The MIME Sniffing standard reads an ISO BMFF brand list within the first 1445 bytes of a file.
const FTYP_SNIFF_BYTES = 1445;

/** Bounds-checked reads of `bytes`; a read past the end refuses the file as a cut-short `format`. */
function reader(bytes: Uint8Array, format: string): { u8(at: number): number; u16(at: number, little?: boolean): number; u32(at: number, little?: boolean): number; u64(at: number): bigint } {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const within = (at: number, size: number): number => {
    if (!Number.isInteger(at) || at < 0 || at + size > bytes.length) throw cutShort(format);
    return at;
  };
  return {
    u8: (at) => data.getUint8(within(at, 1)),
    u16: (at, little = false) => data.getUint16(within(at, 2), little),
    u32: (at, little = false) => data.getUint32(within(at, 4), little),
    u64: (at) => data.getBigUint64(within(at, 8)),
  };
}

// The four bytes at `at` as one big-endian number, or -1 past the end: a chunk or box type, compared without building a string.
const tagAt = (bytes: Uint8Array, at: number): number =>
  (at >= 0 && at + 4 <= bytes.length ? ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0 : -1);

const FTYP = fourcc('ftyp');
const AVIF = fourcc('avif');
const AVIS = fourcc('avis');

/**
 * The brands the `ftyp` box at the start of an ISO BMFF file names, its major brand first, each as its four bytes' big-endian
 * number; undefined for a file that does not start with one. Reads no further than the first 1445 bytes.
 */
export function ftypBrands(bytes: Uint8Array): number[] | undefined {
  if (bytes.length < 16 || tagAt(bytes, 4) !== FTYP) return undefined;
  const end = Math.min(tagAt(bytes, 0), bytes.length, FTYP_SNIFF_BYTES);
  const brands = [tagAt(bytes, 8)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(tagAt(bytes, at));
  return brands;
}

/** Whether the file's `ftyp` box names an AVIF brand; undefined for a file that does not start with an `ftyp` box. */
export function namesAvifBrand(bytes: Uint8Array): boolean | undefined {
  return ftypBrands(bytes)?.some((brand) => brand === AVIF || brand === AVIS);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean => bytes.length >= magic.length && magic.every((byte, at) => bytes[at] === byte);

/** Whether `bytes` start as a WebP container. */
export const isWebp = (bytes: Uint8Array): boolean => tagAt(bytes, 0) === fourcc('RIFF') && tagAt(bytes, 8) === fourcc('WEBP');

/** The format `bytes` start like, by magic bytes only. */
export function sniffWallpaper(bytes: Uint8Array): ImageFormat | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, GIF87A) || startsWith(bytes, GIF89A)) return 'gif';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (isWebp(bytes)) return 'webp';
  if (namesAvifBrand(bytes) === true) return 'avif';
  return undefined;
}

function positive(width: number, height: number, format: string): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw malformed(l('The {0} header gives a size of {1} by {2} pixels.', format, String(width), String(height)));
  return { width, height };
}

const IHDR = fourcc('IHDR');
const IDAT = fourcc('IDAT');
const IEND = fourcc('IEND');
const ACTL = fourcc('acTL');

// PNG: IHDR is the first chunk; an acTL chunk before the first IDAT makes it an APNG.
function png(bytes: Uint8Array): ImageHeader {
  const read = reader(bytes, 'PNG');
  if (bytes.length < 33 || read.u32(8) !== 13 || tagAt(bytes, 12) !== IHDR) throw malformed(l('The PNG does not start with its IHDR chunk.'));
  const size = positive(read.u32(16), read.u32(20), 'PNG');
  let frames: number | undefined;
  let at = 33;
  for (let chunks = 0; ; chunks++) {
    if (chunks >= MAX_PNG_CHUNKS) throw malformed(l('The PNG holds more than {0} chunks before its image data.', String(MAX_PNG_CHUNKS)));
    const length = read.u32(at);
    const type = read.u32(at + 4);
    if (type === IDAT) break;
    if (type === ACTL) {
      if (length < 8) throw cutShort('PNG');
      frames = read.u32(at + 8);
      // APNG 1.0: a num_frames of 0 is an error
      if (frames === 0) throw malformed(l('The animated PNG declares no frames.'));
    }
    if (type === IEND) throw malformed(l('The PNG has no image data.'));
    at += 12 + length;
  }
  return { format: 'png', ...size, animated: frames !== undefined, ...(frames !== undefined ? { frames } : {}) };
}

// GIF: the logical screen's size, and one frame per image descriptor, found by walking every block to the trailer. A frame
// must lie inside the logical screen (GIF89a section 20), so the screen's size is the size any decoder works at.
function gif(bytes: Uint8Array): ImageHeader {
  const read = reader(bytes, 'GIF');
  const size = positive(read.u16(6, true), read.u16(8, true), 'GIF');
  const table = (flags: number): number => ((flags & 0x80) !== 0 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  let at = 13 + table(read.u8(10));
  let frames = 0;
  // data sub-blocks: a length byte and that many bytes, up to a zero length
  const skipSubBlocks = (): void => {
    for (;;) {
      const length = read.u8(at);
      at += 1 + length;
      if (length === 0) return;
    }
  };
  for (;;) {
    const block = read.u8(at);
    if (block === 0x3b) break;
    if (block === 0x21) {
      at += 2;
      skipSubBlocks();
    } else if (block === 0x2c) {
      if (read.u16(at + 1, true) + read.u16(at + 5, true) > size.width || read.u16(at + 3, true) + read.u16(at + 7, true) > size.height) {
        throw malformed(l('A GIF frame reaches outside the image, which the format does not allow.'));
      }
      at += 10 + table(read.u8(at + 9)) + 1;
      skipSubBlocks();
      frames++;
    } else throw malformed(l('The GIF holds a block that is no part of the format.'));
  }
  if (frames === 0) throw malformed(l('The GIF has no image.'));
  return { format: 'gif', ...size, animated: frames > 1, frames };
}

// JPEG: the first start-of-frame marker holds the size; a frame whose height a later DNL marker gives is refused.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function jpeg(bytes: Uint8Array): ImageHeader {
  const read = reader(bytes, 'JPEG');
  let at = 2;
  for (;;) {
    while (at + 1 < bytes.length && bytes[at] === 0xff && bytes[at + 1] === 0xff) at++;
    if (read.u8(at) !== 0xff) throw malformed(l('The JPEG markers are not valid.'));
    const marker = read.u8(at + 1);
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) throw malformed(l('The JPEG has no frame header before its image data.'));
    const length = read.u16(at + 2);
    if (length < 2) throw malformed(l('The JPEG markers are not valid.'));
    if (SOF.has(marker)) return { format: 'jpeg', ...positive(read.u16(at + 7), read.u16(at + 5), 'JPEG'), animated: false };
    at += 2 + length;
  }
}

const VP8X = fourcc('VP8X');
const VP8 = fourcc('VP8 ');
const VP8L = fourcc('VP8L');
const ANIM = fourcc('ANIM');
const ANMF = fourcc('ANMF');

// WebP: a simple lossy (VP8) or lossless (VP8L) file, or an extended one (VP8X) whose canvas size and animation flag it reads.
function webp(bytes: Uint8Array): ImageHeader {
  const read = reader(bytes, 'WebP');
  const chunk = tagAt(bytes, 12);
  if (chunk === VP8X) {
    const flags = read.u8(20);
    const width = 1 + (read.u16(24, true) | (read.u8(26) << 16));
    const height = 1 + (read.u16(27, true) | (read.u8(29) << 16));
    const { anim, frames } = riffAnimation(bytes);
    const animated = (flags & 0x02) !== 0 || anim;
    if (animated && frames === 0) throw malformed(l('The animated WebP has no frames.'));
    return { format: 'webp', ...positive(width, height, 'WebP'), animated, ...(animated ? { frames } : {}) };
  }
  if (chunk === VP8) {
    if (read.u8(23) !== 0x9d || read.u8(24) !== 0x01 || read.u8(25) !== 0x2a) throw malformed(l('The WebP does not start with a valid VP8, VP8L or VP8X chunk.'));
    return { format: 'webp', ...positive(read.u16(26, true) & 0x3fff, read.u16(28, true) & 0x3fff, 'WebP'), animated: false };
  }
  if (chunk === VP8L) {
    if (read.u8(20) !== 0x2f) throw malformed(l('The WebP does not start with a valid VP8, VP8L or VP8X chunk.'));
    const bits = read.u32(21, true);
    return { format: 'webp', ...positive((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 'WebP'), animated: false };
  }
  throw malformed(l('The WebP does not start with a valid VP8, VP8L or VP8X chunk.'));
}

// One pass over the file's top-level chunks: whether an ANIM chunk is among them, and how many ANMF frames.
function riffAnimation(bytes: Uint8Array): { anim: boolean; frames: number } {
  const read = reader(bytes, 'WebP');
  let anim = false;
  let frames = 0;
  let chunks = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    if (++chunks > MAX_RIFF_CHUNKS) throw malformed(l('The WebP holds more than {0} chunks.', String(MAX_RIFF_CHUNKS)));
    const type = read.u32(at);
    if (type === ANIM) anim = true;
    else if (type === ANMF) frames++;
    const size = read.u32(at + 4, true);
    at += 8 + size + (size % 2);
  }
  return { anim, frames };
}

// AVIF: an ISO BMFF file whose ftyp names avif or avis; the image's size is its ispe property, the largest one listed (an
// alpha plane or a thumbnail has its own), and avis or a moov box makes it a sequence.
interface Box { readonly type: number; readonly start: number; readonly end: number }

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const read = reader(bytes, 'AVIF');
  const outside = (): ImageHeaderError => malformed(l('An AVIF box runs past the end of its parent.'));
  const out: Box[] = [];
  for (let at = start; at + 8 <= end;) {
    let size = read.u32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) throw cutShort('AVIF');
      const large = read.u64(at + 8);
      if (large > BigInt(end - at)) throw outside();
      size = Number(large);
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw outside();
    out.push({ type: read.u32(at + 4), start: at + header, end: at + size });
    at += size;
    if (out.length > MAX_AVIF_BOXES) throw malformed(l('The AVIF holds more than {0} boxes in one place.', String(MAX_AVIF_BOXES)));
  }
  return out;
}

const META = fourcc('meta');
const IPRP = fourcc('iprp');
const IPCO = fourcc('ipco');
const ISPE = fourcc('ispe');
const MOOV = fourcc('moov');

function avif(bytes: Uint8Array): ImageHeader {
  const read = reader(bytes, 'AVIF');
  const top = boxes(bytes, 0, bytes.length);
  const child = (parent: Box | undefined, type: number, fullBox = false): Box | undefined =>
    parent === undefined ? undefined : boxes(bytes, parent.start + (fullBox ? 4 : 0), parent.end).find((box) => box.type === type);
  const meta = top.find((box) => box.type === META);
  const ipco = child(child(meta, IPRP, true), IPCO);
  const sizes = ipco === undefined ? [] : boxes(bytes, ipco.start, ipco.end).filter((box) => box.type === ISPE && box.end - box.start >= 12)
    .map((box) => ({ width: read.u32(box.start + 4), height: read.u32(box.start + 8) }));
  if (sizes.length === 0) throw malformed(l('The AVIF lists no image size.'));
  const largest = sizes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const animated = tagAt(bytes, 8) === AVIS || top.some((box) => box.type === MOOV);
  return { format: 'avif', ...positive(largest.width, largest.height, 'AVIF'), animated };
}

function header(bytes: Uint8Array): ImageHeader {
  switch (sniffWallpaper(bytes)) {
    case 'png': return png(bytes);
    case 'gif': return gif(bytes);
    case 'jpeg': return jpeg(bytes);
    case 'webp': return webp(bytes);
    case 'avif': return avif(bytes);
    default: throw new ImageHeaderError('unknown', l('The file is not a PNG, JPEG, WebP, AVIF or GIF image.'));
  }
}

/**
 * The header of a PNG, JPEG, WebP, AVIF or GIF file. Total: any bytes give a header or an ImageHeaderError, for anything else
 * or a header that does not hold up, and nothing else is thrown.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  try {
    return header(bytes);
  } catch (err) {
    if (err instanceof ImageHeaderError) throw err;
    throw malformed(l('The image\'s header is not valid.'));
  }
}
