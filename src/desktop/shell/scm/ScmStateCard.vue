<script setup lang="ts">
import { Button } from '@/components/ui/button';
import type { ScmStateCard } from './scm-state';

defineProps<{ card: ScmStateCard }>();
</script>

<template>
  <div
    data-testid="scm-state"
    :data-state="card.id"
    class="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pt-3.5 pb-4"
  >
    <component
      :is="card.icon"
      aria-hidden="true"
      class="d-state-icon size-6.5"
      :class="card.tone === 'warning' ? 'text-(--d-warning)' : 'text-(--d-faint)'"
    />
    <p
      v-if="card.title"
      class="text-13 font-semibold text-(--d-text)"
    >
      {{ card.title }}
    </p>
    <p class="text-12.5 text-pretty text-(--d-muted)">
      {{ card.text }}
    </p>
    <Button
      type="button"
      data-testid="scm-state-action"
      class="d-press h-7 w-full rounded-7 bg-(--d-accent) text-xs font-semibold text-(--d-on-accent) hover:bg-(--d-accent) hover:brightness-[1.08]"
      @click="card.primary.run()"
    >
      {{ card.primary.label }}
    </Button>
    <Button
      v-if="card.secondary"
      type="button"
      variant="ghost"
      data-testid="scm-state-secondary"
      class="d-press -mt-1 h-7 w-full gap-1.5 rounded-7 border border-(--d-border2) text-xs font-medium text-(--d-text) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.25"
      @click="card.secondary.run()"
    >
      <component
        :is="card.secondary.icon"
        aria-hidden="true"
      />{{ card.secondary.label }}
    </Button>
  </div>
</template>
