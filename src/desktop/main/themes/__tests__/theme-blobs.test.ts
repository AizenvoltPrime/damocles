import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openThemeBlob, readThemeBlob, readThemeThumb, readWallpaperFlash, readWallpaperStats } from '../theme-blobs';
import { sfntFont, woff2Font } from '../../../../core/themes/__tests__/font-fixtures';
import { gif, png, webpLossy } from '../../../../shared/themes/testing/image-fixtures';
import { FLASH_CHECK_VERSION, flashPlayable } from '../../../../shared/themes/wallpapers';
import { mp4, webm } from '../../../../core/themes/__tests__/video-fixtures';

// a blob is named by the SHA-256 of its bytes
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const PAGE = '<html><script>alert(1)</script></html>';
const WOFF2 = sha(woff2Font());
const TTF = sha(sfntFont());
const TEXT = sha(PAGE);
const PNG = sha(png(1600, 1000));
const HUGE = sha(png(20_000, 20_000));
const PACKED = sha(png(800, 500));
const THUMB = '2'.repeat(64);
let root: string;
let packedFile: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-blobs-'));
  fs.mkdirSync(path.join(root, 'blobs'));
  fs.writeFileSync(path.join(root, 'blobs', WOFF2), woff2Font());
  fs.writeFileSync(path.join(root, 'blobs', TTF), sfntFont());
  fs.writeFileSync(path.join(root, 'blobs', TEXT), PAGE);
  fs.writeFileSync(path.join(root, 'blobs', PNG), png(1600, 1000));
  fs.writeFileSync(path.join(root, 'blobs', HUGE), png(20_000, 20_000));
  packedFile = path.join(root, 'packed.png');
  fs.writeFileSync(packedFile, png(800, 500));
  fs.mkdirSync(path.join(root, 'cache', THUMB), { recursive: true });
  fs.writeFileSync(path.join(root, 'cache', THUMB, 'thumb-480.webp'), webpLossy(480, 300));
  fs.writeFileSync(path.join(root, 'cache', THUMB, 'stats.json'), JSON.stringify({ p10: 0.1, p90: 0.7, mean: 0.4 }));
  fs.mkdirSync(path.join(root, 'cache', PNG), { recursive: true });
  fs.writeFileSync(path.join(root, 'cache', PNG, 'thumb-480.webp'), png(480, 300));
  fs.writeFileSync(path.join(root, 'cache', PNG, 'stats.json'), JSON.stringify({ p10: -1, p90: 2, mean: 0.4 }));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readThemeBlob', () => {
  it('reads a blob a theme names, with the type it declared and its bytes sniffed as', async () => {
    const blob = await readThemeBlob(root, WOFF2, () => ({ kind: 'font', mime: 'font/woff2' }));
    expect(blob?.mime).toBe('font/woff2');
    expect(new Uint8Array(blob!.bytes)).toEqual(woff2Font());
  });

  it('refuses a blob no theme names, and one whose bytes are not the type its theme declared', async () => {
    expect(await readThemeBlob(root, WOFF2, () => undefined)).toBeUndefined();
    expect(await readThemeBlob(root, TTF, () => ({ kind: 'font', mime: 'font/woff2' }))).toBeUndefined();
    expect(await readThemeBlob(root, TEXT, () => ({ kind: 'font', mime: 'font/woff2' }))).toBeUndefined();
  });

  it('refuses a key that is not a sha256 and a blob that is not there, without asking what names it', async () => {
    const asked: string[] = [];
    const named = (sha256: string): { kind: 'font'; mime: string } => {
      asked.push(sha256);
      return { kind: 'font', mime: 'font/ttf' };
    };
    expect(await readThemeBlob(root, '../blobs/x', named)).toBeUndefined();
    expect(asked).toEqual([]);
    expect(await readThemeBlob(root, 'd'.repeat(64), named)).toBeUndefined();
  });

  it('serves a wallpaper only as the still image its theme declared, within the caps', async () => {
    expect((await readThemeBlob(root, PNG, () => ({ kind: 'image', mime: 'image/png' })))?.mime).toBe('image/png');
    expect(await readThemeBlob(root, PNG, () => ({ kind: 'image', mime: 'image/jpeg' }))).toBeUndefined();
    expect(await readThemeBlob(root, TEXT, () => ({ kind: 'image', mime: 'image/png' }))).toBeUndefined();
    // the header declares 20000 x 20000: past the caps, so no page ever decodes it
    expect(await readThemeBlob(root, HUGE, () => ({ kind: 'image', mime: 'image/png' }))).toBeUndefined();
  });

  it("reads a built-in example's wallpaper from its packed file when no blob holds it", async () => {
    const blob = await readThemeBlob(root, PACKED, () => ({ kind: 'image', mime: 'image/png' }), (name) => (name === PACKED ? packedFile : undefined));
    expect(new Uint8Array(blob!.bytes)).toEqual(png(800, 500));
    expect(await readThemeBlob(root, PACKED, () => ({ kind: 'image', mime: 'image/jpeg' }), () => packedFile)).toBeUndefined();
    // a packed file is held to its name as well
    expect(await readThemeBlob(root, sha(png(801, 500)), () => ({ kind: 'image', mime: 'image/png' }), () => packedFile)).toBeUndefined();
  });

  it('serves no blob whose bytes are not the ones its name is the hash of, though they are an image of the declared type', async () => {
    const name = sha(png(640, 400));
    const file = path.join(root, 'blobs', name);
    fs.writeFileSync(file, png(640, 400));
    expect(await readThemeBlob(root, name, () => ({ kind: 'image', mime: 'image/png' }))).toBeDefined();
    // another valid PNG of another size under the same name: a changed file is hashed again
    fs.writeFileSync(file, png(1280, 800, { noData: true }));
    expect(await readThemeBlob(root, name, () => ({ kind: 'image', mime: 'image/png' }))).toBeUndefined();
    expect(await openThemeBlob(root, name, () => ({ kind: 'image', mime: 'image/png' }))).toBeUndefined();
  });
});

describe('openThemeBlob for moving wallpapers', () => {
  const GIF = sha(gif(320, 200, 4));
  const VIDEO = sha(mp4({ moovAtEnd: true }));
  const HEVC = sha(mp4({ codec: 'hvc1' }));
  const LONG = sha(webm({ durationMs: 61_000 }));
  beforeAll(() => {
    fs.writeFileSync(path.join(root, 'blobs', GIF), gif(320, 200, 4));
    fs.writeFileSync(path.join(root, 'blobs', VIDEO), mp4({ moovAtEnd: true }));
    fs.writeFileSync(path.join(root, 'blobs', HEVC), mp4({ codec: 'hvc1' }));
    fs.writeFileSync(path.join(root, 'blobs', LONG), webm({ durationMs: 61_000 }));
  });
  const read = async (blob: Awaited<ReturnType<typeof openThemeBlob>>, start: number, end: number): Promise<Uint8Array> => new Uint8Array(await new Response(blob!.body(start, end)).arrayBuffer());

  it('serves an animated image only as the moving type its theme declared', async () => {
    const blob = await openThemeBlob(root, GIF, () => ({ kind: 'animated', mime: 'image/gif' }));
    expect(blob?.mime).toBe('image/gif');
    expect(await read(blob, 0, blob!.size - 1)).toEqual(gif(320, 200, 4));
    expect(await openThemeBlob(root, GIF, () => ({ kind: 'animated', mime: 'image/png' }))).toBeUndefined();
    // a still PNG is no animation, and a GIF no still image
    expect(await openThemeBlob(root, PNG, () => ({ kind: 'animated', mime: 'image/png' }))).toBeUndefined();
    expect(await openThemeBlob(root, GIF, () => ({ kind: 'image', mime: 'image/gif' }))).toBeUndefined();
  });

  it('serves a video by byte ranges from its file, once its header passed', async () => {
    const bytes = mp4({ moovAtEnd: true });
    const blob = await openThemeBlob(root, VIDEO, () => ({ kind: 'video', mime: 'video/mp4' }));
    expect(blob?.size).toBe(bytes.length);
    expect(await read(blob, 10, 29)).toEqual(bytes.slice(10, 30));
    expect(await read(blob, bytes.length - 8, bytes.length - 1)).toEqual(bytes.slice(-8));
    expect(await openThemeBlob(root, VIDEO, () => ({ kind: 'video', mime: 'video/webm' }))).toBeUndefined();
  });

  it('reads a video whole for the theme renderer, which decodes every frame of it', async () => {
    const blob = await readThemeBlob(root, VIDEO, () => ({ kind: 'video', mime: 'video/mp4' }));
    expect(new Uint8Array(blob!.bytes)).toEqual(mp4({ moovAtEnd: true }));
    expect(await readThemeBlob(root, HEVC, () => ({ kind: 'video', mime: 'video/mp4' }))).toBeUndefined();
  });

  it('serves no video whose bytes are not the ones its name is the hash of', async () => {
    const name = sha(mp4({ width: 320 }));
    fs.writeFileSync(path.join(root, 'blobs', name), mp4({ width: 640 }));
    expect(await openThemeBlob(root, name, () => ({ kind: 'video', mime: 'video/mp4' }))).toBeUndefined();
    expect(await readThemeBlob(root, name, () => ({ kind: 'video', mime: 'video/mp4' }))).toBeUndefined();
  });

  it('refuses a video in another codec or past the caps, and a video a theme names as anything else', async () => {
    expect(await openThemeBlob(root, HEVC, () => ({ kind: 'video', mime: 'video/mp4' }))).toBeUndefined();
    expect(await openThemeBlob(root, LONG, () => ({ kind: 'video', mime: 'video/webm' }))).toBeUndefined();
    expect(await openThemeBlob(root, VIDEO, () => ({ kind: 'image', mime: 'image/png' }))).toBeUndefined();
    expect(await openThemeBlob(root, VIDEO, () => undefined)).toBeUndefined();
  });
});

describe('the wallpaper cache', () => {
  it('serves a moving wallpaper\'s still frame only as a PNG, and reads its flash check', async () => {
    const STILL = '7'.repeat(64);
    fs.mkdirSync(path.join(root, 'cache', STILL), { recursive: true });
    fs.writeFileSync(path.join(root, 'cache', STILL, 'still.png'), png(1920, 1080));
    fs.writeFileSync(path.join(root, 'cache', STILL, 'flash.json'), JSON.stringify({ version: FLASH_CHECK_VERSION, flagged: true, atMs: 250, allowed: true }));
    expect(new Uint8Array((await readThemeThumb(root, STILL, 'still.png'))!)).toEqual(png(1920, 1080));
    expect(await readThemeThumb(root, THUMB, 'still.png')).toBeUndefined();
    expect(await readWallpaperFlash(root, STILL)).toMatchObject({ flagged: true, atMs: 250, allowed: true });
    expect(flashPlayable(await readWallpaperFlash(root, STILL))).toBe(true);
    expect(await readWallpaperFlash(root, THUMB)).toBeUndefined();
    // a check an older flash rule made is no check: the file does not play until core analyses it again
    fs.writeFileSync(path.join(root, 'cache', STILL, 'flash.json'), JSON.stringify({ flagged: false }));
    expect(await readWallpaperFlash(root, STILL)).toBeUndefined();
    expect(flashPlayable(await readWallpaperFlash(root, STILL))).toBe(false);
  });

  it('serves a thumbnail only by its fixed name, and only a WebP', async () => {
    expect(new Uint8Array((await readThemeThumb(root, THUMB, 'thumb-480.webp'))!)).toEqual(webpLossy(480, 300));
    expect(await readThemeThumb(root, THUMB, 'stats.json')).toBeUndefined();
    expect(await readThemeThumb(root, PNG, 'thumb-480.webp')).toBeUndefined();
    expect(await readThemeThumb(root, '../x', 'thumb-480.webp')).toBeUndefined();
  });

  it('reads stats in range and nothing else', async () => {
    expect(await readWallpaperStats(root, THUMB)).toEqual({ p10: 0.1, p90: 0.7, mean: 0.4 });
    expect(await readWallpaperStats(root, PNG)).toBeUndefined();
    expect(await readWallpaperStats(root, 'd'.repeat(64))).toBeUndefined();
  });

  it('reads no cache file that is not a regular file or is far larger than core writes one', async () => {
    const folder = '8'.repeat(64);
    fs.mkdirSync(path.join(root, 'cache', folder, 'stats.json'), { recursive: true });
    expect(await readWallpaperStats(root, folder)).toBeUndefined();
    const padded = '9'.repeat(64);
    fs.mkdirSync(path.join(root, 'cache', padded), { recursive: true });
    fs.writeFileSync(path.join(root, 'cache', padded, 'stats.json'), `${JSON.stringify({ p10: 0.1, p90: 0.7, mean: 0.4 })}${' '.repeat(64 * 1024)}`);
    expect(await readWallpaperStats(root, padded)).toBeUndefined();
  });
});
