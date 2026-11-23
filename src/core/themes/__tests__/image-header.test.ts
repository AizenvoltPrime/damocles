import { describe, expect, it } from 'vitest';
import { englishText, LocalizedError } from '../../../shared/localized-text';
import { MAX_MOVING_BYTES, MAX_WALLPAPER_BYTES } from '../../../shared/themes/wallpapers';
import { sniffAsset } from '../../design/assets';
import { checkWallpaper } from '../assets';
import { sniffVideo } from '../../../shared/themes/video-header';
import { ftypBrands, ImageHeaderError, MAX_PNG_CHUNKS, MAX_RIFF_CHUNKS, namesAvifBrand, readImageHeader, sniffWallpaper } from '../../../shared/themes/image-header';
import { avif, gif, jpeg, png, webpExtended, webpLossless, webpLossy } from '../../../shared/themes/testing/image-fixtures';

// A wallpaper's size is read from its header and held to the caps before anything decodes it (docs/themes.md "Wallpapers").

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    if (err instanceof LocalizedError) return englishText(err.text);
    throw err;
  }
  throw new Error('not refused');
};

describe('readImageHeader', () => {
  it.each([
    ['PNG', png(2400, 1600), 'png', 2400, 1600],
    ['JPEG', jpeg(4032, 3024), 'jpeg', 4032, 3024],
    ['lossy WebP', webpLossy(1920, 1080), 'webp', 1920, 1080],
    ['lossless WebP', webpLossless(800, 600), 'webp', 800, 600],
    ['extended WebP', webpExtended(5000, 3000), 'webp', 5000, 3000],
    ['AVIF', avif([[3840, 2160]]), 'avif', 3840, 2160],
  ] as const)('reads the size of a %s', (_name, bytes, format, width, height) => {
    expect(readImageHeader(bytes)).toEqual({ format, width, height, animated: false });
  });

  it('takes the largest size an AVIF lists, since an alpha plane or a thumbnail lists its own', () => {
    expect(readImageHeader(avif([[320, 180], [6000, 4000], [640, 360]]))).toMatchObject({ width: 6000, height: 4000 });
  });

  it.each([
    ['an APNG', png(800, 600, { animated: true })],
    ['an animated WebP', webpExtended(800, 600, true)],
    ['an AVIF image sequence', avif([[800, 600]], { sequence: true })],
  ])('says %s moves', (_name, bytes) => {
    expect(readImageHeader(bytes).animated).toBe(true);
  });

  it('refuses a file that is no PNG, JPEG, WebP or AVIF', () => {
    expect(() => readImageHeader(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow(ImageHeaderError);
  });

  // A header that does not hold up is refused, never guessed around.
  it.each([
    ['a PNG cut inside its header', png(800, 600).subarray(0, 20)],
    ['a PNG with no image data', png(800, 600, { noData: true })],
    ['a PNG of no width', png(0, 600)],
    ['a JPEG with no frame header', new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0xff, 0xd9])],
    ['a JPEG cut inside its frame header', jpeg(800, 600).subarray(0, 26)],
    ['a JPEG whose height comes later (DNL)', jpeg(800, 0)],
    ['a WebP with no VP8 start code', (() => { const bytes = webpLossy(800, 600); bytes[23] = 0; return bytes; })()],
    ['a WebP cut short', webpLossy(800, 600).subarray(0, 24)],
    ['an AVIF that lists no size', avif([])],
    ['an AVIF whose box runs past its end', (() => { const bytes = avif([[800, 600]]); bytes[bytes.length - 9] = 0x7f; return bytes; })()],
  ])('refuses %s', (_name, bytes) => {
    expect(() => readImageHeader(bytes)).toThrow(ImageHeaderError);
  });
});

describe('checkWallpaper', () => {
  it('accepts a still image within every cap', () => {
    expect(checkWallpaper(png(8192, 4880), 'dunes.png')).toMatchObject({ format: 'png', width: 8192, height: 4880 });
  });

  // Decompression bombs: a few hundred bytes that declare a huge image are refused by the header alone.
  it.each([
    ['wider than 8192', png(8193, 100), /at most 8192 pixels on a side/],
    ['taller than 8192', jpeg(100, 65_535), /at most 8192 pixels on a side/],
    ['past 40 megapixels within 8192 a side', webpExtended(8000, 6000), /at most 40/],
    ['an AVIF declaring 16384 a side', avif([[16_384, 16_384]]), /at most 8192 pixels on a side/],
  ])('refuses an image %s before any decode', (_name, bytes, message) => {
    expect(bytes.length).toBeLessThan(1024);
    expect(refusal(() => checkWallpaper(bytes))).toMatch(message);
  });

  it('refuses a file over 20 MB', () => {
    const big = new Uint8Array(MAX_WALLPAPER_BYTES + 1);
    big.set(png(800, 600));
    expect(refusal(() => checkWallpaper(big))).toMatch(/larger than 20 MB/);
  });

  it.each([
    ['an APNG', png(800, 600, { animated: true, frames: 24 }), 'image/png', 24],
    ['an animated WebP', webpExtended(800, 600, true, 12), 'image/webp', 12],
    ['a GIF', gif(800, 600, 3), 'image/gif', 3],
    ['a GIF of one frame', gif(800, 600, 1), 'image/gif', 1],
  ])('accepts %s as a moving wallpaper with its frame count', (_name, bytes, mime, frames) => {
    expect(checkWallpaper(bytes)).toEqual({ kind: 'animated', mime, format: mime.slice(6), width: 800, height: 600, frames });
  });

  it.each([
    ['an APNG', png(800, 600, { animated: true, frames: 1001 })],
    ['an animated WebP', webpExtended(800, 600, true, 1001)],
    ['a GIF', gif(64, 64, 1001)],
  ])('refuses %s of more than 1000 frames, from its header', (_name, bytes) => {
    expect(refusal(() => checkWallpaper(bytes))).toMatch(/1001 frames; a moving wallpaper may have at most 1000/);
  });

  it('refuses any file over 40 MB before reading its header', () => {
    expect(refusal(() => checkWallpaper(new Uint8Array(MAX_MOVING_BYTES + 1)))).toMatch(/larger than 40 MB/);
  });

  it('refuses an AVIF image sequence', () => {
    expect(refusal(() => checkWallpaper(avif([[800, 600]], { sequence: true })))).toMatch(/image sequence/);
  });

  it('refuses a GIF cut before its trailer', () => {
    const bytes = gif(800, 600, 2);
    expect(refusal(() => checkWallpaper(bytes.subarray(0, bytes.length - 1)))).toMatch(/could not be read: The GIF file ends before its header does/);
  });

  // A lying name: the bytes decide the type, and a name that says otherwise is refused.
  it('refuses a file whose name says another type than its bytes', () => {
    expect(refusal(() => checkWallpaper(jpeg(800, 600), 'photo.png'))).toMatch(/named \.png but holds a JPEG file/);
    expect(refusal(() => checkWallpaper(gif(80, 60, 2), 'loop.png'))).toMatch(/named \.png but holds a GIF file/);
    expect(checkWallpaper(jpeg(800, 600), 'photo.JPEG').format).toBe('jpeg');
  });

  it('names a header that does not hold up', () => {
    expect(refusal(() => checkWallpaper(png(800, 600, { noData: true })))).toMatch(/could not be read: The PNG has no image data/);
  });
});

const bytesOf = (...parts: ReadonlyArray<ArrayLike<number>>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const be32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const tag = (name: string): number[] => [...name].map((char) => char.charCodeAt(0));
const malformedText = (bytes: Uint8Array): string => {
  try {
    readImageHeader(bytes);
  } catch (err) {
    if (err instanceof ImageHeaderError && err.reason === 'malformed') return englishText(err.text);
    throw err;
  }
  throw new Error('not refused');
};

describe('a header walk', () => {
  // the bounds as numbers, so these inputs are the same whatever the module exports
  const PNG_CHUNKS = 1000;
  const RIFF_CHUNKS = 4096;

  it('is bounded at 1000 PNG chunks and 4096 WebP chunks', () => {
    expect([MAX_PNG_CHUNKS, MAX_RIFF_CHUNKS]).toEqual([PNG_CHUNKS, RIFF_CHUNKS]);
  });

  // `count` empty chunks of one type, as a file padded to make a walk long holds them
  const emptyChunks = (count: number, chunk: number[]): Uint8Array => {
    const out = new Uint8Array(count * chunk.length);
    for (let i = 0; i < count; i++) out.set(chunk, i * chunk.length);
    return out;
  };

  it('reads an ftyp box\'s brands from the first 1445 bytes only, however long the box says it is', () => {
    const padded = new Uint8Array(MAX_MOVING_BYTES);
    padded.set([...be32(padded.length), ...tag('ftyp'), ...tag('isom'), 0, 0, 2, 0]);
    expect(ftypBrands(padded)!.length).toBeLessThanOrEqual(1445 / 4);
    expect(namesAvifBrand(padded)).toBe(false);
    expect(sniffVideo(padded)).toBe('mp4');
    expect(sniffWallpaper(padded)).toBeUndefined();
    expect(sniffAsset(padded)).toBeUndefined();
    // an AVIF brand past the bytes that are read does not make the file an AVIF
    padded.set(tag('avif'), 2000);
    expect(namesAvifBrand(padded)).toBe(false);
    expect(ftypBrands(new Uint8Array(64))).toBeUndefined();
  });

  it('stops a PNG at 1000 chunks before its image data', () => {
    const head = png(8, 8).subarray(0, 33);
    const text = [...be32(0), ...tag('tEXt'), 0, 0, 0, 0];
    const idat = [...be32(0), ...tag('IDAT'), 0, 0, 0, 0];
    expect(readImageHeader(bytesOf(head, emptyChunks(PNG_CHUNKS - 1, text), idat))).toMatchObject({ format: 'png', width: 8, height: 8 });
    expect(malformedText(bytesOf(head, emptyChunks(PNG_CHUNKS, text), idat))).toBe('The PNG holds more than 1000 chunks before its image data.');
    // 40 MB of empty chunks refuses at the same chunk
    expect(malformedText(bytesOf(head, emptyChunks(Math.floor(MAX_MOVING_BYTES / 12), text)))).toBe('The PNG holds more than 1000 chunks before its image data.');
  });

  it('stops a WebP at 4096 chunks', () => {
    const head = webpExtended(8, 8, true, 1);
    const junk = [...tag('JUNK'), ...le32(0)];
    expect(readImageHeader(bytesOf(head, emptyChunks(RIFF_CHUNKS - 3, junk)))).toMatchObject({ format: 'webp', animated: true, frames: 1 });
    expect(malformedText(bytesOf(head, emptyChunks(RIFF_CHUNKS - 2, junk)))).toBe('The WebP holds more than 4096 chunks.');
    expect(malformedText(bytesOf(head, emptyChunks(Math.floor(MAX_MOVING_BYTES / 8), junk)))).toBe('The WebP holds more than 4096 chunks.');
  });
});

describe('an animated image that declares no frame', () => {
  it('is refused: an APNG of 0 frames, and an animated WebP with no ANMF chunk', () => {
    expect(malformedText(png(8, 8, { animated: true, frames: 0 }))).toBe('The animated PNG declares no frames.');
    expect(malformedText(webpExtended(8, 8, true, 0))).toBe('The animated WebP has no frames.');
    expect(readImageHeader(png(8, 8, { animated: true, frames: 1 }))).toMatchObject({ animated: true, frames: 1 });
  });
});

describe('a GIF frame', () => {
  // the first image descriptor of the fixture: left, top, width and height at its bytes 1 to 8
  const withFrame = (left: number, top: number, width: number, height: number): Uint8Array => {
    const bytes = gif(10, 10, 1);
    const descriptor = bytes.indexOf(0x2c, 19);
    new DataView(bytes.buffer).setUint16(descriptor + 1, left, true);
    new DataView(bytes.buffer).setUint16(descriptor + 3, top, true);
    new DataView(bytes.buffer).setUint16(descriptor + 5, width, true);
    new DataView(bytes.buffer).setUint16(descriptor + 7, height, true);
    return bytes;
  };

  it('is refused when it reaches outside the logical screen, which is the only size the caps were held to', () => {
    for (const [left, top, width, height] of [[0, 0, 20_000, 20_000], [0, 0, 11, 10], [0, 0, 10, 11], [1, 0, 10, 10], [0, 5, 10, 6], [65_535, 65_535, 65_535, 65_535]] as const) {
      expect(malformedText(withFrame(left, top, width, height)), `${left},${top} ${width}x${height}`).toBe('A GIF frame reaches outside the image, which the format does not allow.');
    }
    expect(refusal(() => checkWallpaper(withFrame(0, 0, 20_000, 20_000)))).toMatch(/could not be read: A GIF frame reaches outside the image/);
  });

  it('is read when it fills the screen or sits inside it', () => {
    expect(readImageHeader(withFrame(0, 0, 10, 10))).toEqual({ format: 'gif', width: 10, height: 10, animated: false, frames: 1 });
    expect(readImageHeader(withFrame(4, 5, 6, 5))).toEqual({ format: 'gif', width: 10, height: 10, animated: false, frames: 1 });
  });
});

describe('any bytes', () => {
  it('give a header or an ImageHeaderError, never another error, at every length an image can be cut to', () => {
    const images = [png(8, 8), png(8, 8, { animated: true }), jpeg(8, 8), webpLossy(8, 8), webpLossless(8, 8), webpExtended(8, 8, true), gif(8, 8, 2), avif([[8, 8]]), avif([[8, 8]], { sequence: true })];
    for (const image of images) {
      for (let length = 0; length <= image.length; length++) {
        let outcome = 'read';
        try {
          readImageHeader(image.subarray(0, length));
        } catch (err) {
          outcome = err instanceof ImageHeaderError ? 'refused' : String(err);
        }
        expect(['read', 'refused'], `cut to ${length}`).toContain(outcome);
      }
    }
  });

  it('give a header or an ImageHeaderError when a size field claims more than the file holds', () => {
    // an AVIF whose first box declares a 64-bit size, and one whose box size is all ones
    const large = bytesOf(be32(1), tag('ftyp'), [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], tag('avif'), new Uint8Array(16));
    const ones = bytesOf([0xff, 0xff, 0xff, 0xff], tag('ftyp'), tag('avif'), new Uint8Array(16));
    for (const bytes of [large, ones]) expect(() => readImageHeader(bytes)).toThrow(ImageHeaderError);
  });
});
