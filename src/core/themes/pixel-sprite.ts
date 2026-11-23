// A character drawn as pixel grids (ThemeSet asset.from.pixels, the built-in Arcade theme) turned into one sprite-strip SVG: the
// frames side by side, each pixel a crisp square. scripts/generate-theme-art.ts imports this file through Node's type stripping:
// erasable TypeScript and no imports.

export const MAX_PIXEL_SIDE = 32;
export const MAX_PIXEL_COLORS = 16;
export const MAX_PIXEL_FRAMES = 12;
export const DEFAULT_PIXEL_FPS = 4;
export const MAX_PIXEL_FPS = 30;
// A clear pixel; any other character is a palette index in hex, 0 to f.
const CLEAR = new Set(['.', ' ']);
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Frames of rows, one character a pixel: `.` or a space is clear, `0` to `f` names a palette color. */
export interface PixelSprite {
  readonly palette: readonly string[];
  readonly frames: ReadonlyArray<readonly string[]>;
  readonly fps: number;
}

export interface PixelStrip {
  readonly svg: string;
  // one frame's size in pixels; the SVG is frames × frameWidth wide
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frames: number;
  readonly fps: number;
}

export class PixelSpriteError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` checked as a pixel sprite: at most 32x32 pixels, 16 colors and 12 frames, every frame the same size. */
export function parsePixelSprite(value: unknown): PixelSprite {
  if (!isRecord(value)) throw new PixelSpriteError('pixels is { palette: ["#rrggbb", ...], frames: [[row, ...], ...], fps? }.');
  const palette = value['palette'];
  if (!Array.isArray(palette) || palette.length === 0 || palette.length > MAX_PIXEL_COLORS || !palette.every((color) => typeof color === 'string' && HEX6.test(color))) {
    throw new PixelSpriteError(`palette lists 1 to ${MAX_PIXEL_COLORS} colors as #rrggbb.`);
  }
  const frames = value['frames'];
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_PIXEL_FRAMES) throw new PixelSpriteError(`frames holds 1 to ${MAX_PIXEL_FRAMES} frames.`);
  let width = 0;
  let height = 0;
  frames.forEach((frame: unknown, f) => {
    if (!Array.isArray(frame) || frame.length === 0 || frame.length > MAX_PIXEL_SIDE || !frame.every((row) => typeof row === 'string')) {
      throw new PixelSpriteError(`Frame ${f + 1} needs 1 to ${MAX_PIXEL_SIDE} rows of text.`);
    }
    if (f === 0) {
      height = frame.length;
      width = (frame[0] as string).length;
    }
    if (frame.length !== height) throw new PixelSpriteError(`Frame ${f + 1} has ${frame.length} rows; every frame needs ${height}.`);
    (frame as string[]).forEach((row, r) => {
      if (row.length !== width || width === 0 || width > MAX_PIXEL_SIDE) throw new PixelSpriteError(`Frame ${f + 1}, row ${r + 1} is ${row.length} pixels wide; every row needs the same width, 1 to ${MAX_PIXEL_SIDE}.`);
      for (const char of row) {
        if (CLEAR.has(char)) continue;
        const index = Number.parseInt(char, 16);
        if (!/^[0-9a-fA-F]$/.test(char) || index >= palette.length) throw new PixelSpriteError(`Frame ${f + 1}, row ${r + 1} uses "${char}", which names no palette color.`);
      }
    });
  });
  const fps = value['fps'] ?? DEFAULT_PIXEL_FPS;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 1 || fps > MAX_PIXEL_FPS) throw new PixelSpriteError(`fps is 1 to ${MAX_PIXEL_FPS}.`);
  return { palette: palette as string[], frames: frames as string[][], fps };
}

/**
 * The sprite as one SVG strip: the frames left to right, one unit a pixel, each color one path of horizontal runs, with
 * crispEdges so the pixels stay square at any size. It holds no script, style, link or animation.
 */
export function pixelSpriteSvg(sprite: PixelSprite): PixelStrip {
  const frameHeight = sprite.frames[0]!.length;
  const frameWidth = sprite.frames[0]![0]!.length;
  const runs: string[][] = sprite.palette.map(() => []);
  sprite.frames.forEach((frame, f) => {
    frame.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const char = row[x]!;
        if (CLEAR.has(char)) {
          x++;
          continue;
        }
        let end = x + 1;
        while (end < row.length && row[end] === char) end++;
        runs[Number.parseInt(char, 16)]!.push(`M${f * frameWidth + x} ${y}h${end - x}v1h${x - end}z`);
        x = end;
      }
    });
  });
  const width = frameWidth * sprite.frames.length;
  const paths = runs.flatMap((run, i) => (run.length === 0 ? [] : [`<path fill="${sprite.palette[i]!.toLowerCase()}" d="${run.join('')}"/>`]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${frameHeight}" viewBox="0 0 ${width} ${frameHeight}" shape-rendering="crispEdges">${paths.join('')}</svg>\n`;
  return { svg, frameWidth, frameHeight, frames: sprite.frames.length, fps: sprite.fps };
}
