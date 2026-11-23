// Color math for themes: hex, sRGB, linear sRGB, OKLab and OKLCH (Bjorn Ottosson's matrices), CSS color-mix and compositing.

/** sRGB channels and alpha, each 0 to 1. */
export type Rgba = readonly [number, number, number, number];
export interface Oklab { readonly l: number; readonly a: number; readonly b: number }
/** Hue in degrees. */
export interface Oklch { readonly l: number; readonly c: number; readonly h: number }

export const TRANSPARENT: Rgba = [0, 0, 0, 0];
export const BLACK: Rgba = [0, 0, 0, 1];
export const WHITE: Rgba = [1, 1, 1, 1];

const HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;

/** `#rrggbb` or `#rrggbbaa` in any case; undefined for anything else. */
export function parseHex(hex: string): Rgba | undefined {
  const match = HEX.exec(hex);
  if (!match) return undefined;
  const digits = match[1]! + (match[2] ?? 'ff');
  const channel = (i: number): number => Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255;
  return [channel(0), channel(1), channel(2), channel(3)];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const byte = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');

/** Lowercase `#rrggbb` when opaque, else `#rrggbbaa`. */
export function formatHex(c: Rgba): string {
  const alpha = byte(c[3]);
  return `#${byte(c[0])}${byte(c[1])}${byte(c[2])}${alpha === 'ff' ? '' : alpha}`;
}

/** The color a hex round trip gives, so a contrast check sees the value that ships. */
export const quantize = (c: Rgba): Rgba => parseHex(formatHex(c))!;

export const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const fromLinear = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function toOklab(c: Rgba): Oklab {
  const [r, g, b] = [toLinear(c[0]), toLinear(c[1]), toLinear(c[2])];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Unclamped sRGB; a channel outside 0..1 means the color is out of gamut. */
export function fromOklab(lab: Oklab, alpha = 1): Rgba {
  const l = (lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
  const m = (lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
  const s = (lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  ];
}

export function toOklch(c: Rgba): Oklch {
  const { l, a, b } = toOklab(c);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { l, c: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

const EPSILON = 1e-6;
const inGamut = (c: Rgba): boolean => c.slice(0, 3).every((v) => v >= -EPSILON && v <= 1 + EPSILON);
const fromLch = ({ l, c, h }: Oklch, alpha: number): Rgba => {
  const rad = (h * Math.PI) / 180;
  return fromOklab({ l, a: c * Math.cos(rad), b: c * Math.sin(rad) }, alpha);
};

/** The sRGB color of an OKLCH value, its chroma reduced at the same lightness and hue until it fits the gamut. */
export function fromOklch(lch: Oklch, alpha = 1): Rgba {
  const l = clamp01(lch.l);
  const exact = fromLch({ ...lch, l }, alpha);
  if (inGamut(exact)) return clampRgba(exact);
  let [lo, hi] = [0, lch.c];
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(fromLch({ l, c: mid, h: lch.h }, alpha))) lo = mid;
    else hi = mid;
  }
  return clampRgba(fromLch({ l, c: lo, h: lch.h }, alpha));
}

const clampRgba = (c: Rgba): Rgba => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), clamp01(c[3])];

/** OKLab distance scaled by 100, the usual deltaE OK scale (about 2 is a just noticeable difference). */
export function deltaE(a: Rgba, b: Rgba): number {
  const [x, y] = [toOklab(a), toOklab(b)];
  return Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b) * 100;
}

// color-mix(in srgb, a p, b): interpolates premultiplied channels, so mixing toward transparent keeps a's color at alpha p.
export function colorMix(a: Rgba, p: number, b: Rgba): Rgba {
  const alpha = a[3] * p + b[3] * (1 - p);
  if (alpha === 0) return TRANSPARENT;
  const channel = (i: 0 | 1 | 2): number => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

/** A translucent color painted over an opaque surface. */
export function over(top: Rgba, surface: Rgba): Rgba {
  return colorMix([top[0], top[1], top[2], 1], top[3], surface);
}

export const withAlpha = (c: Rgba, alpha: number): Rgba => [c[0], c[1], c[2], alpha];
