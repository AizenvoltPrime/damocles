<script setup lang="ts" generic="T extends string">
import SegmentedToggle, { type SegmentedOption } from '@/components/SegmentedToggle.vue';

defineProps<{
  modelValue: T;
  options: readonly SegmentedOption<T>[];
  label: string;
  radios?: boolean;
  disabled?: boolean;
  /** The id of the text that describes the group. */
  describedby?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: T): void;
}>();
</script>

<template>
  <SegmentedToggle
    :model-value="modelValue"
    :options="options"
    size="md"
    indicator-class="[--tone:var(--d-card)] drop-shadow-[0_1px_2px_rgba(0,0,0,.18)]"
    class="max-w-110 bg-(--d-hover)"
    :aria-label="label"
    :aria-describedby="describedby"
    :radios="radios === true"
    :disabled="disabled === true"
    @update:model-value="(value: T) => emit('update:modelValue', value)"
  />
</template>
