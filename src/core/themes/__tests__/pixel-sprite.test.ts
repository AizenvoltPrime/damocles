import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { svgHeader } from '../../../shared/themes/characters';
import type { ThemeFile } from '../../../shared/themes/schema';
import { checkSprite, spriteAsset } from '../characters';
import { MAX_PIXEL_COLORS, MAX_PIXEL_FPS, MAX_PIXEL_FRAMES, MAX_PIXEL_SIDE, parsePixelSprite, PixelSpriteError, pixelSpriteFromSvg, pixelSpriteSvg, type PixelSprite } from '../pixel-sprite';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const grid = (side: number, char = '0'): string[] => Array.from({ length: side }, () => char.repeat(side));

describe('pixel sprites', () => {
  it('draws the frames side by side, each color one path of runs, with crisp edges and nothing that loads or moves', () => {
    const strip = pixelSpriteSvg(parsePixelSprite({ palette: ['#FF0000', '#00ff00'], frames: [['00.', '.11'], ['11.', '..0']], fps: 3 }));
    expect(strip).toMatchObject({ frameWidth: 3, frameHeight: 2, frames: 2, fps: 3 });
    expect(strip.svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="6" height="2" viewBox="0 0 6 2" shape-rendering="crispEdges">'
      + '<path fill="#ff0000" d="M0 0h2v1h-2zM5 1h1v1h-1z"/><path fill="#00ff00" d="M1 1h2v1h-2zM3 0h2v1h-2z"/></svg>\n',
    );
    expect(svgHeader(encode(strip.svg))).toEqual({ width: 6, height: 2 });
  });

  it('takes 32 x 32 pixels, 16 colors and 12 frames at most, and 4 frames a second by default', () => {
    const palette = Array.from({ length: MAX_PIXEL_COLORS }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`);
    const sprite = parsePixelSprite({ palette, frames: Array.from({ length: MAX_PIXEL_FRAMES }, () => grid(MAX_PIXEL_SIDE, 'f')) });
    expect(sprite.fps).toBe(4);
    const strip = pixelSpriteSvg(sprite);
    expect(strip).toMatchObject({ frameWidth: 32, frameHeight: 32, frames: 12 });
    // a strip's frame stays within the sprite caps, and its whole image too
    expect(spriteAsset(encode(strip.svg), checkSprite(encode(strip.svg), 'sprite.svg', { frames: 12, fps: 4 }))).toMatchObject({ kind: 'sprite', mime: 'image/svg+xml', width: 384, height: 32, frames: 12, durationMs: 3000 });
  });

  it.each([
    ['no palette', { frames: [['0']] }, 'palette lists 1 to 16 colors'],
    ['17 colors', { palette: Array.from({ length: 17 }, () => '#000000'), frames: [['0']] }, 'palette lists 1 to 16 colors'],
    ['a named color', { palette: ['red'], frames: [['0']] }, 'palette lists 1 to 16 colors'],
    ['13 frames', { palette: ['#000000'], frames: Array.from({ length: 13 }, () => ['0']) }, 'frames holds 1 to 12 frames'],
    ['33 rows', { palette: ['#000000'], frames: [grid(33)] }, 'needs 1 to 32 rows'],
    ['33 columns', { palette: ['#000000'], frames: [['0'.repeat(33)]] }, 'every row needs the same width, 1 to 32'],
    ['uneven rows', { palette: ['#000000'], frames: [['00', '0']] }, 'every row needs the same width'],
    ['frames of two sizes', { palette: ['#000000'], frames: [['00', '00'], ['00']] }, 'every frame needs 2'],
    ['an index past the palette', { palette: ['#000000'], frames: [['01']] }, 'names no palette color'],
    ['a letter past f', { palette: ['#000000'], frames: [['0g']] }, 'names no palette color'],
    ['31 fps', { palette: ['#000000'], frames: [['0']], fps: 31 }, 'fps is 1 to 30'],
  ])('refuses %s', (_name, value, message) => {
    expect(() => parsePixelSprite(value)).toThrow(PixelSpriteError);
    expect(() => parsePixelSprite(value)).toThrow(message);
  });
});

// A seeded generator, so a failing grid is the same on every run.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 2 ** 32;
  };
}

// The color a pixel shows, or null for a clear one; what both sprites must agree on, whatever indexes they use.
const colorAt = (sprite: PixelSprite, f: number, y: number, x: number): string | null => {
  const char = sprite.frames[f]![y]![x]!;
  return char === '.' || char === ' ' ? null : sprite.palette[Number.parseInt(char, 16)]!.toLowerCase();
};

describe('pixel sprites read back from their SVG', () => {
  it('give back the grid of any sprite within the caps, which draws the same SVG again', () => {
    const next = random(7);
    const pick = (n: number): number => Math.floor(next() * n);
    for (let round = 0; round < 150; round++) {
      const colors = 1 + pick(MAX_PIXEL_COLORS);
      const palette = Array.from({ length: colors }, () => `#${pick(0x1000000).toString(16).padStart(6, '0')}`.replace(/[a-f]/g, (c) => (next() < 0.5 ? c.toUpperCase() : c)));
      const width = 1 + pick(MAX_PIXEL_SIDE);
      const height = 1 + pick(MAX_PIXEL_SIDE);
      const clear = next();
      const cell = (): string => {
        if (next() < clear) return '.';
        const index = pick(colors).toString(16);
        return next() < 0.5 ? index.toUpperCase() : index;
      };
      const frames = Array.from({ length: 1 + pick(MAX_PIXEL_FRAMES) }, () => Array.from({ length: height }, () => Array.from({ length: width }, cell).join('')));
      const sprite = parsePixelSprite({ palette, frames, fps: 1 + pick(30) });
      const strip = pixelSpriteSvg(sprite);
      const back = pixelSpriteFromSvg(strip.svg, strip.frames, strip.fps);
      expect(pixelSpriteSvg(back)).toEqual(strip);
      const differs = frames.some((frame, f) => frame.some((row, y) => [...row].some((_, x) => colorAt(back, f, y, x) !== colorAt(sprite, f, y, x))));
      expect(differs).toBe(false);
    }
  });

  it('joins a and A into one run, since both name one palette color', () => {
    const palette = Array.from({ length: 11 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`);
    expect(pixelSpriteSvg(parsePixelSprite({ palette, frames: [['aA', 'Aa']] })).svg).toContain('<path fill="#00000a" d="M0 0h2v1h-2zM0 1h2v1h-2z"/>');
  });

  it.each([
    ['a drawing of other shapes', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" viewBox="0 0 2 2" shape-rendering="crispEdges"><circle cx="1" cy="1" r="1"/></svg>\n', 1, 'something other than the paths of pixel runs'],
    ['a root of other attributes', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1"><path fill="#000000" d="M0 0h2v1h-2z"/></svg>\n', 1, 'its root element is not the one Damocles writes'],
    ['runs that overlap', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1" shape-rendering="crispEdges"><path fill="#000000" d="M0 0h2v1h-2z"/><path fill="#ffffff" d="M1 0h1v1h-1z"/></svg>\n', 1, 'Two runs cover the same pixel'],
    ['two runs pixelSpriteSvg would join', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1" shape-rendering="crispEdges"><path fill="#000000" d="M0 0h1v1h-1zM1 0h1v1h-1z"/></svg>\n', 1, 'Its runs are not the ones its pixels draw'],
    ['a run across two frames', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1" shape-rendering="crispEdges"><path fill="#000000" d="M0 0h2v1h-2z"/></svg>\n', 2, 'A run reaches past its frame'],
    ['a width that is not whole frames', '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="1" viewBox="0 0 3 1" shape-rendering="crispEdges"><path fill="#000000" d="M0 0h1v1h-1z"/></svg>\n', 2, 'does not cut into 2 frames'],
    ['a frame past 32 pixels', '<svg xmlns="http://www.w3.org/2000/svg" width="33" height="1" viewBox="0 0 33 1" shape-rendering="crispEdges"><path fill="#000000" d="M0 0h33v1h-33z"/></svg>\n', 1, 'Its frames are 33 by 1 pixels'],
    ['a run of another height', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" viewBox="0 0 2 2" shape-rendering="crispEdges"><path fill="#000000" d="M0 0h2v2h-2z"/></svg>\n', 1, 'A path is not made of one-pixel-high runs'],
  ])('refuses %s, saying why', (_name, svg, frames, message) => {
    expect(() => pixelSpriteFromSvg(svg, frames, 4)).toThrow(PixelSpriteError);
    expect(() => pixelSpriteFromSvg(svg, frames, 4)).toThrow(message);
  });

  it('holds the rate and the palette to what parsePixelSprite takes', () => {
    const strip = pixelSpriteSvg(parsePixelSprite({ palette: ['#000000'], frames: [['0']] }));
    for (const fps of [0.5, MAX_PIXEL_FPS + 1, Number.NaN]) expect(() => pixelSpriteFromSvg(strip.svg, 1, fps), String(fps)).toThrow(`a pixel sprite moves at 1 to ${MAX_PIXEL_FPS} frames a second`);
    expect(pixelSpriteFromSvg(strip.svg, 1, MAX_PIXEL_FPS).fps).toBe(MAX_PIXEL_FPS);
    const clear = pixelSpriteSvg(parsePixelSprite({ palette: ['#000000'], frames: [['..']] }));
    expect(() => pixelSpriteFromSvg(clear.svg, 1, 4)).toThrow('It has no colored pixel');
  });

  it("reads every sprite of the built-in Arcade theme", () => {
    const folder = path.join(__dirname, '..', '..', '..', '..', 'resources', 'themes', 'damocles-arcade');
    const theme = JSON.parse(fs.readFileSync(path.join(folder, 'theme.json'), 'utf8')) as ThemeFile;
    const strips = (theme.characters?.characters ?? []).flatMap((character) => Object.values(character.states).flatMap((frame) => (frame && 'strip' in frame ? [frame.strip] : [])));
    expect(strips.length).toBeGreaterThan(0);
    for (const strip of strips) {
      const svg = fs.readFileSync(path.join(folder, `${strip.asset}.svg`), 'utf8');
      const sprite = pixelSpriteFromSvg(svg, strip.frames, strip.fps);
      expect(sprite.frames).toHaveLength(strip.frames);
      expect(sprite.frames[0]).toHaveLength(strip.frameHeight);
      expect(pixelSpriteSvg(sprite).svg).toBe(svg);
    }
  });
});
