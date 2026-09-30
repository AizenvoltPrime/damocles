<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconWarning, IconChevronRight } from '@/components/icons';
import { useUIStore, skippedFilesKey } from '@/stores/useUIStore';
import type { RewindHistoryItem, SkipReason, SkippedFilesTarget } from '@shared/types/session';

const { t } = useI18n();
const uiStore = useUIStore();

const props = defineProps<{
  skipped?: RewindHistoryItem['skipped'] | undefined;
  notRewindable?: RewindHistoryItem['notRewindable'] | undefined;
  /** Where the full skipped list is read from when the user expands it; absent shows the summary only. */
  target?: SkippedFilesTarget | undefined;
}>();

const expanded = ref(false);

const KIB = 1024;
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= KIB && unit < UNITS.length - 1) {
    value /= KIB;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}

const REASON_KEYS: Record<SkipReason, string> = {
  size: 'rewind.notRestored.reason.size',
  category: 'rewind.notRestored.reason.category',
  lfs: 'rewind.notRestored.reason.lfs',
};
const REASONS: readonly SkipReason[] = ['size', 'category', 'lfs'];

const hasSkipped = computed(() => (props.skipped?.totalCount ?? 0) > 0);

const reasonRows = computed(() => {
  const byReason = props.skipped?.byReason ?? {};
  return REASONS.flatMap((reason) => {
    const tally = byReason[reason];
    return tally && tally.count > 0 ? [{ reason, ...tally }] : [];
  });
});

const listState = computed(() => (props.target ? uiStore.skippedFiles[skippedFilesKey(props.target)] : undefined));

function toggle(): void {
  expanded.value = !expanded.value;
  if (expanded.value && props.target && props.skipped?.manifest) uiStore.requestSkippedFiles(props.target);
}

const notRewindableReason = computed(() =>
  props.notRewindable?.reason === 'baseline-timeout'
    ? t('rewind.notRewindable.reason.baselineTimeout')
    : t('rewind.notRewindable.reason.baselineFailed'),
);

const notRewindableDetail = computed(() => {
  const record = props.notRewindable;
  if (!record) return '';
  const { tool, waitSeconds, error } = record.params;
  if (record.reason === 'baseline-timeout') {
    return tool && waitSeconds !== undefined ? t('rewind.notRewindable.detail.baselineTimeout', { tool, n: waitSeconds }) : '';
  }
  return error ? t('rewind.notRewindable.detail.baselineFailed', { error }) : '';
});
</script>

<template>
  <div v-if="notRewindable || hasSkipped" class="space-y-2" data-no-keyboard-shortcuts>
    <div
      v-if="notRewindable"
      data-testid="rewind-not-rewindable"
      class="flex items-start gap-2 p-2 rounded bg-warning/15 border border-warning/30 text-xs"
    >
      <IconWarning :size="14" class="mt-0.5 shrink-0 text-warning" />
      <div class="min-w-0">
        <div class="font-medium text-warning">{{ t('rewind.notRewindable.title') }}</div>
        <div class="text-foreground/80">{{ notRewindableReason }}</div>
        <div v-if="notRewindableDetail" class="text-muted-foreground break-words">{{ notRewindableDetail }}</div>
      </div>
    </div>

    <div v-if="skipped && hasSkipped" data-testid="rewind-not-restored" class="px-1 text-xs text-muted-foreground">
      <button
        type="button"
        class="flex items-center gap-1 text-foreground/80 hover:text-foreground transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
        :aria-expanded="expanded"
        :aria-label="t('rewind.notRestored.toggle')"
        @click="toggle"
      >
        <IconChevronRight :size="12" class="transition-transform" :class="expanded ? 'rotate-90' : ''" />
        <span class="font-medium">{{ t('rewind.notRestored.title') }}</span>
        <span>· {{ t('rewind.notRestored.summary', { n: skipped.totalCount, size: formatBytes(skipped.totalBytes) }, skipped.totalCount) }}</span>
      </button>
      <div v-if="expanded" class="mt-2 rounded bg-muted/50 border border-border/60 max-h-40 overflow-y-auto">
        <div
          v-for="row in reasonRows"
          :key="row.reason"
          data-testid="rewind-not-restored-reason"
          class="flex items-center gap-2 px-3 py-1.5"
        >
          <span class="text-foreground/80 flex-1 min-w-0">{{ t(REASON_KEYS[row.reason]) }}</span>
          <span class="shrink-0 tabular-nums">{{ t('rewind.notRestored.summary', { n: row.count, size: formatBytes(row.bytes) }, row.count) }}</span>
        </div>
        <div
          v-for="pattern in skipped.patterns"
          :key="`${pattern.reason}:${pattern.pattern}`"
          data-testid="rewind-not-restored-pattern"
          class="flex items-center gap-2 px-3 py-1.5"
        >
          <span class="font-mono text-foreground/80 truncate flex-1 min-w-0">{{ t('rewind.notRestored.pattern', { pattern: pattern.pattern, n: pattern.count }, pattern.count) }}</span>
          <span class="shrink-0 text-muted-foreground/80">{{ t(REASON_KEYS[pattern.reason]) }}</span>
        </div>
        <div v-if="listState?.status === 'loading'" data-testid="rewind-not-restored-loading" class="px-3 py-1.5 animate-pulse">
          {{ t('rewind.notRestored.loading') }}
        </div>
        <div v-else-if="listState?.status === 'error'" data-testid="rewind-not-restored-error" class="px-3 py-1.5 text-warning">
          {{ t('rewind.notRestored.loadFailed') }}
        </div>
        <template v-else-if="listState?.status === 'loaded'">
          <div
            v-for="file in listState.files"
            :key="file.path"
            data-testid="rewind-not-restored-file"
            class="flex items-center gap-2 px-3 py-1.5"
          >
            <span class="font-mono text-foreground/80 truncate flex-1 min-w-0" :title="file.path">{{ file.path }}</span>
            <span v-if="file.bytes !== null" class="shrink-0 tabular-nums">{{ formatBytes(file.bytes) }}</span>
            <span class="shrink-0 text-muted-foreground/80">{{ t(REASON_KEYS[file.reason]) }}</span>
          </div>
        </template>
      </div>
      <div class="mt-1">{{ t('rewind.notRestored.hint') }}</div>
    </div>
  </div>
</template>
