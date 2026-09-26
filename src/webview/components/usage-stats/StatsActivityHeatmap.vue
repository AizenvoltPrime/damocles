<script setup lang="ts">
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UsageStatsHeatmapCell } from '@shared/types/usage-stats';
import { useCostLabel } from '@/composables/useCostLabel';
import { useStatsFormat } from '@/composables/useStatsFormat';
import type { StatsMetric } from './stats-chart-data';

const props = defineProps<{
  cells: readonly UsageStatsHeatmapCell[];
  metric: StatsMetric;
}>();

const { t, locale } = useI18n();
const format = useStatsFormat();
const { spendLabel } = useCostLabel();
const titleId = useId();

const HOURS = Array.from({ length: 24 }, (_, h) => h);
// 2024-01-01 was a Monday; weekday 0 is Monday throughout `/stats`.
const dayOf = (weekday: number): Date => new Date(2024, 0, 1 + weekday);

// 24-hour clock in every locale: the axis shows `06`, a cell `06:00`.
const hourFormats = computed(() => ({
  axis: new Intl.DateTimeFormat(locale.value, { hour: '2-digit', hourCycle: 'h23' }),
  cell: new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
}));
const axisHour = (hour: number): string => hourFormats.value.axis.format(new Date(2024, 0, 1, hour));
const cellHour = (hour: number): string => hourFormats.value.cell.format(new Date(2024, 0, 1, hour));

const valueOf = (c: UsageStatsHeatmapCell | undefined): number => (c ? (props.metric === 'cost' ? c.cost : c.tokens) : 0);

const max = computed(() => props.cells.reduce((m, c) => Math.max(m, valueOf(c)), 0));

// `--heat` feeds the cell's color-mix() class; a floor keeps the quietest active hour visible against an empty one.
function heat(value: number): Record<string, string> | undefined {
  if (value <= 0 || max.value <= 0) return undefined;
  return { '--heat': `${Math.round(12 + (value / max.value) * 88)}%` };
}

function valuesText(c: UsageStatsHeatmapCell | undefined): string {
  if (!c) return t('usageStats.heatmap.noUsage');
  return t('usageStats.heatmap.values', {
    cost: spendLabel(c.cost, c.tokens),
    tokens: t('usageStats.heatmap.tokens', { n: format.tokens(c.tokens) }, c.tokens),
    requests: t('usageStats.heatmap.requests', { n: format.integer(c.requests) }, c.requests),
  });
}

const rows = computed(() => {
  const short = new Intl.DateTimeFormat(locale.value, { weekday: 'short' });
  const long = new Intl.DateTimeFormat(locale.value, { weekday: 'long' });
  const byCell = new Map(props.cells.map((c) => [c.weekday * 24 + c.hour, c]));
  return Array.from({ length: 7 }, (_, weekday) => {
    const dayLong = long.format(dayOf(weekday));
    return {
      weekday,
      short: short.format(dayOf(weekday)),
      long: dayLong,
      cells: HOURS.map((hour) => {
        const c = byCell.get(weekday * 24 + hour);
        const values = valuesText(c);
        const value = valueOf(c);
        return {
          hour,
          values,
          title: t('usageStats.heatmap.cell', { when: t('usageStats.heatmap.when', { day: dayLong, hour: cellHour(hour) }), values }),
          active: value > 0,
          style: heat(value),
        };
      }),
    };
  });
});
</script>

<template>
  <section class="min-w-0 space-y-2 rounded-md border border-border/50 bg-card p-3 text-card-foreground" data-heatmap>
    <div class="flex flex-wrap items-baseline gap-2">
      <h3 :id="titleId" class="flex-1 truncate text-xs font-medium text-muted-foreground">{{ t('usageStats.heatmap.title') }}</h3>
      <span class="text-[10px] text-muted-foreground">{{ t(metric === 'cost' ? 'usageStats.heatmap.byCost' : 'usageStats.heatmap.byTokens') }}</span>
    </div>

    <table class="w-full table-fixed border-separate border-spacing-px text-[10px] text-muted-foreground" :aria-labelledby="titleId">
      <thead>
        <tr>
          <td class="w-8 p-0" />
          <th v-for="hour in HOURS" :key="hour" scope="col" class="truncate p-0 text-center font-normal">
            <span aria-hidden="true">{{ hour % 6 === 0 ? axisHour(hour) : '' }}</span>
            <span class="sr-only">{{ cellHour(hour) }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="day in rows" :key="day.weekday">
          <th scope="row" class="truncate p-0 pr-1.5 text-left font-normal leading-4" :title="day.long">
            <span aria-hidden="true">{{ day.short }}</span>
            <span class="sr-only">{{ day.long }}</span>
          </th>
          <td
            v-for="cell in day.cells"
            :key="cell.hour"
            class="h-4 rounded-[2px] p-0"
            :class="cell.active ? 'bg-[color-mix(in_srgb,var(--chart-1)_var(--heat),transparent)]' : 'bg-muted/40'"
            :style="cell.style"
            :title="cell.title"
            :data-cell="`${day.weekday}-${cell.hour}`"
          >
            <span class="sr-only">{{ cell.values }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
