<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { IconChartBar, IconRotateLeft, IconWarning } from '@/components/icons';
import LoadingSpinner from '../LoadingSpinner.vue';
import OverlayShell from '../OverlayShell.vue';
import StatsFilterBar from './StatsFilterBar.vue';
import StatsKpiGrid from './StatsKpiGrid.vue';
import StatsUsageChart from './StatsUsageChart.vue';
import StatsBreakdown from './StatsBreakdown.vue';
import StatsActivityHeatmap from './StatsActivityHeatmap.vue';
import StatsTopSessions from './StatsTopSessions.vue';
import type { StatsMetric } from './stats-chart-data';
import { useUsageStatsStore } from '@/stores/useUsageStatsStore';
import { useStatsFormat } from '@/composables/useStatsFormat';

defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const store = useUsageStatsStore();
const format = useStatsFormat();

// Shared by the chart toggle and the breakdown shares; switching it never sends a request.
const metric = ref<StatsMetric>('cost');

const busy = computed(() => store.status === 'loading' || store.status === 'indexing');

// Before the first scan completes the index holds partial numbers, so they wait for the final reply.
const shownReport = computed(() => {
  const report = store.report;
  if (!report) return null;
  return report.indexedAtMs !== null || store.status === 'ready' ? report : null;
});

// Kept while a reload runs, so an empty result is not replaced by a dashboard of zeros until the new one lands.
const isEmpty = computed(() => shownReport.value?.totals.requests === 0);

const progressPercent = computed(() => {
  const p = store.progress;
  return p && p.filesTotal > 0 ? Math.round((p.filesDone / p.filesTotal) * 100) : 0;
});

const updatedText = computed(() => {
  if (!store.report) return undefined;
  const at = store.updatedAtMs;
  return at === null ? t('usageStats.notIndexed') : t('usageStats.updated', { time: format.dateTime(at) });
});
</script>

<template>
  <OverlayShell
    :title="t('usageStats.title')"
    :subtitle="updatedText"
    :icon="IconChartBar"
    icon-class="text-info"
    @close="$emit('close')"
  >
    <template #header-actions>
      <Button
        variant="ghost"
        size="icon-sm"
        :disabled="busy"
        :aria-label="t('usageStats.refresh')"
        :title="t('usageStats.refresh')"
        @click="store.refresh()"
      >
        <IconRotateLeft :size="16" :class="{ 'animate-spin-reverse': busy }" />
      </Button>
    </template>

    <div class="@container space-y-4 p-4" :aria-busy="busy">
      <StatsFilterBar />

      <div v-if="store.status === 'indexing' && store.progress" class="space-y-1.5" role="status">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <span class="flex-1">{{ t('usageStats.indexing') }}</span>
          <span class="tabular-nums">
            {{ t('usageStats.indexingProgress', { done: format.integer(store.progress.filesDone), total: format.integer(store.progress.filesTotal) }, store.progress.filesTotal) }}
          </span>
        </div>
        <Progress :model-value="progressPercent" class="h-1.5" :aria-label="t('usageStats.indexing')" />
      </div>

      <div v-if="store.status === 'error'" class="flex flex-col items-center gap-3 py-12 text-center" role="alert">
        <IconWarning :size="28" class="text-error" />
        <div class="space-y-1">
          <p class="text-sm font-medium text-foreground">{{ t('usageStats.error') }}</p>
          <p v-if="store.error" class="break-words text-xs text-muted-foreground">{{ store.error }}</p>
        </div>
        <Button variant="outline" size="sm" @click="store.retry()">{{ t('usageStats.retry') }}</Button>
      </div>

      <div v-else-if="!shownReport" class="flex flex-col items-center gap-3 py-12 text-muted-foreground" role="status">
        <LoadingSpinner v-if="store.status === 'loading'" :size="28" />
        <p v-if="store.status === 'loading'" class="text-xs">{{ t('usageStats.loading') }}</p>
      </div>

      <div v-else-if="isEmpty" class="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground transition-opacity" :class="{ 'opacity-60': busy }" data-empty>
        <IconChartBar :size="28" class="opacity-40" />
        <p class="text-sm font-medium">{{ t('usageStats.empty') }}</p>
        <p class="text-xs">{{ t('usageStats.emptyHint') }}</p>
      </div>

      <div v-else class="space-y-4 transition-opacity" :class="{ 'opacity-60': busy }">
        <StatsKpiGrid :totals="shownReport.totals" :previous="shownReport.previousTotals" />
        <StatsUsageChart
          v-if="shownReport.series"
          v-model:metric="metric"
          :series="shownReport.series"
          :range="shownReport.range"
          :by-model="shownReport.byModel ?? []"
        />
        <StatsBreakdown v-if="shownReport.bySource" :report="shownReport" :metric="metric" />
        <div class="grid grid-cols-1 gap-3 @4xl:grid-cols-2">
          <StatsActivityHeatmap v-if="shownReport.heatmap" :cells="shownReport.heatmap" :metric="metric" />
          <StatsTopSessions v-if="shownReport.topSessions?.length" :sessions="shownReport.topSessions" />
        </div>
      </div>
    </div>
  </OverlayShell>
</template>
