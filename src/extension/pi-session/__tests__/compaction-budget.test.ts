import { describe, it, expect } from 'vitest';
import type { AutoCompactConfig } from '../../../shared/types/settings';
import { resolveCompactionBudget } from '../compaction-budget';

const WINDOW = 200_000;

function cfg(extra?: Partial<AutoCompactConfig>): AutoCompactConfig {
  return { enabled: true, triggerPercent: 80, ...extra };
}

describe('resolveCompactionBudget', () => {
  it('reproduces the plain trigger percent when there are no model overrides', () => {
    expect(resolveCompactionBudget(cfg(), 'claude-opus-4-8', WINDOW)).toEqual({
      triggerPercent: 80,
      reserveTokens: 40_000,
    });
  });

  it('uses the active model entry and ignores an entry for another model', () => {
    const withOverride = cfg({ modelOverrides: { 'claude-opus-4-8': { triggerPercent: 55 } } });
    expect(resolveCompactionBudget(withOverride, 'claude-opus-4-8', WINDOW).reserveTokens).toBe(90_000);

    const otherModel = cfg({ modelOverrides: { 'gpt-6-sol': { triggerPercent: 55 } } });
    expect(resolveCompactionBudget(otherModel, 'claude-opus-4-8', WINDOW).reserveTokens).toBe(40_000);
  });

  it('leaves keepRecentTokens absent when the entry sets only triggerPercent', () => {
    const budget = resolveCompactionBudget(
      cfg({ modelOverrides: { 'claude-opus-4-8': { triggerPercent: 60 } } }),
      'claude-opus-4-8',
      WINDOW,
    );
    expect(budget).toEqual({ triggerPercent: 60, reserveTokens: 80_000 });
    expect('keepRecentTokens' in budget).toBe(false);
  });

  it('keeps the plain trigger percent when the entry sets only keepRecentPercent', () => {
    expect(
      resolveCompactionBudget(
        cfg({ modelOverrides: { 'claude-opus-4-8': { keepRecentPercent: 10 } } }),
        'claude-opus-4-8',
        WINDOW,
      ),
    ).toEqual({ triggerPercent: 80, reserveTokens: 40_000, keepRecentTokens: 20_000 });
  });

  it('matches the model value exactly, with no normalization', () => {
    const budget = resolveCompactionBudget(
      cfg({ modelOverrides: { 'Claude-Opus-4-8': { triggerPercent: 55 } } }),
      'claude-opus-4-8',
      WINDOW,
    );
    expect(budget.reserveTokens).toBe(40_000);
  });
});

/**
 * `damocles.autoCompact` is declared `type: object`, so VS Code enforces none of its nested `minimum`
 * / `maximum` bounds on the value handed to `get()`. Every case here is a settings file a user can
 * write today, and each one reaches pi's `getCompactionTokenSetting`, which throws for anything that
 * is not a non-negative safe integer.
 */
describe('resolveCompactionBudget — malformed settings', () => {
  const badTriggers: [string, unknown][] = [
    ['NaN', Number.NaN],
    ['a string', 'eighty'],
    ['null', null],
    ['an object', {}],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
  ];

  it.each(badTriggers)('falls back to the contribution default for a triggerPercent of %s', (_label, value) => {
    const budget = resolveCompactionBudget(
      cfg({ triggerPercent: value as number }),
      'claude-opus-4-8',
      WINDOW,
    );
    expect(budget.triggerPercent).toBe(80);
    expect(budget.reserveTokens).toBe(40_000);
  });

  it.each(badTriggers)('falls back to the plain trigger percent for a model override of %s', (_label, value) => {
    const budget = resolveCompactionBudget(
      cfg({ triggerPercent: 70, modelOverrides: { 'claude-opus-4-8': { triggerPercent: value as number } } }),
      'claude-opus-4-8',
      WINDOW,
    );
    expect(budget.triggerPercent).toBe(70);
    expect(budget.reserveTokens).toBe(60_000);
  });

  it('clamps a zero trigger percent up to the minimum instead of reserving the whole window', () => {
    const budget = resolveCompactionBudget(cfg({ triggerPercent: 0 }), 'claude-opus-4-8', WINDOW);
    expect(budget.triggerPercent).toBe(50);
    expect(budget.reserveTokens).toBe(100_000);
    expect(budget.reserveTokens).toBeLessThan(WINDOW);
  });

  it('clamps trigger percents on both sides of the contributed range', () => {
    expect(resolveCompactionBudget(cfg({ triggerPercent: -40 }), 'claude-opus-4-8', WINDOW).triggerPercent).toBe(50);
    expect(resolveCompactionBudget(cfg({ triggerPercent: 200 }), 'claude-opus-4-8', WINDOW).triggerPercent).toBe(95);
    expect(resolveCompactionBudget(cfg({ triggerPercent: 200 }), 'claude-opus-4-8', WINDOW).reserveTokens).toBe(10_000);
  });

  it('emits a reserve pi accepts for every malformed trigger percent', () => {
    for (const [, value] of [...badTriggers, ['negative', -40], ['huge', 1e9]] as [string, unknown][]) {
      const { reserveTokens } = resolveCompactionBudget(cfg({ triggerPercent: value as number }), 'claude-opus-4-8', WINDOW);
      expect(Number.isSafeInteger(reserveTokens)).toBe(true);
      expect(reserveTokens).toBeGreaterThan(0);
    }
  });

  it('omits keepRecentTokens for a keepRecentPercent that is not a usable number', () => {
    for (const value of [Number.NaN, 'ten', null, {}, Number.POSITIVE_INFINITY]) {
      const budget = resolveCompactionBudget(
        cfg({ modelOverrides: { 'claude-opus-4-8': { keepRecentPercent: value as number } } }),
        'claude-opus-4-8',
        WINDOW,
      );
      expect('keepRecentTokens' in budget).toBe(false);
    }
  });

  it('clamps keepRecentPercent into the contributed range', () => {
    const atFloor = resolveCompactionBudget(
      cfg({ modelOverrides: { 'claude-opus-4-8': { keepRecentPercent: 0 } } }),
      'claude-opus-4-8',
      WINDOW,
    );
    expect(atFloor.keepRecentTokens).toBe(2_000);

    const atCeiling = resolveCompactionBudget(
      cfg({ modelOverrides: { 'claude-opus-4-8': { keepRecentPercent: 900 } } }),
      'claude-opus-4-8',
      WINDOW,
    );
    expect(atCeiling.keepRecentTokens).toBe(100_000);
  });

  it('keeps strictly less than the post-compaction budget at the schema extremes', () => {
    // 50% trigger with 50% kept: compaction that keeps exactly the threshold it crossed re-triggers on
    // the next turn.
    const budget = resolveCompactionBudget(
      cfg({ triggerPercent: 50, modelOverrides: { 'claude-opus-4-8': { keepRecentPercent: 50 } } }),
      'claude-opus-4-8',
      WINDOW,
    );
    expect(budget.reserveTokens).toBe(100_000);
    expect(budget.keepRecentTokens).toBe(99_999);
    expect(budget.keepRecentTokens!).toBeLessThan(WINDOW - budget.reserveTokens);
  });
});
