<script setup lang="ts">
import type { DesignResultDecision } from '@shared/types/design';

// A design's decisions on the branch; each title and chosen value is the designer's own words.
defineProps<{ decisions: readonly DesignResultDecision[] }>();
</script>

<template>
  <ul class="flex flex-col gap-1">
    <li
      v-for="decision in decisions"
      :key="decision.id"
      class="flex min-w-0 items-start gap-2"
      data-testid="design-decision"
    >
      <span
        class="mt-1.25 size-1.5 flex-none rotate-45 bg-(--d-design)"
        aria-hidden="true"
      />
      <span class="min-w-0 text-pretty">
        <span class="font-mono text-11 font-semibold text-(--d-design-text)">{{ `${decision.id} ` }}</span>
        <span class="font-medium text-(--d-text)">{{ decision.title }}</span>
        <span
          aria-hidden="true"
          class="text-(--d-faint)"
        > · </span>
        <span class="text-(--d-muted)">{{ decision.chosen }}</span>
      </span>
    </li>
  </ul>
</template>
