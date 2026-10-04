<script setup lang="ts">
import { computed, defineComponent, h, ref, useId, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AcceptableValue } from 'reka-ui';
import { VisAxis, VisStackedBar, VisXYContainer } from '@unovis/vue';
import { ChartCrosshair, ChartTooltip } from '@/components/ui/chart';
import SegmentedToggle from '../SegmentedToggle.vue';
import { useCostLabel } from '@/composables/useCostLabel';
import { useStatsFormat } from '@/composables/useStatsFormat';
import { remPx } from '@/composables/useRemPx';
import type { UsageStatsBucket, UsageStatsModelRow, UsageStatsRange, UsageStatsSeries } from '@shared/types/usage-stats';
import ProviderLogo from '@/components/icons/ProviderLogo.vue';
import { bucketStartMs, bucketTotals, chartRows, modelProvider, type BucketTotal, type StatsMetric, type StatsSplit, type TokenType } from './stats-chart-data';
import { useStatsLabels } from './stats-labels';

const props = defineProps<{
  series: UsageStatsSeries;
  range: UsageStatsRange;
  byModel: UsageStatsModelRow[];
}>();

const metric = defineModel<StatsMetric>('metric', { required: true });
const split = ref<StatsSplit>('model');

const { t, locale } = useI18n();
const format = useStatsFormat();
const labels = useStatsLabels();
const { costLabel, spendLabel, panelDollarBilled } = useCostLabel();
const headingId = useId();
const tableId = useId();

const TITLE_KEY = 'title';
const CHART_HEIGHT_REM = 12.5;

const shaped = computed(() => chartRows(props.series, props.range, props.byModel, metric.value, split.value));
const categories = computed(() => shaped.value.categories);

const modelLabels = computed(() => new Map(props.byModel.map((m) => [m.key ?? '', m.label])));

function categoryLabel(key: string): string {
  if (split.value === 'tokenType') return labels.tokenType(key as TokenType);
  return labels.model(key, modelLabels.value.get(key));
}

function categoryProvider(key: string): string | null {
  return split.value === 'model' ? modelProvider(key) : null;
}

const dateFormats = computed(() => ({
  tick: new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric' }),
  day: new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }),
  monthTick: new Intl.DateTimeFormat(locale.value, { month: 'short', year: '2-digit' }),
  month: new Intl.DateTimeFormat(locale.value, { month: 'long', year: 'numeric' }),
}));

function bucketTick(key: string, bucket: UsageStatsBucket): string {
  return (bucket === 'month' ? dateFormats.value.monthTick : dateFormats.value.tick).format(bucketStartMs(key));
}

function bucketTitle(key: string, bucket: UsageStatsBucket): string {
  const ms = bucketStartMs(key);
  if (bucket === 'month') return dateFormats.value.month.format(ms);
  const day = dateFormats.value.day.format(ms);
  return bucket === 'week' ? t('usageStats.chart.weekOf', { date: day }) : day;
}

type Datum = Record<string, number | string>;

const totals = computed(() => bucketTotals(props.series));
const NO_TOTAL: BucketTotal = { cost: 0, tokens: 0 };

const titledRows = computed(() =>
  shaped.value.rows.map(({ bucket, ...values }) => ({
    title: bucketTitle(bucket, props.series.bucket),
    values,
    total: totals.value.get(bucket) ?? NO_TOTAL,
  })),
);

const data = computed<Datum[]>(() => titledRows.value.map(({ title, values }) => ({ ...values, [TITLE_KEY]: title })));

// Tooltips are keyed by bucket title, which is unique per bucket.
const totalsByTitle = computed(() => new Map(titledRows.value.map((r) => [r.title, r.total])));

const allZero = computed(() => shaped.value.rows.every((row) => categories.value.every((c) => row[c.key] === 0)));

const x = (_d: Datum, i: number): number => i;
const y = computed(() => categories.value.map((c) => (d: Datum) => d[c.key] as number));
const color = (_d: Datum, i: number): string => categories.value[i]?.color ?? 'transparent';

// Index ticks, thinned so labels never overlap in a narrow sidebar.
const MAX_TICKS = 7;
const tickValues = computed(() => {
  const n = shaped.value.rows.length;
  const every = Math.max(1, Math.ceil(n / MAX_TICKS));
  return Array.from({ length: n }, (_, i) => i).filter((i) => i % every === 0);
});

const xTick = (i: number | Date): string => {
  const row = shaped.value.rows[Number(i)];
  return row ? bucketTick(row.bucket, props.series.bucket) : '';
};
const yTick = (v: number | Date): string => (metric.value === 'cost' ? format.usdCompact(Number(v)) : format.tokens(Number(v)));

const formatValue = (v: number): string => (metric.value === 'cost' ? costLabel(v) : format.integer(v));
const formatTotal = (total: BucketTotal): string => (metric.value === 'cost' ? spendLabel(total.cost, total.tokens) : format.integer(total.tokens));

const tableRows = computed(() =>
  titledRows.value.map((r) => ({
    title: r.title,
    values: categories.value.map((c) => formatValue(r.values[c.key] as number)),
    total: formatTotal(r.total),
  })),
);

const legendItems = computed(() => categories.value.map((c) => ({ name: c.key, color: c.color })));
const legend = computed(() => categories.value.map((c) => ({ ...c, label: categoryLabel(c.key), provider: categoryProvider(c.key) })));

// Mounted by Unovis in a bare app, so it receives plain formatting closures rather than injected i18n.
const Tooltip = defineComponent({
  props: {
    title: { type: String, default: '' },
    data: { type: Array as PropType<Array<{ name?: string | number; color?: string; value: unknown }>>, default: () => [] },
  },
  setup(p) {
    return () => {
      const series = p.data
        .filter((d): d is { name: string | number; color?: string; value: number } => typeof d.value === 'number' && d.value > 0 && d.name !== undefined)
        .map((d) => ({ key: String(d.name), color: d.color ?? 'transparent', value: d.value }));
      const rows = series.map((s) => ({ name: categoryLabel(s.key), color: s.color, value: formatValue(s.value) }));
      rows.push({ name: t('usageStats.chart.total'), color: 'transparent', value: formatTotal(totalsByTitle.value.get(p.title) ?? NO_TOTAL) });
      // The total row has no series, so it gets no logo.
      const providers = series.map((s) => categoryProvider(s.key));
      return h(ChartTooltip, { title: p.title, data: rows }, {
        icon: ({ index }: { index: number }) => {
          const provider = providers[index];
          return provider ? h(ProviderLogo, { provider, class: 'size-3' }) : null;
        },
      });
    };
  },
});

const metricOptions = computed(() => [
  { value: 'cost' as const, label: t('usageStats.chart.metric.cost') },
  { value: 'tokens' as const, label: t('usageStats.chart.metric.tokens') },
]);
const splitOptions = computed(() => [
  { value: 'model' as const, label: t('usageStats.chart.split.model') },
  { value: 'tokenType' as const, label: t('usageStats.chart.split.tokenType') },
]);

function onMetric(value: AcceptableValue): void {
  if (value === 'cost' || value === 'tokens') metric.value = value;
}

function onSplit(value: AcceptableValue): void {
  if (value === 'model' || value === 'tokenType') split.value = value;
}

const labelParts = computed(() => ({
  metric: t(`usageStats.chart.metric.${metric.value}`),
  split: t(`usageStats.chart.split.${split.value}`),
}));
const chartLabel = computed(() => t('usageStats.chart.ariaLabel', labelParts.value));
const tableCaption = computed(() => t('usageStats.chart.tableCaption', labelParts.value));
</script>

<template>
  <section class="space-y-2 rounded-lg border border-(--d-border) px-3 pt-2.5 pb-2" :aria-labelledby="headingId">
    <div class="flex flex-wrap items-center gap-2">
      <h3 :id="headingId" class="min-w-30 flex-1 truncate text-xs font-semibold">{{ t('usageStats.chart.title') }}</h3>
      <SegmentedToggle
        :model-value="metric"
        :options="metricOptions"
        class="border border-(--d-border)"
        indicator-class="text-[color-mix(in_srgb,var(--d-text)_8%,var(--d-bg))]"
        :aria-label="t('usageStats.chart.metricLabel')"
        data-toggle="metric"
        @update:model-value="onMetric"
      />
      <SegmentedToggle
        :model-value="split"
        :options="splitOptions"
        class="border border-(--d-border)"
        indicator-class="text-[color-mix(in_srgb,var(--d-text)_8%,var(--d-bg))]"
        :aria-label="t('usageStats.chart.splitLabel')"
        data-toggle="split"
        @update:model-value="onSplit"
      />
    </div>

    <div
      role="img"
      :aria-label="chartLabel"
      :aria-describedby="tableId"
      class="text-xs [--vis-axis-grid-color:var(--chart-grid)] [--vis-axis-tick-label-color:var(--muted-foreground)] [--vis-axis-label-color:var(--muted-foreground)] [--vis-axis-domain-color:var(--chart-grid)] [--vis-axis-tick-color:var(--chart-grid)] [--vis-font-family:var(--d-font)] [--vis-axis-font-family:var(--d-font)] [--vis-axis-tick-label-font-size:0.75rem] [--vis-crosshair-line-stroke-color:var(--muted-foreground)] [--vis-crosshair-circle-stroke-color:var(--card)] [--vis-tooltip-background-color:transparent] [--vis-tooltip-border-color:transparent] [--vis-tooltip-padding:0px] [--vis-tooltip-text-color:var(--popover-foreground)] [--vis-stacked-bar-stroke-color:transparent]"
    >
      <VisXYContainer :data="data" :height="remPx(CHART_HEIGHT_REM)" :duration="0" :y-domain="allZero ? [0, 1] : undefined">
        <VisStackedBar :x="x" :y="y" :color="color" :bar-padding="0.2" :rounded-corners="2" />
        <VisAxis type="x" :tick-values="tickValues" :tick-format="xTick" :grid-line="false" :tick-line="false" :domain-line="false" />
        <VisAxis type="y" :num-ticks="4" :tick-format="yTick" :tick-line="false" :domain-line="false" />
        <ChartCrosshair :colors="categories.map((c) => c.color)" :items="legendItems" :index="TITLE_KEY" :custom-tooltip="Tooltip" :tooltip-key="`${locale}:${panelDollarBilled}`" />
      </VisXYContainer>
    </div>

    <table :id="tableId" class="sr-only" data-chart-table>
      <caption>{{ tableCaption }}</caption>
      <thead>
        <tr>
          <th scope="col">{{ t('usageStats.chart.period') }}</th>
          <th v-for="c in categories" :key="c.key" scope="col">{{ categoryLabel(c.key) }}</th>
          <th scope="col">{{ t('usageStats.chart.total') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in tableRows" :key="row.title">
          <th scope="row">{{ row.title }}</th>
          <td v-for="(value, i) in row.values" :key="i">{{ value }}</td>
          <td>{{ row.total }}</td>
        </tr>
      </tbody>
    </table>

    <ul class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-(--d-muted)" data-chart-legend>
      <li v-for="c in legend" :key="c.key" class="flex min-w-0 items-center gap-1.5" :title="c.key.includes('/') ? c.key : undefined">
        <span class="size-2.5 shrink-0 rounded-sm" :style="{ backgroundColor: c.color }" aria-hidden="true" />
        <ProviderLogo v-if="c.provider" :provider="c.provider" class="size-3.5" data-model-logo />
        <span class="truncate">{{ c.label }}</span>
      </li>
    </ul>
  </section>
</template>
