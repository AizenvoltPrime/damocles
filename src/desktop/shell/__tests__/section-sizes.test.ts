import { describe, expect, it } from 'vitest';
import { fitSections, largestSection, yieldTo, type SectionSizes, type SizedSection } from '../layout/section-sizes';

const STORED: SectionSizes = { projects: 180, files: 230, search: 260, scm: 300 };
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
    expect(sizes).toEqual({ projects: 144, files: 184, search: 260, scm: 240 });
    expect(total(sizes, open)).toBeLessThanOrEqual(568);
  });

  it('holds a section at the minimum and shares what is left among the others in proportion', () => {
    const sizes = fitSections({ ...STORED, projects: 70 }, ['projects', 'files', 'scm'], 300, 60);
    expect(sizes.projects).toBe(60);
    expect(sizes.files / sizes.scm).toBeCloseTo(230 / 300, 1);
    expect(total(sizes, ['projects', 'files', 'scm'])).toBeLessThanOrEqual(300);
  });

  it('keeps every open section at the minimum when even the minimums do not fit', () => {
    expect(fitSections(STORED, ALL, 100, 60)).toEqual({ projects: 60, files: 60, search: 60, scm: 60 });
  });

  it('leaves a section outside the fixed set at its stored size, and raises a stored size below the minimum', () => {
    expect(fitSections({ ...STORED, files: 20 }, ['files'], 500, 60)).toEqual({ ...STORED, files: 60 });
  });
});

describe('yieldTo', () => {
  it('keeps the section the user expanded at its size, the others giving way from the bottom up', () => {
    // Search opens at 260 among 144 + 184 + 240 in 568: Source control gives 180 (to 60), then Files 80.
    const current = fitSections(STORED, ['projects', 'files', 'scm'], 568, 60);
    expect(yieldTo(current, ALL, 568, 60, 'search', 260)).toEqual({ projects: 144, files: 104, search: 260, scm: 60 });
  });

  it('changes nothing else when the new size fits', () => {
    expect(yieldTo(STORED, ALL, 1000, 60, 'files', 250)).toEqual({ ...STORED, files: 250 });
  });

  it('caps the changed section at what the others can give', () => {
    expect(yieldTo(STORED, ALL, 600, 60, 'projects', 900)).toEqual({ projects: 420, files: 60, search: 60, scm: 60 });
  });

  it('resizes from the sizes a drag started with, so dragging back restores the others', () => {
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
