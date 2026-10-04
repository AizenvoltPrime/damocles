import { describe, expect, it } from 'vitest';
import { clockFormatter, formatClock, formatDateTime } from '../clock';

const AFTERNOON = new Date(2026, 4, 12, 14, 5, 9);
const PAST_MIDNIGHT = new Date(2026, 4, 12, 0, 5, 9);

describe('24-hour clock', () => {
  for (const locale of ['en', 'en-US', 'el']) {
    it(`formats ${locale} times on a 24-hour clock with no day period`, () => {
      expect(formatClock(AFTERNOON, locale)).toBe('14:05');
      expect(formatClock(PAST_MIDNIGHT, locale)).toBe('00:05');
      expect(formatClock(AFTERNOON.getTime(), locale, { seconds: true })).toBe('14:05:09');
      expect(formatClock(PAST_MIDNIGHT, locale, { seconds: true })).toBe('00:05:09');
      expect(clockFormatter(locale).format(PAST_MIDNIGHT)).toBe('00:05');

      const dateTime = formatDateTime(AFTERNOON, locale);
      expect(dateTime).toContain('14:05');
      expect(formatDateTime(PAST_MIDNIGHT, locale, { dateStyle: 'medium', seconds: true })).toContain('00:05:09');
      expect(dateTime).not.toMatch(/AM|PM|π\.μ\.|μ\.μ\./i);
    });
  }

  it('uses the runtime locale when none is given, still on a 24-hour clock', () => {
    expect(formatClock(AFTERNOON)).toMatch(/^14.05$/);
    expect(formatClock(PAST_MIDNIGHT)).toMatch(/^00.05$/);
  });
});
