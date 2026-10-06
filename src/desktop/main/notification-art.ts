import { crc32 } from 'node:zlib';
import type { RasterArt } from '../preload/overlay-channels';

// The art of D52's taskbar badge. Main builds it from its own data only; the overlay draws it (it has the fonts and a
// canvas) and main validates the PNG it answers with (validPng).

const BADGE_UNITS = 16;

/** The taskbar badge's text for an unread count: none at 0, the digit up to 9, "9+" past it. */
export function badgeLabel(count: number): string {
  if (count <= 0) return '';
  return count > 9 ? '9+' : String(count);
}

/** A filled circle with the count, 16 px square times `scale`, rounded to whole pixels. */
export function badgeArt(label: string, scale: number, colors: { readonly fill: string; readonly text: string }): RasterArt {
  // The colour lands in an SVG attribute.
  if (!/^#[0-9a-f]{6}$/i.test(colors.fill)) throw new Error(`Not a #rrggbb colour: ${colors.fill}`);
  const pixels = Math.round(BADGE_UNITS * scale);
  return {
    width: pixels,
    height: pixels,
    scale: pixels / BADGE_UNITS,
    ops: [
      {
        kind: 'svg',
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${BADGE_UNITS} ${BADGE_UNITS}"><circle cx="8" cy="8" r="8" fill="${colors.fill}"/></svg>`,
      },
      { kind: 'text', text: label, x: 8, y: 8, size: label.length > 1 ? 8.5 : 10.5, weight: 700, color: colors.text },
    ],
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_LENGTH = 13;
// 8-bit truecolour, with or without alpha, as a canvas encodes it.
const COLOR_TYPES: ReadonlySet<number> = new Set([2, 6]);

/**
 * The bytes as a Buffer when they are one complete PNG of exactly width × height within maxBytes: the signature, an
 * IHDR first, every chunk's CRC, image data, and IEND last with nothing after it. Anything else is undefined.
 */
export function validPng(raw: unknown, width: number, height: number, maxBytes: number): Buffer | undefined {
  if (!(raw instanceof Uint8Array) || raw.byteLength > maxBytes || raw.byteLength < PNG_SIGNATURE.length) return undefined;
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return undefined;
  let offset = PNG_SIGNATURE.length;
  let first = true;
  let sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return undefined;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return undefined;
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return undefined;
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (first) {
      if (type !== 'IHDR' || length !== IHDR_LENGTH) return undefined;
      if (data.readUInt32BE(0) !== width || data.readUInt32BE(4) !== height) return undefined;
      if (data[8] !== 8 || !COLOR_TYPES.has(data[9]!) || data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) return undefined;
      first = false;
    } else if (type === 'IHDR') {
      return undefined;
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') return length === 0 && end === bytes.length && sawData ? bytes : undefined;
    offset = end;
  }
  return undefined;
}
