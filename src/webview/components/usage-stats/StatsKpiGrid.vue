<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KpiCard from '../KpiCard.vue';
import { useCostLabel } from '@/composables/useCostLabel';
import { useStatsFormat } from '@/composables/useStatsFormat';
import { cacheHitRate } from '@shared/usage-accounting';
import type { UsageStatsTotals } from '@shared/types/usage-stats';

const props = defineProps<{
  totals: UsageStatsTotals;
  /** Null when compare is off. */
  previous: UsageStatsTotals | null;
}>();

type KpiId = 'cost' | 'totalTokens' | 'outputTokens' | 'cacheHitRate' | 'netCacheSavings' | 'sessions' | 'activeDays';

interface Delta {
  text: string;
  /** Spend reads neutral whichever way it moves; only a cache improvement reads as success. */
  tone: 'neutral' | 'success';
  title: string;
}

interface Kpi {
  id: KpiId;
  label: string;
  value: string;
  valueTitle: string | undefined;
  note: string | undefined;
  delta: Delta | null;
}

const { t } = useI18n();
const format = useStatsFormat();
const { costLabel, spendLabel, spendTitle } = useCostLabel();

const totalTokens = (u: UsageStatsTotals): number => u.input + u.output + u.cacheRead + u.cacheWrite;
const hitRate = (u: UsageStatsTotals): number | null => cacheHitRate(u.input, u.cacheRead, u.cacheWrite);

function relativeDelta(current: number, previous: number, previousText: string, improvesUpward: boolean): Delta | null {
  const title = t('usageStats.kpi.previousValue', { value: previousText });
  if (previous === 0) return current === 0 ? null : { text: t('usageStats.kpi.new'), tone: 'neutral', title };
  const change = (current - previous) / Math.abs(previous);
  return { text: format.signedPercent(change), tone: improvesUpward && change > 0 ? 'success' : 'neutral', title };
}

function hitRateDelta(current: number | null, previous: number | null): Delta | null {
  if (current === null) return null;
  if (previous === null) {
    return { text: t('usageStats.kpi.new'), tone: 'neutral', title: t('usageStats.kpi.previousValue', { value: t('usageStats.kpi.notAvailable') }) };
  }
  const points = (current - previous) * 100;
  return {
    text: t('usageStats.kpi.points', { value: format.signedPoints(points) }),
    tone: points > 0 ? 'success' : 'neutral',
    title: t('usageStats.kpi.previousValue', { value: format.percent(previous) }),
  };
}

const kpis = computed<Kpi[]>(() => {
  const cur = props.totals;
  const prev = props.previous;
  const rate = hitRate(cur);
  const kpi = (id: KpiId, value: string, delta: Delta | null, extra: Partial<Pick<Kpi, 'valueTitle' | 'note'>> = {}): Kpi => ({
    id,
    label: t(`usageStats.kpi.${id}`),
    value,
    valueTitle: extra.valueTitle,
    note: extra.note,
    delta,
  });
  return [
    kpi('cost', spendLabel(cur.cost, totalTokens(cur)), prev && relativeDelta(cur.cost, prev.cost, costLabel(prev.cost), false), {
      valueTitle: spendTitle(cur.cost, totalTokens(cur)),
      note: cur.unpricedTokens > 0 ? t('usageStats.kpi.unpriced', { tokens: format.tokens(cur.unpricedTokens) }, cur.unpricedTokens) : undefined,
    }),
    kpi('totalTokens', format.tokens(totalTokens(cur)), prev && relativeDelta(totalTokens(cur), totalTokens(prev), format.tokens(totalTokens(prev)), false), {
      valueTitle: format.integer(totalTokens(cur)),
    }),
    kpi('outputTokens', format.tokens(cur.output), prev && relativeDelta(cur.output, prev.output, format.tokens(prev.output), false), {
      valueTitle: format.integer(cur.output),
    }),
    kpi('cacheHitRate', rate === null ? t('usageStats.kpi.notAvailable') : format.percent(rate), prev && hitRateDelta(rate, hitRate(prev))),
    kpi('netCacheSavings', format.usd(cur.netCacheSavings), prev && relativeDelta(cur.netCacheSavings, prev.netCacheSavings, format.usd(prev.netCacheSavings), true)),
    kpi('sessions', format.integer(cur.sessions), prev && relativeDelta(cur.sessions, prev.sessions, format.integer(prev.sessions), false)),
    kpi('activeDays', format.integer(cur.activeDays), prev && relativeDelta(cur.activeDays, prev.activeDays, format.integer(prev.activeDays), false)),
  ];
});
</script>

<template>
  <div class="flex flex-wrap gap-px overflow-hidden rounded-lg border border-(--d-border) bg-(--d-border)">
    <KpiCard
      v-for="k in kpis"
      :id="k.id"
      :key="k.id"
      :label="k.label"
      :info-label="t('usageStats.kpi.formulaFor', { label: k.label })"
      :value="k.value"
      :value-title="k.valueTitle"
      :note="k.note"
    >
      <template #formula>{{ t(`usageStats.formula.${k.id}`) }}</template>
      <template v-if="k.delta" #delta>
        <span
          data-kpi-delta
          class="font-mono text-10.5 tabular-nums"
          :class="k.delta.tone === 'success' ? 'text-(--d-success)' : 'text-(--d-faint)'"
          :title="k.delta.title"
        >{{ k.delta.text }}</span>
      </template>
    </KpiCard>
  </div>
</template>
