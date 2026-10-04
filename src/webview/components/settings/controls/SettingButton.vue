<script setup lang="ts">
defineProps<{
  variant?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <button
    type="button"
    class="sm-button"
    :class="{ 'sm-button-primary': variant === 'primary', 'sm-button-danger': variant === 'danger' }"
    :disabled="disabled"
    @click="emit('click')"
  >
    <slot />
  </button>
</template>
