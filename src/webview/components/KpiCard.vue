<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconInfo } from '@/components/icons';

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
    class="flex min-w-0 flex-col gap-1 rounded-md border border-border/50 bg-card p-3 text-card-foreground"
  >
    <div class="flex items-center gap-1">
      <span class="flex-1 truncate text-xs text-muted-foreground">{{ label }}</span>
      <Popover>
        <PopoverTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="size-5 shrink-0 text-muted-foreground"
            :aria-label="infoLabel"
          >
            <IconInfo :size="12" />
          </Button>
        </PopoverTrigger>
        <PopoverContent class="w-72 space-y-2 p-3 text-xs leading-relaxed" align="end" :data-kpi-popover="id">
          <slot name="formula" />
        </PopoverContent>
      </Popover>
    </div>
    <div class="flex flex-wrap items-baseline gap-x-2">
      <span data-kpi-value class="text-lg font-semibold tabular-nums text-foreground" :title="valueTitle">{{ value }}</span>
      <slot name="delta" />
    </div>
    <p v-if="note" data-kpi-note class="text-xs text-muted-foreground">{{ note }}</p>
  </div>
</template>
