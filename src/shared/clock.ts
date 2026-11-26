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
