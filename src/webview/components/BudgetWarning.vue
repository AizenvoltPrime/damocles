<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleStop, Gauge } from 'lucide-vue-next';
import DockBanner from './DockBanner.vue';
import { formatCost } from '@/composables/useTeamFormatting';

const { t, locale } = useI18n();

const props = defineProps<{
  currentSpend: number;
  limit: number;
  exceeded?: boolean;
}>();

defineEmits<{
  (e: 'dismiss'): void;
}>();

const percentUsed = computed(() => {
  if (props.limit <= 0) return 0;
  return Math.min((props.currentSpend / props.limit) * 100, 100);
});

const meterColor = computed(() => {
  if (props.exceeded || percentUsed.value >= 90) return 'bg-(--d-danger)';
  if (percentUsed.value >= 80) return 'bg-(--d-warning)';
  return 'bg-(--d-success)';
});
</script>

<template>
  <DockBanner
    :tone="exceeded ? 'danger' : 'warning'"
    :icon="exceeded ? CircleStop : Gauge"
    :title="exceeded ? t('budget.exceeded') : t('budget.approaching')"
    data-testid="budget-banner"
    @dismiss="$emit('dismiss')"
  >
    <div class="flex items-center gap-2.5 pb-0.5 text-xs text-(--d-muted)">
      <div
        class="h-1 w-28 shrink-0 overflow-hidden rounded-full bg-(--d-hover)"
        role="meter"
        :aria-valuenow="Math.round(percentUsed)"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="exceeded ? t('budget.exceeded') : t('budget.approaching')"
      >
        <div
          class="size-full origin-left rounded-full transition-transform duration-500 ease-out rtl:origin-right"
          :class="meterColor"
          :style="{ transform: `scaleX(${percentUsed / 100})` }"
        />
      </div>
      <span class="font-mono tabular-nums">{{ t('budget.progress', { current: formatCost(currentSpend, locale), limit: formatCost(limit, locale), percent: percentUsed.toFixed(0) }) }}</span>
    </div>
  </DockBanner>
</template>
