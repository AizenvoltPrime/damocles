<script setup lang="ts">
import { CircleX } from 'lucide-vue-next';

// A failed tool call's error, at the foot of its card.
defineProps<{ message: string }>();
</script>

<template>
  <div class="flex items-start gap-2 border-t border-[color-mix(in_srgb,var(--d-danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--d-danger)_8%,transparent)] px-3 py-2 text-xs text-(--d-danger-text)">
    <CircleX
      class="mt-px size-3.25 flex-none"
      aria-hidden="true"
    />
    <span class="text-pretty wrap-anywhere">{{ message }}</span>
  </div>
</template>
