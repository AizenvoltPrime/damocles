<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { ArrowDown, ArrowUp, ChartPie, Database, FileText, Minimize2 } from 'lucide-vue-next';
import type { SessionStats } from '@shared/types/session';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MENU_CONTENT, MENU_ITEM } from '@/components/chat-header/menuStyles';
import TeamIndicator from '@/components/TeamIndicator.vue';
import CompassIndicator from '@/components/CompassIndicator.vue';
import BackgroundTasksIndicator from '@/components/BackgroundTasksIndicator.vue';
import { useSettingsStore } from '@/stores';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useContextPercentage } from '@/composables/useContextPercentage';
import { useCostLabel } from '@/composables/useCostLabel';
import { contextWarningBands } from '@/utils/contextBands';
import { cacheHitPercent } from '@/utils/cacheHitPercent';
import { agentCacheHitRate, agentUsageUnpriced, promptTokens } from '@shared/usage-accounting';
import { remPx } from '@/composables/useRemPx';

const props = defineProps<{ stats: SessionStats }>();

const emit = defineEmits<{
  openLog: [];
  openContextUsage: [];
  openBackgroundTasks: [];
}>();

const { t, locale } = useI18n();
const { postMessage } = usePlatformBridge();
const { currentSettings } = storeToRefs(useSettingsStore());
const { costLabel, costTitle } = useCostLabel();

const { totalContext, contextPercentage } = useContextPercentage(() => props.stats);

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const ringDash = computed(() => {
  const filled = (RING_CIRCUMFERENCE * Math.min(contextPercentage.value, 100)) / 100;
  return `${filled.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`;
});

const band = computed(() => {
  const { hard, soft, warning } = contextWarningBands(currentSettings.value.autoCompact.triggerPercent);
  if (contextPercentage.value >= hard) return { color: 'var(--d-danger)', note: t('context.critical') };
  if (contextPercentage.value >= soft) return { color: 'color-mix(in srgb, var(--d-warning) 50%, var(--d-danger))', note: t('context.soft') };
  if (contextPercentage.value >= warning) return { color: 'var(--d-warning)', note: t('context.warning') };
  return { color: 'var(--d-success)', note: null };
});

const contextLabel = computed(() => `${formatNumber(totalContext.value)} / ${formatNumber(props.stats.contextWindowSize)} · ${contextPercentage.value}%`);
const contextTitle = computed(() => [t('stats.contextUsage'), band.value.note].filter(Boolean).join(' · '));
const menuHeading = computed(() =>
  currentSettings.value.autoCompact.enabled
    ? t('composer.contextMenuHeading', { n: currentSettings.value.autoCompact.triggerPercent })
    : t('composer.contextMenuHeadingOff'),
);

function compactNow(): void {
  postMessage({ type: 'sendMessage', content: '/compact' });
}

const cacheHitRate = computed(() => agentCacheHitRate(props.stats));

const tokensTooltip = computed(() => {
  const s = props.stats;
  const n = (v: number) => v.toLocaleString(locale.value);
  return t('stats.tokensTooltip', {
    input: n(s.totalInputTokens),
    cacheRead: n(s.cacheReadTokens),
    cacheWrite: n(s.cacheCreationTokens),
    output: n(s.totalOutputTokens),
  });
});

const unpriced = computed(() => agentUsageUnpriced(props.stats));
const costTooltip = computed(() =>
  [t('stats.cost'), unpriced.value ? t('common.unpricedTooltip') : costTitle()].filter(Boolean).join('\n'),
);

function formatNumber(num: number): string {
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}
</script>

<template>
  <!-- Container widths 33rem and 43rem are the header's 35rem and 45rem panel folds less the chat column's padding. -->
  <div
    class="@container flex min-w-0 items-center gap-1.5 whitespace-nowrap px-1 text-11.5 text-(--d-muted)"
    data-testid="composer-status-strip"
  >
    <div
      class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
      data-testid="composer-status-left"
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          class="flex shrink-0 items-center gap-1.5 rounded-full py-0.5 ps-1 pe-2 transition-colors hover:bg-(--d-hover) hover:text-(--d-text) data-[state=open]:bg-(--d-hover)"
          :title="contextTitle"
          :aria-label="`${contextTitle}: ${contextLabel}`"
          data-testid="composer-context"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            class="size-4 shrink-0"
          >
            <circle
              cx="8"
              cy="8"
              :r="RING_RADIUS"
              fill="none"
              stroke="var(--d-border2)"
              stroke-width="2.4"
            />
            <circle
              cx="8"
              cy="8"
              :r="RING_RADIUS"
              fill="none"
              :stroke="band.color"
              stroke-width="2.4"
              stroke-linecap="round"
              :stroke-dasharray="ringDash"
              transform="rotate(-90 8 8)"
            />
          </svg>
          <span class="font-mono tabular-nums">{{ contextLabel }}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          :side-offset="remPx(0.375)"
          :class="['w-57.5', MENU_CONTENT]"
          data-testid="composer-context-menu"
        >
          <DropdownMenuLabel class="px-2.25 py-1.25 text-11 font-normal text-(--d-faint)">
            {{ menuHeading }}
          </DropdownMenuLabel>
          <DropdownMenuItem
            :class="MENU_ITEM"
            data-action="details"
            @select="emit('openContextUsage')"
          >
            <ChartPie aria-hidden="true" />{{ t('composer.viewDetails') }}
          </DropdownMenuItem>
          <DropdownMenuItem
            :class="MENU_ITEM"
            data-action="compact"
            @select="compactNow"
          >
            <Minimize2 aria-hidden="true" />{{ t('composer.compactNow') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <span
        class="flex shrink-0 items-center gap-1 px-1.5 py-0.5 font-mono tabular-nums"
        :title="tokensTooltip"
      >
        {{ formatNumber(promptTokens(stats)) }}<ArrowDown
          class="size-2.5"
          aria-hidden="true"
        />
        {{ formatNumber(stats.totalOutputTokens) }}<ArrowUp
          class="size-2.5"
          aria-hidden="true"
        />
      </span>

      <span
        v-if="cacheHitRate !== null"
        class="hidden shrink-0 items-center gap-1.25 px-1.5 py-0.5 text-(--d-info) @min-[33rem]:flex"
        :title="t('stats.cacheHitTooltip')"
      >
        <Database
          class="size-2.75"
          aria-hidden="true"
        />{{ t('stats.cacheHit', { pct: cacheHitPercent(cacheHitRate) }) }}
      </span>

      <CompassIndicator />
      <BackgroundTasksIndicator @click="emit('openBackgroundTasks')" />
      <TeamIndicator />
    </div>

    <div
      class="flex shrink-0 items-center gap-1.5"
      data-testid="composer-status-right"
    >
      <span
        v-if="stats.numTurns > 0"
        class="shrink-0 @max-[12rem]:sr-only"
      >{{ t('stats.turns', { n: stats.numTurns }, stats.numTurns) }}</span>
      <span
        class="shrink-0 font-mono font-semibold text-(--d-text)"
        :title="costTooltip"
      >
        {{ unpriced ? t('common.unpriced') : costLabel(stats.costUsd) }}
      </span>
      <button
        type="button"
        class="flex size-5.5 shrink-0 items-center justify-center rounded-5 transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
        :title="t('composer.openLog')"
        :aria-label="t('composer.openLog')"
        data-testid="composer-open-log"
        @click="emit('openLog')"
      >
        <FileText
          class="size-3"
          aria-hidden="true"
        />
      </button>
    </div>
  </div>
</template>
