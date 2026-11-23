import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { isEntryPoint } from './entry-point.ts';
import { parsePixelSprite, pixelSpriteSvg } from '../src/core/themes/pixel-sprite.ts';

/**
 * The built-in examples' art, drawn here and nowhere else, so it ships under the repository's own license with no third-party
 * asset (docs/themes.md "Built-in examples"): Aurora's wallpapers, painted procedurally, and Arcade's characters, authored below
 * as pixel grids and made into sprite strips by core's own pixel-sprite.ts.
 *
 *   node scripts/generate-theme-art.ts          # write resources/themes/damocles-aurora/ and damocles-arcade/
 *   node scripts/generate-theme-art.ts --check  # exit 1 if the committed files are stale
 *
 * Each image is named by its sha256, which theme.json's assets name; theme.json is written here too. resources/themes is
 * -text in .gitattributes, so every text file is written with LF on every platform.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const AURORA_DIR = join(ROOT, 'resources', 'themes', 'damocles-aurora');
export const ARCADE_DIR = join(ROOT, 'resources', 'themes', 'damocles-arcade');
const WIDTH = 1600;
const HEIGHT = 1000;

type Rgb = readonly [number, number, number];

/** A truecolor PNG of `rgb` (3 bytes a pixel, rows top to bottom), every row Paeth-filtered, which smooth art compresses well. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? rgb[y * stride + x - 3]! : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + x]! : 0;
      const c = x >= 3 && y > 0 ? rgb[(y - 1) * stride + x - 3]! : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      filtered[y * (stride + 1) + 1 + x] = (rgb[y * stride + x]! - predictor) & 0xff;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A seeded generator, so the art is the same on every run.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v: number): number => Math.max(0, Math.min(1, v));
const hex = (value: string): Rgb => [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16)];

interface Scene {
  readonly skyTop: Rgb;
  readonly skyBottom: Rgb;
  // ribbon colors from the curtain's foot up to its fading top
  readonly ribbonLow: Rgb;
  readonly ribbonHigh: Rgb;
  readonly ribbonStrength: number;
  // additive light (night) or a pastel wash over the sky (dawn)
  readonly additive: boolean;
  readonly ridge: Rgb;
  readonly ridgeFar: Rgb;
  readonly stars: number;
  readonly seed: number;
}

// Curtains of light along wavy curves, rising from each curve and fading upward; two ridges of hills in front.
function paint(scene: Scene): Uint8Array {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  const rand = random(scene.seed);
  const curtains = [0, 1, 2].map((i) => ({
    base: 0.42 + i * 0.09 + rand() * 0.04,
    amp: [0.05 + rand() * 0.04, 0.02 + rand() * 0.02],
    freq: [1.4 + rand() * 1.2, 3.2 + rand() * 2.4],
    phase: [rand() * 6.28, rand() * 6.28],
    height: 0.16 + rand() * 0.1,
    weight: 1 - i * 0.28,
  }));
  const ridge = (x: number, far: boolean): number => (far
    ? 0.74 + 0.05 * Math.sin(x * 4.1 + 1.2) + 0.025 * Math.sin(x * 11.3 + 0.4)
    : 0.83 + 0.06 * Math.sin(x * 2.7 + 2.1) + 0.02 * Math.sin(x * 9.7 + 1.7));
  for (let py = 0; py < HEIGHT; py++) {
    const y = py / HEIGHT;
    for (let px = 0; px < WIDTH; px++) {
      const x = px / WIDTH;
      let color = mix(scene.skyTop, scene.skyBottom, y);
      let glow = 0;
      let lift = 0;
      for (const c of curtains) {
        const foot = c.base + c.amp[0]! * Math.sin(x * c.freq[0]! * 6.28 + c.phase[0]!) + c.amp[1]! * Math.sin(x * c.freq[1]! * 6.28 + c.phase[1]!);
        const above = foot - y;
        // light rises from the foot and fades upward; below the foot it falls off fast
        const strength = above >= 0 ? Math.exp(-above / c.height) : Math.exp(-((above / 0.015) ** 2));
        // vertical rays across the curtain
        const rays = 0.75 + 0.25 * Math.sin(x * 140 + Math.sin(x * 17) * 3);
        const amount = strength * rays * c.weight;
        if (amount > glow) lift = clamp(above / (c.height * 2.2));
        glow = Math.max(glow, amount);
      }
      const ribbon = mix(scene.ribbonLow, scene.ribbonHigh, lift);
      const t = clamp(glow * scene.ribbonStrength);
      color = scene.additive
        ? [color[0] + ribbon[0] * t, color[1] + ribbon[1] * t, color[2] + ribbon[2] * t]
        : mix(color, ribbon, t);
      if (y > ridge(x, true)) color = mix(scene.ridgeFar, color, 0.15);
      if (y > ridge(x, false)) color = scene.ridge;
      const at = (py * WIDTH + px) * 3;
      rgb[at] = Math.round(Math.min(255, color[0]));
      rgb[at + 1] = Math.round(Math.min(255, color[1]));
      rgb[at + 2] = Math.round(Math.min(255, color[2]));
    }
  }
  for (let i = 0; i < scene.stars; i++) {
    const px = Math.floor(rand() * WIDTH);
    const py = Math.floor(rand() * HEIGHT * 0.55);
    const at = (py * WIDTH + px) * 3;
    const shine = 140 + Math.floor(rand() * 100);
    for (let k = 0; k < 3; k++) rgb[at + k] = Math.max(rgb[at + k]!, shine);
  }
  return rgb;
}

const NIGHT: Scene = {
  skyTop: hex('#04070f'), skyBottom: hex('#0c1a2b'), ribbonLow: hex('#3ff0a8'), ribbonHigh: hex('#7a5cff'), ribbonStrength: 0.55, additive: true,
  ridge: hex('#03060c'), ridgeFar: hex('#08111d'), stars: 260, seed: 7,
};
const DAWN: Scene = {
  skyTop: hex('#dfeaf7'), skyBottom: hex('#fbf1e7'), ribbonLow: hex('#9fe6cf'), ribbonHigh: hex('#c9b8f5'), ribbonStrength: 0.6, additive: false,
  ridge: hex('#c7d3e2'), ridgeFar: hex('#d9e2ee'), stars: 0, seed: 11,
};

// The theme's colors, at AA by derivation (palette-contrast.test.ts covers it).
const LOOKS = {
  dark: { background: '#0b1020', panel: '#10172a', text: '#e4ecf5', accent: '#5ee6b0', success: '#4fd18b', warning: '#f2c14e', danger: '#ff6b7a', info: '#8ab4ff' },
  light: { background: '#f4f7fb', panel: '#e8eef6', text: '#14202e', accent: '#0f7a68', success: '#1f7a3e', warning: '#8a5a00', danger: '#c0303c', info: '#3a5fc4' },
} as const;
// Dims a little past what muted text needs over each image, so the art shows through.
const SPAN = { dark: { dim: 0.6, blur: 2 }, light: { dim: 0.62, blur: 2 } } as const;
const PANELS = ['titlebar', 'sidebar', 'chat', 'editor', 'terminal'] as const;
const LICENSE = [
  'The Aurora theme ships with Damocles under the repository\'s MIT License (see LICENSE at the repository root).',
  'Its two wallpapers are drawn procedurally by scripts/generate-theme-art.ts, with no third-party image or asset;',
  'run npm run generate:theme-art to draw them again. It uses Damocles\' built-in fonts.',
  '',
].join('\n');

export interface ThemeArt {
  // file name under AURORA_DIR, and its bytes
  readonly files: ReadonlyMap<string, Buffer>;
}

/** Every file of resources/themes/damocles-aurora/ as this script draws it. */
export function renderAurora(): ThemeArt {
  const files = new Map<string, Buffer>();
  const assets: Record<string, unknown> = {};
  const looks: Record<string, unknown> = {};
  for (const [kind, scene] of [['dark', NIGHT], ['light', DAWN]] as const) {
    const png = encodePng(WIDTH, HEIGHT, paint(scene));
    const sha = createHash('sha256').update(png).digest('hex');
    files.set(`${sha}.png`, png);
    assets[sha] = { kind: 'image', mime: 'image/png', bytes: png.length, width: WIDTH, height: HEIGHT, license: { spdx: 'MIT', author: 'Damocles', source: 'scripts/generate-theme-art.ts' } };
    looks[kind] = {
      colors: LOOKS[kind],
      wallpapers: [{ name: kind === 'dark' ? 'Night' : 'Dawn', span: { asset: sha, panels: PANELS, fit: 'fill' }, spanLook: Object.fromEntries(PANELS.map((panel) => [panel, SPAN[kind]])) }],
      surfaceOpacity: 0.9,
    };
  }
  const theme = {
    schemaVersion: 1,
    id: 'damocles-aurora',
    name: 'Aurora',
    description: 'Northern lights behind every panel: a night look and a dawn look, one image across the window.',
    author: 'Damocles',
    license: 'MIT',
    looks,
    assets,
  };
  files.set('theme.json', Buffer.from(`${JSON.stringify(theme, null, 2)}\n`));
  files.set('LICENSE', Buffer.from(LICENSE));
  return { files };
}

// Arcade's characters, 8 x 8 pixels, one letter a color of PIXEL_COLORS and "." clear.
const CHARACTERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Pip', ['..wwww..', '.wwwwww.', 'wkkwwkkw', 'wkbwwkbw', 'wwwwwwww', 'wwwwwwww', 'wwwwwwww', 'w.ww.ww.']],
  ['Mochi', ['y......y', 'yy....yy', 'yyyyyyyy', 'ykyyyyky', 'yyyooyyy', 'yyyyyyyy', '.yyyyyy.', '.y.yy.y.']],
  ['Bolt', ['...rr...', '...cc...', 'cccccccc', 'ckkcckkc', 'cccccccc', 'ckkkkkkc', 'cccccccc', '.cc..cc.']],
  ['Gloop', ['........', '...gg...', '..gGgg..', '.gGgggg.', '.gkggkg.', 'gggggggg', 'gggggggg', '.gggggg.']],
  ['Nova', ['...mm...', '..mmmm..', '.mkmmkm.', 'mmmmmmmm', 'mmammamm', '.mmmmmm.', '..m..m..', '.m....m.']],
  ['Fizz', ['..o..o..', '..oooo..', '.oooooo.', 'okooooko', 'oooooooo', '.oyyyyo.', '.oooooo.', 'oo....oo']],
];
const PIXEL_COLORS: Readonly<Record<string, string>> = {
  w: '#f2f4f8', k: '#141821', b: '#5aa9ff', y: '#ffd84a', o: '#ff9a3c', r: '#ff5a5f', c: '#4fd6e8', g: '#6fdc6f', G: '#2f9e44', m: '#d070ff', a: '#ff8fc8',
  // the waiting state's exclamation mark
  e: '#ffcc33',
};
// A frame is the 8 x 8 character in a 10 x 10 square, so it can lift a pixel and show a mark beside it.
const FRAME_SIDE = 10;
// At most 6 steps a second, so no strip can flash more than three times a second (WCAG 2.3.1).
const STATE_FPS = { idle: 2, running: 6, waiting: 2 } as const;

/** `sprite` drawn into a FRAME_SIDE square at (x, y), with extra pixels of letter `mark` at `marks`. */
function frameOf(sprite: readonly string[], x: number, y: number, marks: ReadonlyArray<readonly [number, number]> = [], mark = 'e'): string[] {
  const rows = Array.from({ length: FRAME_SIDE }, () => Array.from({ length: FRAME_SIDE }, () => '.'));
  sprite.forEach((row, r) => [...row].forEach((char, c) => {
    if (char !== '.') rows[y + r]![x + c] = char;
  }));
  for (const [mx, my] of marks) rows[my]![mx] = mark;
  return rows.map((row) => row.join(''));
}

// The eyes closed: the first row holding the dark color takes the row's body color there.
function blinked(sprite: readonly string[]): string[] {
  const eyes = sprite.findIndex((row) => row.includes('k'));
  return sprite.map((row, r) => {
    if (r !== eyes) return row;
    const counts = [...row].filter((char) => char !== '.' && char !== 'k').reduce((map, char) => map.set(char, (map.get(char) ?? 0) + 1), new Map<string, number>());
    const body = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'k';
    return row.replaceAll('k', body);
  });
}

// The feet swapped: the last row mirrored.
const stepped = (sprite: readonly string[]): string[] => sprite.map((row, r) => (r === sprite.length - 1 ? [...row].reverse().join('') : row));

/** Each state's frames: idle blinks, running hops with its feet swapped, waiting shows an exclamation mark beside it. */
function stateFrames(sprite: readonly string[]): Record<keyof typeof STATE_FPS, string[][]> {
  const mark: ReadonlyArray<readonly [number, number]> = [[9, 1], [9, 2], [9, 3], [9, 5]];
  return {
    idle: [frameOf(sprite, 1, 1), frameOf(blinked(sprite), 1, 1)],
    running: [frameOf(sprite, 1, 1), frameOf(sprite, 1, 0), frameOf(stepped(sprite), 1, 1), frameOf(stepped(sprite), 1, 0)],
    waiting: [frameOf(sprite, 0, 1, mark), frameOf(sprite, 0, 1)],
  };
}

/** The frames as pixel grids of palette indices, with the palette they index. */
function indexed(frames: readonly string[][]): { readonly palette: string[]; readonly frames: string[][] } {
  const letters = [...new Set(frames.flat().join('').replaceAll('.', ''))].sort();
  return { palette: letters.map((letter) => PIXEL_COLORS[letter]!), frames: frames.map((frame) => frame.map((row) => [...row].map((char) => (char === '.' ? '.' : letters.indexOf(char).toString(16))).join(''))) };
}

// Neon on a night arcade cabinet; palette-contrast.test.ts holds it to every contrast rule.
const ARCADE_COLORS = { background: '#0d0b1a', panel: '#151229', text: '#ece8ff', accent: '#ff6bb5', success: '#5cf28a', warning: '#ffd23f', danger: '#ff6b6b', info: '#5cc8ff' } as const;
const ARCADE_LICENSE = [
  'The Arcade theme ships with Damocles under the repository\'s MIT License (see LICENSE at the repository root).',
  'Its characters are pixel grids written in scripts/generate-theme-art.ts and made into SVG sprite strips there, with no',
  'third-party image or asset; run npm run generate:theme-art to draw them again. It uses Damocles\' built-in fonts.',
  '',
].join('\n');

/** Every file of resources/themes/damocles-arcade/ as this script draws it. */
export function renderArcade(): ThemeArt {
  const files = new Map<string, Buffer>();
  const assets: Record<string, unknown> = {};
  const characters = CHARACTERS.map(([name, sprite]) => {
    const states = Object.fromEntries(Object.entries(stateFrames(sprite)).map(([state, frames]) => {
      const fps = STATE_FPS[state as keyof typeof STATE_FPS];
      const strip = pixelSpriteSvg(parsePixelSprite({ ...indexed(frames), fps }));
      const svg = Buffer.from(strip.svg);
      const sha = createHash('sha256').update(svg).digest('hex');
      files.set(`${sha}.svg`, svg);
      assets[sha] = {
        kind: 'sprite', mime: 'image/svg+xml', bytes: svg.length, width: strip.frameWidth * strip.frames, height: strip.frameHeight, frames: strip.frames,
        durationMs: Math.round((strip.frames * 1000) / strip.fps), license: { spdx: 'MIT', author: 'Damocles', source: 'scripts/generate-theme-art.ts' },
      };
      return [state, { strip: { asset: sha, frameWidth: strip.frameWidth, frameHeight: strip.frameHeight, frames: strip.frames, fps: strip.fps } }];
    }));
    return { name, states };
  });
  const theme = {
    schemaVersion: 1,
    id: 'damocles-arcade',
    name: 'Arcade',
    description: 'Neon night colors and six pixel characters for your projects, idle, running and waiting.',
    author: 'Damocles',
    license: 'MIT',
    looks: { dark: { colors: ARCADE_COLORS } },
    style: { radius: 0.5 },
    characters: { name: 'Arcade', characters },
    assets,
  };
  files.set('theme.json', Buffer.from(`${JSON.stringify(theme, null, 2)}\n`));
  files.set('LICENSE', Buffer.from(ARCADE_LICENSE));
  return { files };
}

/** Whether `dir` holds exactly `files`; writes them unless `check`. */
function sync(dir: string, files: ReadonlyMap<string, Buffer>, check: boolean): boolean {
  const name = relative(ROOT, dir);
  const committed = (() => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  })();
  const same = committed.length === files.size && [...files].every(([file, bytes]) => committed.includes(file) && readFileSync(join(dir, file)).equals(bytes));
  if (same) {
    console.log(`${name} is up to date.`);
    return true;
  }
  if (check) {
    console.error(`${name} is stale. Run: npm run generate:theme-art`);
    return false;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [file, bytes] of files) writeFileSync(join(dir, file), bytes);
  console.log(`Wrote ${name}: ${[...files].map(([file, bytes]) => `${file} (${Math.round(bytes.length / 1024)} KB)`).join(', ')}`);
  return true;
}

function main(): void {
  const check = process.argv.includes('--check');
  const results = [sync(AURORA_DIR, renderAurora().files, check), sync(ARCADE_DIR, renderArcade().files, check)];
  if (results.includes(false)) process.exit(1);
}

if (isEntryPoint(import.meta.url)) main();
