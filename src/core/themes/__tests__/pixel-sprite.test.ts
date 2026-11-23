import { describe, expect, it } from 'vitest';
import { svgHeader } from '../../../shared/themes/characters';
import { checkSprite, spriteAsset } from '../characters';
import { MAX_PIXEL_COLORS, MAX_PIXEL_FRAMES, MAX_PIXEL_SIDE, parsePixelSprite, PixelSpriteError, pixelSpriteSvg } from '../pixel-sprite';

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
