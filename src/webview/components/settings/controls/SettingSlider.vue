<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  modelValue: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  format?: (value: number) => string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

// The thumb follows the drag at once; the value is saved only on release, never per input event.
const live = ref(props.modelValue);
const dragging = ref(false);
watch(() => props.modelValue, (value) => {
  if (!dragging.value) live.value = value;
});

const fill = computed(() => `${((live.value - props.min) / (props.max - props.min)) * 100}%`);
const shown = computed(() => (props.format ? props.format(live.value) : String(live.value)));

function onInput(event: Event): void {
  dragging.value = true;
  live.value = Number((event.target as HTMLInputElement).value);
}

function onChange(event: Event): void {
  dragging.value = false;
  const value = Number((event.target as HTMLInputElement).value);
  live.value = value;
  if (value !== props.modelValue) emit('update:modelValue', value);
}
</script>

<template>
  <div class="sm-slider">
    <input
      type="range"
      :min="min"
      :max="max"
      :step="step ?? 1"
      :value="live"
      :aria-label="label"
      :aria-valuetext="shown"
      :disabled="disabled"
      :data-dragging="dragging ? '' : undefined"
      :style="{ '--sm-fill': fill }"
      @input="onInput"
      @change="onChange"
    >
    <output
      class="sm-slider-value"
      aria-hidden="true"
    >{{ shown }}</output>
  </div>
</template>
