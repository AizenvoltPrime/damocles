<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconInfo } from '@/components/icons';
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
  <div class="grid grid-cols-1 gap-2 @[16rem]:grid-cols-2 @xl:grid-cols-3 @4xl:grid-cols-4">
    <div
      v-for="k in kpis"
      :key="k.id"
      :data-kpi="k.id"
      class="flex min-w-0 flex-col gap-1 rounded-md border border-border/50 bg-card p-3 text-card-foreground"
    >
      <div class="flex items-center gap-1">
        <span class="flex-1 truncate text-xs text-muted-foreground">{{ k.label }}</span>
        <Popover>
          <PopoverTrigger as-child>
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-5 shrink-0 text-muted-foreground"
              :aria-label="t('usageStats.kpi.formulaFor', { label: k.label })"
            >
              <IconInfo :size="12" />
            </Button>
          </PopoverTrigger>
          <PopoverContent class="w-72 p-3 text-xs leading-relaxed" align="end">
            {{ t(`usageStats.formula.${k.id}`) }}
          </PopoverContent>
        </Popover>
      </div>
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span data-kpi-value class="text-lg font-semibold tabular-nums text-foreground" :title="k.valueTitle">{{ k.value }}</span>
        <span
          v-if="k.delta"
          data-kpi-delta
          class="text-xs tabular-nums"
          :class="k.delta.tone === 'success' ? 'text-success' : 'text-muted-foreground'"
          :title="k.delta.title"
        >{{ k.delta.text }}</span>
      </div>
      <p v-if="k.note" data-kpi-note class="text-xs text-muted-foreground">{{ k.note }}</p>
    </div>
  </div>
</template>
