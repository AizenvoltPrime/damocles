<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }>(), { variant: 'primary', size: 'md' });
</script>

<template>
  <button
    type="button"
    class="inline-flex items-center gap-2 rounded-md font-medium"
    :class="{
      'bg-primary text-primary-foreground': variant === 'primary',
      'border border-border bg-surface': variant === 'secondary',
      'hover:bg-muted': variant === 'ghost',
      'bg-danger text-primary-foreground': variant === 'danger',
      'px-2 py-1 text-sm': size === 'sm',
      'px-4 py-2': size === 'md',
    }"
  >
    <slot />
  </button>
</template>
