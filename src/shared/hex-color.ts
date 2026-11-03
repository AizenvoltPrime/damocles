declare const HEX_COLOR: unique symbol;

/** A color written exactly `#rrggbbaa` in lowercase; only `isHexColor` and `canonicalHexColor` produce one. */
export type HexColor = `#${string}` & { readonly [HEX_COLOR]: true };

const HEX_COLOR_PATTERN = /^#[0-9a-f]{8}$/;

export const isHexColor = (value: unknown): value is HexColor => typeof value === 'string' && HEX_COLOR_PATTERN.test(value);

/** The `#rrggbbaa` form of a `#rrggbb` or `#rrggbbaa` string in any case; six digits mean full opacity. */
export function canonicalHexColor(text: string): HexColor | undefined {
  if (!/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return undefined;
  const lower = text.toLowerCase();
  return (lower.length === 7 ? `${lower}ff` : lower) as HexColor;
}

/** r, g and b are 0-255; alpha is 0-1. */
export function hexColorParts(color: HexColor): { r: number; g: number; b: number; alpha: number } {
  const channel = (at: number): number => Number.parseInt(color.slice(at, at + 2), 16);
  return { r: channel(1), g: channel(3), b: channel(5), alpha: channel(7) / 255 };
}
