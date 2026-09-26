<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AcceptableValue } from 'reka-ui';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { IconCheck, IconChevronDown } from '@/components/icons';

export interface StatsSelectOption {
  key: string;
  label: string;
  /** Hover text, e.g. the full path behind a folder name. */
  title?: string | undefined;
}

const props = defineProps<{
  label: string;
  allLabel: string;
  options: StatsSelectOption[];
  modelValue: string[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', keys: string[]): void;
}>();

const { t } = useI18n();

const triggerText = computed(() => {
  if (props.modelValue.length === 0) return props.allLabel;
  if (props.modelValue.length === 1) {
    const only = props.options.find((o) => o.key === props.modelValue[0]);
    if (only) return only.label;
  }
  return t('usageStats.filters.selectedCount', { count: props.modelValue.length });
});

function onUpdate(value: AcceptableValue | AcceptableValue[]): void {
  const keys = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  emit('update:modelValue', keys);
}
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button variant="outline" size="sm" class="h-8 max-w-full gap-1 px-2 text-xs font-normal" :aria-label="`${label}: ${triggerText}`">
        <span class="text-muted-foreground">{{ label }}:</span>
        <span class="truncate">{{ triggerText }}</span>
        <IconChevronDown :size="12" class="shrink-0 opacity-60" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-64 p-0" align="start">
      <Command multiple :model-value="modelValue" @update:model-value="onUpdate">
        <CommandInput :placeholder="t('usageStats.filters.search')" />
        <CommandList>
          <CommandEmpty>{{ t('usageStats.filters.noMatches') }}</CommandEmpty>
          <CommandGroup>
            <CommandItem
              v-for="option in options"
              :key="option.key"
              :value="option.key"
              :title="option.title"
              class="text-xs"
            >
              <span class="flex size-4 shrink-0 items-center justify-center">
                <IconCheck v-if="modelValue.includes(option.key)" :size="12" />
              </span>
              <span class="truncate">{{ option.label }}</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div v-if="modelValue.length > 0" class="border-t border-border p-1">
          <Button variant="ghost" size="sm" class="h-7 w-full text-xs" @click="emit('update:modelValue', [])">
            {{ t('usageStats.filters.clear') }}
          </Button>
        </div>
      </Command>
    </PopoverContent>
  </Popover>
</template>
