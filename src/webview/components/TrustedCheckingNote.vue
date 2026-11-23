<script setup lang="ts">
import { Info } from 'lucide-vue-next';

// Why a trusted card's controls do nothing yet (useTrustedVisibility); each page passes its own catalog's text.
// `overlay`: laid over its positioned card, out of flow, so that showing or removing it moves no card.
// `cover`: laid over the whole of its positioned cell (a one-row strip's text), so that it moves no control of the strip.
defineProps<{ text: string; shown: boolean; overlay?: boolean; cover?: boolean }>();
</script>

<template>
  <!-- The live region is mounted before its text: one inserted together with its text is often not announced. -->
  <p
    role="status"
    :class="overlay ? 'pointer-events-none absolute inset-x-0 z-10' : cover ? 'pointer-events-none absolute inset-0 z-10' : undefined"
  >
    <span
      v-if="shown"
      class="flex items-center gap-2 text-xs text-(--d-muted)"
      :class="overlay ? 'border-t border-(--d-border) bg-(--d-card) px-3 py-1.5' : cover ? 'min-h-full bg-(--d-card)' : undefined"
      data-testid="trusted-checking"
    >
      <Info
        class="size-3.5 flex-none text-(--d-accent)"
        aria-hidden="true"
      />
      <span class="min-w-0 text-pretty">{{ text }}</span>
    </span>
  </p>
</template>
