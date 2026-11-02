import { describe, expect, it } from 'vitest';
import { fuseRankedLists, RRF_K } from '../rank-fusion';

describe('fuseRankedLists', () => {
  it('interleaves two lists by position alone, the first list winning a tie', () => {
    expect(fuseRankedLists([['p1', 'p2', 'p3'], ['g1', 'g2']])).toEqual(['p1', 'g1', 'p2', 'g2', 'p3']);
  });

  it('ranks an id both lists hold above ids only one list holds', () => {
    expect(fuseRankedLists([['a', 'b', 'shared'], ['shared', 'c']])[0]).toBe('shared');
  });

  it('scores each id as the sum of 1 / (k + rank)', () => {
    const fused = fuseRankedLists([['x', 'y'], ['y']]);
    expect(fused).toEqual(['y', 'x']);
    // with k = 60, two third places (2/63) outrank one first place (1/61); with a small k the first places would lead
    expect(RRF_K).toBe(60);
    expect(fuseRankedLists([['x', 'a', 'z'], ['b', 'c', 'z']])).toEqual(['z', 'x', 'b', 'a', 'c']);
  });

  it('ignores a repeat of an id within one list', () => {
    expect(fuseRankedLists([['a', 'a', 'b'], ['b']])).toEqual(['b', 'a']);
  });

  it('keeps one list as it is', () => {
    expect(fuseRankedLists([['c', 'a', 'b']])).toEqual(['c', 'a', 'b']);
    expect(fuseRankedLists([[], []])).toEqual([]);
  });
});
