// node scripts/theme-validator-fixtures.ts <dir>
// Writes the theme validator's three local fixtures: valid.damocles-theme (a still PNG wallpaper, every license declared),
// flashing.damocles-theme (a GIF wallpaper alternating black and white 20 times a second) and over-limit.damocles-theme (an
// asset that inflates past the archive's 100:1 ratio). Run `node dist/theme-validate.js <file> --thumbs <dir>` on each.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { encodePng } from './generate-theme-art.ts';

const SEEDS = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const le16 = (value: number): number[] => [value & 0xff, value >> 8];

function theme(name: string, asset: string, meta: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: '11111111-2222-4333-8444-555555555555',
    name,
    description: `${name}, a validator fixture.`,
    author: 'Damocles',
    version: '1.0.0',
    license: 'CC0-1.0',
    looks: { dark: { colors: SEEDS, wallpapers: [{ panels: { chat: { asset, fit: 'fill', dim: 0.3, blur: 0 } } }] } },
    assets: { [asset]: { ...meta, license: { spdx: 'CC0-1.0' } } },
  });
}

function archive(themeText: string, entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync({ 'theme.json': new TextEncoder().encode(themeText), ...entries });
}

/** A 640x400 vertical gradient, which decodes in any browser. */
function gradientPng(): Uint8Array {
  const width = 640;
  const height = 400;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      rgb[at] = 16 + Math.round((y / height) * 60);
      rgb[at + 1] = 20 + Math.round((x / width) * 80);
      rgb[at + 2] = 90 + Math.round((y / height) * 120);
    }
  }
  return new Uint8Array(encodePng(width, height, rgb));
}

/** A 1x1 GIF of `frames` frames of 50 ms, black and white in turn: 10 flashes a second over the whole image. */
function flashingGif(frames: number): Uint8Array {
  // LZW with a minimum code size of 2: clear (4), the pixel's index, end (5), three bits each
  const frame = (index: number): number[] => [
    0x21, 0xf9, 4, 0, ...le16(5), 0, 0,
    0x2c, 0, 0, 0, 0, ...le16(1), ...le16(1), 0,
    2, 2, 0x04 | (index << 3) | 0x40, 0x01, 0,
  ];
  const loop = [0x21, 0xff, 11, ...new TextEncoder().encode('NETSCAPE2.0'), 3, 1, 0, 0, 0];
  return new Uint8Array([
    ...new TextEncoder().encode('GIF89a'), ...le16(1), ...le16(1), 0x80, 0, 0,
    0, 0, 0, 255, 255, 255,
    ...loop,
    ...Array.from({ length: frames }, (_, i) => frame(i % 2)).flat(),
    0x3b,
  ]);
}

function main(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const png = gradientPng();
  const pngSha = sha256(png);
  writeFileSync(join(dir, 'valid.damocles-theme'), archive(theme('Validator Dusk', pngSha, { kind: 'image', mime: 'image/png', bytes: png.length, width: 640, height: 400 }), { [`assets/${pngSha}.png`]: png }));

  const gif = flashingGif(20);
  const gifSha = sha256(gif);
  writeFileSync(join(dir, 'flashing.damocles-theme'), archive(theme('Validator Strobe', gifSha, { kind: 'animated', mime: 'image/gif', bytes: gif.length, width: 1, height: 1, frames: 20, durationMs: 1000 }), { [`assets/${gifSha}.gif`]: gif }));

  // zeros deflate far past 100:1, which the archive reader refuses while inflating
  const zeros = new Uint8Array(4 * 1024 * 1024);
  const zerosSha = sha256(zeros);
  const bomb = zipSync({
    'theme.json': new TextEncoder().encode(theme('Validator Bomb', zerosSha, { kind: 'image', mime: 'image/png', bytes: zeros.length, width: 640, height: 400 })),
    [`assets/${zerosSha}.png`]: [zeros, { level: 9 }],
  });
  writeFileSync(join(dir, 'over-limit.damocles-theme'), bomb);
  console.log(`wrote valid, flashing and over-limit fixtures to ${dir}`);
}

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  console.error('usage: node scripts/theme-validator-fixtures.ts <dir>');
  process.exit(2);
}
main(resolve(dir));
