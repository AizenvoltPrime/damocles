import { ref, watch, onMounted, onUnmounted, type Ref } from 'vue';
import { stopwatchElapsedMs, type Stopwatch } from '@shared/team-stopwatch';

export function useElapsedTimer(
  isRunning: Ref<boolean> | (() => boolean),
  getStopwatch: () => Stopwatch | null,
) {
  const elapsedMs = ref(0);
  let interval: ReturnType<typeof setInterval> | null = null;

  function update(): void {
    const stopwatch = getStopwatch();
    elapsedMs.value = stopwatch ? stopwatchElapsedMs(stopwatch, Date.now()) : 0;
  }

  function startInterval(): void {
    if (interval) return;
    interval = setInterval(update, 1000);
  }

  function stopInterval(): void {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
  }

  const running = typeof isRunning === 'function'
    ? { get value() { return isRunning(); } }
    : isRunning;

  onMounted(() => {
    update();
    if (running.value) startInterval();
  });

  watch(
    typeof isRunning === 'function' ? isRunning : () => isRunning.value,
    (nowRunning) => {
      if (nowRunning) {
        update();
        startInterval();
      } else {
        stopInterval();
        update();
      }
    },
  );

  // A settled card never flips isRunning, so a stopwatch replaced after mount (a reload swapping its
  // placeholder, or a settle update) must recompute on its own.
  watch(
    [() => getStopwatch()?.activeMs, () => getStopwatch()?.runningSince],
    update,
  );

  onUnmounted(stopInterval);

  return { elapsedMs };
}
