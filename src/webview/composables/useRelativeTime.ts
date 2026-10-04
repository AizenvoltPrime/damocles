import { onMounted, onUnmounted, ref, type Ref } from 'vue';
import { i18n } from '@/i18n';
import { formatDateTime } from '@/utils/clock';

/**
 * Auto-ticking relative-time label ("just now", "3m ago") for a timestamp. One shared interval per
 * mounted consumer updates a reactive string without forcing a parent re-render; pair with an
 * absolute-time `title` for hover precision.
 */
export function useRelativeTime(getTimestamp: () => number | null, intervalMs = 30_000): {
  relative: Ref<string>;
  absolute: Ref<string>;
} {
  const relative = ref('');
  const absolute = ref('');
  let interval: ReturnType<typeof setInterval> | null = null;

  function format(ts: number): string {
    const diff = Date.now() - ts;
    const { t } = i18n.global;
    if (diff < 45_000) return t('time.justNow');
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return t('time.minutesAgo', { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t('time.hoursAgo', { n: hours });
    const days = Math.round(hours / 24);
    return t('time.daysAgo', { n: days });
  }

  function update(): void {
    const ts = getTimestamp();
    if (ts === null) {
      relative.value = '';
      absolute.value = '';
      return;
    }
    relative.value = format(ts);
    absolute.value = formatDateTime(ts, i18n.global.locale.value, { seconds: true });
  }

  onMounted(() => {
    update();
    interval = setInterval(update, intervalMs);
  });
  onUnmounted(() => {
    if (interval) clearInterval(interval);
  });

  return { relative, absolute };
}
