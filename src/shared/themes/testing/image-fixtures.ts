// Image files built byte by byte for header tests: each holds a valid header and as little else as the header needs. None
// decodes to pixels; the theme renderer's decode is e2e's.

const u32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u16 = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff];
const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const le24 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const chunk = (type: string, data: number[]): number[] => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];

/** A PNG header, an acTL chunk for an APNG (of `frames`, 2 by default), and an empty IDAT. */
export function png(width: number, height: number, options: { readonly animated?: boolean; readonly frames?: number; readonly noData?: boolean } = {}): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
    ...(options.animated ? chunk('acTL', [...u32(options.frames ?? 2), ...u32(0)]) : []),
    ...chunk('tEXt', ascii('Comment\0fixture')),
    ...(options.noData ? [] : chunk('IDAT', [])),
    ...chunk('IEND', []),
  ]);
}

/** A JPEG with an APP0 segment before its baseline start-of-frame. */
export function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, ...u16(16), ...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, ...u16(17), 8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda, ...u16(8), 1, 1, 0, 0, 0x3f, 0,
    0xff, 0xd9,
  ]);
}

const riff = (body: number[]): Uint8Array => new Uint8Array([...ascii('RIFF'), ...le32(body.length + 4), ...ascii('WEBP'), ...body]);

/** A lossy WebP (VP8). */
export function webpLossy(width: number, height: number): Uint8Array {
  const data = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0];
  return riff([...ascii('VP8 '), ...le32(data.length), ...data]);
}

/** A lossless WebP (VP8L). */
export function webpLossless(width: number, height: number): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const data = [0x2f, ...le32(bits), 0, 0, 0, 0];
  return riff([...ascii('VP8L'), ...le32(data.length), ...data]);
}

/** An extended WebP (VP8X), animated when asked: its flag, an ANIM chunk and `frames` empty ANMF chunks. */
export function webpExtended(width: number, height: number, animated = false, frames = 2): Uint8Array {
  const data = [animated ? 0x02 : 0x00, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  const anim = animated ? [...ascii('ANIM'), ...le32(6), 0, 0, 0, 0, 0, 0] : [];
  const anmf = animated ? Array.from({ length: frames }, () => [...ascii('ANMF'), ...le32(16), ...new Array<number>(16).fill(0)]).flat() : [];
  return riff([...ascii('VP8X'), ...le32(data.length), ...data, ...anim, ...anmf]);
}

/** A GIF of `frames` 1-pixel images under a global color table, each with its graphic control extension. */
export function gif(width: number, height: number, frames: number): Uint8Array {
  const image = [
    0x21, 0xf9, 4, 0, ...le16(10), 0, 0,
    0x2c, 0, 0, 0, 0, ...le16(1), ...le16(1), 0,
    2, 2, 0x4c, 0x01, 0,
  ];
  return new Uint8Array([
    ...ascii('GIF89a'), ...le16(width), ...le16(height), 0x80, 0, 0,
    0, 0, 0, 255, 255, 255,
    ...Array.from({ length: frames }, () => image).flat(),
    0x3b,
  ]);
}

const box = (type: string, body: number[]): number[] => [...u32(body.length + 8), ...ascii(type), ...body];
const fullBox = (type: string, body: number[]): number[] => box(type, [0, 0, 0, 0, ...body]);

/** An AVIF: ftyp, then meta > iprp > ipco > ispe for each size; avis and a moov box for a sequence. */
export function avif(sizes: ReadonlyArray<readonly [number, number]>, options: { readonly sequence?: boolean } = {}): Uint8Array {
  const brand = options.sequence ? 'avis' : 'avif';
  const ispe = sizes.flatMap(([width, height]) => fullBox('ispe', [...u32(width), ...u32(height)]));
  return new Uint8Array([
    ...box('ftyp', [...ascii(brand), 0, 0, 0, 0, ...ascii('mif1'), ...ascii(brand)]),
    ...fullBox('meta', [...fullBox('hdlr', [0, 0, 0, 0, ...ascii('pict'), ...new Array<number>(13).fill(0)]), ...box('iprp', box('ipco', ispe))]),
    ...(options.sequence ? box('moov', []) : []),
    ...box('mdat', [0]),
  ]);
}
