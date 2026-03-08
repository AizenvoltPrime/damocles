<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import type { SessionStats } from '@shared/types/session';
import { IconArrowDown, IconArrowUp, IconChartBar, IconDatabase, IconFile } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSettingsStore } from '@/stores';
import { useVSCode } from '@/composables/useVSCode';
import { useContextPercentage } from '@/composables/useContextPercentage';

const { t } = useI18n();
const { postMessage } = useVSCode();
const settingsStore = useSettingsStore();
const { currentSettings } = storeToRefs(settingsStore);

const props = defineProps<{
  stats: SessionStats;
}>();

const emit = defineEmits<{
  openLog: [];
  openContextUsage: [];
}>();

const { totalContext, contextPercentage } = useContextPercentage(() => props.stats);

const contextStatusColor = computed(() => {
  const { hardThreshold, softThreshold, warningThreshold } = currentSettings.value.autoCompact;
  if (contextPercentage.value >= hardThreshold) return { fill: 'var(--color-destructive)', text: 'text-destructive' };
  if (contextPercentage.value >= softThreshold) return { fill: 'var(--color-orange)', text: 'text-[var(--color-orange)]' };
  if (contextPercentage.value >= warningThreshold) return { fill: 'var(--color-warning)', text: 'text-warning' };
  return { fill: 'var(--color-success)', text: 'text-success' };
});

const contextTooltip = computed(() => {
  const { hardThreshold, softThreshold, warningThreshold } = currentSettings.value.autoCompact;
  const base = t('stats.contextUsage');
  if (contextPercentage.value >= hardThreshold) return `${base} - ${t('context.critical')}`;
  if (contextPercentage.value >= softThreshold) return `${base} - ${t('context.soft')}`;
  if (contextPercentage.value >= warningThreshold) return `${base} - ${t('context.warning')}`;
  return base;
});

const popoverOpen = ref(false);

function handleCompact() {
  popoverOpen.value = false;
  postMessage({ type: 'sendMessage', content: '/compact' });
}

function handleViewDetails() {
  popoverOpen.value = false;
  emit('openContextUsage');
}

const hasCacheActivity = computed(() => {
  return props.stats.cacheCreationTokens > 0 || props.stats.cacheReadTokens > 0;
});

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}
</script>

<template>
  <div
    class="flex items-center justify-between px-3 pt-1.5 text-sm border-t border-border/30 bg-card"
  >
    <div class="flex items-center gap-3">
      <Popover v-model:open="popoverOpen">
        <PopoverTrigger as-child>
          <button
            class="flex items-center gap-1.5 cursor-pointer rounded px-1.5 py-0.5 hover:bg-muted/50 transition-colors border border-transparent hover:border-border/50"
            :title="contextTooltip"
          >
            <!-- Status circle indicator -->
            <svg class="w-3 h-3" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="6" cy="6" r="5" :fill="contextStatusColor.fill" />
            </svg>
            <span :class="contextStatusColor.text">{{ formatNumber(totalContext) }}/{{ formatNumber(stats.contextWindowSize) }} ({{ contextPercentage }}%)</span>
          </button>
        </PopoverTrigger>
        <PopoverContent class="w-auto p-2" align="start" :side-offset="8">
          <div class="flex flex-col gap-1">
            <div class="text-xs text-muted-foreground px-2 py-1">{{ contextTooltip }}</div>
            <Button
              variant="ghost"
              size="sm"
              class="justify-start"
              @click="handleViewDetails"
            >
              {{ t('context.viewDetails') }}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="justify-start"
              @click="handleCompact"
            >
              {{ t('context.compact') }}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <span class="flex items-center gap-1.5" :title="t('stats.sessionTokens')">
        <IconChartBar :size="14" class="text-muted-foreground shrink-0" />
        <span class="flex items-center gap-0.5 text-foreground">
          {{ formatNumber(stats.totalInputTokens) }}<IconArrowDown :size="10" />
        </span>
        <span class="flex items-center gap-0.5 text-foreground">
          {{ formatNumber(stats.totalOutputTokens) }}<IconArrowUp :size="10" />
        </span>
      </span>

      <span
        v-if="hasCacheActivity"
        class="flex items-center gap-1.5"
        :title="t('stats.cache')"
      >
        <IconDatabase :size="14" class="text-muted-foreground shrink-0" />
        <span class="flex items-center gap-0.5 text-purple-400">
          {{ formatNumber(stats.cacheCreationTokens) }}<IconArrowUp :size="10" />
        </span>
        <span class="flex items-center gap-0.5 text-info">
          {{ formatNumber(stats.cacheReadTokens) }}<IconArrowDown :size="10" />
        </span>
      </span>

      <slot />
    </div>

    <div class="flex items-center gap-3">
      <span v-if="stats.numTurns > 0" class="text-muted-foreground" :title="t('stats.turns', { n: stats.numTurns }, stats.numTurns)">
        {{ t('stats.turns', { n: stats.numTurns }, stats.numTurns) }}
      </span>
      <span class="font-medium text-foreground" :title="t('stats.cost')">
        {{ formatCost(stats.totalCostUsd) }}
      </span>
      <Button
        variant="ghost"
        class="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
        :title="t('stats.openLog')"
        @click="emit('openLog')"
      >
        <IconFile :size="14" />
      </Button>
    </div>
  </div>
</template>
