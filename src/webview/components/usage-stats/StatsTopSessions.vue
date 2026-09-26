<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { IconArrowDown, IconArrowUp } from '@/components/icons';
import type { UsageStatsTopSession } from '@shared/types/usage-stats';
import { useCostLabel } from '@/composables/useCostLabel';
import { useStatsFormat } from '@/composables/useStatsFormat';
import { useVSCode } from '@/composables/useVSCode';
import { useUsageStatsStore } from '@/stores/useUsageStatsStore';
import { useStatsLabels } from './stats-labels';

const props = defineProps<{
  sessions: readonly UsageStatsTopSession[];
}>();

type Column = 'title' | 'project' | 'cost' | 'tokens' | 'lastActive';

const { t, locale } = useI18n();
const format = useStatsFormat();
const labels = useStatsLabels();
const { spendLabel, spendTitle } = useCostLabel();
const { postMessage } = useVSCode();
const store = useUsageStatsStore();

const tokensOf = (s: UsageStatsTopSession): number => s.input + s.output + s.cacheRead + s.cacheWrite;

function titleOf(s: UsageStatsTopSession): string {
  if (s.missing) return t('usageStats.topSessions.deleted');
  return s.title ?? t('usageStats.topSessions.untitled');
}

function blockedReason(s: UsageStatsTopSession): string | undefined {
  if (s.openable) return undefined;
  return t(s.missing ? 'usageStats.topSessions.deletedHint' : 'usageStats.topSessions.otherFolderHint');
}

const sort = ref<{ column: Column; desc: boolean }>({ column: 'cost', desc: true });

function sortKey(s: UsageStatsTopSession, column: Column): number | string {
  switch (column) {
    case 'title': return titleOf(s).toLocaleLowerCase(locale.value);
    case 'project': return labels.project(s.projectKey, s.cwd).toLocaleLowerCase(locale.value);
    case 'cost': return s.cost;
    case 'tokens': return tokensOf(s);
    case 'lastActive': return s.lastActiveMs;
  }
}

const rows = computed(() => {
  const { column, desc } = sort.value;
  return [...props.sessions].sort((a, b) => {
    const ka = sortKey(a, column);
    const kb = sortKey(b, column);
    const order = typeof ka === 'string' ? ka.localeCompare(kb as string, locale.value) : ka - (kb as number);
    return desc ? -order : order;
  });
});

function toggleSort(column: Column): void {
  sort.value = sort.value.column === column ? { column, desc: !sort.value.desc } : { column, desc: column !== 'title' && column !== 'project' };
}

function ariaSort(column: Column): 'ascending' | 'descending' | 'none' {
  if (sort.value.column !== column) return 'none';
  return sort.value.desc ? 'descending' : 'ascending';
}

const columns = computed<Array<{ id: Column; label: string; numeric: boolean }>>(() => [
  { id: 'title', label: t('usageStats.topSessions.columns.title'), numeric: false },
  { id: 'project', label: t('usageStats.topSessions.columns.project'), numeric: false },
  { id: 'cost', label: t('usageStats.topSessions.columns.cost'), numeric: true },
  { id: 'tokens', label: t('usageStats.topSessions.columns.tokens'), numeric: true },
  { id: 'lastActive', label: t('usageStats.topSessions.columns.lastActive'), numeric: true },
]);

function open(s: UsageStatsTopSession): void {
  if (!s.openable) return;
  postMessage({ type: 'resumeSession', sessionId: s.sessionId });
  store.closeOverlay();
}
</script>

<template>
  <section class="min-w-0 space-y-2 rounded-md border border-border/50 bg-card p-3 text-card-foreground" data-top-sessions>
    <h3 class="truncate text-xs font-medium text-muted-foreground">{{ t('usageStats.topSessions.title') }}</h3>

    <Table class="text-xs">
      <TableCaption class="sr-only">{{ t('usageStats.topSessions.title') }}</TableCaption>
      <TableHeader>
        <TableRow class="hover:bg-transparent">
          <TableHead
            v-for="col in columns"
            :key="col.id"
            class="h-8 px-2"
            :class="{ 'text-right': col.numeric }"
            :aria-sort="ariaSort(col.id)"
          >
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
              :class="{ 'flex-row-reverse': col.numeric }"
              :data-sort="col.id"
              @click="toggleSort(col.id)"
            >
              <span>{{ col.label }}</span>
              <IconArrowDown v-if="ariaSort(col.id) === 'descending'" :size="10" />
              <IconArrowUp v-else-if="ariaSort(col.id) === 'ascending'" :size="10" />
            </button>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="s in rows"
          :key="s.sessionId"
          :data-session="s.sessionId"
          :class="s.openable ? 'cursor-pointer' : 'text-muted-foreground'"
          :title="blockedReason(s)"
          @click="open(s)"
        >
          <TableCell class="w-full max-w-0 px-2 py-1.5">
            <div class="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                class="block min-w-0 flex-1 truncate text-left enabled:cursor-pointer enabled:hover:underline disabled:cursor-default"
                :class="{ italic: s.missing }"
                :disabled="!s.openable"
                :title="blockedReason(s) ?? t('usageStats.topSessions.openHint', { title: titleOf(s) })"
                data-open
                @click.stop="open(s)"
              >
                {{ titleOf(s) }}
              </button>
              <Badge
                v-if="s.unpricedTokens > 0"
                variant="outline"
                class="shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                :title="t('usageStats.breakdown.unpricedTitle', { tokens: format.integer(s.unpricedTokens) }, s.unpricedTokens)"
                data-unpriced
              >{{ t('usageStats.breakdown.unpriced') }}</Badge>
            </div>
          </TableCell>
          <TableCell class="max-w-32 truncate px-2 py-1.5" :title="s.cwd ?? undefined">{{ labels.project(s.projectKey, s.cwd) }}</TableCell>
          <TableCell class="whitespace-nowrap px-2 py-1.5 text-right tabular-nums" :title="spendTitle(s.cost, tokensOf(s))" data-cost>{{ spendLabel(s.cost, tokensOf(s)) }}</TableCell>
          <TableCell class="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{{ format.tokens(tokensOf(s)) }}</TableCell>
          <TableCell class="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{{ format.dateTime(s.lastActiveMs) }}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </section>
</template>
