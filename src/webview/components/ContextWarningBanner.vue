<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { TriangleAlert, Zap } from 'lucide-vue-next';
import DockBanner from './DockBanner.vue';
import { useSessionStore } from '@/stores/useSessionStore';
import { useContextPercentage } from '@/composables/useContextPercentage';
import type { ContextWarningLevel } from '@shared/types/settings';

const { t } = useI18n();
const { sessionStats } = storeToRefs(useSessionStore());

const props = defineProps<{
  level: ContextWarningLevel;
  autoCompactTriggered?: boolean;
}>();

defineEmits<{
  (e: 'dismiss'): void;
}>();

const { totalContext, contextPercentage: percentUsed } = useContextPercentage(sessionStats);

const formattedTokens = computed(() => {
  const input = Math.round(totalContext.value / 1000);
  const total = Math.round(sessionStats.value.contextWindowSize / 1000);
  return `${input}K / ${total}K`;
});

const title = computed(() => {
  if (props.autoCompactTriggered) return t('context.autoCompacting');
  if (props.level === 'critical') return t('context.critical');
  if (props.level === 'soft') return t('context.soft');
  return t('context.warning');
});
</script>

<template>
  <DockBanner
    :tone="level === 'critical' ? 'danger' : 'warning'"
    :icon="level === 'critical' ? Zap : TriangleAlert"
    :title="title"
    data-testid="context-banner"
    @dismiss="$emit('dismiss')"
  >
    <div class="flex items-center gap-2.5 pb-0.5 text-xs text-(--d-muted)">
      <div
        v-if="autoCompactTriggered"
        class="d-sweep-bar h-1 w-28 shrink-0 overflow-hidden rounded-full bg-(--d-hover)"
        :class="level === 'critical' ? 'text-(--d-danger)' : 'text-(--d-warning)'"
        role="progressbar"
        :aria-label="t('context.autoCompacting')"
      />
      <div
        v-else
        class="h-1 w-28 shrink-0 overflow-hidden rounded-full bg-(--d-hover)"
        role="meter"
        :aria-valuenow="Math.min(percentUsed, 100)"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="t('stats.contextUsage')"
      >
        <div
          class="size-full origin-left rounded-full transition-transform duration-500 ease-out rtl:origin-right"
          :class="level === 'critical' ? 'bg-(--d-danger)' : 'bg-(--d-warning)'"
          :style="{ transform: `scaleX(${Math.min(percentUsed, 100) / 100})` }"
        />
      </div>
      <span class="font-mono tabular-nums">{{ formattedTokens }} ({{ percentUsed }}%)</span>
    </div>
  </DockBanner>
</template>
