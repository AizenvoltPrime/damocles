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
  /** Also emits while the thumb is dragged, for a value that previews and is written by a later Save. */
  live?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

// The thumb follows the drag at once; without `live` the value is emitted only on release, never per input event.
const shown = ref(props.modelValue);
const dragging = ref(false);
watch(() => props.modelValue, (value) => {
  if (!dragging.value) shown.value = value;
});

const fill = computed(() => `${((shown.value - props.min) / (props.max - props.min)) * 100}%`);
const text = computed(() => (props.format ? props.format(shown.value) : String(shown.value)));

function onInput(event: Event): void {
  dragging.value = true;
  shown.value = Number((event.target as HTMLInputElement).value);
  if (props.live && shown.value !== props.modelValue) emit('update:modelValue', shown.value);
}

function onChange(event: Event): void {
  dragging.value = false;
  const value = Number((event.target as HTMLInputElement).value);
  shown.value = value;
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
      :value="shown"
      :aria-label="label"
      :aria-valuetext="text"
      :disabled="disabled"
      :data-dragging="dragging ? '' : undefined"
      :style="{ '--sm-fill': fill }"
      @input="onInput"
      @change="onChange"
    >
    <output
      class="sm-slider-value"
      aria-hidden="true"
    >{{ text }}</output>
  </div>
</template>
