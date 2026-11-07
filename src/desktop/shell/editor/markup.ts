import { MAX_MARKUP_STROKE_ANCHORS } from '../../../shared/design-markup';

// Geometry of markup on a frozen preview capture (PD-12). Mark coordinates are CSS px of the captured viewport at the
// frozen width, origin at its top-left, as the elements' rects are.

export type MarkupPoint = readonly [x: number, y: number];
/** x, y, width, height */
export type MarkupRect = readonly [x: number, y: number, width: number, height: number];

export interface MarkupElement {
  // the data-ds element name, such as ui/Table
  readonly element: string;
  readonly rect: MarkupRect;
  readonly facts: readonly string[];
}

/** An element covers a stroke's box when at least this share of its own area lies inside the box. */
export const COVERED_SHARE = 0.5;

const area = (rect: MarkupRect): number => rect[2] * rect[3];

function contains(rect: MarkupRect, [x, y]: MarkupPoint): boolean {
  return x >= rect[0] && x <= rect[0] + rect[2] && y >= rect[1] && y <= rect[1] + rect[3];
}

function intersection(a: MarkupRect, b: MarkupRect): number {
  const width = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The smallest element whose rect contains the point, edges included; of equal areas the later one, since a descendant
 * comes after its ancestor in document order. Null when none contains it. Empty rects never anchor.
 */
export function resolveAnchor(point: MarkupPoint, elements: readonly MarkupElement[]): MarkupElement | null {
  let best: MarkupElement | null = null;
  for (const candidate of elements) {
    if (area(candidate.rect) <= 0 || !contains(candidate.rect, point)) continue;
    if (best === null || area(candidate.rect) <= area(best.rect)) best = candidate;
  }
  return best;
}

/**
 * The element names a stroke's bounding box covers, in document order, each once: an element is covered when at least
 * COVERED_SHARE of its area lies inside the box. A box covering none names the smallest element containing the whole box,
 * so a stroke drawn inside one element still names it; none at all is an empty list.
 */
export function strokeAnchors(bbox: MarkupRect, elements: readonly MarkupElement[]): string[] {
  const names: string[] = [];
  for (const candidate of elements) {
    const own = area(candidate.rect);
    if (own <= 0 || intersection(candidate.rect, bbox) < own * COVERED_SHARE) continue;
    if (!names.includes(candidate.element)) names.push(candidate.element);
    if (names.length === MAX_MARKUP_STROKE_ANCHORS) return names;
  }
  if (names.length > 0) return names;
  const corner: MarkupPoint = [bbox[0] + bbox[2], bbox[1] + bbox[3]];
  let inside: MarkupElement | null = null;
  for (const candidate of elements) {
    if (area(candidate.rect) <= 0 || !contains(candidate.rect, [bbox[0], bbox[1]]) || !contains(candidate.rect, corner)) continue;
    if (inside === null || area(candidate.rect) <= area(inside.rect)) inside = candidate;
  }
  return inside ? [inside.element] : [];
}

/** The bounding box of a shape's points: a pen's whole path, or an arrow's or a box's drag from its start to its end. */
export function shapeBox(points: readonly MarkupPoint[]): MarkupRect {
  if (points.length === 0) return [0, 0, 0, 0];
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return [left, top, right - left, bottom - top];
}

const mid = (a: MarkupPoint, b: MarkupPoint): MarkupPoint => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** A pen path as one SVG path: quadratic curves through the midpoints of the kept points. */
export function penPath(points: readonly MarkupPoint[]): string {
  const [first] = points;
  if (!first) return '';
  const parts = [`M${first[0]} ${first[1]}`];
  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index]!;
    const next = mid(point, points[index + 1]!);
    parts.push(`Q${point[0]} ${point[1]} ${next[0]} ${next[1]}`);
  }
  const last = points[points.length - 1]!;
  if (points.length > 1) parts.push(`L${last[0]} ${last[1]}`);
  return parts.join(' ');
}

const ARROW_WING_RADIANS = (28 * Math.PI) / 180;

/** The two wing tips of an open arrow head at `head`, each `wing` long at ±28° from the shaft. */
export function arrowWings(tail: MarkupPoint, head: MarkupPoint, wing: number): [MarkupPoint, MarkupPoint] {
  const back = Math.atan2(tail[1] - head[1], tail[0] - head[0]);
  const tip = (angle: number): MarkupPoint => [head[0] + wing * Math.cos(angle), head[1] + wing * Math.sin(angle)];
  return [tip(back - ARROW_WING_RADIANS), tip(back + ARROW_WING_RADIANS)];
}

/** The shaft then the head in one path, so a dash animation traces the shaft before the head. */
export function arrowPath(tail: MarkupPoint, head: MarkupPoint, wing: number): string {
  const [left, right] = arrowWings(tail, head, wing);
  return `M${tail[0]} ${tail[1]} L${head[0]} ${head[1]} M${left[0]} ${left[1]} L${head[0]} ${head[1]} L${right[0]} ${right[1]}`;
}

/** The end of a drag from `start` snapped to the nearest 45° direction, keeping its length. */
export function snapAngle(start: MarkupPoint, end: MarkupPoint): MarkupPoint {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [start[0] + length * Math.cos(angle), start[1] + length * Math.sin(angle)];
}

/** The end of a box drag from `start` made square, on the side of the longer move. */
export function squareEnd(start: MarkupPoint, end: MarkupPoint): MarkupPoint {
  const side = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]));
  return [start[0] + Math.sign(end[0] - start[0] || 1) * side, start[1] + Math.sign(end[1] - start[1] || 1) * side];
}

export interface FrozenImage {
  // the frozen CSS px viewport width, which the capture covers exactly
  readonly width: number;
  // the capture's px, at its own scale; never derive it from the view's zoom or the screen's pixel ratio
  readonly imageWidth: number;
  readonly imageHeight: number;
}

/** Image px per CSS px of the capture. */
export function imageScale(image: FrozenImage): number {
  return image.imageWidth / image.width;
}

/** The captured viewport's size in CSS px. */
export function cssSize(image: FrozenImage): { width: number; height: number } {
  return { width: image.width, height: image.imageHeight / imageScale(image) };
}

/**
 * A point on the image as displayed (shell px from its displayed box's top-left; the box shows the whole image unclipped
 * at displayedWidth wide) in CSS px of the capture, clamped to it, to 0.1 px.
 */
export function displayedToCss(point: MarkupPoint, displayedWidth: number, image: FrozenImage): MarkupPoint {
  const perShellPx = cssSize(image).width / displayedWidth;
  return clampPoint([point[0] * perShellPx, point[1] * perShellPx], image);
}

/** A point kept on the capture, to 0.1 CSS px. */
export function clampPoint(point: MarkupPoint, image: FrozenImage): MarkupPoint {
  const size = cssSize(image);
  const clamp = (value: number, max: number): number => Math.round(Math.min(max, Math.max(0, value)) * 10) / 10;
  return [clamp(point[0], size.width), clamp(point[1], size.height)];
}

export interface PinPopoverSizes {
  readonly pin: number;
  // the popover's own width, before the layer narrows it
  readonly popover: number;
  // the popover's offset from the pin
  readonly gap: number;
  // the space the popover keeps from the layer's edges
  readonly padding: number;
}

/**
 * The side a pin's popover opens on, from the layer's width and the pin's center in it (shell px): beside the pin when that
 * side holds the popover whole, right first, else below, where the popover is at most the layer's width less its padding.
 */
export function pinPopoverSide(layerWidth: number, pinCenter: number, sizes: PinPopoverSizes): 'right' | 'left' | 'bottom' {
  const width = Math.max(0, Math.min(sizes.popover, layerWidth - 2 * sizes.padding));
  const reach = sizes.pin / 2 + sizes.gap + width + sizes.padding;
  if (pinCenter + reach <= layerWidth) return 'right';
  if (pinCenter - reach >= 0) return 'left';
  return 'bottom';
}
