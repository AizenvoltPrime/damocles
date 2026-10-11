<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ChartLine, RefreshCw } from 'lucide-vue-next';
import { IconChartBar, IconWarning } from '@/components/icons';
import OverlayHeaderAction from '../OverlayHeaderAction.vue';
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
  return `${t('overlays.stats.subtitle')} · ${at === null ? t('usageStats.notIndexed') : t('usageStats.updated', { time: format.dateTime(at) })}`;
});
</script>

<template>
  <OverlayShell
    max-width="62.5rem"
    :title="t('usageStats.title')"
    :subtitle="updatedText"
    :icon="ChartLine"
    data-testid="usage-stats-overlay"
    @close="$emit('close')"
  >
    <template #header-actions>
      <OverlayHeaderAction
        :label="t('usageStats.refresh')"
        :icon="RefreshCw"
        :busy="busy"
        :disabled="busy"
        data-testid="stats-refresh"
        @click="store.refresh()"
      />
    </template>

    <div
      class="@container flex flex-col gap-3 px-4 pt-3 pb-4.5 tabular-nums"
      :aria-busy="busy"
    >
      <StatsFilterBar />

      <div
        v-if="store.status === 'indexing' && store.progress"
        class="space-y-1.5"
        role="status"
      >
        <div class="flex items-center gap-2 text-xs text-(--d-muted)">
          <span class="flex-1">{{ t('usageStats.indexing') }}</span>
          <span class="tabular-nums">
            {{ t('usageStats.indexingProgress', { done: format.integer(store.progress.filesDone), total: format.integer(store.progress.filesTotal) }, store.progress.filesTotal) }}
          </span>
        </div>
        <Progress
          :model-value="progressPercent"
          class="h-1.5"
          :aria-label="t('usageStats.indexing')"
        />
      </div>

      <div
        v-if="store.status === 'error'"
        class="flex flex-col items-center gap-3 py-12 text-center"
        role="alert"
      >
        <IconWarning class="size-7 text-(--d-danger)" />
        <div class="space-y-1">
          <p class="text-sm font-medium text-(--d-text)">
            {{ t('usageStats.error') }}
          </p>
          <p
            v-if="store.error"
            class="wrap-break-word text-xs text-(--d-muted)"
          >
            {{ store.error }}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          @click="store.retry()"
        >
          {{ t('usageStats.retry') }}
        </Button>
      </div>

      <div
        v-else-if="!shownReport"
        class="flex flex-col items-center gap-3 py-12 text-(--d-muted)"
        role="status"
      >
        <LoadingSpinner
          v-if="store.status === 'loading'"
          class="size-7"
        />
        <p
          v-if="store.status === 'loading'"
          class="text-xs"
        >
          {{ t('usageStats.loading') }}
        </p>
      </div>

      <div
        v-else-if="isEmpty"
        class="flex flex-col items-center gap-2 py-12 text-center text-(--d-muted) transition-opacity"
        :class="{ 'opacity-60': busy }"
        data-empty
      >
        <IconChartBar class="size-7 opacity-40" />
        <p class="text-sm font-medium">
          {{ t('usageStats.empty') }}
        </p>
        <p class="text-xs">
          {{ t('usageStats.emptyHint') }}
        </p>
      </div>

      <div
        v-else
        class="flex flex-col gap-3 transition-opacity"
        :class="{ 'opacity-60': busy }"
      >
        <StatsKpiGrid
          :totals="shownReport.totals"
          :previous="shownReport.previousTotals"
        />
        <StatsUsageChart
          v-if="shownReport.series"
          v-model:metric="metric"
          :series="shownReport.series"
          :range="shownReport.range"
          :by-model="shownReport.byModel ?? []"
        />
        <StatsBreakdown
          v-if="shownReport.bySource"
          :report="shownReport"
          :metric="metric"
        />
        <div class="grid grid-cols-1 gap-3 @4xl:grid-cols-2">
          <StatsActivityHeatmap
            v-if="shownReport.heatmap"
            :cells="shownReport.heatmap"
            :metric="metric"
          />
          <StatsTopSessions
            v-if="shownReport.topSessions?.length"
            :sessions="shownReport.topSessions"
          />
        </div>
      </div>
    </div>
  </OverlayShell>
</template>
