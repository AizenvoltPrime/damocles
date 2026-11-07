<script setup lang="ts">
defineProps<{ label: string; type?: 'text' | 'email' | 'search'; placeholder?: string }>();
const model = defineModel<string>();
</script>

<template>
  <label class="flex flex-col gap-1 text-sm">
    <span>{{ label }}</span>
    <input v-model="model" :type="type ?? 'text'" :placeholder="placeholder" class="rounded-md border border-border px-3 py-2" />
  </label>
</template>
