<script setup lang="ts">
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Info } from 'lucide-vue-next';

defineProps<{
  id: string;
  label: string;
  /** Accessible name of the info button that opens the formula popover. */
  infoLabel: string;
  value: string;
  valueTitle?: string | undefined;
  note?: string | undefined;
}>();
</script>

<template>
  <div
    :data-kpi="id"
    class="flex min-w-0 flex-[1_1_8rem] flex-col bg-(--d-bg) px-2.75 pt-2.25 pb-2"
  >
    <div class="flex min-w-0 items-center gap-1 text-11 whitespace-nowrap text-(--d-muted)">
      <span class="min-w-0 truncate">{{ label }}</span>
      <Popover>
        <PopoverTrigger as-child>
          <!-- A 24px target (WCAG 2.5.8) whose negative margin keeps the 11px icon's footprint in the row. -->
          <button
            type="button"
            class="-m-[0.40625rem] flex size-6 flex-none items-center justify-center rounded-sm text-(--d-faint) transition-colors hover:text-(--d-text) focus-visible:outline-2 focus-visible:outline-(--d-accent)"
            :aria-label="infoLabel"
          >
            <Info
              class="size-2.75"
              aria-hidden="true"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          class="w-72 space-y-2 p-3 text-xs/relaxed"
          align="start"
          :data-kpi-popover="id"
        >
          <slot name="formula" />
        </PopoverContent>
      </Popover>
    </div>
    <div class="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span
        data-kpi-value
        class="font-mono text-[1.0625rem] font-semibold tracking-[-.01em] whitespace-nowrap text-(--d-text) tabular-nums"
        :title="valueTitle"
      >{{ value }}</span>
      <slot name="delta" />
    </div>
    <p
      v-if="note"
      data-kpi-note
      class="min-h-3.75 truncate font-mono text-10.5 text-(--d-faint)"
    >
      {{ note }}
    </p>
  </div>
</template>
