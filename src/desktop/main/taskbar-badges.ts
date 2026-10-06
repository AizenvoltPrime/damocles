import { nativeImage, type NativeImage } from 'electron';
import type { RasterArt } from '../preload/overlay-channels';
import { badgeArt } from './notification-art';

export interface TaskbarBadgesDeps {
  // the overlay's PNG of the art, already validated, or undefined
  readonly rasterize: (art: RasterArt) => Promise<Buffer | undefined>;
  // the primary display's, whose taskbar draws the overlay icon at 16 px times it
  readonly scaleFactor: () => number;
  // #rrggbb
  readonly colors: { readonly fill: string; readonly text: string };
  readonly log: (line: string) => void;
}

/** The decoded image when it is exactly width × height; a decode Chromium refuses is empty. */
function decoded(png: Buffer, width: number, height: number): NativeImage | undefined {
  const image = nativeImage.createFromBuffer(png, { scaleFactor: 1 });
  if (image.isEmpty()) return undefined;
  const size = image.getSize();
  return size.width === width && size.height === height ? image : undefined;
}

// A filled circle in the badge colour with no count, drawn without the overlay: Skia's N32 order (BGRA), premultiplied.
function fallbackDot(hex: string, size: number): NativeImage {
  const [red, green, blue] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4;
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const dx = x + (sx + 0.5) / samples - radius;
          const dy = y + (sy + 0.5) / samples - radius;
          if (dx * dx + dy * dy <= radius * radius) inside++;
        }
      }
      const alpha = inside / (samples * samples);
      const at = (y * size + x) * 4;
      pixels[at] = Math.round(blue * alpha);
      pixels[at + 1] = Math.round(green * alpha);
      pixels[at + 2] = Math.round(red * alpha);
      pixels[at + 3] = Math.round(255 * alpha);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

/**
 * The Windows taskbar badge per count label, drawn by the overlay once at the display's scale; a plain dot when it cannot
 * draw one. Electron hands Windows one HICON made of an image's 1x representation, so the image is a single representation
 * holding the device pixels.
 */
export class TaskbarBadges {
  private readonly deps: TaskbarBadgesDeps;
  // by label and pixel size
  private readonly images = new Map<string, NativeImage>();
  private readonly dots = new Map<number, NativeImage>();

  constructor(deps: TaskbarBadgesDeps) {
    this.deps = deps;
  }

  async badge(label: string): Promise<NativeImage> {
    const art = badgeArt(label, this.deps.scaleFactor(), this.deps.colors);
    const key = `${label}@${art.width}`;
    const cached = this.images.get(key);
    if (cached) return cached;
    const png = await this.deps.rasterize(art);
    const image = png ? decoded(png, art.width, art.height) : undefined;
    if (!image) {
      this.deps.log(`[notifications] drawing the taskbar badge "${label}" failed; showing a dot`);
      let dot = this.dots.get(art.width);
      if (!dot) {
        dot = fallbackDot(this.deps.colors.fill, art.width);
        this.dots.set(art.width, dot);
      }
      return dot;
    }
    this.images.set(key, image);
    return image;
  }
}
