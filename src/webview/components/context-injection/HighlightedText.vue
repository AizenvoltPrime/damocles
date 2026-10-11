<script setup lang="ts">
import { computed } from 'vue';
import { highlightTerms } from './highlight-terms';

const props = defineProps<{
  text: string;
  terms: readonly string[];
}>();

const segments = computed(() => highlightTerms(props.text, props.terms));
</script>

<template>
  <template
    v-for="(segment, i) in segments"
    :key="i"
  >
    <mark
      v-if="segment.hit"
      class="rounded-sm bg-[color-mix(in_srgb,var(--d-warning)_25%,transparent)] px-0.5 font-semibold text-(--d-text)"
    >{{ segment.text }}</mark>
    <span v-else>{{ segment.text }}</span>
  </template>
</template>
