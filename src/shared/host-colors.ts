import { canonicalHexColor, hexColorParts, isHexColor, type HexColor } from './hex-color';

// A host's safety color: a palette tone with a --d-<tone>-text shade and a --d-on-<tone> label color (safety-colors.test.ts),
// or a custom #rrggbbaa color that `.d-tone-custom` in src/webview/style.css renders.
export const HOST_TONES = ['accent', 'success', 'warning', 'danger', 'info'] as const;
export type HostTone = (typeof HOST_TONES)[number];

declare const CUSTOM_HOST_COLOR: unique symbol;
/** A `#rrggbbaa` color above zero opacity; only `canonicalHostColor` and `isHostColor` produce one. */
export type CustomHostColor = HexColor & { readonly [CUSTOM_HOST_COLOR]: true };
export type HostColor = HostTone | CustomHostColor;

export const isHostTone = (value: unknown): value is HostTone => (HOST_TONES as readonly unknown[]).includes(value);

const isTransparent = (color: HexColor): boolean => color.endsWith('00');

// A custom color lands in inline style, so isHexColor's exact pattern is the CSS injection guard at every boundary.
export const isHostColor = (value: unknown): value is HostColor => isHostTone(value) || (isHexColor(value) && !isTransparent(value));

/** The stored form of a `#rrggbb` or `#rrggbbaa` string in any case; null at zero opacity, which reads as no color. */
export function canonicalHostColor(text: HexColor): CustomHostColor | null;
export function canonicalHostColor(text: string): CustomHostColor | null | undefined;
export function canonicalHostColor(text: string): CustomHostColor | null | undefined {
  const hex = canonicalHexColor(text);
  if (hex === undefined) return undefined;
  return isTransparent(hex) ? null : (hex as CustomHostColor);
}

export interface HostColorLook {
  class: string;
  style?: Record<string, string>;
}

/** The tone class, plus the custom color's channels that `.d-tone-custom` reads; `untinted` is the tone of a host with no color. */
export function hostColorLook(color: HostColor | undefined, untinted: HostTone | 'muted' = 'muted'): HostColorLook {
  if (color === undefined) return { class: `d-tone-${untinted}` };
  if (isHostTone(color)) return { class: `d-tone-${color}` };
  const { r, g, b, alpha } = hexColorParts(color);
  return { class: 'd-tone-custom', style: { '--host-rgb': `${r} ${g} ${b}`, '--host-alpha': String(alpha) } };
}

export function hostColorDataTone(color: HostColor): HostTone | 'custom' {
  return isHostTone(color) ? color : 'custom';
}
