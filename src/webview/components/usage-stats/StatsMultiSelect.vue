<script setup lang="ts">
import { computed, type Component } from 'vue';
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
  icon: Component;
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
      <button
        type="button"
        class="flex h-7 max-w-full items-center gap-1.5 rounded-md border border-(--d-border2) px-2.25 text-xs whitespace-nowrap transition-colors hover:bg-(--d-hover)"
        :class="modelValue.length > 0 ? 'text-(--d-text)' : 'text-(--d-muted)'"
        :aria-label="`${label}: ${triggerText}`"
      >
        <component
          :is="icon"
          class="size-3 flex-none text-(--d-faint)"
          aria-hidden="true"
        />
        <span class="truncate">{{ triggerText }}</span>
        <IconChevronDown
          class="size-2.75 flex-none text-(--d-faint)"
        />
      </button>
    </PopoverTrigger>
    <PopoverContent
      class="w-64 p-0"
      align="start"
    >
      <Command
        multiple
        :model-value="modelValue"
        @update:model-value="onUpdate"
      >
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
                <IconCheck
                  v-if="modelValue.includes(option.key)"
                  class="size-3"
                />
              </span>
              <span class="truncate">{{ option.label }}</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div
          v-if="modelValue.length > 0"
          class="border-t border-(--d-border) p-1"
        >
          <Button
            variant="ghost"
            size="sm"
            class="h-7 w-full text-xs"
            @click="emit('update:modelValue', [])"
          >
            {{ t('usageStats.filters.clear') }}
          </Button>
        </div>
      </Command>
    </PopoverContent>
  </Popover>
</template>
