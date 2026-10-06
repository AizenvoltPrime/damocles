import { describe, expect, it } from 'vitest';
import { clockFormatter, formatClock, formatDateTime, formatResetTime } from '../clock';

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

describe('reset time', () => {
  // Wednesday 31 Dec 2025, 09:00
  const NOW = new Date(2025, 11, 31, 9, 0).getTime();

  it('shows the clock time alone for a reset later today', () => {
    expect(formatResetTime(new Date(2025, 11, 31, 23, 59).getTime(), NOW, 'en-US')).toEqual({ time: '23:59' });
  });

  it('adds the weekday for a reset within the coming week, the next calendar day included', () => {
    expect(formatResetTime(new Date(2026, 0, 1, 0, 5).getTime(), NOW, 'en-US')).toEqual({ day: 'Thursday', time: '00:05' });
    expect(formatResetTime(new Date(2026, 0, 3, 5, 0).getTime(), NOW, 'en-US')).toEqual({ day: 'Saturday', time: '05:00' });
    expect(formatResetTime(new Date(2026, 0, 6, 23, 0).getTime(), NOW, 'en-US')).toEqual({ day: 'Tuesday', time: '23:00' });
  });

  it('adds the date a week or more out, where a weekday would repeat', () => {
    expect(formatResetTime(new Date(2026, 0, 7, 9, 0).getTime(), NOW, 'en-US')).toEqual({ day: 'Jan 7', time: '09:00' });
  });
});
