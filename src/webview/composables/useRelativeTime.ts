import { onMounted, onUnmounted, ref, type Ref } from 'vue';

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
    if (diff < 45_000) return 'just now';
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  function update(): void {
    const ts = getTimestamp();
    if (ts === null) {
      relative.value = '';
      absolute.value = '';
      return;
    }
    relative.value = format(ts);
    absolute.value = new Date(ts).toLocaleString();
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
