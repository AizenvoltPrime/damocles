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

/** A date with its 24-hour clock time, e.g. "1/2/26, 14:05". */
export function formatDateTime(time: Date | number, locale?: string, options: { dateStyle?: 'short' | 'medium'; seconds?: boolean } = {}): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: options.dateStyle ?? 'short',
    timeStyle: options.seconds ? 'medium' : 'short',
    hourCycle: 'h23',
  }).format(time);
}
