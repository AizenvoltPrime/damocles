import { describe, expect, it } from 'vitest';
import { fitSections, largestSection, moveSash, sashRange, yieldTo, type SectionSizes, type SizedSection, type SplitItem } from '../layout/section-sizes';

const STORED: SectionSizes = { projects: 180, files: 230, search: 260, repos: 220, scm: 300, graph: 190 };
// Repositories and Graph stay collapsed here, so their stored sizes carry through every result.
const ALL: SizedSection[] = ['projects', 'files', 'search', 'scm'];
const total = (sizes: SectionSizes, names: readonly SizedSection[]): number => names.reduce((sum, name) => sum + sizes[name], 0);

describe('fitSections', () => {
  it('keeps every stored size when the open sections fit', () => {
    expect(fitSections(STORED, ALL, 1000, 60)).toEqual(STORED);
  });

  it('shrinks sections that do not fit in proportion, as SplitView.layout does with its saved proportions', () => {
    const open: SizedSection[] = ['projects', 'files', 'scm'];
    const sizes = fitSections(STORED, open, 568, 60);
    // 710 in 568 is a 0.8 scale.
    expect(sizes).toEqual({ projects: 144, files: 184, search: 260, repos: 220, scm: 240, graph: 190 });
    expect(total(sizes, open)).toBeLessThanOrEqual(568);
  });

  it('holds a section at the minimum and shares what is left among the others in proportion', () => {
    const sizes = fitSections({ ...STORED, projects: 70 }, ['projects', 'files', 'scm'], 300, 60);
    expect(sizes.projects).toBe(60);
    expect(sizes.files / sizes.scm).toBeCloseTo(230 / 300, 1);
    expect(total(sizes, ['projects', 'files', 'scm'])).toBeLessThanOrEqual(300);
  });

  it('keeps every open section at the minimum when even the minimums do not fit', () => {
    expect(fitSections(STORED, ALL, 100, 60)).toEqual({ projects: 60, files: 60, search: 60, repos: 220, scm: 60, graph: 190 });
  });

  it('leaves a section outside the fixed set at its stored size, and raises a stored size below the minimum', () => {
    expect(fitSections({ ...STORED, files: 20 }, ['files'], 500, 60)).toEqual({ ...STORED, files: 60 });
  });
});

describe('yieldTo', () => {
  it('keeps the section the user expanded at its size, the others giving way from the bottom up', () => {
    // Search opens at 260 among 144 + 184 + 240 in 568: Source control gives 180 (to 60), then Files 80.
    const current = fitSections(STORED, ['projects', 'files', 'scm'], 568, 60);
    expect(yieldTo(current, ALL, 568, 60, 'search', 260)).toEqual({ projects: 144, files: 104, search: 260, repos: 220, scm: 60, graph: 190 });
  });

  it('changes nothing else when the new size fits', () => {
    expect(yieldTo(STORED, ALL, 1000, 60, 'files', 250)).toEqual({ ...STORED, files: 250 });
  });

  it('caps the changed section at what the others can give', () => {
    expect(yieldTo(STORED, ALL, 600, 60, 'projects', 900)).toEqual({ projects: 420, files: 60, search: 60, repos: 220, scm: 60, graph: 190 });
  });

  it('works from the sizes it is given, so the same start at the stored size gives the stored sizes back', () => {
    const start = fitSections(STORED, ALL, 1000, 60);
    const grown = yieldTo(start, ALL, 1000, 60, 'projects', 400);
    expect(grown.scm).toBeLessThan(300);
    expect(yieldTo(start, ALL, 1000, 60, 'projects', 180)).toEqual(STORED);
  });
});

describe('largestSection', () => {
  it('is the room less every other open section at its minimum', () => {
    expect(largestSection(ALL, 700, 60)).toBe(520);
    expect(largestSection(['files'], 700, 60)).toBe(700);
    expect(largestSection(ALL, 100, 60)).toBe(60);
  });
});

// VS Code's SplitView over a sidebar's bodies: open sections keep 60px at least, collapsed ones are 0 at 0 to 0.
const open = (size: number): SplitItem => ({ size, min: 60, max: Number.POSITIVE_INFINITY });
const COLLAPSED: SplitItem = { size: 0, min: 0, max: 0 };

describe('sashRange', () => {
  it('lets a sash beside a collapsed section move the height between the open sections past it', () => {
    const items = [open(200), COLLAPSED, COLLAPSED, open(300)];
    expect([0, 1, 2].map((index) => sashRange(items, index))).toEqual([{ min: -140, max: 240 }, { min: -140, max: 240 }, { min: -140, max: 240 }]);
  });

  it('is empty, a disabled sash, where neither side has height to give', () => {
    // nothing open above the first sash
    expect(sashRange([COLLAPSED, open(300), open(200)], 0)).toEqual({ min: 0, max: 0 });
    // every open section at its minimum
    expect(sashRange([open(60), COLLAPSED, open(60)], 1)).toEqual({ min: 0, max: 0 });
    // one way only: the sections above are at their minimum, VS Code's AtMinimum
    expect(sashRange([open(60), open(60), open(200)], 1)).toEqual({ min: 0, max: 140 });
  });
});

describe('moveSash', () => {
  it('takes from the nearest section first and then the ones past it, each down to its minimum', () => {
    const items = [open(100), open(200), COLLAPSED, open(100), open(300)];
    expect(moveSash(items, 1, 150)).toEqual([100, 350, 0, 60, 190]);
    expect(moveSash(items, 1, -100)).toEqual([100, 100, 0, 200, 300]);
    // past what the two above can give, the move stops at -180
    expect(moveSash(items, 1, -200)).toEqual([60, 60, 0, 280, 300]);
  });

  it('stops at the range and keeps the total', () => {
    const items = [open(100), COLLAPSED, open(200)];
    expect(moveSash(items, 0, 1000)).toEqual([240, 0, 60]);
    expect(moveSash(items, 1, -1000)).toEqual([60, 0, 240]);
    expect(moveSash([COLLAPSED, open(300), open(200)], 0, 50)).toEqual([0, 300, 200]);
  });
});
