// Numbers, ratios, durations and lists as the theme editor writes them, in the UI's language.
import { useI18n } from 'vue-i18n';
import { floorRatio } from './colors';

/** A duration as whole minutes and seconds to a tenth, rounded before it is split so 59.96 s is 1:00.0, never 0:60.0. */
export function durationParts(ms: number): { readonly minutes: number; readonly seconds: number } {
  const tenths = Math.round(ms / 100);
  return { minutes: Math.floor(tenths / 600), seconds: (tenths % 600) / 10 };
}

/** The same object whatever order its keys were set in, as text: two drafts that hold the same theme compare equal. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'object' && item !== null && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : item));
}

export interface EditorFormat {
  number(value: number, digits?: number): string;
  // a contrast ratio rounded down to a tenth: "4.4:1"
  ratio(ratio: number): string;
  // a ratio a rule asks for, as it is: "4.5:1", "3:1"
  need(need: number): string;
  percent(fraction: number): string;
  // minutes, seconds and tenths: "0:00.5"
  duration(ms: number): string;
  megabytes(bytes: number): string;
  list(items: readonly string[]): string;
}

export function useEditorFormat(): EditorFormat {
  const { t, locale } = useI18n();
  const number = (value: number, digits = 0): string => new Intl.NumberFormat(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  return {
    number,
    ratio: (ratio) => t('themeEditor.ratio', { n: number(floorRatio(ratio), 1) }),
    need: (need) => t('themeEditor.ratio', { n: number(need, Number.isInteger(need) ? 0 : 1) }),
    percent: (fraction) => new Intl.NumberFormat(locale.value, { style: 'percent' }).format(fraction),
    duration: (ms) => {
      const { minutes, seconds } = durationParts(ms);
      return t('themeEditor.duration', { minutes: number(minutes), seconds: new Intl.NumberFormat(locale.value, { minimumIntegerDigits: 2, minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(seconds) });
    },
    megabytes: (bytes) => number(bytes / 1024 / 1024, 1),
    list: (items) => new Intl.ListFormat(locale.value, { style: 'short', type: 'unit' }).format(items),
  };
}
