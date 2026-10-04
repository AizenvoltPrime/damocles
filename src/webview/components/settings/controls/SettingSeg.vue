<script setup lang="ts" generic="T extends string">
import SegmentedToggle, { type SegmentedOption } from '@/components/SegmentedToggle.vue';

defineProps<{
  modelValue: T;
  options: readonly SegmentedOption<T>[];
  label: string;
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
    indicator-class="text-(--d-card) drop-shadow-[0_1px_2px_rgba(0,0,0,.18)]"
    class="max-w-110 bg-(--d-hover)"
    :aria-label="label"
    @update:model-value="(value: T) => emit('update:modelValue', value)"
  />
</template>
