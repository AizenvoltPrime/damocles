<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, Minimize2, RotateCcw } from 'lucide-vue-next';
import type { CompactMarker as CompactMarkerType } from '@shared/types/session';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { formatCost } from '@/composables/useTeamFormatting';
import { formatClock } from '@/utils/clock';

const { t, locale } = useI18n();

// The card's figures follow the panel language, so a Greek reader gets Greek grouping, separators and units.
const tokenFormat = computed(() => new Intl.NumberFormat(locale.value, { notation: 'compact' }));

const props = defineProps<{
  marker: CompactMarkerType;
}>();

const emit = defineEmits<{
  rewindToCompaction: [entryId: string];
}>();

const isExpanded = ref(true);

const hasSummary = computed(() => !!props.marker.summary);
const canRewind = computed(() => !!props.marker.entryId);

function requestRewind() {
  if (!props.marker.entryId) return;
  emit('rewindToCompaction', props.marker.entryId);
}

const tokenReduction = computed(() => {
  const format = tokenFormat.value;
  if (props.marker.postTokens) {
    return `${format.format(props.marker.preTokens)} → ${format.format(props.marker.postTokens)}`;
  }
  return format.format(props.marker.preTokens);
});

const triggerLabel = computed(() => {
  if (props.marker.trigger === 'manual') return t('compactMarker.manual');
  if (props.marker.trigger === 'overflow') return t('compactMarker.overflow');
  return t('compactMarker.threshold');
});

// Manual gets no hint: the user started the compaction and already knows why it ran.
const triggerHint = computed(() => {
  if (props.marker.trigger === 'overflow') return t('compactMarker.triggerHintOverflow');
  if (props.marker.trigger === 'threshold') return t('compactMarker.triggerHintThreshold');
  return '';
});

const billedText = computed(() => {
  const { billedTokens, billedCost } = props.marker;
  if (billedTokens === undefined) return '';
  const tokens = tokenFormat.value.format(billedTokens);
  // Below a cent the dollar figure is noise, so state tokens alone. This mirrors pi's own notice.
  if (billedCost === undefined || billedCost < 0.01) return t('compactMarker.billed', { tokens });
  return t('compactMarker.billedWithCost', { tokens, cost: formatCost(billedCost, locale.value) });
});

const triggerChipClass = computed(() => {
  if (props.marker.trigger === 'overflow') return 'bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] text-(--d-warning-text)';
  if (props.marker.trigger === 'threshold') return 'bg-[color-mix(in_srgb,var(--d-info)_14%,transparent)] text-(--d-info-text)';
  return 'bg-(--d-accent-soft) text-(--d-accent-text)';
});

const subtitle = computed(() =>
  [t('compactMarker.tokens', { tokens: tokenReduction.value }, props.marker.postTokens || props.marker.preTokens), formatClock(props.marker.timestamp, locale.value), billedText.value].filter(Boolean).join(' · '),
);
</script>

<template>
  <Collapsible
    v-model:open="isExpanded"
    :disabled="!hasSummary"
    class="flex flex-col gap-2 pt-1 pb-3"
  >
    <div
      class="flex items-center gap-3"
      aria-hidden="true"
    >
      <span class="h-px flex-1 bg-(--d-border)" />
      <span class="text-10.5 font-semibold tracking-[.06em] text-(--d-faint) uppercase">{{ t('compactMarker.boundary') }}</span>
      <span class="h-px flex-1 bg-(--d-border)" />
    </div>

    <section
      class="overflow-hidden rounded-xl border border-(--d-border) bg-(--d-card)"
      :aria-label="t('compactMarker.title')"
      data-testid="compact-marker"
    >
      <CollapsibleTrigger
        class="flex w-full items-center gap-2.5 px-3 py-2.25 text-left transition-colors enabled:hover:bg-(--d-hover) disabled:cursor-default"
        :aria-label="hasSummary ? t('compactMarker.toggleSummary') : undefined"
      >
        <span
          class="flex size-7 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)"
          aria-hidden="true"
        >
          <Minimize2 class="size-3.5" />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-px">
          <span class="truncate text-13 font-semibold text-(--d-text)">{{ t('compactMarker.title') }}</span>
          <span class="truncate text-11 text-(--d-faint)">{{ subtitle }}</span>
        </span>
        <span
          class="flex flex-none items-center gap-1.25 rounded-full px-2 py-0.5 text-11 font-medium"
          :class="triggerChipClass"
          data-testid="compact-trigger"
        >{{ triggerLabel }}</span>
        <ChevronRight
          v-if="hasSummary"
          class="size-3.25 flex-none text-(--d-faint) transition-transform duration-200 ease-out"
          :class="isExpanded && 'rotate-90'"
          aria-hidden="true"
        />
      </CollapsibleTrigger>

      <p
        v-if="triggerHint"
        class="border-t border-(--d-border) py-1.75 pr-3 pl-12.5 text-xs text-pretty text-(--d-muted)"
      >
        {{ triggerHint }}
      </p>

      <CollapsibleContent v-if="hasSummary">
        <div class="border-t border-(--d-border) py-2 pr-3 pl-12.5 text-12.5 text-(--d-muted)">
          <MarkdownRenderer :content="marker.summary ?? ''" />
        </div>
      </CollapsibleContent>
      <p
        v-else
        class="border-t border-(--d-border) py-1.75 pr-3 pl-12.5 text-xs text-(--d-faint) italic"
      >
        {{ t('compactMarker.noSummary') }}
      </p>

      <div
        v-if="canRewind"
        class="flex justify-end border-t border-(--d-border) px-2 py-1"
      >
        <button
          type="button"
          class="d-press flex items-center gap-1.25 rounded-md px-2 py-1 text-xs text-(--d-accent) transition-colors hover:bg-(--d-hover) hover:text-(--d-accent-text)"
          @click="requestRewind"
        >
          <RotateCcw
            class="size-3"
            aria-hidden="true"
          />
          {{ t('compactMarker.rewindBefore') }}
        </button>
      </div>
    </section>
  </Collapsible>
</template>
