import { ref, watch, onMounted, onUnmounted, type Ref } from 'vue';

export function useElapsedTimer(
  isRunning: Ref<boolean> | (() => boolean),
  getStartTime: () => number | null,
  getEndTime: () => number | null,
) {
  const elapsedMs = ref(0);
  let interval: ReturnType<typeof setInterval> | null = null;

  function update(): void {
    const start = getStartTime();
    if (!start) {
      elapsedMs.value = 0;
      return;
    }
    elapsedMs.value = (getEndTime() ?? Date.now()) - start;
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

  // Recompute when the bounds themselves change after mount — e.g. a completed team/agent reloaded from
  // history swaps its placeholder (start≈end≈now → 0s) for the real persisted timestamps. Without this,
  // a settled card (isRunning never flips) would keep the stale mount-time value forever.
  watch(
    [() => getStartTime(), () => getEndTime()],
    update,
  );

  onUnmounted(stopInterval);

  return { elapsedMs };
}
