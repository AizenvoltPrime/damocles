import { describe, expect, it } from 'vitest';
import { MAX_MARKUP_STROKE_ANCHORS } from '../../../shared/design-markup';
import { arrowPath, arrowWings, clampPoint, cssSize, displayedToCss, imageScale, penPath, pinPopoverSide, resolveAnchor, shapeBox, snapAngle, squareEnd, strokeAnchors, type MarkupElement } from '../editor/markup';

const el = (element: string, rect: [number, number, number, number]): MarkupElement => ({ element, rect, facts: [] });

// The fixture's contacts screen at 1280: the main column, a table, its rows and cells, and a button above the table.
const SCREEN: MarkupElement[] = [
  el('layout/Main', [0, 0, 1280, 900]),
  el('ui/Button', [40, 80, 120, 36]),
  el('ui/Table', [40, 140, 1200, 400]),
  el('ui/TableCell', [40, 180, 300, 40]),
];

describe('resolveAnchor', () => {
  it('anchors a point on a table row to ui/Table, the smallest element containing it', () => {
    expect(resolveAnchor([700, 200], SCREEN)?.element).toBe('ui/Table');
  });

  it('takes the innermost of nested elements', () => {
    expect(resolveAnchor([100, 200], SCREEN)?.element).toBe('ui/TableCell');
    expect(resolveAnchor([10, 10], SCREEN)?.element).toBe('layout/Main');
  });

  it('counts the edges as inside', () => {
    expect(resolveAnchor([40, 140], SCREEN)?.element).toBe('ui/Table');
    expect(resolveAnchor([1240, 540], SCREEN)?.element).toBe('ui/Table');
  });

  it('prefers the later of equal rects, as a descendant follows its ancestor in document order', () => {
    expect(resolveAnchor([5, 5], [el('ui/Card', [0, 0, 10, 10]), el('ui/CardBody', [0, 0, 10, 10])])?.element).toBe('ui/CardBody');
  });

  it('is null outside every element, and never anchors to an empty rect', () => {
    expect(resolveAnchor([1300, 10], SCREEN)).toBeNull();
    expect(resolveAnchor([5, 5], [el('ui/Hidden', [5, 5, 0, 0])])).toBeNull();
  });
});

describe('strokeAnchors', () => {
  it('lists every element at least half inside the box, in document order', () => {
    // Covers the button whole and the table cell whole; the table is far less than half inside, the main column too.
    expect(strokeAnchors([30, 70, 320, 160], SCREEN)).toEqual(['ui/Button', 'ui/TableCell']);
  });

  it('counts exactly half as covered and just under half as not', () => {
    const half = [el('ui/Button', [0, 0, 100, 10])];
    expect(strokeAnchors([0, 0, 50, 10], half)).toEqual(['ui/Button']);
    // Starts left of the button, so no element holds the whole box either.
    expect(strokeAnchors([-1, 0, 50, 10], half)).toEqual([]);
  });

  it('names a repeated element once', () => {
    const rows = [el('ui/TableRow', [0, 0, 100, 20]), el('ui/TableRow', [0, 20, 100, 20])];
    expect(strokeAnchors([0, 0, 100, 40], rows)).toEqual(['ui/TableRow']);
  });

  it('names the smallest element holding the whole box when the box covers none', () => {
    expect(strokeAnchors([600, 300, 80, 40], SCREEN)).toEqual(['ui/Table']);
  });

  it('is empty for a box on no element', () => {
    expect(strokeAnchors([1290, 10, 20, 20], SCREEN)).toEqual([]);
  });

  it('stops at the anchor cap', () => {
    const many = Array.from({ length: MAX_MARKUP_STROKE_ANCHORS + 5 }, (_, index) => el(`ui/Item${index}`, [index * 10, 0, 10, 10]));
    expect(strokeAnchors([0, 0, 1000, 10], many)).toHaveLength(MAX_MARKUP_STROKE_ANCHORS);
  });
});

describe('shapeBox', () => {
  it('bounds a pen path', () => {
    expect(shapeBox([[10, 20], [40, 5], [25, 60]])).toEqual([10, 5, 30, 55]);
  });

  it('bounds a drag in any direction', () => {
    expect(shapeBox([[200, 150], [120, 90]])).toEqual([120, 90, 80, 60]);
  });

  it('is an empty box at the origin for no points', () => {
    expect(shapeBox([])).toEqual([0, 0, 0, 0]);
  });
});

describe('displayed image to CSS px', () => {
  // 1280 × 900 CSS px captured at scale 0.9: the image is 1152 × 810.
  const capture = { width: 1280, imageWidth: 1152, imageHeight: 810 };

  it('derives the capture scale and its CSS size from the frozen width', () => {
    expect(imageScale(capture)).toBeCloseTo(0.9);
    expect(cssSize(capture)).toEqual({ width: 1280, height: 900 });
  });

  it('maps a point on the displayed image through the displayed scale, whatever the capture density', () => {
    // Shown 640 shell px wide: one shell px is two CSS px.
    expect(displayedToCss([320, 100], 640, capture)).toEqual([640, 200]);
    expect(displayedToCss([320, 100], 640, { width: 1280, imageWidth: 2560, imageHeight: 1800 })).toEqual([640, 200]);
  });

  it('clamps to the capture', () => {
    expect(displayedToCss([700, -5], 640, capture)).toEqual([1280, 0]);
    expect(displayedToCss([10, 460], 640, capture)).toEqual([20, 900]);
  });

  it('is the identity for a capture at 1:1 shown at its own size', () => {
    expect(displayedToCss([123.45, 67.89], 1280, { width: 1280, imageWidth: 1280, imageHeight: 800 })).toEqual([123.5, 67.9]);
  });
});

describe('stroke shapes', () => {
  it('smooths a pen path through the midpoints and ends on the last point', () => {
    expect(penPath([[0, 0], [10, 0], [10, 10], [20, 10]])).toBe('M0 0 Q10 0 10 5 Q10 10 15 10 L20 10');
    expect(penPath([[1, 2]])).toBe('M1 2');
    expect(penPath([])).toBe('');
  });

  it('draws an arrow head of two wings at ±28° behind the head', () => {
    const [left, right] = arrowWings([0, 0], [100, 0], 10);
    expect(left[0]).toBeCloseTo(100 - 10 * Math.cos((28 * Math.PI) / 180));
    expect(Math.abs(left[1])).toBeCloseTo(10 * Math.sin((28 * Math.PI) / 180));
    expect(right[1]).toBeCloseTo(-left[1]);
    expect(arrowPath([0, 0], [100, 0], 10).startsWith('M0 0 L100 0 M')).toBe(true);
  });

  it('snaps a drag to 45° steps and a box to a square', () => {
    const snapped = snapAngle([0, 0], [100, 10]);
    expect(snapped[0]).toBeCloseTo(Math.hypot(100, 10));
    expect(snapped[1]).toBeCloseTo(0);
    expect(squareEnd([10, 10], [0, 40])).toEqual([-20, 40]);
  });

  it('keeps a point on the capture', () => {
    expect(clampPoint([-3, 2000], { width: 1280, imageWidth: 1280, imageHeight: 900 })).toEqual([0, 900]);
  });
});

describe('pinPopoverSide', () => {
  // 16 px rem: a 24 px pin, a 288 px popover, 8 px from the pin and from the layer's edges, so 316 px from the pin's center.
  const SIZES = { pin: 24, popover: 288, gap: 8, padding: 8 };

  it('opens right when the right holds the popover, else left', () => {
    expect(pinPopoverSide(640, 324, SIZES)).toBe('right');
    expect(pinPopoverSide(640, 325, SIZES)).toBe('left');
    expect(pinPopoverSide(640, 316, SIZES)).toBe('right');
  });

  it('opens below when neither side holds it, as at the base breakpoint\'s 390 px', () => {
    // the measured case: a 388 px layer with its pin 189 px in
    expect(pinPopoverSide(388, 189, SIZES)).toBe('bottom');
    expect(pinPopoverSide(630, 315, SIZES)).toBe('bottom');
  });

  it('measures a layer narrower than the popover with the popover narrowed to it, which no side holds', () => {
    expect(pinPopoverSide(250, 12, SIZES)).toBe('bottom');
    expect(pinPopoverSide(0, 12, SIZES)).toBe('bottom');
  });
});
