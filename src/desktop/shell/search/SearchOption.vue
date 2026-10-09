<script setup lang="ts">
import type { Component } from 'vue';
import { Toggle } from '@/components/ui/toggle';

// An option toggle inside a Search field (Match Case, Preserve Case, Search only in Open Editors…): an accent outline and
// tint when on, the -text shade keeping its icon at AA on the tint.
defineProps<{ modelValue: boolean; label: string; title: string; icon: Component; testid: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <Toggle
    :model-value="modelValue"
    size="sm"
    :data-testid="testid"
    class="h-5 min-w-5 rounded-5 border border-transparent px-0 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 data-[state=on]:border-(--d-accent) data-[state=on]:bg-(--d-accent-soft) data-[state=on]:text-(--d-accent-text) [&_svg]:size-3.5"
    :aria-label="label"
    :title="title"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <component
      :is="icon"
      aria-hidden="true"
    />
  </Toggle>
</template>
