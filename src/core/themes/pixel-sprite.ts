// A character drawn as pixel grids (ThemeSet sprites, the built-in Arcade theme) turned into one sprite-strip SVG, the frames
// side by side, each pixel a crisp square, and read back from it. scripts/generate-theme-art.ts imports this file through Node's
// type stripping: erasable TypeScript and no imports.

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
        const index = Number.parseInt(char, 16);
        let end = x + 1;
        while (end < row.length && !CLEAR.has(row[end]!) && Number.parseInt(row[end]!, 16) === index) end++;
        runs[index]!.push(`M${f * frameWidth + x} ${y}h${end - x}v1h${x - end}z`);
        x = end;
      }
    });
  });
  const width = frameWidth * sprite.frames.length;
  const paths = runs.flatMap((run, i) => (run.length === 0 ? [] : [`<path fill="${sprite.palette[i]!.toLowerCase()}" d="${run.join('')}"/>`]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${frameHeight}" viewBox="0 0 ${width} ${frameHeight}" shape-rendering="crispEdges">${paths.join('')}</svg>\n`;
  return { svg, frameWidth, frameHeight, frames: sprite.frames.length, fps: sprite.fps };
}

const SVG_ROOT = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)" shape-rendering="crispEdges">/;
const SVG_PATH = /<path fill="(#[0-9a-f]{6})" d="([^"]*)"\/>/y;
const SVG_RUN = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/y;
const SVG_END = '</svg>\n';

/**
 * The pixel grids `pixelSpriteSvg` drew `svg` from, cut into `frames` at `fps`: palette indexes in the order of its paths, `.`
 * for clear. Only text `pixelSpriteSvg` itself writes, with a colored pixel and at a rate parsePixelSprite takes, reads back;
 * anything else throws PixelSpriteError saying why.
 */
export function pixelSpriteFromSvg(svg: string, frames: number, fps: number): PixelSprite {
  const root = SVG_ROOT.exec(svg);
  if (!root) throw new PixelSpriteError('It is not an SVG drawn from pixel grids: its root element is not the one Damocles writes.');
  const [width, height, viewWidth, viewHeight] = root.slice(1, 5).map(Number) as [number, number, number, number];
  if (viewWidth !== width || viewHeight !== height) throw new PixelSpriteError('Its viewBox is not its size.');
  if (!Number.isInteger(frames) || frames < 1 || frames > MAX_PIXEL_FRAMES) throw new PixelSpriteError(`It holds ${frames} frames; a pixel sprite holds 1 to ${MAX_PIXEL_FRAMES}.`);
  if (!Number.isFinite(fps) || fps < 1 || fps > MAX_PIXEL_FPS) throw new PixelSpriteError(`Its frame rate is ${fps}; a pixel sprite moves at 1 to ${MAX_PIXEL_FPS} frames a second.`);
  if (width % frames !== 0) throw new PixelSpriteError(`It is ${width} pixels wide, which does not cut into ${frames} frames.`);
  const frameWidth = width / frames;
  if (frameWidth < 1 || frameWidth > MAX_PIXEL_SIDE || height < 1 || height > MAX_PIXEL_SIDE) throw new PixelSpriteError(`Its frames are ${frameWidth} by ${height} pixels; a pixel sprite's are 1 to ${MAX_PIXEL_SIDE} a side.`);
  const grid: string[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => '.'));
  const palette: string[] = [];
  let at = root[0].length;
  for (;;) {
    SVG_PATH.lastIndex = at;
    const path = SVG_PATH.exec(svg);
    if (!path) break;
    at = SVG_PATH.lastIndex;
    if (palette.length === MAX_PIXEL_COLORS) throw new PixelSpriteError(`It has more than ${MAX_PIXEL_COLORS} colors.`);
    const index = palette.length.toString(16);
    palette.push(path[1]!);
    const runs = path[2]!;
    let from = 0;
    while (from < runs.length) {
      SVG_RUN.lastIndex = from;
      const run = SVG_RUN.exec(runs);
      if (!run) throw new PixelSpriteError('A path is not made of one-pixel-high runs.');
      from = SVG_RUN.lastIndex;
      const [x, y, length, back] = run.slice(1, 5).map(Number) as [number, number, number, number];
      if (length < 1 || back !== length) throw new PixelSpriteError('A run is not a closed one-pixel-high row of pixels.');
      if (y >= height || x + length > width || Math.floor(x / frameWidth) !== Math.floor((x + length - 1) / frameWidth)) throw new PixelSpriteError('A run reaches past its frame.');
      const row = grid[y]!;
      for (let cell = x; cell < x + length; cell++) {
        if (row[cell] !== '.') throw new PixelSpriteError('Two runs cover the same pixel.');
        row[cell] = index;
      }
    }
  }
  if (svg.slice(at) !== SVG_END) throw new PixelSpriteError('It holds something other than the paths of pixel runs.');
  if (palette.length === 0) throw new PixelSpriteError(`It has no colored pixel; a pixel sprite has 1 to ${MAX_PIXEL_COLORS} colors.`);
  const sprite: PixelSprite = {
    palette,
    frames: Array.from({ length: frames }, (_, f) => grid.map((row) => row.slice(f * frameWidth, (f + 1) * frameWidth).join(''))),
    fps,
  };
  if (pixelSpriteSvg(sprite).svg !== svg) throw new PixelSpriteError('Its runs are not the ones its pixels draw.');
  return sprite;
}
