<script setup lang="ts">
import type { Component } from 'vue';

/** A one-line outcome under a tool card's row, with an optional quoted detail (the user's feedback). */
defineProps<{
  icon?: Component | undefined;
  /** A --d-* text class for the line. */
  tone: string;
  text: string;
  /** Pulses a dot in place of the icon, for a state that waits on the user. */
  waiting?: boolean;
  quote?: string | undefined;
}>();
</script>

<template>
  <div class="border-t border-(--d-border) px-3 py-2 text-xs">
    <div
      class="flex items-center gap-2"
      :class="tone"
    >
      <span
        v-if="waiting"
        class="d-pulsing size-1.5 flex-none rounded-full bg-current"
        aria-hidden="true"
      />
      <component
        :is="icon"
        v-else-if="icon"
        class="size-3 flex-none"
        aria-hidden="true"
      />
      <span>{{ text }}</span>
    </div>
    <p
      v-if="quote"
      class="mt-1 pl-5 text-(--d-muted) italic text-pretty"
    >
      “{{ quote }}”
    </p>
  </div>
</template>
