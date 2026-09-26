import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatCost } from './useTeamFormatting';

/** Number and date formatting for `/stats`, in the UI locale rather than the browser's. */
export function useStatsFormat() {
  const { locale } = useI18n();

  const formats = computed(() => ({
    compact: new Intl.NumberFormat(locale.value, { notation: 'compact', maximumFractionDigits: 1 }),
    integer: new Intl.NumberFormat(locale.value, { maximumFractionDigits: 0 }),
    percent: new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 1 }),
    signedPercent: new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' }),
    signedPoints: new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1, signDisplay: 'exceptZero' }),
    usdCompact: new Intl.NumberFormat(locale.value, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }),
    date: new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }),
    dateTime: new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }),
  }));

  return {
    tokens: (n: number): string => formats.value.compact.format(n),
    integer: (n: number): string => formats.value.integer.format(n),
    percent: (ratio: number): string => formats.value.percent.format(ratio),
    signedPercent: (ratio: number): string => formats.value.signedPercent.format(ratio),
    signedPoints: (points: number): string => formats.value.signedPoints.format(points),
    usd: (n: number): string => formatCost(n, locale.value),
    usdCompact: (n: number): string => formats.value.usdCompact.format(n),
    /** `endMs` is exclusive, so the label names the last day the range includes. */
    dateRange: (startMs: number, endMs: number): string => formats.value.date.formatRange(startMs, endMs - 1),
    dateTime: (ms: number): string => formats.value.dateTime.format(ms),
  };
}
