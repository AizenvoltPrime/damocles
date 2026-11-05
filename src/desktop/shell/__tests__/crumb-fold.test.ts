import { describe, expect, it } from 'vitest';
import { foldCrumbs } from '../editor/crumb-fold';

// Crumbs: the first, three folders of 30, 40 and 50, the file; 10 between two crumbs, 12 for the ellipsis.
const WIDTHS = [20, 30, 40, 50, 60];
const SEPARATOR = 10;
const ELLIPSIS = 12;
// 200 of crumbs and 4 separators
const WHOLE = 240;
// the first, the ellipsis and the file with their separators
const FLOOR = 20 + 10 + 12 + 10 + 60;

describe('foldCrumbs', () => {
  it('folds nothing when every crumb fits', () => {
    expect(foldCrumbs(WIDTHS, WHOLE, SEPARATOR, ELLIPSIS)).toBe(0);
    expect(foldCrumbs(WIDTHS, 1000, SEPARATOR, ELLIPSIS)).toBe(0);
  });

  it('folds only the first folder when the rest fit beside the ellipsis', () => {
    expect(foldCrumbs(WIDTHS, WHOLE - 1, SEPARATOR, ELLIPSIS)).toBe(1);
    expect(foldCrumbs(WIDTHS, FLOOR + 50 + 10 + 40 + 10, SEPARATOR, ELLIPSIS)).toBe(1);
  });

  it('folds the leading folders and keeps as many trailing folders as fit, each whole', () => {
    expect(foldCrumbs(WIDTHS, FLOOR + 50 + 10 + 40 + 9, SEPARATOR, ELLIPSIS)).toBe(2);
    expect(foldCrumbs(WIDTHS, FLOOR + 50 + 10, SEPARATOR, ELLIPSIS)).toBe(2);
  });

  it('keeps a trailing run: a narrower folder before one that does not fit stays folded', () => {
    expect(foldCrumbs([20, 5, 200, 60], 20 + 10 + 12 + 10 + 60 + 10 + 5 + 50, SEPARATOR, ELLIPSIS)).toBe(2);
  });

  it('folds every folder when only the first crumb, the ellipsis and the file fit', () => {
    expect(foldCrumbs(WIDTHS, FLOOR + 59, SEPARATOR, ELLIPSIS)).toBe(3);
    expect(foldCrumbs(WIDTHS, FLOOR, SEPARATOR, ELLIPSIS)).toBe(3);
  });

  it('folds every folder when the file alone is too wide, leaving the truncation to the row', () => {
    expect(foldCrumbs(WIDTHS, 40, SEPARATOR, ELLIPSIS)).toBe(3);
    expect(foldCrumbs([20, 30, 900], 300, SEPARATOR, ELLIPSIS)).toBe(1);
  });

  it('never folds a path with no folder between the first crumb and the file', () => {
    expect(foldCrumbs([20, 900], 100, SEPARATOR, ELLIPSIS)).toBe(0);
    expect(foldCrumbs([900], 100, SEPARATOR, ELLIPSIS)).toBe(0);
    expect(foldCrumbs([], 100, SEPARATOR, ELLIPSIS)).toBe(0);
  });
});
