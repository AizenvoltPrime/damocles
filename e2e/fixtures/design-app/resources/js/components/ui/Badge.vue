<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'neutral' | 'success' | 'danger' }>(), { tone: 'neutral' });
</script>

<template>
  <span class="inline-flex rounded-sm px-2 text-xs" :class="{ 'bg-muted': tone === 'neutral', 'bg-primary text-primary-foreground': tone === 'success', 'bg-danger text-primary-foreground': tone === 'danger' }">
    <slot />
  </span>
</template>
