import { describe, expect, it } from 'vitest';
import { dropSection, sameOrder, shiftSection } from '../layout/section-order';

const ORDER = ['projects', 'chats', 'files', 'search', 'repos', 'scm'] as const;

describe('section order', () => {
  it('drops a section above or below the target, whichever side it came from', () => {
    expect(dropSection(ORDER, 'scm', 'chats', 'before')).toEqual(['projects', 'scm', 'chats', 'files', 'search', 'repos']);
    expect(dropSection(ORDER, 'scm', 'chats', 'after')).toEqual(['projects', 'chats', 'scm', 'files', 'search', 'repos']);
    expect(dropSection(ORDER, 'projects', 'scm', 'after')).toEqual(['chats', 'files', 'search', 'repos', 'scm', 'projects']);
    expect(dropSection(ORDER, 'projects', 'scm', 'before')).toEqual(['chats', 'files', 'search', 'repos', 'projects', 'scm']);
  });

  it('leaves the order alone for a drop on the section itself or next to where it already is', () => {
    expect(dropSection(ORDER, 'files', 'files', 'before')).toBe(ORDER);
    expect(sameOrder(dropSection(ORDER, 'files', 'search', 'before'), ORDER)).toBe(true);
    expect(sameOrder(dropSection(ORDER, 'files', 'chats', 'after'), ORDER)).toBe(true);
  });

  it('swaps a section with its neighbour, and stops at either end', () => {
    expect(shiftSection(ORDER, 'files', -1)).toEqual(['projects', 'files', 'chats', 'search', 'repos', 'scm']);
    expect(shiftSection(ORDER, 'files', 1)).toEqual(['projects', 'chats', 'search', 'files', 'repos', 'scm']);
    expect(shiftSection(ORDER, 'projects', -1)).toBe(ORDER);
    expect(shiftSection(ORDER, 'scm', 1)).toBe(ORDER);
  });
});
