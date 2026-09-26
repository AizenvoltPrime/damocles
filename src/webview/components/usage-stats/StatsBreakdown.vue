<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { IconArrowDown, IconArrowUp, IconChevronDown, IconChevronRight, IconX } from '@/components/icons';
import { useCostLabel } from '@/composables/useCostLabel';
import { useStatsFormat } from '@/composables/useStatsFormat';
import { useUsageStatsStore } from '@/stores/useUsageStatsStore';
import { cacheHitRate } from '@shared/usage-accounting';
import { USAGE_STATS_SOURCES, type UsageStatsAggregate, type UsageStatsReport, type UsageStatsSource } from '@shared/types/usage-stats';
import { chartColor, type StatsMetric } from './stats-chart-data';
import { useStatsLabels } from './stats-labels';

const props = defineProps<{
  report: UsageStatsReport;
  metric: StatsMetric;
}>();

type SectionId = 'model' | 'project' | 'source';
type Column = 'name' | 'cost' | 'tokens' | 'share' | 'cache';

interface Row {
  id: string;
  label: string;
  title: string | undefined;
  color: string;
  agg: UsageStatsAggregate;
  /** Set on project rows; a click drills into the project. */
  projectKey?: string;
  /** Set on source rows that have more than their own single detail to show. */
  children?: Row[];
}

const { t, locale } = useI18n();
const format = useStatsFormat();
const labels = useStatsLabels();
const { spendLabel, spendTitle } = useCostLabel();
const store = useUsageStatsStore();

const tokensOf = (a: UsageStatsAggregate): number => a.input + a.output + a.cacheRead + a.cacheWrite;
const metricOf = (a: UsageStatsAggregate): number => (props.metric === 'cost' ? a.cost : tokensOf(a));
const metricTotal = computed(() => metricOf(props.report.totals));

function share(a: UsageStatsAggregate): number | null {
  return metricTotal.value > 0 ? metricOf(a) / metricTotal.value : null;
}

const hitRate = (a: UsageStatsAggregate): number | null => cacheHitRate(a.input, a.cacheRead, a.cacheWrite);

function sumOf(rows: readonly UsageStatsAggregate[]): UsageStatsAggregate {
  const total: UsageStatsAggregate = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 0 };
  for (const r of rows) {
    total.cost += r.cost;
    total.input += r.input;
    total.output += r.output;
    total.cacheRead += r.cacheRead;
    total.cacheWrite += r.cacheWrite;
    total.unpricedTokens += r.unpricedTokens;
    total.requests += r.requests;
  }
  return total;
}

const byCost = (a: UsageStatsAggregate, b: UsageStatsAggregate): number => b.cost - a.cost || tokensOf(b) - tokensOf(a);

// Colors follow each row's cost rank as the host sends it, so a model keeps its chart color whatever the table sort.
const modelRows = computed<Row[]>(() =>
  (props.report.byModel ?? []).map((m, rank) => ({
    id: `model:${m.key ?? ''}`,
    label: labels.model(m.key, m.label),
    title: m.key ?? undefined,
    color: chartColor(rank),
    agg: m,
  })),
);

const projectRows = computed<Row[]>(() =>
  (props.report.byProject ?? []).map((p, rank) => ({
    id: `project:${p.key}`,
    label: labels.project(p.key, p.cwd),
    title: p.cwd ?? undefined,
    color: chartColor(rank),
    agg: p,
    projectKey: p.key,
  })),
);

const sourceRows = computed<Row[]>(() => {
  const groups = new Map<UsageStatsSource, UsageStatsAggregate[]>();
  const details = new Map<UsageStatsSource, Row[]>();
  for (const r of props.report.bySource ?? []) {
    groups.set(r.source, [...(groups.get(r.source) ?? []), r]);
    details.set(r.source, [
      ...(details.get(r.source) ?? []),
      { id: `source:${r.source}:${r.detail ?? ''}`, label: labels.sourceDetail(r.source, r.detail), title: r.detail ?? undefined, color: '', agg: r },
    ]);
  }
  const sources = USAGE_STATS_SOURCES.filter((s) => groups.has(s)).map((source) => ({ source, agg: sumOf(groups.get(source)!) }));
  return sources.sort((a, b) => byCost(a.agg, b.agg)).map(({ source, agg }, rank) => {
    const children = details.get(source)!;
    const expandable = children.length > 1 || children[0]!.title !== undefined;
    return {
      id: `source:${source}`,
      label: labels.source(source),
      title: undefined,
      color: chartColor(rank),
      agg,
      ...(expandable ? { children: children.map((c) => ({ ...c, color: chartColor(rank) })) } : {}),
    };
  });
});

const sections = computed(() => [
  { id: 'model' as const, title: t('usageStats.breakdown.byModel'), rows: modelRows.value },
  { id: 'project' as const, title: t('usageStats.breakdown.byProject'), rows: projectRows.value },
  { id: 'source' as const, title: t('usageStats.breakdown.bySource'), rows: sourceRows.value },
]);

const sort = reactive<Record<SectionId, { column: Column; desc: boolean } | null>>({ model: null, project: null, source: null });

function sortOf(section: SectionId): { column: Column; desc: boolean } {
  return sort[section] ?? { column: props.metric, desc: true };
}

function sortKey(row: Row, column: Column): number | string | null {
  switch (column) {
    case 'name': return row.label.toLocaleLowerCase(locale.value);
    case 'cost': return row.agg.cost;
    case 'tokens': return tokensOf(row.agg);
    case 'share': return metricOf(row.agg);
    case 'cache': return hitRate(row.agg);
  }
}

function sorted(section: SectionId, rows: readonly Row[]): Row[] {
  const { column, desc } = sortOf(section);
  const cmp = (a: Row, b: Row): number => {
    const ka = sortKey(a, column);
    const kb = sortKey(b, column);
    // A row with no rate sorts below every rate in both directions.
    if (ka === null || kb === null) return (ka === null ? 1 : 0) - (kb === null ? 1 : 0);
    const order = typeof ka === 'string' ? ka.localeCompare(kb as string, locale.value) : ka - (kb as number);
    return desc ? -order : order;
  };
  return [...rows].sort(cmp).map((r) => (r.children ? { ...r, children: [...r.children].sort(cmp) } : r));
}

function toggleSort(section: SectionId, column: Column): void {
  const current = sortOf(section);
  sort[section] = current.column === column ? { column, desc: !current.desc } : { column, desc: column !== 'name' };
}

function ariaSort(section: SectionId, column: Column): 'ascending' | 'descending' | 'none' {
  const current = sortOf(section);
  if (current.column !== column) return 'none';
  return current.desc ? 'descending' : 'ascending';
}

const expanded = ref(new Set<string>());

function toggleExpanded(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function drillInto(row: Row): void {
  const key = row.projectKey;
  if (key === undefined) return;
  if (store.projectKeys.length === 1 && store.projectKeys[0] === key) return;
  store.setProjectKeys([key]);
}

const projectChips = computed(() => {
  const options = new Map((props.report.filterOptions.projects ?? []).map((p) => [p.key, p.cwd]));
  return store.projectKeys.map((key) => ({ key, label: labels.project(key, options.get(key) ?? null), title: options.get(key) ?? undefined }));
});

function removeProject(key: string): void {
  store.setProjectKeys(store.projectKeys.filter((k) => k !== key));
}

const columns = computed<Array<{ id: Column; label: string; numeric: boolean }>>(() => [
  { id: 'name', label: t('usageStats.breakdown.columns.name'), numeric: false },
  { id: 'cost', label: t('usageStats.breakdown.columns.cost'), numeric: true },
  { id: 'tokens', label: t('usageStats.breakdown.columns.tokens'), numeric: true },
  { id: 'share', label: t('usageStats.breakdown.columns.share'), numeric: true },
  { id: 'cache', label: t('usageStats.breakdown.columns.cache'), numeric: true },
]);

const shareTitle = computed(() => t(props.metric === 'cost' ? 'usageStats.breakdown.shareOfCost' : 'usageStats.breakdown.shareOfTokens'));

function percentText(ratio: number | null): string {
  return ratio === null ? t('usageStats.kpi.notAvailable') : format.percent(ratio);
}

function barSegments(rows: readonly Row[]): Array<{ id: string; color: string; width: string; title: string }> {
  return rows
    .map((r) => ({ r, s: share(r.agg) }))
    .filter((x): x is { r: Row; s: number } => x.s !== null && x.s > 0)
    .map(({ r, s }) => ({ id: r.id, color: r.color, width: `${s * 100}%`, title: `${r.label}: ${format.percent(s)}` }));
}
</script>

<template>
  <div class="grid grid-cols-1 gap-3 @4xl:grid-cols-2">
    <section
      v-for="section in sections"
      :key="section.id"
      :data-breakdown="section.id"
      class="min-w-0 space-y-2 rounded-md border border-border/50 bg-card p-3 text-card-foreground"
      :class="{ '@4xl:col-span-2': section.id === 'source' }"
    >
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="flex-1 truncate text-xs font-medium text-muted-foreground">{{ section.title }}</h3>
        <template v-if="section.id === 'project'">
          <Badge
            v-for="chip in projectChips"
            :key="chip.key"
            variant="secondary"
            class="max-w-48 gap-1 py-0 pr-1 font-normal"
            :title="chip.title"
            data-project-chip
          >
            <span class="truncate">{{ chip.label }}</span>
            <button
              type="button"
              class="cursor-pointer rounded-sm p-0.5 hover:bg-accent hover:text-accent-foreground"
              :aria-label="t('usageStats.breakdown.removeProject', { project: chip.label })"
              :title="t('usageStats.breakdown.removeProject', { project: chip.label })"
              @click="removeProject(chip.key)"
            >
              <IconX :size="10" />
            </button>
          </Badge>
        </template>
      </div>

      <div class="flex h-2 w-full overflow-hidden rounded-sm bg-muted" aria-hidden="true" data-breakdown-bar>
        <span
          v-for="seg in barSegments(section.rows)"
          :key="seg.id"
          class="h-full"
          :style="{ width: seg.width, backgroundColor: seg.color }"
          :title="seg.title"
        />
      </div>

      <Table class="text-xs">
        <TableCaption class="sr-only">{{ section.title }}</TableCaption>
        <TableHeader>
          <TableRow class="hover:bg-transparent">
            <TableHead
              v-for="col in columns"
              :key="col.id"
              class="h-8 px-2"
              :class="{ 'text-right': col.numeric }"
              :aria-sort="ariaSort(section.id, col.id)"
            >
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
                :class="{ 'flex-row-reverse': col.numeric }"
                :title="col.id === 'share' ? shareTitle : undefined"
                :data-sort="col.id"
                @click="toggleSort(section.id, col.id)"
              >
                <span>{{ col.label }}</span>
                <IconArrowDown v-if="ariaSort(section.id, col.id) === 'descending'" :size="10" />
                <IconArrowUp v-else-if="ariaSort(section.id, col.id) === 'ascending'" :size="10" />
              </button>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-for="row in sorted(section.id, section.rows)" :key="row.id">
            <TableRow
              :data-row="row.id"
              :class="{ 'cursor-pointer': row.projectKey !== undefined }"
              @click="drillInto(row)"
            >
              <TableCell class="w-full max-w-0 px-2 py-1.5">
                <div class="flex min-w-0 items-center gap-1.5">
                  <button
                    v-if="row.children"
                    type="button"
                    class="shrink-0 cursor-pointer rounded-sm text-muted-foreground hover:text-foreground"
                    :aria-expanded="expanded.has(row.id)"
                    :aria-label="t(expanded.has(row.id) ? 'usageStats.breakdown.collapse' : 'usageStats.breakdown.expand', { name: row.label })"
                    data-expand
                    @click.stop="toggleExpanded(row.id)"
                  >
                    <IconChevronDown v-if="expanded.has(row.id)" :size="12" />
                    <IconChevronRight v-else :size="12" />
                  </button>
                  <span class="size-2 shrink-0 rounded-sm" :style="{ backgroundColor: row.color }" aria-hidden="true" />
                  <button
                    v-if="row.projectKey !== undefined"
                    type="button"
                    class="cursor-pointer truncate text-left hover:underline"
                    :title="row.title ? `${row.title}\n${t('usageStats.breakdown.drillHint')}` : t('usageStats.breakdown.drillHint')"
                  >{{ row.label }}</button>
                  <span v-else class="truncate" :title="row.title">{{ row.label }}</span>
                  <Badge
                    v-if="row.agg.unpricedTokens > 0"
                    variant="outline"
                    class="shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                    :title="t('usageStats.breakdown.unpricedTitle', { tokens: format.integer(row.agg.unpricedTokens) }, row.agg.unpricedTokens)"
                    data-unpriced
                  >{{ t('usageStats.breakdown.unpriced') }}</Badge>
                </div>
              </TableCell>
              <TableCell class="whitespace-nowrap px-2 py-1.5 text-right tabular-nums" :title="spendTitle(row.agg.cost, tokensOf(row.agg))" data-cost>{{ spendLabel(row.agg.cost, tokensOf(row.agg)) }}</TableCell>
              <TableCell class="whitespace-nowrap px-2 py-1.5 text-right tabular-nums" :title="format.integer(tokensOf(row.agg))">{{ format.tokens(tokensOf(row.agg)) }}</TableCell>
              <TableCell class="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{{ percentText(share(row.agg)) }}</TableCell>
              <TableCell class="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{{ percentText(hitRate(row.agg)) }}</TableCell>
            </TableRow>
            <template v-if="row.children && expanded.has(row.id)">
              <TableRow v-for="child in row.children" :key="child.id" :data-row="child.id" data-source-detail class="bg-muted/30">
                <TableCell class="w-full max-w-0 py-1 pl-8 pr-2">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <span class="truncate" :title="child.title">{{ child.label }}</span>
                    <Badge
                      v-if="child.agg.unpricedTokens > 0"
                      variant="outline"
                      class="shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                      :title="t('usageStats.breakdown.unpricedTitle', { tokens: format.integer(child.agg.unpricedTokens) }, child.agg.unpricedTokens)"
                      data-unpriced
                    >{{ t('usageStats.breakdown.unpriced') }}</Badge>
                  </div>
                </TableCell>
                <TableCell class="whitespace-nowrap px-2 py-1 text-right tabular-nums" :title="spendTitle(child.agg.cost, tokensOf(child.agg))" data-cost>{{ spendLabel(child.agg.cost, tokensOf(child.agg)) }}</TableCell>
                <TableCell class="whitespace-nowrap px-2 py-1 text-right tabular-nums">{{ format.tokens(tokensOf(child.agg)) }}</TableCell>
                <TableCell class="whitespace-nowrap px-2 py-1 text-right tabular-nums">{{ percentText(share(child.agg)) }}</TableCell>
                <TableCell class="whitespace-nowrap px-2 py-1 text-right tabular-nums">{{ percentText(hitRate(child.agg)) }}</TableCell>
              </TableRow>
            </template>
          </template>
        </TableBody>
      </Table>
    </section>
  </div>
</template>
