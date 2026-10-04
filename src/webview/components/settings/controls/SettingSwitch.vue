<script setup lang="ts">
import ToggleSwitch from '@/components/ToggleSwitch.vue';

// Without `label`, name the switch through its attributes (aria-labelledby, or a wrapping <label>).
defineProps<{
  modelValue: boolean;
  label?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();
</script>

<template>
  <ToggleSwitch
    :checked="modelValue"
    size="md"
    :disabled="disabled === true"
    :aria-label="label"
    @update:checked="(value: boolean) => emit('update:modelValue', value)"
  />
</template>
