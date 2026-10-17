import { describe, expect, it } from 'vitest';
import { visibleRange } from '../outer-virtual-list';

// a 24px header, then 26px rows
const tops = [0, 24, 50, 76, 102, 128, 154];

describe('visibleRange', () => {
  it('returns the items meeting the view, a partly shown item included', () => {
    expect(visibleRange(tops, 30, 50, 0)).toEqual({ start: 1, end: 4 });
    expect(visibleRange(tops, 24, 26, 0)).toEqual({ start: 1, end: 2 });
  });

  it('widens by the overscan within the list', () => {
    expect(visibleRange(tops, 60, 20, 1)).toEqual({ start: 1, end: 5 });
    expect(visibleRange(tops, 0, 1000, 5)).toEqual({ start: 0, end: 6 });
  });

  it('starts at the first item while content above the list fills the view, and renders only the overscan below it', () => {
    expect(visibleRange(tops, -100, 120, 0)).toEqual({ start: 0, end: 1 });
    expect(visibleRange(tops, -300, 120, 2)).toEqual({ start: 0, end: 2 });
  });

  it('renders only the last items once the view is past the list', () => {
    expect(visibleRange(tops, 500, 100, 1)).toEqual({ start: 5, end: 6 });
  });

  it('renders nothing for an empty list', () => {
    expect(visibleRange([0], 0, 100, 10)).toEqual({ start: 0, end: 0 });
  });
});
