<script setup lang="ts">
import { computed } from 'vue';

// A host's last round trips as a line beside the latency text, which says all it shows. Keyed on the host's measurement count,
// which moves even when a reading repeats the history, so the line draws itself again (d-draw) for every measurement.
const props = defineProps<{ history: readonly number[]; slow: boolean; measurements: number }>();

// viewBox units; the element is 4.75rem by 1.25rem
const WIDTH = 76;
const HEIGHT = 20;

const path = computed(() => {
  const values = props.history.length === 1 ? [props.history[0]!, props.history[0]!] : props.history;
  const top = Math.max(...values, 1) * 1.15;
  return `M${values.map((value, index) => `${((index / (values.length - 1)) * WIDTH).toFixed(1)},${(HEIGHT - 2 - (value / top) * (HEIGHT - 4)).toFixed(1)}`).join(' L')}`;
});
</script>

<template>
  <svg
    v-if="history.length > 0"
    aria-hidden="true"
    data-testid="host-latency-sparkline"
    :data-slow="slow || undefined"
    :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
    class="h-5 w-19 shrink-0 overflow-visible"
  >
    <path
      :key="measurements"
      :d="path"
      fill="none"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="d-draw"
      :class="slow ? 'stroke-(--d-warning)' : 'stroke-(--d-accent)'"
      style="--len: 400"
    />
  </svg>
</template>
