import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BASE64_LENGTH, type ImageMediaType } from './types/content';

/** A MIME type without its parameters, lower case. */
export function mimeBaseType(mimeType: string): string {
  return mimeType.split(';', 1)[0]!.trim().toLowerCase();
}

/** The image type a label names, among the types providers take; `image/jpg` is pi's alias for `image/jpeg`. */
export function inlineImageMediaType(mimeType: string | undefined): ImageMediaType | undefined {
  if (mimeType === undefined) return undefined;
  const type = mimeBaseType(mimeType);
  if (type === 'image/jpg') return 'image/jpeg';
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type) ? (type as ImageMediaType) : undefined;
}

/** Why image data cannot go to the model as an image. */
export type InlineImageRefusal = 'unsupportedType' | 'tooLarge' | 'notBase64' | 'unrecognized';

export type InlineImage = { ok: true; mediaType: ImageMediaType; data: string } | { ok: false; reason: InlineImageRefusal };

// Anchored with one character class, so a failed match costs time linear in the length.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// pi 1.5.2 sniffs this many leading bytes (`IMAGE_TYPE_SNIFF_BYTES`, pi-coding-agent `dist/utils/mime.js:2`).
export const IMAGE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function decodeBase64Prefix(data: string, maxBytes: number): Uint8Array {
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (let index = 0; index < data.length && bytes.length < maxBytes; index++) {
    const char = data[index]!;
    if (char === '=') break;
    value = ((value << 6) | BASE64_ALPHABET.indexOf(char)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16) + (bytes[offset + 3] ?? 0) * 0x1000000;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) * 0x1000000 + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}

function isAnimatedPng(bytes: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    if (asciiAt(bytes, offset + 4, 'acTL')) return true;
    if (asciiAt(bytes, offset + 4, 'IDAT')) return false;
    const next = offset + 8 + readUint32BE(bytes, offset) + 4;
    if (next <= offset || next > bytes.length) return false;
    offset = next;
  }
  return false;
}

/** Port of pi 1.5.2's `detectSupportedImageMimeType` (`dist/utils/mime.js:4-21`) without BMP, which is not one of `IMAGE_MEDIA_TYPES`. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return bytes[3] === 0xf7 ? null : 'image/jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) {
    const png = bytes.length >= 16 && readUint32BE(bytes, 8) === 13 && asciiAt(bytes, 12, 'IHDR');
    return png && !isAnimatedPng(bytes) ? 'image/png' : null;
  }
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif';
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp';
  return null;
}

/** pi 1.5.2's `isBmp` (`dist/utils/mime.js`). */
function isBmp(bytes: Uint8Array): boolean {
  if (bytes.length < 26) return false;
  const declaredFileSize = readUint32LE(bytes, 2);
  const pixelDataOffset = readUint32LE(bytes, 10);
  const dibHeaderSize = readUint32LE(bytes, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(bytes, 22);
    bitsPerPixel = readUint16LE(bytes, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (bytes.length < 30) return false;
    colorPlanes = readUint16LE(bytes, 26);
    bitsPerPixel = readUint16LE(bytes, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

/** pi 1.5.2's `detectSupportedImageMimeType` whole: `sniffImageMediaType` and BMP, which pi's read converts before sending. */
export function sniffReadableImageType(bytes: Uint8Array): ImageMediaType | 'image/bmp' | null {
  return sniffImageMediaType(bytes) ?? (asciiAt(bytes, 0, 'BM') && isBmp(bytes) ? 'image/bmp' : null);
}

/**
 * Whether base64 `data` may go to the model as an image block, and as which type: the label must be absent or name
 * a type providers take, the data must fit `MAX_IMAGE_BASE64_LENGTH`, and the media type is the one its bytes carry.
 */
export function classifyInlineImage(data: string, declaredMimeType: string | undefined): InlineImage {
  if (declaredMimeType !== undefined && inlineImageMediaType(declaredMimeType) === undefined) return { ok: false, reason: 'unsupportedType' };
  if (data.length > MAX_IMAGE_BASE64_LENGTH) return { ok: false, reason: 'tooLarge' };
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) return { ok: false, reason: 'notBase64' };
  const mediaType = sniffImageMediaType(decodeBase64Prefix(data, IMAGE_SNIFF_BYTES));
  return mediaType ? { ok: true, mediaType, data } : { ok: false, reason: 'unrecognized' };
}
