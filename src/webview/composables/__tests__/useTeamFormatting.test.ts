import { describe, it, expect } from 'vitest';
import { formatCost, formatTokenCount } from '../useTeamFormatting';

describe('formatCost', () => {
  it('keeps cents, and four decimals for a nonzero amount under a cent', () => {
    expect(formatCost(0, 'en')).toBe('$0.00');
    expect(formatCost(0.0042, 'en')).toBe('$0.0042');
    expect(formatCost(0.01, 'en')).toBe('$0.01');
    expect(formatCost(26.45, 'en')).toBe('$26.45');
  });

  it('groups thousands and follows the UI locale', () => {
    expect(formatCost(1234.5, 'en')).toBe('$1,234.50');
    expect(formatCost(1234.5, 'el')).toMatch(/^1\.234,50\s\$$/);
    expect(formatCost(0.0042, 'el')).toMatch(/^0,0042\s\$$/);
  });

  it('signs a negative amount instead of treating it as under a cent', () => {
    expect(formatCost(-5, 'en')).toBe('-$5.00');
  });
});

describe('formatTokenCount', () => {
  it('abbreviates with the locale decimal separator', () => {
    expect(formatTokenCount(999, 'en')).toBe('999');
    expect(formatTokenCount(1_500, 'en')).toBe('1.5K');
    expect(formatTokenCount(2_000_000, 'en')).toBe('2.0M');
    expect(formatTokenCount(1_500, 'el')).toBe('1,5K');
  });
});
