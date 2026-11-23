// A `data:` image a theme's custom CSS may paint: a still image, decided from its bytes (docs/invariants.md "Theme CSS and
// trusted regions"). Pure: the sanitizer runs it in core, main and the renderers.
import { svgHeader } from './characters';
import { readImageHeader, type ImageFormat } from './image-header';

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml)(?:;charset=utf-8|;utf8)?(;base64)?,/i;
const RASTER_FORMATS: ReadonlySet<ImageFormat> = new Set<ImageFormat>(['png', 'jpeg', 'gif', 'webp']);
const utf8 = new TextEncoder();

// The URL parser's part of reading a data: URL: outer controls and spaces go, and tabs and line breaks anywhere.
function urlText(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end).replace(/[\t\n\r]/g, '');
}

// A hex digit's value, or -1.
const hexValue = (byte: number | undefined): number => {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  const lower = byte | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
};

function percentDecoded(text: string): Uint8Array {
  const raw = utf8.encode(text);
  const out = new Uint8Array(raw.length);
  let length = 0;
  for (let at = 0; at < raw.length; at += 1) {
    const high = raw[at] === 0x25 ? hexValue(raw[at + 1]) : -1;
    const low = high < 0 ? -1 : hexValue(raw[at + 2]);
    if (low < 0) out[length++] = raw[at]!;
    else {
      out[length++] = high * 16 + low;
      at += 2;
    }
  }
  return out.subarray(0, length);
}

function base64Decoded(bytes: Uint8Array): Uint8Array | undefined {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function stillRaster(bytes: Uint8Array): boolean {
  try {
    const header = readImageHeader(bytes);
    return RASTER_FORMATS.has(header.format) && !header.animated;
  } catch {
    return false;
  }
}

/**
 * Whether `value` is a data: URL of a still PNG, JPEG, GIF or WebP, whatever raster type it declares, or of an SVG that is
 * declared one and passes the sprite SVG rules. A URL with a fragment is refused: Chromium cuts its data there.
 */
export function isStillDataImage(value: string): boolean {
  const url = urlText(value);
  const found = DATA_IMAGE.exec(url);
  if (!found || url.includes('#')) return false;
  const payload = percentDecoded(url.slice(found[0].length));
  const bytes = found[2] === undefined ? payload : base64Decoded(payload);
  if (bytes === undefined) return false;
  // Chromium renders SVG by the declared type alone and picks a raster decoder by the bytes alone
  return found[1]!.toLowerCase() === 'svg+xml' ? !('refused' in svgHeader(bytes)) : stillRaster(bytes);
}
