import { describe, it, expect } from 'vitest';
import { addUsage, getLifetimeTotal, getSessionTokens, getSessionContextPercent } from '../usage';

describe('usage', () => {
  it('addUsage mutates the accumulator component-wise', () => {
    const acc = { input: 1, output: 2, cacheWrite: 3 };
    addUsage(acc, { input: 10, output: 20, cacheWrite: 30 });
    expect(acc).toEqual({ input: 11, output: 22, cacheWrite: 33 });
  });

  it('getLifetimeTotal sums input+output+cacheWrite (cacheRead excluded), 0 when undefined', () => {
    expect(getLifetimeTotal({ input: 5, output: 7, cacheWrite: 11 })).toBe(23);
    expect(getLifetimeTotal(undefined)).toBe(0);
  });

  it('getSessionTokens reads input+output+cacheWrite from stats; 0 on missing/throwing session', () => {
    const session = { getSessionStats: () => ({ tokens: { input: 2, output: 3, cacheWrite: 4 } }) };
    expect(getSessionTokens(session)).toBe(9);
    expect(getSessionTokens(undefined)).toBe(0);
    expect(getSessionTokens({ getSessionStats: () => { throw new Error('x'); } })).toBe(0);
  });

  it('getSessionContextPercent returns the percent or null', () => {
    expect(getSessionContextPercent({ getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 42 } }) })).toBe(42);
    expect(getSessionContextPercent({ getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }) })).toBeNull();
    expect(getSessionContextPercent(undefined)).toBeNull();
  });
});
