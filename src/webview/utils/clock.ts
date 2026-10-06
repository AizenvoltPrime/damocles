// Every clock time renders on a 24-hour clock in every locale. hourCycle 'h23', not hour12: false, which some engines
// render as "24:05" just after midnight.

/** A formatter for a clock time, "14:05" or with seconds "14:05:09"; undefined locale is the runtime's. */
export function clockFormatter(locale?: string, options: { seconds?: boolean } = {}): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' as const } : {}),
    hourCycle: 'h23',
  });
}

export function formatClock(time: Date | number, locale?: string, options: { seconds?: boolean } = {}): string {
  return clockFormatter(locale, options).format(time);
}

const DAY_MS = 86_400_000;

/**
 * When a usage window resets, as Subscription usage and notifications word it: the clock time alone on `now`'s day,
 * with the weekday within the coming week, with the date further out (a monthly window).
 */
export function formatResetTime(time: number, now: number, locale?: string): { day?: string; time: string } {
  const clock = formatClock(time, locale);
  const today = new Date(now);
  if (new Date(time).toDateString() === today.toDateString()) return { time: clock };
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const day = time - startOfToday < 7 * DAY_MS
    ? new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(time)
    : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(time);
  return { day, time: clock };
}

/** A date with its 24-hour clock time, e.g. "1/2/26, 14:05". */
export function formatDateTime(time: Date | number, locale?: string, options: { dateStyle?: 'short' | 'medium'; seconds?: boolean } = {}): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: options.dateStyle ?? 'short',
    timeStyle: options.seconds ? 'medium' : 'short',
    hourCycle: 'h23',
  }).format(time);
}
